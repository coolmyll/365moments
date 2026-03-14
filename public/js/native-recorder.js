// Native Recorder Adapter for Capacitor (Android)
//
// Uses the custom OneSecondRecorder Capacitor plugin backed by CameraX to
// show a native Android preview and record exactly 1 second of H.264 MP4
// video natively. Falls back to MediaRecorder when the plugin is unavailable.

class NativeRecorder {
  constructor() {
    this.stream = null;
    this.previewSyncFrame = null;
    this.previewRetryTimer = null;
    this.clipsCache = new Map();
    this.targetDate = null;
    this.currentFacingMode = "user";
    this.isRecording = false;

    this.cameraContainer = document.querySelector(".camera-container");
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

  async init() {
    try {
      if (!(await this.ensureNativeRecordingPermissions())) {
        return false;
      }

      this.setupEventListeners();
      this.setupVisibilityHandling();

      if (this.orientationBtn) {
        this.orientationBtn.style.display = "none";
      }

      this.cameraContainer?.classList.remove("landscape");

      this.preview.style.visibility = "hidden";
      this.preview.style.pointerEvents = "none";

      await this.startCamera();

      console.log("NativeRecorder initialized (CameraX preview + recording)");
      return true;
    } catch (error) {
      console.error("Failed to initialize NativeRecorder:", error);
      showToast("Camera access denied. Please allow camera access.", "error");
      return false;
    }
  }

  showViewfinder(label = "Ready to record") {
    const container = document.querySelector(".camera-container");
    if (!container || document.getElementById("native-viewfinder")) return;
    const viewfinder = document.createElement("div");
    viewfinder.id = "native-viewfinder";
    viewfinder.className = "native-viewfinder";
    viewfinder.innerHTML = `<span class="material-symbols-rounded">videocam</span><p>${label}</p>`;
    container.insertBefore(viewfinder, container.firstChild);
  }

  hideViewfinder() {
    const viewfinder = document.getElementById("native-viewfinder");
    if (viewfinder) {
      viewfinder.remove();
    }
  }

  getPreviewBounds() {
    const container = document.querySelector(".camera-container");
    if (!container) {
      return null;
    }

    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const styles = window.getComputedStyle(container);
    const borderRadius = Number.parseFloat(styles.borderTopLeftRadius) || 16;

    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      borderRadius,
      pixelRatio: window.devicePixelRatio || 1,
    };
  }

  schedulePreviewSync() {
    if (this.previewSyncFrame !== null) {
      cancelAnimationFrame(this.previewSyncFrame);
    }

    this.previewSyncFrame = requestAnimationFrame(async () => {
      this.previewSyncFrame = null;

      if (this.isRecording || this.isDayRecorded() || document.hidden) {
        return;
      }

      const plugin = this.getNativeRecorderPlugin();
      const bounds = this.getPreviewBounds();
      if (!plugin || !bounds) {
        return;
      }

      try {
        await plugin.updatePreviewLayout(bounds);
      } catch (error) {
        console.error("Failed to update native preview layout:", error);
      }
    });
  }

  queuePreviewRetry(facingMode = this.currentFacingMode) {
    if (this.previewRetryTimer !== null) {
      clearTimeout(this.previewRetryTimer);
    }

    this.previewRetryTimer = window.setTimeout(() => {
      this.previewRetryTimer = null;
      if (!this.isRecording && !this.isDayRecorded() && !document.hidden) {
        void this.startCamera(facingMode);
      }
    }, 120);
  }

  async showNativeCountdown(text) {
    const plugin = this.getNativeRecorderPlugin();
    if (!plugin?.showCountdown) {
      return;
    }

    await plugin.showCountdown({ text });
  }

  async hideNativeCountdown() {
    const plugin = this.getNativeRecorderPlugin();
    if (!plugin?.hideCountdown) {
      return;
    }

    await plugin.hideCountdown();
  }

  async startCamera(facingMode = this.currentFacingMode) {
    const plugin = this.getNativeRecorderPlugin();
    if (plugin) {
      const bounds = this.getPreviewBounds();
      if (!bounds) {
        this.showViewfinder();
        this.queuePreviewRetry(facingMode);
        return;
      }

      if (this.previewRetryTimer !== null) {
        clearTimeout(this.previewRetryTimer);
        this.previewRetryTimer = null;
      }

      await plugin.startPreview({
        ...bounds,
        useFrontCamera: facingMode === "user",
      });

      this.currentFacingMode = facingMode;
      this.hideViewfinder();
      return;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }

    const constraints = {
      video: {
        width: { ideal: 1080 },
        height: { ideal: 1920 },
        facingMode: { exact: facingMode },
        frameRate: { ideal: 30, min: 24 },
      },
      audio: false,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.currentFacingMode = facingMode;
    } catch {
      const fallback = {
        video: {
          width: { ideal: 1080 },
          height: { ideal: 1920 },
          facingMode,
          frameRate: { ideal: 30, min: 15 },
        },
        audio: false,
      };
      this.stream = await navigator.mediaDevices.getUserMedia(fallback);
      this.currentFacingMode = facingMode;
    }

    this.preview.srcObject = this.stream;
    this.preview.style.visibility = "visible";
    this.preview.style.transform = facingMode === "user" ? "scaleX(-1)" : "";
    this.hideViewfinder();
  }

  async stopCamera() {
    if (this.previewRetryTimer !== null) {
      clearTimeout(this.previewRetryTimer);
      this.previewRetryTimer = null;
    }

    const plugin = this.getNativeRecorderPlugin();
    if (plugin) {
      try {
        await plugin.stopPreview();
      } catch (error) {
        console.error("Failed to stop native preview:", error);
      }
      return;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.preview.srcObject = null;
  }

  async resumePreview() {
    const targetDate = this.getTargetDate();
    if (this.clipsCache.has(targetDate)) {
      this.updateRecordingState(true);
      return;
    }

    try {
      await this.startCamera();
      this.updateRecordingState(false);
    } catch (error) {
      console.error("Failed to resume native preview:", error);
      throw error;
    }
  }

  destroy() {
    if (this.previewSyncFrame !== null) {
      cancelAnimationFrame(this.previewSyncFrame);
      this.previewSyncFrame = null;
    }

    if (this.previewRetryTimer !== null) {
      clearTimeout(this.previewRetryTimer);
      this.previewRetryTimer = null;
    }

    void this.stopCamera();
  }

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

  updateRecordingState(dayRecorded) {
    const cameraOffOverlay = document.getElementById("camera-off-overlay");
    if (dayRecorded) {
      this.recordBtn.disabled = true;
      this.recordBtn.classList.add("disabled");
      this.switchCameraBtn.disabled = true;
      this.switchCameraBtn.classList.add("disabled");
      void this.stopCamera();
      this.showViewfinder("Already recorded for this day");
      if (cameraOffOverlay) cameraOffOverlay.classList.remove("hidden");
    } else {
      this.recordBtn.disabled = false;
      this.recordBtn.classList.remove("disabled");
      this.switchCameraBtn.disabled = false;
      this.switchCameraBtn.classList.remove("disabled");
      this.hideViewfinder();
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

  updateOrientationIcon() {}

  setupEventListeners() {
    this.recordBtn.addEventListener("click", () => this.handleRecordClick());
    this.switchCameraBtn.addEventListener("click", () => this.switchCamera());
  }

  setupVisibilityHandling() {
    const syncPreview = () => this.schedulePreviewSync();

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (!this.isRecording) {
          void this.stopCamera();
        }
      } else if (!this.isRecording && !this.isDayRecorded()) {
        void this.resumePreview();
      }
    });

    window.addEventListener("resize", syncPreview);
    window.addEventListener("orientationchange", syncPreview);
    window.visualViewport?.addEventListener("resize", syncPreview);
    window.visualViewport?.addEventListener("scroll", syncPreview);
    window.addEventListener("beforeunload", () => this.destroy());
  }

  async switchCamera() {
    if (this.isDayRecorded()) return;
    const newFacingMode =
      this.currentFacingMode === "user" ? "environment" : "user";
    try {
      await this.startCamera(newFacingMode);
      showToast(
        `Switched to ${newFacingMode === "user" ? "front" : "back"} camera`,
        "success",
      );
    } catch {
      showToast("Could not switch camera", "error");
    }
  }

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

    const OneSecondRecorder = this.getNativeRecorderPlugin();
    if (!(await this.ensureNativeRecordingPermissions())) {
      this.setRecordingEnabled(true);
      return;
    }

    for (let i = CONFIG.VIDEO_COUNTDOWN_SECONDS; i > 0; i--) {
      this.countdownEl.textContent = i;
      this.countdownEl.classList.remove("hidden");
      await this.showNativeCountdown(String(i));
      await this.sleep(1000);
    }
    this.countdownEl.classList.add("hidden");
    await this.hideNativeCountdown();
    await this.stopCamera();

    this.isRecording = true;
    this.recordBtn.classList.add("recording");
    this.recordingIndicator.classList.remove("hidden");

    try {
      if (OneSecondRecorder) {
        const result = await OneSecondRecorder.record({
          durationMs: CONFIG.VIDEO_DURATION_MS,
          useFrontCamera: this.currentFacingMode === "user",
        });

        const recordingResult = this.validateNativeRecordingResult(result);
        const blob = await this.readNativeRecordingBlob(recordingResult);

        await this.uploadRecording(blob);
      } else {
        console.warn(
          "OneSecondRecorder plugin unavailable, using MediaRecorder fallback",
        );
        await this.recordWithMediaRecorder();
      }
    } catch (error) {
      console.error("Native recording failed:", error);
      await this.hideNativeCountdown();
      showToast("Recording failed. Please try again.", "error");
      this.setRecordingEnabled(true);
    } finally {
      await this.hideNativeCountdown();
      this.isRecording = false;
      this.recordBtn.classList.remove("recording");
      this.recordingIndicator.classList.add("hidden");

      if (!this.isDayRecorded() && !document.hidden) {
        try {
          await this.startCamera();
        } catch (error) {
          console.error(
            "Failed to restart preview after native recording:",
            error,
          );
        }
      }
    }
  }

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

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
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

    stream.getTracks().forEach((track) => track.stop());
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
