// Native Recorder Adapter for Capacitor (Android)
//
// Uses the custom OneSecondRecorder Capacitor plugin backed by CameraX to
// record exactly 1 second of H.264 MP4 video natively.  The resulting file
// is uploaded directly — the server can skip re-encoding via the MP4
// passthrough path.
//
// Falls back to MediaRecorder in the WebView when the native plugin is
// unavailable (e.g. during web development).
//
// This module exposes a NativeRecorder class with the same public interface
// that app.js expects from VideoRecorder, so swapping is transparent.

class NativeRecorder {
  constructor() {
    this.clipsCache = new Map();
    this.targetDate = null;
    this.currentFacingMode = "user";
    this.isRecording = false;

    // DOM elements (same IDs as the web recorder)
    this.preview = document.getElementById("camera-preview");
    this.recordBtn = document.getElementById("record-btn");
    this.switchCameraBtn = document.getElementById("switch-camera-btn");
    this.orientationBtn = document.getElementById("orientation-btn");
    this.countdownEl = document.getElementById("countdown");
    this.recordingIndicator = document.getElementById("recording-indicator");
  }

  getNativeRecorderPlugin() {
    return window.Capacitor?.Plugins?.OneSecondRecorder || null;
  }

  async ensureNativeRecordingPermissions() {
    const plugin = this.getNativeRecorderPlugin();
    if (!plugin) {
      return true;
    }

    const perms = await plugin.checkPermissions();
    if (perms.camera === "granted" && perms.microphone === "granted") {
      return true;
    }

    const requested = await plugin.requestPermissions();
    const granted =
      requested.camera === "granted" && requested.microphone === "granted";

    if (!granted) {
      showToast("Camera and microphone permissions are required.", "error");
    }

    return granted;
  }

  validateNativeRecordingResult(result) {
    if (!result || typeof result !== "object") {
      throw new Error("Plugin returned an empty recording result");
    }

    if (typeof result.filePath !== "string" || !result.filePath.trim()) {
      throw new Error("Plugin returned no filePath");
    }

    if (result.filePath.includes("..")) {
      throw new Error("Plugin returned an unsafe file path");
    }

    if (
      result.mimeType &&
      typeof result.mimeType === "string" &&
      result.mimeType !== "video/mp4"
    ) {
      throw new Error(`Unsupported native mime type: ${result.mimeType}`);
    }

    const durationMs = Number(result.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 700 || durationMs > 5000) {
      throw new Error("Plugin returned an invalid recording duration");
    }

    return {
      filePath: result.filePath,
      mimeType: "video/mp4",
      durationMs,
    };
  }

  async readNativeRecordingBlob(recordingResult) {
    const Filesystem = window.Capacitor?.Plugins?.Filesystem;

    if (Filesystem) {
      try {
        const fileData = await Filesystem.readFile({
          path: recordingResult.filePath,
        });

        if (!fileData?.data || typeof fileData.data !== "string") {
          throw new Error("Filesystem returned empty file data");
        }

        const byteString = atob(fileData.data);
        const bytes = new Uint8Array(byteString.length);
        for (let index = 0; index < byteString.length; index += 1) {
          bytes[index] = byteString.charCodeAt(index);
        }

        return new Blob([bytes], { type: recordingResult.mimeType });
      } catch (error) {
        console.warn(
          "Filesystem read failed for native recording, falling back to file fetch",
          error,
        );
      }
    }

    const webPath = window.Capacitor?.convertFileSrc?.(
      recordingResult.filePath,
    );
    if (!webPath) {
      throw new Error("Unable to resolve native recording path");
    }

    const response = await fetch(webPath);
    if (!response.ok) {
      throw new Error(`Failed to read native recording: ${response.status}`);
    }

    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error("Native recording file was empty");
    }

    return blob.type
      ? blob
      : new Blob([await blob.arrayBuffer()], {
          type: recordingResult.mimeType,
        });
  }

  // ---- Lifecycle ----

  async init() {
    try {
      this.setupEventListeners();
      this.setupVisibilityHandling();
      // Hide orientation button on native — physical rotation controls this
      if (this.orientationBtn) {
        this.orientationBtn.style.display = "none";
      }
      // Hide the video preview element — no getUserMedia on native
      this.preview.style.display = "none";
      // Show viewfinder UI
      this.showViewfinder();
      console.log("NativeRecorder initialized (Capacitor, no WebView preview)");
      return true;
    } catch (error) {
      console.error("Failed to initialize NativeRecorder:", error);
      showToast("Camera initialization failed.", "error");
      return false;
    }
  }

  showViewfinder() {
    const container = document.querySelector(".camera-container");
    if (!container || document.getElementById("native-viewfinder")) return;
    const vf = document.createElement("div");
    vf.id = "native-viewfinder";
    vf.className = "native-viewfinder";
    vf.innerHTML =
      '<span class="material-symbols-rounded">videocam</span><p>Ready to record</p>';
    container.insertBefore(vf, container.firstChild);
  }

  hideViewfinder() {
    const vf = document.getElementById("native-viewfinder");
    if (vf) vf.remove();
  }

  // No getUserMedia on native — camera is CameraX only
  async startCamera() {
    // no-op on native
  }

  stopCamera() {
    // no-op on native — no WebView stream to stop
  }

  async resumePreview() {
    const targetDate = this.getTargetDate();
    if (this.clipsCache.has(targetDate)) {
      this.updateRecordingState(true);
      return;
    }
    this.showViewfinder();
    this.updateRecordingState(false);
  }

  destroy() {
    // no-op — no WebView stream
  }

  // ---- Cache / date helpers (same as VideoRecorder) ----

  setClipsCache(clips) {
    this.clipsCache.clear();
    clips.forEach((clip) => {
      if (clip.date) this.clipsCache.set(clip.date, clip);
    });
  }

  setTargetDate(dateString) {
    this.targetDate = dateString;
  }

  getTargetDate() {
    return this.targetDate || CONFIG.formatDateForFile();
  }

  isDayRecorded() {
    return this.clipsCache.has(this.getTargetDate());
  }

  // ---- UI state (matches VideoRecorder interface) ----

  updateRecordingState(dayRecorded) {
    const cameraOffOverlay = document.getElementById("camera-off-overlay");
    if (dayRecorded) {
      this.recordBtn.disabled = true;
      this.recordBtn.classList.add("disabled");
      this.switchCameraBtn.disabled = true;
      this.switchCameraBtn.classList.add("disabled");
      this.hideViewfinder();
      if (cameraOffOverlay) cameraOffOverlay.classList.remove("hidden");
    } else {
      this.recordBtn.disabled = false;
      this.recordBtn.classList.remove("disabled");
      this.switchCameraBtn.disabled = false;
      this.switchCameraBtn.classList.remove("disabled");
      if (cameraOffOverlay) cameraOffOverlay.classList.add("hidden");
    }
  }

  setRecordingEnabled(enabled) {
    this.recordBtn.disabled = !enabled;
    if (enabled) {
      this.recordBtn.classList.remove("disabled");
    } else {
      this.recordBtn.classList.add("disabled");
    }
  }

  updateOrientationIcon() {
    // No orientation toggle on native
  }

  // ---- Event listeners ----

  setupEventListeners() {
    this.recordBtn.addEventListener("click", () => this.handleRecordClick());
    this.switchCameraBtn.addEventListener("click", () => this.switchCamera());
  }

  setupVisibilityHandling() {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !this.isRecording && !this.isDayRecorded()) {
        this.showViewfinder();
      }
    });
  }

  async switchCamera() {
    if (this.isDayRecorded()) return;
    this.currentFacingMode =
      this.currentFacingMode === "user" ? "environment" : "user";
    showToast(
      `Switched to ${this.currentFacingMode === "user" ? "front" : "back"} camera`,
      "success",
    );
  }

  // ---- Recording (native path) ----

  async handleRecordClick() {
    if (this.isRecording) return;

    const targetDate = this.getTargetDate();
    if (this.clipsCache.has(targetDate)) {
      showToast(
        `Already recorded for ${CONFIG.formatDateStringForDisplay(targetDate)}!`,
        "error",
      );
      return;
    }

    await this.startCountdownAndRecord();
  }

  async startCountdownAndRecord() {
    this.setRecordingEnabled(false);

    // Ensure native camera + microphone permissions are granted before countdown.
    const OneSecondRecorder = this.getNativeRecorderPlugin();
    if (!(await this.ensureNativeRecordingPermissions())) {
      this.setRecordingEnabled(true);
      return;
    }

    // Countdown
    for (let i = CONFIG.VIDEO_COUNTDOWN_SECONDS; i > 0; i--) {
      this.countdownEl.textContent = i;
      this.countdownEl.classList.remove("hidden");
      await this.sleep(1000);
    }
    this.countdownEl.classList.add("hidden");

    // ---- Native capture via custom OneSecondRecorder CameraX plugin ----
    this.isRecording = true;
    this.recordBtn.classList.add("recording");
    this.recordingIndicator.classList.remove("hidden");

    try {
      if (OneSecondRecorder) {
        this.hideViewfinder();

        const result = await OneSecondRecorder.record({
          durationMs: CONFIG.VIDEO_DURATION_MS,
          useFrontCamera: this.currentFacingMode === "user",
        });

        const recordingResult = this.validateNativeRecordingResult(result);
        const blob = await this.readNativeRecordingBlob(recordingResult);

        await this.uploadRecording(blob);
      } else {
        // Fallback: record with MediaRecorder in the WebView
        console.warn(
          "OneSecondRecorder plugin unavailable, using MediaRecorder fallback",
        );
        await this.startCamera();
        await this.recordWithMediaRecorder();
      }
    } catch (error) {
      console.error("Native recording failed:", error);
      showToast("Recording failed. Please try again.", "error");
      this.setRecordingEnabled(true);
    } finally {
      this.isRecording = false;
      this.recordBtn.classList.remove("recording");
      this.recordingIndicator.classList.add("hidden");
      if (!this.isDayRecorded()) {
        this.showViewfinder();
      }
    }
  }

  // MediaRecorder fallback (same as web recorder logic)
  async recordWithMediaRecorder() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1080 },
        height: { ideal: 1920 },
        facingMode: this.currentFacingMode,
        frameRate: { ideal: 30 },
      },
      audio: true,
    });
    this.preview.srcObject = stream;

    const chunks = [];
    const mimeType = this.getSupportedMimeType();
    const options = mimeType ? { mimeType } : {};
    const recorder = new MediaRecorder(stream, options);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    await new Promise((resolve) => {
      recorder.onstart = resolve;
      recorder.start();
    });

    await this.sleep(CONFIG.VIDEO_DURATION_MS + 300);

    const blob = await new Promise((resolve) => {
      recorder.onstop = () => {
        const type = recorder.mimeType || "video/webm";
        resolve(new Blob(chunks, { type }));
      };
      recorder.stop();
    });

    stream.getTracks().forEach((t) => t.stop());
    await this.uploadRecording(blob);
  }

  getSupportedMimeType() {
    const types = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4",
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return null;
  }

  async uploadRecording(blob) {
    const uploadingModal = document.getElementById("uploading-modal");
    uploadingModal.classList.remove("hidden");
    if (typeof app !== "undefined" && app.startUploadingDelight) {
      app.startUploadingDelight("video");
    }

    try {
      const targetDate = this.getTargetDate();
      const ext = blob.type.includes("mp4") ? ".mp4" : ".webm";
      const fileName = `${targetDate}${ext}`;

      const result = await API.uploadClip(blob, fileName, {
        captureSource: "native-android",
      });

      if (typeof app !== "undefined" && app.stopUploadingDelight) {
        app.stopUploadingDelight("Your one-second keepsake is ready.");
      }
      window.celebrateMomentSaved?.(".camera-container");
      showToast(
        `Moment saved for ${CONFIG.formatDateStringForDisplay(targetDate)}!`,
        "success",
      );
      await this.sleep(950);

      this.clipsCache.set(targetDate, result.file);
      this.targetDate = null;

      if (typeof app !== "undefined") {
        if (app.loadClips) await app.loadClips();
        if (app.checkTodayStatus) app.checkTodayStatus();
      }

      this.updateRecordingState(true);
    } catch (error) {
      console.error("Upload failed:", error);
      if (typeof app !== "undefined" && app.stopUploadingDelight) {
        app.stopUploadingDelight("That one slipped away. Try again.");
      }
      showToast("Failed to upload. Please try again.", "error");
      this.setRecordingEnabled(true);
    } finally {
      uploadingModal.classList.add("hidden");
      if (typeof app !== "undefined" && app.stopUploadingDelight) {
        app.stopUploadingDelight();
      }
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

window.NativeRecorder = NativeRecorder;
