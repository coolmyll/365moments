require("dotenv").config();
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { google } = require("googleapis");
const { CompilationJobStore } = require("./compilation-job-store");
const {
  getRequestLogContext,
  logError,
  logInfo,
  logWarn,
  requestContextMiddleware,
  retryAsync,
  serializeError,
} = require("./backend-utils");

const nativeAuthTokens = new Map();

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
    logWarn("redis.client.error", { message: err.message }),
  );

  // Connect synchronously before app starts
  redisClient
    .connect()
    .then(() => {
      logInfo("redis.connected");
    })
    .catch((err) => {
      logError("redis.connection_failed", { message: err.message });
    });

  redisStore = new RedisStore({ client: redisClient, prefix: "365m:" });
  logInfo("session.store.selected", { store: "redis" });
} else {
  logInfo("session.store.selected", { store: "file" });
}

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, "temp");
const NATIVE_AUTH_TOKEN_TTL_MS = 60 * 1000;
const COMPILATION_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_COMPILATION_STALE_MS = 2 * 60 * 60 * 1000;
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const VALID_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TRIM_START_SECONDS = 24 * 60 * 60;
const MAX_MUSIC_DATA_URL_LENGTH = 30 * 1024 * 1024;
const TEMP_ENTRY_PATTERN = /^(?:input|output|thumb|image)-|^session-/;
const VIDEO_UPLOAD_MIME_TYPES = new Map([
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"],
]);
const IMAGE_UPLOAD_MIME_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
]);
const ALLOWED_AUDIO_DATA_URL_PATTERN = /^data:audio\/(?:mpeg|mp3);base64,/i;

// Compilation job tracking
const compilationJobs = new CompilationJobStore(
  path.join(TEMP_DIR, "compilation-jobs.json"),
);

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function isValidDateString(value) {
  if (typeof value !== "string" || !VALID_DATE_PATTERN.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function normalizeClipFileName(fileName) {
  if (typeof fileName !== "string" || !fileName.trim()) {
    return null;
  }

  const normalized = path.basename(fileName.trim());
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})(?:\.[A-Za-z0-9]+)?$/);
  if (!match || !isValidDateString(match[1])) {
    return null;
  }

  return `${match[1]}.mp4`;
}

function parseStartTime(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return { value: 0 };
  }

  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed)) {
    return { error: "startTime must be a finite number" };
  }

  if (parsed < 0 || parsed > MAX_TRIM_START_SECONDS) {
    return {
      error: `startTime must be between 0 and ${MAX_TRIM_START_SECONDS} seconds`,
    };
  }

  return { value: parsed };
}

function validateCompileRequest(body = {}) {
  const startDate = body.startDate ?? null;
  const endDate = body.endDate ?? null;
  const musicData = body.musicData ?? null;

  if ((startDate && !endDate) || (!startDate && endDate)) {
    return { error: "startDate and endDate must be provided together" };
  }

  if (startDate && !isValidDateString(startDate)) {
    return { error: "startDate must be a valid YYYY-MM-DD date" };
  }

  if (endDate && !isValidDateString(endDate)) {
    return { error: "endDate must be a valid YYYY-MM-DD date" };
  }

  if (startDate && endDate && startDate > endDate) {
    return { error: "startDate must be before or equal to endDate" };
  }

  if (musicData !== null) {
    if (typeof musicData !== "string" || !musicData.trim()) {
      return { error: "musicData must be a non-empty base64 data URL" };
    }

    if (!ALLOWED_AUDIO_DATA_URL_PATTERN.test(musicData)) {
      return { error: "musicData must be an MP3 data URL" };
    }

    if (musicData.length > MAX_MUSIC_DATA_URL_LENGTH) {
      return { error: "musicData is too large" };
    }
  }

  return {
    startDate,
    endDate,
    musicData,
  };
}

function getUploadExtension(mimeType, allowImages = false) {
  if (VIDEO_UPLOAD_MIME_TYPES.has(mimeType)) {
    return VIDEO_UPLOAD_MIME_TYPES.get(mimeType);
  }

  if (allowImages && IMAGE_UPLOAD_MIME_TYPES.has(mimeType)) {
    return IMAGE_UPLOAD_MIME_TYPES.get(mimeType);
  }

  return null;
}

function getJobTimestamp(job, fieldName) {
  const value = job?.[fieldName] ? Date.parse(job[fieldName]) : Number.NaN;
  return Number.isNaN(value) ? null : value;
}

function isCompilationJobExpired(job, now = Date.now()) {
  if (!job) return true;

  const completedAt = getJobTimestamp(job, "completedAt");
  if (completedAt) {
    return completedAt <= now - COMPILATION_JOB_TTL_MS;
  }

  const startedAt = getJobTimestamp(job, "startedAt");
  if (!startedAt) {
    return true;
  }

  return startedAt <= now - ACTIVE_COMPILATION_STALE_MS;
}

function sweepExpiredNativeAuthTokens(now = Date.now()) {
  for (const [token, entry] of nativeAuthTokens.entries()) {
    if (!entry?.expiresAt || entry.expiresAt <= now) {
      nativeAuthTokens.delete(token);
    }
  }
}

function sweepExpiredCompilationJobs(now = Date.now()) {
  for (const [userId, job] of compilationJobs.entries()) {
    if (isCompilationJobExpired(job, now)) {
      compilationJobs.delete(userId);
    }
  }
}

function sweepStaleTempEntries(now = Date.now()) {
  ensureTempDir();

  for (const entry of fs.readdirSync(TEMP_DIR, { withFileTypes: true })) {
    if (!TEMP_ENTRY_PATTERN.test(entry.name)) {
      continue;
    }

    const entryPath = path.join(TEMP_DIR, entry.name);

    try {
      const stats = fs.statSync(entryPath);
      if (now - stats.mtimeMs <= TEMP_FILE_MAX_AGE_MS) {
        continue;
      }

      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch (error) {
      logWarn("cleanup.temp_entry_remove_failed", {
        entryName: entry.name,
        error: serializeError(error),
      });
    }
  }
}

function startCleanupTasks() {
  sweepExpiredNativeAuthTokens();
  sweepExpiredCompilationJobs();
  sweepStaleTempEntries();

  const interval = setInterval(() => {
    const now = Date.now();
    sweepExpiredNativeAuthTokens(now);
    sweepExpiredCompilationJobs(now);
    sweepStaleTempEntries(now);
  }, CLEANUP_INTERVAL_MS);

  if (typeof interval.unref === "function") {
    interval.unref();
  }
}

startCleanupTasks();

// Multer setup for handling video uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
});

// Middleware
app.use(express.json({ limit: "50mb" })); // Increased for base64 music files
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html") || filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  }),
);

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
    name: "moments365.sid",
    store: sessionStore,
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }),
);

app.use(requestContextMiddleware);

function buildLogContext(req, extra = {}) {
  return getRequestLogContext(req, extra);
}

function getDriveLogContext(req, operation, extra = {}) {
  return buildLogContext(req, {
    service: "google.drive",
    operation,
    ...extra,
  });
}

function withDriveRetry(req, operation, work, extra = {}) {
  return retryAsync(work, {
    label: `google.drive.${operation}`,
    context: getDriveLogContext(req, operation, extra),
  });
}

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
    state: req.query.from === "app" ? "app" : "web",
  });
  res.redirect(authUrl);
});

// OAuth callback
app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;

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
    logInfo("auth.login.success", {
      requestId: req.requestId,
      userId: user.email,
      store: storeType,
      mode: state === "app" ? "app" : "web",
    });

    req.session.save((err) => {
      if (err) {
        logError("auth.session_save_failed", {
          requestId: req.requestId,
          userId: user.email,
          error: serializeError(err),
        });
        return res.redirect("/?error=auth_failed");
      }

      logInfo("auth.callback.completed", {
        requestId: req.requestId,
        userId: user.email,
        state,
      });

      if (state !== "app") {
        return res.redirect("/");
      }

      const token = crypto.randomUUID();
      nativeAuthTokens.set(token, {
        tokens,
        user: req.session.user,
        expiresAt: Date.now() + NATIVE_AUTH_TOKEN_TTL_MS,
      });

      const deepLink = `moments365://auth/callback?token=${encodeURIComponent(token)}`;
      logInfo("auth.deep_link.created", {
        requestId: req.requestId,
        userId: user.email,
      });

      res.redirect(deepLink);
    });
  } catch (error) {
    logError("auth.callback.failed", {
      requestId: req.requestId,
      error: serializeError(error),
    });
    res.redirect("/?error=auth_failed");
  }
});

// ============ NATIVE APP AUTH (Capacitor) ============

// Backward-compatible alias for older native builds.
app.get("/auth/login-native", (req, res) => {
  res.redirect("/auth/login?from=app");
});

// Legacy callback route kept for compatibility with previously generated URLs.
app.get("/auth/callback-native", async (req, res) => {
  const query = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
    : "";
  res.redirect(`/auth/callback${query}`);
});

function handleNativeTokenExchange(req, res) {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: "Missing token" });
  }

  sweepExpiredNativeAuthTokens();
  const entry = nativeAuthTokens.get(token);
  if (!entry || Date.now() > entry.expiresAt) {
    nativeAuthTokens.delete(token);
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  nativeAuthTokens.delete(token);

  req.session.tokens = entry.tokens;
  req.session.user = entry.user;

  req.session.save((err) => {
    if (err) {
      logError("auth.token_exchange.session_failed", {
        requestId: req.requestId,
        error: serializeError(err),
      });
      return res.status(500).json({ error: "Session creation failed" });
    }

    logInfo("auth.token_exchange.success", {
      requestId: req.requestId,
      userId: entry.user.email,
    });
    res.json({ success: true, user: entry.user });
  });
}

app.get("/auth/token-exchange", handleNativeTokenExchange);
app.get("/auth/token-exchange-native", handleNativeTokenExchange);

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
        logWarn("auth.refresh.invalid_grant", buildLogContext(req));
        req.session.destroy(() => {});
        return res.status(401).json({
          error: "Google session expired. Please log in again.",
          requireReauth: true,
        });
      }

      logError("auth.refresh.failed", {
        ...buildLogContext(req),
        error: serializeError(err),
      });
      req.session.destroy(() => {});
      return res.status(401).json({
        error: "Token refresh failed. Please log in again.",
        requireReauth: true,
      });
    }
  } catch (err) {
    logError("auth.middleware.failed", {
      ...buildLogContext(req),
      error: serializeError(err),
    });
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
    logWarn("auth.drive_permission_missing", buildLogContext(req));

    // Try to revoke the token so Google forgets the incomplete permission grant
    if (req.session.tokens?.access_token) {
      try {
        await oauth2Client.revokeToken(req.session.tokens.access_token);
        logInfo("auth.token_revoked", buildLogContext(req));
      } catch (revokeErr) {
        logWarn("auth.token_revoke_failed", {
          ...buildLogContext(req),
          error: serializeError(revokeErr),
        });
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
  const searchResponse = await retryAsync(
    () =>
      drive.files.list({
        q: `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id, name)",
      }),
    {
      label: "google.drive.folder.lookup",
      context: { folderName: DRIVE_FOLDER_NAME },
    },
  );

  if (searchResponse.data.files.length > 0) {
    return searchResponse.data.files[0].id;
  }

  // Create new folder
  const folderResponse = await retryAsync(
    () =>
      drive.files.create({
        requestBody: {
          name: DRIVE_FOLDER_NAME,
          mimeType: "application/vnd.google-apps.folder",
        },
        fields: "id",
      }),
    {
      label: "google.drive.folder.create",
      context: { folderName: DRIVE_FOLDER_NAME },
    },
  );

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

    logInfo("thumbnail.generate.started", { thumbnailPath });
    const ffmpegProcess = spawn(ffmpegPath, args);

    ffmpegProcess.stderr.on("data", (data) => {
      // Log errors for debugging
      const output = data.toString();
      if (output.includes("Error") || output.includes("error")) {
        logWarn("thumbnail.generate.ffmpeg_message", {
          thumbnailPath,
          output: output.trim(),
        });
      }
    });

    ffmpegProcess.on("close", (code) => {
      if (code === 0) {
        logInfo("thumbnail.generate.completed", { thumbnailPath });
        resolve(true);
      } else {
        logWarn("thumbnail.generate.failed", { thumbnailPath, code });
        resolve(false); // Don't reject, thumbnails are optional
      }
    });

    ffmpegProcess.on("error", (err) => {
      logWarn("thumbnail.generate.process_error", {
        thumbnailPath,
        error: serializeError(err),
      });
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
    const response = await retryAsync(
      () => {
        const retryStream = fs.createReadStream(thumbnailPath);
        return drive.files.create({
          requestBody: {
            name: fileName,
            parents: [folderId],
          },
          media: {
            mimeType: "image/jpeg",
            body: retryStream,
          },
          fields: "id",
        });
      },
      {
        label: "google.drive.thumbnail.create",
        context: { folderId, fileName },
      },
    );
    return response.data.id;
  } catch (error) {
    logError("drive.thumbnail_upload.failed", {
      folderId,
      fileName,
      error: serializeError(error),
    });
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
      const response = await withDriveRetry(
        req,
        "clips.list",
        () =>
          drive.files.list({
            q: `'${folderId}' in parents and trashed=false`,
            fields: "nextPageToken, files(id, name, createdTime, size)",
            orderBy: "name",
            pageSize: 1000,
            pageToken: pageToken || undefined,
          }),
        { folderId },
      );
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

    logError("clips.fetch.failed", {
      ...buildLogContext(req),
      error: serializeError(error),
    });
    res.status(500).json({ error: "Failed to fetch clips" });
  }
});

// Serve thumbnail image
app.get("/api/thumbnails/:id", requireAuth, async (req, res) => {
  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    const response = await withDriveRetry(
      req,
      "thumbnails.get",
      () =>
        drive.files.get(
          { fileId: req.params.id, alt: "media" },
          { responseType: "stream" },
        ),
      { fileId: req.params.id },
    );

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 1 day
    response.data.pipe(res);
  } catch (error) {
    logError("thumbnails.fetch.failed", {
      ...buildLogContext(req, { fileId: req.params.id }),
      error: serializeError(error),
    });
    res.status(404).send("Thumbnail not found");
  }
});

// Probe whether a file is already H.264 MP4 (skips FFmpeg conversion)
function probeIsH264Mp4(filePath) {
  const { spawnSync } = require("child_process");
  let ffprobePath;
  try {
    // ffmpeg-static ships ffprobe alongside ffmpeg in newer versions
    ffprobePath = require("ffmpeg-static").replace(/ffmpeg/, "ffprobe");
    const fs = require("fs");
    if (!fs.existsSync(ffprobePath)) ffprobePath = "ffprobe";
  } catch {
    ffprobePath = "ffprobe";
  }

  try {
    const result = spawnSync(
      ffprobePath,
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        filePath,
      ],
      { timeout: 10000 },
    );

    if (result.status !== 0) return false;

    const info = JSON.parse(result.stdout.toString());
    const videoStream = (info.streams || []).find(
      (s) => s.codec_type === "video",
    );
    const isH264 = videoStream && videoStream.codec_name === "h264";
    const isMp4 = info.format && /mp4|mov/.test(info.format.format_name);
    return isH264 && isMp4;
  } catch {
    return false;
  }
}

// Upload a clip (skips conversion if already H.264 MP4, otherwise converts)
app.post(
  "/api/clips",
  requireAuth,
  upload.single("video"),
  async (req, res) => {
    const userName = req.session.user?.name || "Unknown";
    const userEmail = req.session.user?.email || "Unknown";
    logInfo("clips.upload.started", {
      ...buildLogContext(req),
      userName,
      userId: userEmail,
    });

    if (!req.file) {
      return res.status(400).json({ error: "No video file provided" });
    }

    const normalizedFileName = normalizeClipFileName(
      req.body.fileName || `${new Date().toISOString().split("T")[0]}.webm`,
    );
    if (!normalizedFileName) {
      return res.status(400).json({
        error: "fileName must use a valid YYYY-MM-DD-based name",
      });
    }

    const inputExt = getUploadExtension(req.file.mimetype);
    if (!inputExt) {
      return res.status(415).json({
        error: "Unsupported upload type. Use MP4, WebM, or MOV video files.",
      });
    }

    const { spawn } = require("child_process");

    // Get ffmpeg path
    let ffmpegPath;
    try {
      ffmpegPath = require("ffmpeg-static");
    } catch {
      ffmpegPath = "ffmpeg";
    }

    ensureTempDir();

    // Use unique ID to prevent conflicts between concurrent uploads
    const uniqueId = crypto.randomUUID();
    const isUploadMp4 = req.file.mimetype === "video/mp4";
    const captureSource =
      typeof req.body.captureSource === "string"
        ? req.body.captureSource
        : null;
    const captureOrientation =
      req.body.captureOrientation === "portrait" ||
      req.body.captureOrientation === "landscape"
        ? req.body.captureOrientation
        : null;
    const normalizeNativeAndroidUpload = captureSource === "native-android";
    const inputPath = path.join(TEMP_DIR, `input-${uniqueId}${inputExt}`);
    const outputPath = path.join(TEMP_DIR, `output-${uniqueId}.mp4`);

    try {
      // Write uploaded file to disk
      fs.writeFileSync(inputPath, req.file.buffer);

      // Check if already H.264 MP4 — skip conversion if so
      const alreadyMp4 =
        isUploadMp4 &&
        probeIsH264Mp4(inputPath) &&
        !normalizeNativeAndroidUpload;

      const finalVideoPath = alreadyMp4 ? inputPath : outputPath;

      if (alreadyMp4) {
        logInfo("clips.upload.skipped_conversion", {
          ...buildLogContext(req, { userId: userEmail, userName }),
          inputPath,
        });
      } else {
        // Convert to MP4 using FFmpeg
        await new Promise((resolve, reject) => {
          const args = ["-i", inputPath];

          args.push(
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
          );

          logInfo("clips.upload.ffmpeg.started", {
            ...buildLogContext(req, {
              userId: userEmail,
              userName,
              captureSource,
              captureOrientation,
              normalizeNativeAndroidUpload,
            }),
            ffmpegPath,
          });
          const ffmpegProcess = spawn(ffmpegPath, args);

          ffmpegProcess.stderr.on("data", (data) => {
            logInfo("clips.upload.ffmpeg.output", {
              ...buildLogContext(req, { userId: userEmail }),
              output: data.toString().trim(),
            });
          });

          ffmpegProcess.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg exited with code ${code}`));
          });

          ffmpegProcess.on("error", reject);
        });
      }

      const drive = google.drive({ version: "v3", auth: oauth2Client });
      const folderId = await getOrCreateFolder(drive);

      const fileName = normalizedFileName;
      const dateStr = fileName.split(".")[0];

      // Generate thumbnail
      const thumbnailPath = path.join(TEMP_DIR, `thumb-${uniqueId}.jpg`);
      await generateThumbnail(finalVideoPath, thumbnailPath);

      // Upload video
      const fileStream = fs.createReadStream(finalVideoPath);
      const response = await withDriveRetry(
        req,
        "clips.create",
        () => {
          const retryStream = fs.createReadStream(finalVideoPath);
          return drive.files.create({
            requestBody: {
              name: fileName,
              parents: [folderId],
            },
            media: {
              mimeType: "video/mp4",
              body: retryStream,
            },
            fields: "id, name, createdTime",
          });
        },
        { folderId, fileName },
      );

      // Upload thumbnail
      await uploadThumbnail(
        drive,
        folderId,
        thumbnailPath,
        `${dateStr}.thumb.jpg`,
      );

      // Cleanup temp files
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (!alreadyMp4 && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
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

      logError("clips.upload.failed", {
        ...buildLogContext(req, { userName, userId: userEmail }),
        error: serializeError(error),
      });
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
    const metaResponse = await withDriveRetry(
      req,
      "clips.meta.get",
      () =>
        drive.files.get({
          fileId: req.params.id,
          fields: "name, mimeType",
        }),
      { fileId: req.params.id },
    );

    const response = await withDriveRetry(
      req,
      "clips.video.get",
      () =>
        drive.files.get(
          { fileId: req.params.id, alt: "media" },
          { responseType: "stream" },
        ),
      { fileId: req.params.id },
    );

    // Set content type based on file extension or mimeType
    const contentType =
      metaResponse.data.mimeType ||
      (metaResponse.data.name?.endsWith(".mp4") ? "video/mp4" : "video/webm");
    res.setHeader("Content-Type", contentType);
    response.data.pipe(res);
  } catch (error) {
    logError("clips.video_fetch.failed", {
      ...buildLogContext(req, { fileId: req.params.id }),
      error: serializeError(error),
    });
    res.status(500).json({ error: "Failed to fetch video" });
  }
});

// Delete a clip (and its thumbnail)
app.delete("/api/clips/:id", requireAuth, async (req, res) => {
  const userName = req.session.user?.name || "Unknown";
  const userEmail = req.session.user?.email || "Unknown";
  logInfo("clips.delete.started", {
    ...buildLogContext(req, {
      fileId: req.params.id,
      userName,
      userId: userEmail,
    }),
  });

  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    // Get file info to find associated thumbnail
    const fileInfo = await withDriveRetry(
      req,
      "clips.delete.meta",
      () =>
        drive.files.get({
          fileId: req.params.id,
          fields: "name, parents",
        }),
      { fileId: req.params.id },
    );

    const fileName = fileInfo.data.name;
    logInfo("clips.delete.target_resolved", {
      ...buildLogContext(req, {
        fileId: req.params.id,
        fileName,
        userId: userEmail,
      }),
    });
    const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})/);

    // Delete the video
    await withDriveRetry(
      req,
      "clips.delete.file",
      () => drive.files.delete({ fileId: req.params.id }),
      { fileId: req.params.id },
    );

    // Try to delete associated thumbnail
    if (dateMatch && fileInfo.data.parents?.[0]) {
      const folderId = fileInfo.data.parents[0];
      const thumbName = `${dateMatch[1]}.thumb.jpg`;

      try {
        const thumbSearch = await withDriveRetry(
          req,
          "clips.delete.thumbnail_lookup",
          () =>
            drive.files.list({
              q: `'${folderId}' in parents and name='${thumbName}' and trashed=false`,
              fields: "files(id)",
            }),
          { folderId, thumbName },
        );

        if (thumbSearch.data.files?.length > 0) {
          await withDriveRetry(
            req,
            "clips.delete.thumbnail",
            () => drive.files.delete({ fileId: thumbSearch.data.files[0].id }),
            { fileId: thumbSearch.data.files[0].id },
          );
        }
      } catch (thumbError) {
        logWarn("clips.delete.thumbnail_missing", {
          ...buildLogContext(req, { fileId: req.params.id, thumbName }),
          error: serializeError(thumbError),
        });
      }
    }

    res.json({ success: true });
  } catch (error) {
    logError("clips.delete.failed", {
      ...buildLogContext(req, { fileId: req.params.id, userId: userEmail }),
      error: serializeError(error),
    });
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

    const inputExt = getUploadExtension(req.file.mimetype, true);
    if (!inputExt) {
      return res.status(415).json({
        error: "Unsupported file type. Use MP4, WebM, MOV, JPG, or PNG.",
      });
    }

    const isImage = req.file.mimetype.startsWith("image/");
    logInfo("clips.trim_upload.started", {
      ...buildLogContext(req, {
        userName,
        userId: userEmail,
        mediaType: isImage ? "image" : "video",
      }),
    });

    const { spawn } = require("child_process");

    // Get ffmpeg path
    let ffmpegPath;
    try {
      ffmpegPath = require("ffmpeg-static");
    } catch {
      ffmpegPath = "ffmpeg";
    }

    const targetDate = req.body.date || new Date().toISOString().split("T")[0];
    if (!isValidDateString(targetDate)) {
      return res
        .status(400)
        .json({ error: "date must be a valid YYYY-MM-DD date" });
    }

    const parsedStartTime = parseStartTime(req.body.startTime);
    if (parsedStartTime.error) {
      return res.status(400).json({ error: parsedStartTime.error });
    }
    const startTime = parsedStartTime.value;

    ensureTempDir();

    try {
      const drive = google.drive({ version: "v3", auth: oauth2Client });
      const folderId = await getOrCreateFolder(drive);

      // Use unique ID to prevent conflicts between concurrent uploads
      const uniqueId = crypto.randomUUID();

      if (isImage) {
        // Handle image upload - store as-is for compilation later
        const imagePath = path.join(TEMP_DIR, `image-${uniqueId}${inputExt}`);

        // Write uploaded image to disk
        fs.writeFileSync(imagePath, req.file.buffer);

        // Upload image directly to Drive
        const fileName = `${targetDate}${imageExt}`;
        const fileStream = fs.createReadStream(imagePath);

        const response = await withDriveRetry(
          req,
          "clips.trim_upload.image_create",
          () => {
            const retryStream = fs.createReadStream(imagePath);
            return drive.files.create({
              requestBody: {
                name: fileName,
                parents: [folderId],
              },
              media: {
                mimeType: req.file.mimetype,
                body: retryStream,
              },
              fields: "id, name, createdTime",
            });
          },
          { folderId, fileName },
        );

        // Generate thumbnail from image (resize it)
        const thumbnailPath = path.join(TEMP_DIR, `thumb-${uniqueId}.jpg`);
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
        const inputPath = path.join(TEMP_DIR, `input-${uniqueId}${inputExt}`);
        const outputPath = path.join(TEMP_DIR, `output-${uniqueId}.mp4`);

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

          logInfo("clips.trim_upload.ffmpeg.started", {
            ...buildLogContext(req, {
              userId: userEmail,
              userName,
              targetDate,
            }),
            ffmpegPath,
          });

          const ffmpegProcess = spawn(ffmpegPath, args);

          // Timeout after 120 seconds for large/HEVC videos
          const timeout = setTimeout(() => {
            ffmpegProcess.kill("SIGKILL");
            reject(new Error("FFmpeg timed out after 120 seconds"));
          }, 120000);

          ffmpegProcess.stderr.on("data", (data) => {
            logInfo("clips.trim_upload.ffmpeg.output", {
              ...buildLogContext(req, { userId: userEmail, targetDate }),
              output: data.toString().trim(),
            });
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

        const response = await withDriveRetry(
          req,
          "clips.trim_upload.video_create",
          () => {
            const retryStream = fs.createReadStream(outputPath);
            return drive.files.create({
              requestBody: {
                name: fileName,
                parents: [folderId],
              },
              media: {
                mimeType: "video/mp4",
                body: retryStream,
              },
              fields: "id, name, createdTime",
            });
          },
          { folderId, fileName },
        );

        // Generate and upload thumbnail
        const thumbnailPath = path.join(TEMP_DIR, `thumb-${uniqueId}.jpg`);
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
      logError("clips.trim_upload.failed", {
        ...buildLogContext(req, { userId: userEmail, userName }),
        error: serializeError(error),
      });
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

    const files = [];
    let pageToken;

    do {
      const response = await withDriveRetry(
        req,
        "compilations.list",
        () =>
          drive.files.list({
            q: `'${folderId}' in parents and trashed=false and name contains '365moments' and mimeType contains 'video/'`,
            fields: "nextPageToken, files(id, name, createdTime, size)",
            orderBy: "createdTime desc",
            pageSize: 1000,
            pageToken,
          }),
        { folderId },
      );

      files.push(...(response.data.files || []));
      pageToken = response.data.nextPageToken || null;
    } while (pageToken);

    // Filter to only compilation files (not daily clips which are YYYY-MM-DD.mp4)
    const datePattern = /^\d{4}-\d{2}-\d{2}\.(mp4|webm)$/;
    const compilations = files
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
    logError("compilations.fetch.failed", {
      ...buildLogContext(req),
      error: serializeError(error),
    });
    res.status(500).json({ error: "Failed to fetch compilations" });
  }
});

// Download/stream a compilation
app.get("/api/compilations/:id", requireAuth, async (req, res) => {
  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    // Get file metadata
    const fileInfo = await withDriveRetry(
      req,
      "compilations.meta.get",
      () =>
        drive.files.get({
          fileId: req.params.id,
          fields: "name, mimeType, size",
        }),
      { fileId: req.params.id },
    );

    res.setHeader("Content-Type", fileInfo.data.mimeType || "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${fileInfo.data.name}"`,
    );
    if (fileInfo.data.size) {
      res.setHeader("Content-Length", fileInfo.data.size);
    }

    const response = await withDriveRetry(
      req,
      "compilations.stream",
      () =>
        drive.files.get(
          { fileId: req.params.id, alt: "media" },
          { responseType: "stream" },
        ),
      { fileId: req.params.id },
    );

    response.data.pipe(res);
  } catch (error) {
    logError("compilations.stream.failed", {
      ...buildLogContext(req, { fileId: req.params.id }),
      error: serializeError(error),
    });
    res.status(500).json({ error: "Failed to stream compilation" });
  }
});

// Delete a compilation
app.delete("/api/compilations/:id", requireAuth, async (req, res) => {
  const userName = req.session.user?.name || "Unknown";
  const userEmail = req.session.user?.email || "Unknown";
  logInfo("compilations.delete.started", {
    ...buildLogContext(req, {
      fileId: req.params.id,
      userName,
      userId: userEmail,
    }),
  });

  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });
    await withDriveRetry(
      req,
      "compilations.delete",
      () => drive.files.delete({ fileId: req.params.id }),
      { fileId: req.params.id },
    );
    logInfo("compilations.delete.completed", {
      ...buildLogContext(req, { fileId: req.params.id, userId: userEmail }),
    });
    res.json({ success: true });
  } catch (error) {
    logError("compilations.delete.failed", {
      ...buildLogContext(req, { fileId: req.params.id, userId: userEmail }),
      error: serializeError(error),
    });
    res.status(500).json({ error: "Failed to delete compilation" });
  }
});

app.post("/api/compile", requireAuth, async (req, res) => {
  const userName = req.session.user?.name || "Unknown";
  const userEmail = req.session.user?.email || "Unknown";
  logInfo("compile.started", {
    ...buildLogContext(req, { userName, userId: userEmail }),
  });

  try {
    const drive = google.drive({ version: "v3", auth: oauth2Client });
    const folderId = await getOrCreateFolder(drive);
    const compileRequest = validateCompileRequest(req.body);
    if (compileRequest.error) {
      return res.status(400).json({
        success: false,
        message: compileRequest.error,
        status: "invalid_request",
      });
    }

    const { startDate, endDate, musicData } = compileRequest; // musicData is base64 encoded MP3
    const userId = req.session.user?.email || req.session.id; // Use email or session ID for unique job tracking

    // Check if already compiling
    const existingJob = compilationJobs.get(userId);
    if (existingJob && isCompilationJobExpired(existingJob)) {
      compilationJobs.delete(userId);
    }

    const activeJob = compilationJobs.get(userId);
    if (activeJob && activeJob.status === "compiling") {
      return res.json({
        success: false,
        message: "A compilation is already in progress",
        status: "already_compiling",
        jobId: activeJob.id,
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
    const compiler = new VideoCompiler(scopedOauthClient, {
      requestId: req.requestId,
      userId: userEmail,
      jobId,
    });

    // Log music data status
    if (musicData) {
      logInfo("compile.music.received", {
        ...buildLogContext(req, {
          jobId,
          bytes: musicData.length,
          userId: userEmail,
        }),
      });
    } else {
      logInfo("compile.music.absent", {
        ...buildLogContext(req, { jobId, userId: userEmail }),
      });
    }

    try {
      compilationJobs.update(userId, (currentJob) => {
        if (!currentJob) return currentJob;
        return {
          ...currentJob,
          progress: "Fetching clips...",
        };
      });

      const result = await compiler.compile(
        folderId,
        startDate,
        endDate,
        (progress) => {
          compilationJobs.update(userId, (currentJob) => {
            if (!currentJob) return currentJob;
            if (currentJob.progress === progress) {
              return currentJob;
            }

            return {
              ...currentJob,
              progress,
            };
          });
        },
        musicData, // Pass music data (base64) to compiler
      );

      compilationJobs.update(userId, (currentJob) => {
        if (!currentJob) return currentJob;
        return {
          ...currentJob,
          status: "complete",
          progress: "Done!",
          result,
          clipCount: result.clipCount,
          completedAt: new Date().toISOString(),
        };
      });
    } catch (error) {
      logError("compile.background.failed", {
        ...buildLogContext(req, { jobId, userId: userEmail }),
        error: serializeError(error),
      });
      compilationJobs.update(userId, (currentJob) => {
        if (!currentJob) return currentJob;
        return {
          ...currentJob,
          status: "error",
          error: error.message,
          progress: "Failed",
        };
      });
    }
  } catch (error) {
    logError("compile.request.failed", {
      ...buildLogContext(req, { userId: userEmail }),
      error: serializeError(error),
    });
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

  if (job && isCompilationJobExpired(job)) {
    compilationJobs.delete(userId);
    return res.json({ status: "idle", message: "No compilation in progress" });
  }

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

function startServer(port = PORT) {
  return app.listen(port, () => {
    logInfo("server.started", {
      port,
      driveFolderName: DRIVE_FOLDER_NAME,
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  compilationJobs,
  getOrCreateFolder,
  isValidDateString,
  normalizeClipFileName,
  parseStartTime,
  startServer,
  validateCompileRequest,
};
