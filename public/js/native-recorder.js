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
    this.currentOrientation = "landscape";
    this.isRecording = false;

    // DOM elements (same IDs as the web recorder)
    this.preview = document.getElementById("camera-preview");
    this.recordBtn = document.getElementById("record-btn");
    this.switchCameraBtn = document.getElementById("switch-camera-btn");
    this.orientationBtn = document.getElementById("orientation-btn");
    this.countdownEl = document.getElementById("countdown");
    this.recordingIndicator = document.getElementById("recording-indicator");
  }

  // ---- Lifecycle ----

  async init() {
    try {
      await this.startCamera();
      this.setupEventListeners();
      this.setupVisibilityHandling();
      this.updateOrientationIcon();
      console.log("NativeRecorder initialized (Capacitor)");
      return true;
    } catch (error) {
      console.error("Failed to initialize NativeRecorder:", error);
      showToast("Camera access denied. Please allow camera access.", "error");
      return false;
    }
  }

  // Camera preview still uses getUserMedia so the live preview stays in the
  // existing <video> element.  The actual *recording* is done natively.
  async startCamera(facingMode = this.currentFacingMode) {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }

    const isPortrait = this.currentOrientation === "portrait";

    const constraints = {
      video: {
        width: { ideal: isPortrait ? 1920 : 1080 },
        height: { ideal: isPortrait ? 1080 : 1920 },
        facingMode: { exact: facingMode },
        frameRate: { ideal: 30, min: 24 },
      },
      audio: false, // audio not needed for preview
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.currentFacingMode = facingMode;
    } catch {
      const fallback = {
        video: {
          width: { ideal: isPortrait ? 1920 : 1080 },
          height: { ideal: isPortrait ? 1080 : 1920 },
          facingMode: facingMode,
          frameRate: { ideal: 30, min: 15 },
        },
        audio: false,
      };
      this.stream = await navigator.mediaDevices.getUserMedia(fallback);
      this.currentFacingMode = facingMode;
    }

    this.preview.srcObject = this.stream;
    this.preview.style.transform = facingMode === "user" ? "scaleX(-1)" : "";
  }

  stopCamera() {
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
      if (!this.stream || !this.stream.active) {
        await this.startCamera();
      } else if (this.preview.paused) {
        await this.preview.play();
      }
      this.updateRecordingState(false);
    } catch {
      await this.startCamera();
      this.updateRecordingState(false);
    }
  }

  destroy() {
    this.stopCamera();
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
      if (this.orientationBtn) {
        this.orientationBtn.disabled = true;
        this.orientationBtn.classList.add("disabled");
      }
      this.stopCamera();
      if (cameraOffOverlay) cameraOffOverlay.classList.remove("hidden");
    } else {
      this.recordBtn.disabled = false;
      this.recordBtn.classList.remove("disabled");
      this.switchCameraBtn.disabled = false;
      this.switchCameraBtn.classList.remove("disabled");
      if (this.orientationBtn) {
        this.orientationBtn.disabled = false;
        this.orientationBtn.classList.remove("disabled");
      }
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
    if (this.orientationBtn) {
      this.orientationBtn.innerHTML =
        this.currentOrientation === "portrait"
          ? '<span class="material-symbols-rounded">smartphone</span>'
          : '<span class="material-symbols-rounded">tablet</span>';
    }
    const cameraContainer = document.querySelector(".camera-container");
    if (cameraContainer) {
      if (this.currentOrientation === "landscape") {
        cameraContainer.classList.add("landscape");
      } else {
        cameraContainer.classList.remove("landscape");
      }
    }
  }

  // ---- Event listeners ----

  setupEventListeners() {
    this.recordBtn.addEventListener("click", () => this.handleRecordClick());
    this.switchCameraBtn.addEventListener("click", () => this.switchCamera());
    if (this.orientationBtn) {
      this.orientationBtn.addEventListener("click", () =>
        this.toggleOrientation(),
      );
    }
  }

  setupVisibilityHandling() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (!this.isRecording) this.stopCamera();
      } else {
        if (!this.isRecording && !this.isDayRecorded()) this.resumePreview();
      }
    });
    window.addEventListener("beforeunload", () => this.destroy());
  }

  async switchCamera() {
    if (this.isDayRecorded()) return;
    const newFacingMode =
      this.currentFacingMode === "user" ? "environment" : "user";
    try {
      await this.startCamera(newFacingMode);
      this.updateOrientationIcon();
      showToast(
        `Switched to ${newFacingMode === "user" ? "front" : "back"} camera`,
        "success",
      );
    } catch {
      showToast("Could not switch camera", "error");
    }
  }

  async toggleOrientation() {
    if (this.isDayRecorded()) return;
    this.currentOrientation =
      this.currentOrientation === "portrait" ? "landscape" : "portrait";
    try {
      await this.startCamera();
      this.updateOrientationIcon();
      window.scrollTo(0, 0);
      showToast(`Switched to ${this.currentOrientation} mode`, "success");
    } catch {
      showToast("Failed to change orientation", "error");
    }
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
    const OneSecondRecorder = window.Capacitor?.Plugins?.OneSecondRecorder;
    if (OneSecondRecorder) {
      const perms = await OneSecondRecorder.checkPermissions();
      if (perms.camera !== "granted" || perms.microphone !== "granted") {
        const requested = await OneSecondRecorder.requestPermissions();
        if (
          requested.camera !== "granted" ||
          requested.microphone !== "granted"
        ) {
          showToast("Camera and microphone permissions are required.", "error");
          this.setRecordingEnabled(true);
          return;
        }
      }
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
        // The plugin records exactly durationMs of video via CameraX and
        // auto-stops.  It returns { filePath, mimeType, durationMs }.
        // Keep the WebView preview running — the last frame stays visible
        // while CameraX takes over the camera hardware.
        const result = await OneSecondRecorder.record({
          durationMs: CONFIG.VIDEO_DURATION_MS + 500, // buffer for CameraX startup latency
          useFrontCamera: this.currentFacingMode === "user",
        });

        console.log("[NativeRecorder] Plugin returned:", result);

        if (!result.filePath) throw new Error("Plugin returned no filePath");

        // Read the recorded file through Capacitor Filesystem and convert to a Blob
        const Filesystem = window.Capacitor?.Plugins?.Filesystem;
        let blob;

        if (Filesystem) {
          const fileData = await Filesystem.readFile({
            path: result.filePath,
          });
          // Convert base64 → Blob
          const byteString = atob(fileData.data);
          const ab = new ArrayBuffer(byteString.length);
          const ia = new Uint8Array(ab);
          for (let i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
          }
          blob = new Blob([ab], { type: "video/mp4" });
        } else {
          // Fallback: convert the native file URI to a fetchable URL
          const webPath = window.Capacitor.convertFileSrc(result.filePath);
          const resp = await fetch(webPath);
          blob = await resp.blob();
        }

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
      // Restart WebView preview (CameraX may have taken over the camera)
      await this.startCamera();
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

    try {
      const targetDate = this.getTargetDate();
      const ext = blob.type.includes("mp4") ? ".mp4" : ".webm";
      const fileName = `${targetDate}${ext}`;

      const result = await API.uploadClip(blob, fileName);

      showToast(
        `Moment saved for ${CONFIG.formatDateStringForDisplay(targetDate)}!`,
        "success",
      );

      this.clipsCache.set(targetDate, result.file);
      this.targetDate = null;

      if (typeof app !== "undefined") {
        if (app.loadClips) await app.loadClips();
        if (app.checkTodayStatus) app.checkTodayStatus();
      }

      this.updateRecordingState(true);
    } catch (error) {
      console.error("Upload failed:", error);
      showToast("Failed to upload. Please try again.", "error");
      this.setRecordingEnabled(true);
    } finally {
      uploadingModal.classList.add("hidden");
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

window.NativeRecorder = NativeRecorder;
