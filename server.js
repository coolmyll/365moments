require("dotenv").config();
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { google } = require("googleapis");

// Redis for production session storage
let redisStore = null;
let redisClient = null;

if (process.env.REDIS_URL) {
  const { createClient } = require("redis");
  const { RedisStore } = require("connect-redis");

  redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 10000,
    },
  });

  redisClient.on("error", (err) =>
    console.log("Redis Client Error:", err.message),
  );

  // Connect synchronously before app starts
  redisClient
    .connect()
    .then(() => {
      console.log("✅ Redis connected");
    })
    .catch((err) => {
      console.error("Redis connection failed:", err.message);
    });

  redisStore = new RedisStore({ client: redisClient, prefix: "365m:" });
  console.log("📦 Using Redis for session storage");
} else {
  console.log("📁 Using file-based session storage");
}

const app = express();
const PORT = process.env.PORT || 3000;

// Compilation job tracking
const compilationJobs = new Map();

// Multer setup for handling video uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
});

// Middleware
app.use(express.json({ limit: "50mb" })); // Increased for base64 music files
app.use(express.static(path.join(__dirname, "public")));

// Trust proxy in production (required for secure cookies behind Railway/Render/etc)
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// Configure session store - Redis for production, FileStore for local dev
const sessionStore =
  redisStore ||
  new FileStore({
    path: path.join(__dirname, "sessions"),
    ttl: 7 * 24 * 60 * 60, // 7 days in seconds
    retries: 0,
  });

app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }),
);

function createOAuthClient(redirectUri) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  );
}

// Helper to get the base URL from request (works behind reverse proxy)
function getBaseUrl(req) {
  const protocol = req.protocol; // 'https' when behind proxy with X-Forwarded-Proto
  const host = req.get("host"); // includes port if non-standard
  return `${protocol}://${host}`;
}

// Global OAuth2 client for per-request operations (will set redirect dynamically)
const oauth2Client = createOAuthClient();

// Helper to create a scoped OAuth client that won't be mutated by other requests
function cloneOAuthClientWithTokens(tokens, redirectUri) {
  const client = createOAuthClient(redirectUri);
  if (tokens) {
    client.setCredentials(tokens);
  }
  return client;
}

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
];

const DRIVE_FOLDER_NAME = "365Moments";

// ============ AUTH ROUTES ============

// Check if user is authenticated
app.get("/api/auth/status", (req, res) => {
  if (req.session.tokens && req.session.user) {
    res.json({
      authenticated: true,
      user: req.session.user,
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Start OAuth flow
app.get("/auth/login", (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/auth/callback`;
  const client = createOAuthClient(redirectUri);

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
  res.redirect(authUrl);
});

// OAuth callback
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect("/?error=no_code");
  }

  try {
    const baseUrl = getBaseUrl(req);
    const redirectUri = `${baseUrl}/auth/callback`;
    const client = createOAuthClient(redirectUri);

    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const { data: user } = await oauth2.userinfo.get();

    // Store in session
    req.session.tokens = tokens;
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      picture: user.picture,
    };

    // Log session storage
    const storeType = redisStore ? "Redis" : "FileStore";
    console.log(
      `[AUTH] User ${user.email} logged in, session stored in ${storeType}`,
    );

    res.redirect("/");
  } catch (error) {
    console.error("Auth callback error:", error);
    res.redirect("/?error=auth_failed");
  }
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Failed to logout" });
    }
    res.json({ success: true });
  });
});

// ============ AUTH MIDDLEWARE ============

function isInvalidGrantError(error) {
  if (!error) return false;
  const directMessage = error.message;
  const responseError = error.response?.data?.error;
  return directMessage === "invalid_grant" || responseError === "invalid_grant";
}

async function requireAuth(req, res, next) {
  if (!req.session.tokens) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const tokens = req.session.tokens;
    oauth2Client.setCredentials(tokens);

    const needsRefresh =
      tokens.expiry_date && tokens.expiry_date <= Date.now() + 60 * 1000; // refresh 1 min early

    if (!needsRefresh) {
      return next();
    }

    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      req.session.tokens = {
        ...tokens,
        ...credentials,
      };
      oauth2Client.setCredentials(req.session.tokens);
      return next();
    } catch (err) {
      if (isInvalidGrantError(err)) {
        console.warn(
          `[AUTH] Refresh token invalid for ${req.session.user?.email}, forcing logout`,
        );
        req.session.destroy(() => {});
        return res.status(401).json({
          error: "Google session expired. Please log in again.",
          requireReauth: true,
        });
      }

      console.error("Token refresh error:", err);
      return res.status(401).json({ error: "Token refresh failed" });
    }
  } catch (err) {
    console.error("Authentication middleware error:", err);
    return res.status(500).json({ error: "Authentication failed" });
  }
}

// Helper to check for permission errors and force re-auth with token revocation
async function handlePermissionError(req, res, error) {
  const isPermissionError =
    error.code === 403 &&
    (error.message?.includes("Insufficient Permission") ||
      error.message?.includes("insufficient authentication scopes"));

  if (isPermissionError) {
    console.log(
      `[AUTH] User ${req.session.user?.email} has insufficient Drive permissions - revoking token`,
    );

    // Try to revoke the token so Google forgets the incomplete permission grant
    if (req.session.tokens?.access_token) {
      try {
        await oauth2Client.revokeToken(req.session.tokens.access_token);
        console.log("[AUTH] Token revoked successfully");
      } catch (revokeErr) {
        console.log(
          "[AUTH] Token revoke failed (may already be invalid):",
          revokeErr.message,
        );
      }
    }

    req.session.destroy(() => {});
    return res.status(403).json({
      error:
        "Drive access not granted. Please log in again and check the Google Drive permission box.",
      requireReauth: true,
    });
  }
  return false; // Not a permission error
}

// ============ DRIVE ROUTES ============

// Get or create app folder
async function getOrCreateFolder(drive) {
  // Search for existing folder
  const searchResponse = await drive.files.list({
    q: `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
  });

  if (searchResponse.data.files.length > 0) {
    return searchResponse.data.files[0].id;
  }

  // Create new folder
  const folderResponse = await drive.files.create({
    requestBody: {
      name: DRIVE_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });

  return folderResponse.data.id;
}

// Helper function to generate thumbnail from video using FFmpeg
async function generateThumbnail(videoPath, thumbnailPath) {
  const { spawn } = require("child_process");

  let ffmpegPath;
  try {
    ffmpegPath = require("ffmpeg-static");
  } catch {
    ffmpegPath = "ffmpeg";
  }

  return new Promise((resolve, reject) => {
    const args = [
      "-i",
      videoPath,
      "-ss",
      "0", // Seek to start (video might be very short)
      "-vframes",
      "1", // Extract 1 frame
      "-vf",
      "scale=320:-1", // Scale to 320px width, maintain aspect ratio
      "-q:v",
      "2", // High quality JPEG
      "-y",
      thumbnailPath,
    ];

    console.log("Generating thumbnail:", thumbnailPath);
    const ffmpegProcess = spawn(ffmpegPath, args);

    ffmpegProcess.stderr.on("data", (data) => {
      // Log errors for debugging
      const output = data.toString();
      if (output.includes("Error") || output.includes("error")) {
        console.log("Thumbnail FFmpeg:", output);
      }
    });

    ffmpegProcess.on("close", (code) => {
      if (code === 0) {
        console.log("Thumbnail generated successfully");
        resolve(true);
      } else {
        console.log("Thumbnail generation failed with code:", code);
        resolve(false); // Don't reject, thumbnails are optional
      }
    });

    ffmpegProcess.on("error", (err) => {
      console.log("Thumbnail generation error:", err.message);
      resolve(false);
    });
  });
}

// Helper function to upload thumbnail to Drive
async function uploadThumbnail(drive, folderId, thumbnailPath, fileName) {
  const fs = require("fs");

  if (!fs.existsSync(thumbnailPath)) {
    return null;
  }

  try {
    const fileStream = fs.createReadStream(thumbnailPath);
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        mimeType: "image/jpeg",
        body: fileStream,
      },
      fields: "id",
    });
    return response.data.id;
  } catch (error) {
    console.error("Failed to upload thumbnail:", error);
    return null;
  }
}

// Get all clips
app.get("/api/clips", requireAuth, async (req, res) => {
  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });
    const folderId = await getOrCreateFolder(drive);

    // Fetch ALL files using pagination (default pageSize is only 100)
    let allFiles = [];
    let pageToken = null;
    do {
      const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "nextPageToken, files(id, name, createdTime, size)",
        orderBy: "name",
        pageSize: 1000,
        pageToken: pageToken || undefined,
      });
      allFiles = allFiles.concat(response.data.files);
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    // Build a map of thumbnail files
    const thumbnailMap = new Map();
    allFiles.forEach((file) => {
      if (file.name.endsWith(".thumb.jpg")) {
        const date = file.name.replace(".thumb.jpg", "");
        thumbnailMap.set(date, file.id);
      }
    });

    // Filter to only daily clips (YYYY-MM-DD.ext format), exclude compilations
    const datePattern = /^\d{4}-\d{2}-\d{2}\.(mp4|webm|jpg|jpeg|png)$/i;
    const clips = allFiles
      .filter((file) => datePattern.test(file.name))
      .map((file) => {
        const dateMatch = file.name.match(/^(\d{4}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : null;
        const thumbId = date ? thumbnailMap.get(date) : null;
        const isImage = /\.(jpg|jpeg|png)$/i.test(file.name);
        return {
          id: file.id,
          name: file.name,
          date: date,
          createdTime: file.createdTime,
          size: file.size,
          thumbnail: thumbId ? `/api/thumbnails/${thumbId}` : null,
          type: isImage ? "image" : "video",
        };
      });

    res.json({ clips, folderId });
  } catch (error) {
    // Check for permission error and force re-auth with token revocation
    const handled = await handlePermissionError(req, res, error);
    if (handled !== false) return;

    console.error("Error fetching clips:", error);
    res.status(500).json({ error: "Failed to fetch clips" });
  }
});

// Serve thumbnail image
app.get("/api/thumbnails/:id", requireAuth, async (req, res) => {
  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    const response = await drive.files.get(
      { fileId: req.params.id, alt: "media" },
      { responseType: "stream" },
    );

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 1 day
    response.data.pipe(res);
  } catch (error) {
    console.error("Error fetching thumbnail:", error);
    res.status(404).send("Thumbnail not found");
  }
});

// Upload a clip (converts to MP4 for better compatibility)
app.post(
  "/api/clips",
  requireAuth,
  upload.single("video"),
  async (req, res) => {
    const userName = req.session.user?.name || "Unknown";
    const userEmail = req.session.user?.email || "Unknown";
    console.log(`[UPLOAD] User: ${userName} (${userEmail}) uploading clip...`);

    if (!req.file) {
      return res.status(400).json({ error: "No video file provided" });
    }

    const { spawn } = require("child_process");
    const fs = require("fs");

    // Get ffmpeg path
    let ffmpegPath;
    try {
      ffmpegPath = require("ffmpeg-static");
    } catch {
      ffmpegPath = "ffmpeg";
    }

    // Create temp directory
    const tempDir = path.join(__dirname, "temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Use unique ID to prevent conflicts between concurrent uploads
    const uniqueId = crypto.randomUUID();
    const inputPath = path.join(tempDir, `input-${uniqueId}.webm`);
    const outputPath = path.join(tempDir, `output-${uniqueId}.mp4`);

    try {
      // Write uploaded file to disk
      fs.writeFileSync(inputPath, req.file.buffer);

      // Convert to MP4 using FFmpeg
      await new Promise((resolve, reject) => {
        const args = [
          "-i",
          inputPath,
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-movflags",
          "+faststart",
          "-y",
          outputPath,
        ];

        console.log("FFmpeg convert command:", ffmpegPath, args.join(" "));
        const ffmpegProcess = spawn(ffmpegPath, args);

        ffmpegProcess.stderr.on("data", (data) => {
          console.log("FFmpeg:", data.toString());
        });

        ffmpegProcess.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exited with code ${code}`));
        });

        ffmpegProcess.on("error", reject);
      });

      const drive = google.drive({ version: "v3", auth: oauth2Client });
      const folderId = await getOrCreateFolder(drive);

      // Use original filename but change extension to .mp4
      const originalName =
        req.body.fileName || `${new Date().toISOString().split("T")[0]}.webm`;
      const fileName = originalName.replace(/\.webm$/, ".mp4");
      const dateStr = fileName.split(".")[0];

      // Generate thumbnail
      const thumbnailPath = path.join(tempDir, `thumb-${uniqueId}.jpg`);
      await generateThumbnail(outputPath, thumbnailPath);

      // Upload video
      const fileStream = fs.createReadStream(outputPath);
      const response = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [folderId],
        },
        media: {
          mimeType: "video/mp4",
          body: fileStream,
        },
        fields: "id, name, createdTime",
      });

      // Upload thumbnail
      await uploadThumbnail(
        drive,
        folderId,
        thumbnailPath,
        `${dateStr}.thumb.jpg`,
      );

      // Cleanup temp files
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
      if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);

      res.json({
        success: true,
        file: {
          id: response.data.id,
          name: response.data.name,
          date: dateStr,
          createdTime: response.data.createdTime,
        },
      });
    } catch (error) {
      // Check for permission error and force re-auth with token revocation
      const handled = await handlePermissionError(req, res, error);
      if (handled !== false) return;

      console.error("Error uploading clip:", error);
      // Cleanup on error
      try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch {}
      res.status(500).json({ error: "Failed to upload clip" });
    }
  },
);

// Get a specific clip video
// Get video file for playback
app.get("/api/clips/:id/video", requireAuth, async (req, res) => {
  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    // Get file metadata to determine content type
    const metaResponse = await drive.files.get({
      fileId: req.params.id,
      fields: "name, mimeType",
    });

    const response = await drive.files.get(
      { fileId: req.params.id, alt: "media" },
      { responseType: "stream" },
    );

    // Set content type based on file extension or mimeType
    const contentType =
      metaResponse.data.mimeType ||
      (metaResponse.data.name?.endsWith(".mp4") ? "video/mp4" : "video/webm");
    res.setHeader("Content-Type", contentType);
    response.data.pipe(res);
  } catch (error) {
    console.error("Error fetching video:", error);
    res.status(500).json({ error: "Failed to fetch video" });
  }
});

// Delete a clip (and its thumbnail)
app.delete("/api/clips/:id", requireAuth, async (req, res) => {
  const userName = req.session.user?.name || "Unknown";
  const userEmail = req.session.user?.email || "Unknown";
  console.log(
    `[DELETE] User: ${userName} (${userEmail}) deleting clip ${req.params.id}...`,
  );

  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    // Get file info to find associated thumbnail
    const fileInfo = await drive.files.get({
      fileId: req.params.id,
      fields: "name, parents",
    });

    const fileName = fileInfo.data.name;
    console.log(`[DELETE] User: ${userName} deleting file: ${fileName}`);
    const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})/);

    // Delete the video
    await drive.files.delete({ fileId: req.params.id });

    // Try to delete associated thumbnail
    if (dateMatch && fileInfo.data.parents?.[0]) {
      const folderId = fileInfo.data.parents[0];
      const thumbName = `${dateMatch[1]}.thumb.jpg`;

      try {
        const thumbSearch = await drive.files.list({
          q: `'${folderId}' in parents and name='${thumbName}' and trashed=false`,
          fields: "files(id)",
        });

        if (thumbSearch.data.files?.length > 0) {
          await drive.files.delete({ fileId: thumbSearch.data.files[0].id });
        }
      } catch (thumbError) {
        console.log("Thumbnail not found or already deleted");
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting clip:", error);
    res.status(500).json({ error: "Failed to delete clip" });
  }
});

// ============ UPLOAD & TRIM ROUTE ============

// Upload a video or image and process it
app.post(
  "/api/clips/upload-trim",
  requireAuth,
  upload.single("video"),
  async (req, res) => {
    const userName = req.session.user?.name || "Unknown";
    const userEmail = req.session.user?.email || "Unknown";

    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    const isImage = req.file.mimetype.startsWith("image/");
    console.log(
      `[UPLOAD-TRIM] User: ${userName} (${userEmail}) uploading ${
        isImage ? "image" : "video"
      }...`,
    );

    const { spawn } = require("child_process");
    const fs = require("fs");
    const path = require("path");

    // Get ffmpeg path
    let ffmpegPath;
    try {
      ffmpegPath = require("ffmpeg-static");
    } catch {
      ffmpegPath = "ffmpeg";
    }

    const targetDate = req.body.date || new Date().toISOString().split("T")[0];
    const startTime = parseFloat(req.body.startTime) || 0;

    // Create temp directory
    const tempDir = path.join(__dirname, "temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      const drive = google.drive({ version: "v3", auth: oauth2Client });
      const folderId = await getOrCreateFolder(drive);

      // Use unique ID to prevent conflicts between concurrent uploads
      const uniqueId = crypto.randomUUID();

      if (isImage) {
        // Handle image upload - store as-is for compilation later
        const imageExt = req.file.mimetype.includes("png") ? ".png" : ".jpg";
        const imagePath = path.join(tempDir, `image-${uniqueId}${imageExt}`);

        // Write uploaded image to disk
        fs.writeFileSync(imagePath, req.file.buffer);

        // Upload image directly to Drive
        const fileName = `${targetDate}${imageExt}`;
        const fileStream = fs.createReadStream(imagePath);

        const response = await drive.files.create({
          requestBody: {
            name: fileName,
            parents: [folderId],
          },
          media: {
            mimeType: req.file.mimetype,
            body: fileStream,
          },
          fields: "id, name, createdTime",
        });

        // Generate thumbnail from image (resize it)
        const thumbnailPath = path.join(tempDir, `thumb-${uniqueId}.jpg`);
        await new Promise((resolve, reject) => {
          const args = [
            "-i",
            imagePath,
            "-vf",
            "scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2",
            "-y",
            thumbnailPath,
          ];
          const ffmpegProcess = spawn(ffmpegPath, args);
          ffmpegProcess.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Thumbnail failed with code ${code}`));
          });
          ffmpegProcess.on("error", reject);
        });

        await uploadThumbnail(
          drive,
          folderId,
          thumbnailPath,
          `${targetDate}.thumb.jpg`,
        );

        // Cleanup temp files
        try {
          fs.unlinkSync(imagePath);
          fs.unlinkSync(thumbnailPath);
        } catch (e) {}

        res.json({
          success: true,
          clip: {
            id: response.data.id,
            name: response.data.name,
            date: targetDate,
            type: "image",
          },
        });
      } else {
        // Handle video upload - trim to 1 second
        const inputExt = req.file.mimetype.includes("mp4") ? ".mp4" : ".webm";
        const inputPath = path.join(tempDir, `input-${uniqueId}${inputExt}`);
        const outputPath = path.join(tempDir, `output-${uniqueId}.mp4`);

        // Write uploaded file to disk
        fs.writeFileSync(inputPath, req.file.buffer);

        // Trim to 1 second and convert to MP4 using FFmpeg
        await new Promise((resolve, reject) => {
          // Use filter-based trimming for reliable handling of VFR videos
          const trimStart = startTime;
          const trimEnd = startTime + 1;

          const args = [
            "-i",
            inputPath,
            "-vf",
            `trim=start=${trimStart}:end=${trimEnd},setpts=PTS-STARTPTS`,
            "-af",
            `atrim=start=${trimStart}:end=${trimEnd},asetpts=PTS-STARTPTS`,
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "-y",
            outputPath,
          ];

          console.log("FFmpeg trim command:", ffmpegPath, args.join(" "));

          const ffmpegProcess = spawn(ffmpegPath, args);

          // Timeout after 120 seconds for large/HEVC videos
          const timeout = setTimeout(() => {
            ffmpegProcess.kill("SIGKILL");
            reject(new Error("FFmpeg timed out after 120 seconds"));
          }, 120000);

          ffmpegProcess.stderr.on("data", (data) => {
            console.log("FFmpeg:", data.toString());
          });

          ffmpegProcess.on("close", (code) => {
            clearTimeout(timeout);
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`FFmpeg exited with code ${code}`));
            }
          });

          ffmpegProcess.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        // Upload trimmed video to Drive
        const fileName = `${targetDate}.mp4`;
        const fileStream = fs.createReadStream(outputPath);

        const response = await drive.files.create({
          requestBody: {
            name: fileName,
            parents: [folderId],
          },
          media: {
            mimeType: "video/mp4",
            body: fileStream,
          },
          fields: "id, name, createdTime",
        });

        // Generate and upload thumbnail
        const thumbnailPath = path.join(tempDir, `thumb-${uniqueId}.jpg`);
        await generateThumbnail(outputPath, thumbnailPath);
        await uploadThumbnail(
          drive,
          folderId,
          thumbnailPath,
          `${targetDate}.thumb.jpg`,
        );

        // Cleanup temp files
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
        if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);

        res.json({
          success: true,
          file: {
            id: response.data.id,
            name: response.data.name,
            date: targetDate,
            createdTime: response.data.createdTime,
          },
        });
      }
    } catch (error) {
      console.error("Error processing upload:", error);
      res
        .status(500)
        .json({ error: "Failed to process file: " + error.message });
    }
  },
);

// ============ COMPILATION ROUTE ============

const VideoCompiler = require("./compiler");

// List all compilations
app.get("/api/compilations", requireAuth, async (req, res) => {
  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });
    const folderId = await getOrCreateFolder(drive);

    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and name contains '365moments' and mimeType contains 'video/'`,
      fields: "files(id, name, createdTime, size)",
      orderBy: "createdTime desc",
    });

    // Filter to only compilation files (not daily clips which are YYYY-MM-DD.mp4)
    const datePattern = /^\d{4}-\d{2}-\d{2}\.(mp4|webm)$/;
    const compilations = (response.data.files || [])
      .filter((file) => !datePattern.test(file.name))
      .map((file) => ({
        id: file.id,
        name: file.name,
        createdAt: file.createdTime,
        size: file.size
          ? Math.round(parseInt(file.size) / 1024 / 1024) + " MB"
          : "Unknown",
      }));

    res.json({ compilations });
  } catch (error) {
    console.error("Error fetching compilations:", error);
    res.status(500).json({ error: "Failed to fetch compilations" });
  }
});

// Download/stream a compilation
app.get("/api/compilations/:id", requireAuth, async (req, res) => {
  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    // Get file metadata
    const fileInfo = await drive.files.get({
      fileId: req.params.id,
      fields: "name, mimeType, size",
    });

    res.setHeader("Content-Type", fileInfo.data.mimeType || "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${fileInfo.data.name}"`,
    );
    if (fileInfo.data.size) {
      res.setHeader("Content-Length", fileInfo.data.size);
    }

    const response = await drive.files.get(
      { fileId: req.params.id, alt: "media" },
      { responseType: "stream" },
    );

    response.data.pipe(res);
  } catch (error) {
    console.error("Error streaming compilation:", error);
    res.status(500).json({ error: "Failed to stream compilation" });
  }
});

// Delete a compilation
app.delete("/api/compilations/:id", requireAuth, async (req, res) => {
  const userName = req.session.user?.name || "Unknown";
  const userEmail = req.session.user?.email || "Unknown";
  console.log(
    `[DELETE-COMPILATION] User: ${userName} (${userEmail}) deleting compilation ${req.params.id}...`,
  );

  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });
    await drive.files.delete({ fileId: req.params.id });
    console.log(
      `[DELETE-COMPILATION] User: ${userName} successfully deleted compilation`,
    );
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting compilation:", error);
    res.status(500).json({ error: "Failed to delete compilation" });
  }
});

app.post("/api/compile", requireAuth, async (req, res) => {
  const userName = req.session.user?.name || "Unknown";
  const userEmail = req.session.user?.email || "Unknown";
  console.log(
    `[COMPILE] User: ${userName} (${userEmail}) starting compilation...`,
  );

  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });
    const folderId = await getOrCreateFolder(drive);
    const { startDate, endDate, musicData } = req.body; // musicData is base64 encoded MP3
    const userId = req.session.user?.email || req.session.id; // Use email or session ID for unique job tracking

    // Check if already compiling
    const existingJob = compilationJobs.get(userId);
    if (existingJob && existingJob.status === "compiling") {
      return res.json({
        success: false,
        message: "A compilation is already in progress",
        status: "already_compiling",
        jobId: existingJob.id,
      });
    }

    // Check if FFmpeg is available (bundled or system)
    let ffmpegAvailable = false;
    try {
      require("ffmpeg-static");
      ffmpegAvailable = true;
    } catch {
      const { execSync } = require("child_process");
      try {
        execSync("ffmpeg -version", { stdio: "ignore" });
        ffmpegAvailable = true;
      } catch {
        // FFmpeg not found
      }
    }

    if (!ffmpegAvailable) {
      return res.json({
        success: false,
        message: "FFmpeg is not available. Run: npm install ffmpeg-static",
        status: "ffmpeg_missing",
      });
    }

    // Create job with unique ID
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      status: "compiling",
      progress: "Starting...",
      startDate,
      endDate,
      startedAt: new Date().toISOString(),
      clipCount: 0,
      error: null,
      result: null,
    };
    compilationJobs.set(userId, job);

    // Return immediately - compilation runs in background
    res.json({
      success: true,
      message: "Compilation started",
      status: "started",
      jobId,
    });

    // Run compilation in background
    const scopedOauthClient = cloneOAuthClientWithTokens(req.session.tokens);
    const compiler = new VideoCompiler(scopedOauthClient);

    // Log music data status
    if (musicData) {
      console.log(`[COMPILE] Music data received: ${musicData.length} bytes`);
    } else {
      console.log("[COMPILE] No music data provided");
    }

    try {
      job.progress = "Fetching clips...";
      const result = await compiler.compile(
        folderId,
        startDate,
        endDate,
        (progress) => {
          job.progress = progress;
        },
        musicData, // Pass music data (base64) to compiler
      );

      job.status = "complete";
      job.progress = "Done!";
      job.result = result;
      job.clipCount = result.clipCount;
      job.completedAt = new Date().toISOString();
    } catch (error) {
      console.error("Compilation error:", error);
      job.status = "error";
      job.error = error.message;
      job.progress = "Failed";
    }
  } catch (error) {
    console.error("Compilation error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Compilation failed",
      status: "error",
    });
  }
});

// Get compilation status
app.get("/api/compile/status", requireAuth, (req, res) => {
  const userId = req.session.user?.email || req.session.id;
  const job = compilationJobs.get(userId);

  if (!job) {
    return res.json({ status: "idle", message: "No compilation in progress" });
  }

  res.json({
    status: job.status,
    progress: job.progress,
    startDate: job.startDate,
    endDate: job.endDate,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    clipCount: job.clipCount,
    error: job.error,
    result: job.result,
  });
});

// Clear compilation status
app.delete("/api/compile/status", requireAuth, (req, res) => {
  const userId = req.session.user?.email || req.session.id;
  compilationJobs.delete(userId);
  res.json({ success: true });
});

// ============ SERVE FRONTEND ============

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============ START SERVER ============

app.listen(PORT, () => {
  console.log(`🎬 365 Moments server running at http://localhost:${PORT}`);
  console.log(
    `📁 Videos will be saved to Google Drive folder: ${DRIVE_FOLDER_NAME}`,
  );
});
