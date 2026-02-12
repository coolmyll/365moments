// Video Compilation Service using FFmpeg
const { google } = require("googleapis");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Use ffmpeg-static for the binary path
let ffmpegPath;
try {
  ffmpegPath = require("ffmpeg-static");
} catch {
  ffmpegPath = "ffmpeg"; // Fall back to system ffmpeg
}

const TEMP_DIR = path.join(__dirname, "temp");

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

class VideoCompiler {
  constructor(oauth2Client) {
    this.oauth2Client = oauth2Client;
    this.drive = google.drive({ version: "v3", auth: oauth2Client });
    // Minimum clips required for compilation (2 for dev, higher for prod)
    const isProd = process.env.NODE_ENV === "production";
    this.minClips = isProd ? 7 : 2;
    console.log(
      `VideoCompiler: NODE_ENV=${process.env.NODE_ENV}, minClips=${this.minClips}`
    );
  }

  async compile(
    folderId,
    startDate = null,
    endDate = null,
    onProgress = null,
    musicData = null
  ) {
    const sessionDir = path.join(TEMP_DIR, `session-${crypto.randomUUID()}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    const progress = (msg) => {
      console.log(msg);
      if (onProgress) onProgress(msg);
    };

    try {
      // 1. Get all clips from Drive folder
      progress("Fetching clips from Drive...");
      let clips = await this.fetchClipsList(folderId);

      // Filter by date range if provided (dates come as YYYY-MM-DD from date picker)
      if (startDate && endDate) {
        clips = clips.filter((clip) => {
          // Extract YYYY-MM-DD from filename (stored as YYYY-MM-DD.ext)
          const dateMatch = clip.name.match(/^(\d{4}-\d{2}-\d{2})/);
          if (!dateMatch) return false;
          const date = dateMatch[1];
          return date >= startDate && date <= endDate;
        });
        progress(`Filtered to ${clips.length} clips in range`);
      }

      if (clips.length === 0) {
        throw new Error("No clips found in selected range");
      }

      if (clips.length < this.minClips) {
        throw new Error(
          `Need at least ${this.minClips} clips to compile (found ${clips.length})`
        );
      }

      progress(`Found ${clips.length} clips`);

      // Generate output filename with date range and timestamp
      const formatForDisplay = (date) => date.split("-").reverse().join("-");
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const outputFileName =
        startDate && endDate
          ? `365moments_${formatForDisplay(startDate)}_to_${formatForDisplay(
              endDate
            )}_${timestamp}.mp4`
          : `365moments-compilation_${timestamp}.mp4`;

      // 2. Download all clips
      progress(`Downloading ${clips.length} clips...`);
      const localFiles = await this.downloadClips(
        clips,
        sessionDir,
        onProgress
      );

      // 3. Create file list for FFmpeg
      const listFile = path.join(sessionDir, "filelist.txt");
      const fileListContent = localFiles.map((f) => `file '${f}'`).join("\n");
      fs.writeFileSync(listFile, fileListContent);

      // 4. Compile with FFmpeg
      progress("Compiling video...");
      const outputPath = path.join(sessionDir, outputFileName);

      // Save music if provided (base64 data URL)
      let musicPath = null;
      if (musicData) {
        progress("Processing music...");
        musicPath = this.saveMusicFromBase64(musicData, sessionDir);
      }

      await this.concatenateVideos(listFile, outputPath, musicPath);

      // 5. Upload compiled video back to Drive
      progress("Uploading to Drive...");
      const uploadedFile = await this.uploadToDrive(
        outputPath,
        outputFileName,
        folderId
      );

      // 6. Cleanup
      this.cleanup(sessionDir);

      return {
        success: true,
        fileId: uploadedFile.id,
        fileName: outputFileName,
        clipCount: clips.length,
      };
    } catch (error) {
      // Cleanup on error
      this.cleanup(sessionDir);
      throw error;
    }
  }

  async fetchClipsList(folderId) {
    const response = await this.drive.files.list({
      q: `'${folderId}' in parents and trashed=false and (mimeType contains 'video/' or mimeType contains 'image/')`,
      fields: "files(id, name, mimeType, createdTime, modifiedTime)",
      orderBy: "name", // Sort by date (filename is YYYY-MM-DD)
    });

    // Filter out compilations and thumbnails - only include files matching YYYY-MM-DD.ext pattern
    const datePattern = /^\d{4}-\d{2}-\d{2}\.(mp4|webm|jpg|jpeg|png)$/i;
    const files = (response.data.files || []).filter(
      (file) => datePattern.test(file.name) && !file.name.includes(".thumb.")
    );

    // Google Drive allows multiple files with the same name; keep only the latest per date
    const uniqueByDate = new Map();
    files.forEach((file) => {
      const dateMatch = file.name.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) return;
      const dateKey = dateMatch[1];
      const existing = uniqueByDate.get(dateKey);

      if (!existing) {
        uniqueByDate.set(dateKey, file);
        return;
      }

      const existingTime = new Date(
        existing.modifiedTime || existing.createdTime || 0
      );
      const candidateTime = new Date(
        file.modifiedTime || file.createdTime || 0
      );

      if (candidateTime >= existingTime) {
        console.log(
          `Duplicate clip found for ${dateKey}, keeping the most recent upload`
        );
        uniqueByDate.set(dateKey, file);
      }
    });

    return Array.from(uniqueByDate.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  async downloadClips(clips, sessionDir, onProgress = null) {
    const localFiles = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const downloadPath = path.join(
        sessionDir,
        `${String(i).padStart(4, "0")}-${clip.name}`
      );

      const progressMsg = `Downloading ${i + 1}/${clips.length}...`;
      console.log(progressMsg);
      if (onProgress) onProgress(progressMsg);

      const response = await this.drive.files.get(
        { fileId: clip.id, alt: "media" },
        { responseType: "stream" }
      );

      await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(downloadPath);
        response.data
          .pipe(writeStream)
          .on("finish", resolve)
          .on("error", reject);
      });

      // Check if it's an image - convert to 1-second video
      const isImage = /\.(jpg|jpeg|png)$/i.test(clip.name);
      if (isImage) {
        const videoPath = downloadPath.replace(/\.(jpg|jpeg|png)$/i, ".mp4");
        if (onProgress)
          onProgress(`Converting image ${i + 1}/${clips.length} to video...`);
        await this.convertImageToVideo(downloadPath, videoPath);
        // Remove original image file
        fs.unlinkSync(downloadPath);
        localFiles.push(videoPath);
        console.log(
          `[COMPILE] Clip ${i + 1}: ${clip.name} (image -> 1s video)`
        );
      } else {
        // Normalize video to exactly 1 second to ensure consistent compilation
        const normalizedPath = downloadPath.replace(
          /\.(mp4|webm)$/i,
          "-norm.mp4"
        );
        if (onProgress)
          onProgress(`Normalizing clip ${i + 1}/${clips.length}...`);
        await this.normalizeVideoToOneSecond(downloadPath, normalizedPath);
        // Remove original and use normalized
        fs.unlinkSync(downloadPath);
        localFiles.push(normalizedPath);
        console.log(
          `[COMPILE] Clip ${i + 1}: ${clip.name} (video -> 1s normalized)`
        );
      }
    }

    return localFiles;
  }

  // Normalize a video clip to exactly 1 second duration
  normalizeVideoToOneSecond(
    inputPath,
    outputPath,
    width = 1920,
    height = 1080
  ) {
    return new Promise((resolve, reject) => {
      // Take only the first 1 second, re-encode to consistent format
      const args = [
        "-i",
        inputPath,
        "-t",
        "1", // Limit to 1 second
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
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
        "-r",
        "30", // Consistent frame rate
        "-pix_fmt",
        "yuv420p",
        "-y",
        outputPath,
      ];

      console.log("Normalizing video to 1s:", inputPath);
      const ffmpegProcess = spawn(ffmpegPath, args);

      ffmpegProcess.stderr.on("data", (data) => {
        // Log duration info for debugging
        const output = data.toString();
        if (output.includes("Duration:")) {
          console.log(
            "  Original duration:",
            output.match(/Duration: [^,]+/)?.[0]
          );
        }
      });

      ffmpegProcess.on("close", (code) => {
        if (code === 0) {
          console.log("Video normalized to 1 second");
          resolve(outputPath);
        } else {
          reject(
            new Error(`FFmpeg video normalization exited with code ${code}`)
          );
        }
      });

      ffmpegProcess.on("error", reject);
    });
  }

  // Convert an image to a 1-second video clip matching target resolution
  convertImageToVideo(imagePath, outputPath, width = 1920, height = 1080) {
    return new Promise((resolve, reject) => {
      // Use scale with force_original_aspect_ratio and pad to maintain aspect ratio
      // This centers the image with black bars if needed
      const args = [
        "-loop",
        "1", // Loop the image
        "-i",
        imagePath, // Input image
        "-c:v",
        "libx264", // Video codec
        "-t",
        "1", // Duration: 1 second
        "-pix_fmt",
        "yuv420p", // Pixel format for compatibility
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
        "-r",
        "30", // Frame rate
        "-y", // Overwrite output
        outputPath,
      ];

      console.log("Converting image to video:", imagePath);
      const ffmpegProcess = spawn(ffmpegPath, args);

      ffmpegProcess.stderr.on("data", (data) => {
        // Suppress FFmpeg output for image conversion
      });

      ffmpegProcess.on("close", (code) => {
        if (code === 0) {
          console.log("Image converted to video");
          resolve(outputPath);
        } else {
          reject(new Error(`FFmpeg image conversion exited with code ${code}`));
        }
      });

      ffmpegProcess.on("error", reject);
    });
  }

  saveMusicFromBase64(musicData, sessionDir) {
    const musicPath = path.join(sessionDir, "music.mp3");

    try {
      // musicData is a data URL like "data:audio/mpeg;base64,..."
      const base64Data = musicData.replace(/^data:audio\/[^;]+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      fs.writeFileSync(musicPath, buffer);
      console.log("Music saved:", musicPath, `(${buffer.length} bytes)`);
      return musicPath;
    } catch (error) {
      console.error("Failed to save music:", error);
      return null; // Continue without music if save fails
    }
  }

  concatenateVideos(listFile, outputPath, musicPath = null) {
    return new Promise((resolve, reject) => {
      // Use vf scale filter to normalize all videos to same resolution
      // This ensures mixed content (phone videos + converted images) blend properly
      let args;

      if (musicPath && fs.existsSync(musicPath)) {
        // With background music - use music as primary audio
        // We use the music track directly instead of mixing, because some clips
        // (like images converted to video) may not have audio tracks
        args = [
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listFile,
          "-stream_loop",
          "-1", // Loop music if needed
          "-i",
          musicPath,
          "-vf",
          "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
          "-map",
          "0:v", // Video from concatenated clips
          "-map",
          "1:a", // Audio from music file
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-shortest", // End when video ends
          "-movflags",
          "+faststart",
          "-y",
          outputPath,
        ];
        console.log("Compiling with background music");
      } else {
        // Without music - original audio only
        args = [
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listFile,
          "-vf",
          "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
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
      }

      console.log("FFmpeg command:", ffmpegPath, args.join(" "));

      const ffmpegProcess = spawn(ffmpegPath, args);

      ffmpegProcess.stderr.on("data", (data) => {
        const output = data.toString();
        // Log progress info
        if (output.includes("frame=") || output.includes("time=")) {
          process.stdout.write(".");
        }
      });

      ffmpegProcess.on("close", (code) => {
        console.log(""); // New line after progress dots
        if (code === 0) {
          console.log("Compilation complete");
          resolve(outputPath);
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpegProcess.on("error", (err) => {
        console.error("FFmpeg error:", err);
        reject(err);
      });
    });
  }

  async uploadToDrive(filePath, fileName, folderId) {
    const fileStream = fs.createReadStream(filePath);
    const fileSize = fs.statSync(filePath).size;

    const response = await this.drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        mimeType: "video/mp4",
        body: fileStream,
      },
      fields: "id, name, webViewLink",
    });

    return response.data;
  }

  cleanup(sessionDir) {
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log("Cleaned up temp files");
      }
    } catch (error) {
      console.error("Cleanup error:", error);
    }
  }
}

module.exports = VideoCompiler;
