// Video Recorder Module for 365 Moments

class VideoRecorder {
  constructor() {
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.isRecording = false;
    this.currentFacingMode = "user";
    this.currentOrientation = "landscape"; // portrait or landscape
    this.clipsCache = new Map();
    this.targetDate = null; // Date to record for (null = today)

    // DOM elements
    this.preview = document.getElementById("camera-preview");
    this.recordBtn = document.getElementById("record-btn");
    this.switchCameraBtn = document.getElementById("switch-camera-btn");
    this.orientationBtn = document.getElementById("orientation-btn");
    this.countdownEl = document.getElementById("countdown");
    this.recordingIndicator = document.getElementById("recording-indicator");
  }

  async init() {
    try {
      await this.startCamera();
      this.setupEventListeners();
      this.setupVisibilityHandling();
      this.updateOrientationIcon(); // Set initial icon
      console.log("VideoRecorder initialized");
      return true;
    } catch (error) {
      console.error("Failed to initialize VideoRecorder:", error);
      showToast("Camera access denied. Please allow camera access.", "error");
      return false;
    }
  }

  setupVisibilityHandling() {
    // Handle tab/app going to background
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        // Tab is hidden - stop camera to save battery and release resources
        if (!this.isRecording) {
          this.stopCamera();
          console.log("Camera stopped - tab hidden");
        }
      } else {
        // Tab is visible again - resume camera if day not recorded
        if (!this.isRecording && !this.isDayRecorded()) {
          this.resumePreview();
          console.log("Camera resumed - tab visible");
        }
      }
    });

    // Handle page unload
    window.addEventListener("beforeunload", () => {
      this.destroy();
    });

    // Handle iOS-specific pause event (when switching apps)
    window.addEventListener("pagehide", () => {
      if (!this.isRecording) {
        this.stopCamera();
      }
    });
  }

  setClipsCache(clips) {
    this.clipsCache.clear();
    clips.forEach((clip) => {
      if (clip.date) {
        this.clipsCache.set(clip.date, clip);
      }
    });
  }

  setTargetDate(dateString) {
    this.targetDate = dateString;
  }

  getTargetDate() {
    return this.targetDate || CONFIG.formatDateForFile();
  }

  async startCamera(facingMode = this.currentFacingMode) {
    // Stop existing stream
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }

    const isPortrait = this.currentOrientation === "portrait";

    // On mobile, camera orientation is often inverted from what you'd expect
    // Request the opposite resolution to get the desired output
    const constraints = {
      video: {
        width: { ideal: isPortrait ? 1920 : 1080 },
        height: { ideal: isPortrait ? 1080 : 1920 },
        facingMode: { exact: facingMode },
        frameRate: { ideal: 30, min: 24 },
      },
      audio: true,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.currentFacingMode = facingMode;
    } catch (error) {
      // Fallback if exact facingMode fails (e.g., device only has one camera)
      console.warn("Exact facingMode failed, trying without exact:", error);
      const fallbackConstraints = {
        video: {
          width: { ideal: isPortrait ? 1920 : 1080 },
          height: { ideal: isPortrait ? 1080 : 1920 },
          facingMode: facingMode,
          frameRate: { ideal: 30, min: 15 },
        },
        audio: true,
      };
      this.stream =
        await navigator.mediaDevices.getUserMedia(fallbackConstraints);
      this.currentFacingMode = facingMode;
    }

    this.preview.srcObject = this.stream;

    // Log actual resolution obtained
    const videoTrack = this.stream.getVideoTracks()[0];
    if (videoTrack) {
      const settings = videoTrack.getSettings();
      console.log(
        `Camera started: ${facingMode}, ${settings.width}x${settings.height} @ ${settings.frameRate}fps`,
      );
    }
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.preview.srcObject = null;
    console.log("Camera stopped");
  }

  async resumePreview() {
    // Check if day is already recorded - don't resume camera if so
    const targetDate = this.getTargetDate();
    if (this.clipsCache.has(targetDate)) {
      this.updateRecordingState(true); // Day recorded, disable controls
      return;
    }

    // Resume video playback after screen was hidden
    try {
      // If stream is inactive or no video tracks, restart camera
      if (
        !this.stream ||
        !this.stream.active ||
        this.stream.getVideoTracks().length === 0
      ) {
        await this.startCamera();
        console.log("Camera restarted due to inactive stream");
      } else if (this.preview.paused) {
        await this.preview.play();
        console.log("Camera preview resumed");
      }
      this.updateRecordingState(false); // Day not recorded, enable controls
    } catch (error) {
      console.error("Failed to resume preview, restarting camera:", error);
      await this.startCamera();
      this.updateRecordingState(false);
    }
  }

  isDayRecorded() {
    const targetDate = this.getTargetDate();
    return this.clipsCache.has(targetDate);
  }

  updateRecordingState(dayRecorded) {
    const cameraOffOverlay = document.getElementById("camera-off-overlay");

    // Update UI based on whether the current day is already recorded
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
    // Used during recording/upload to disable the button
    this.recordBtn.disabled = !enabled;
    if (enabled) {
      this.recordBtn.classList.remove("disabled");
    } else {
      this.recordBtn.classList.add("disabled");
    }
  }

  setupEventListeners() {
    this.recordBtn.addEventListener("click", () => this.handleRecordClick());
    this.switchCameraBtn.addEventListener("click", () => this.switchCamera());
    if (this.orientationBtn) {
      this.orientationBtn.addEventListener("click", () =>
        this.toggleOrientation(),
      );
    }
  }

  updateOrientationIcon() {
    if (this.orientationBtn) {
      // Show current mode icon
      this.orientationBtn.textContent =
        this.currentOrientation === "portrait" ? "📱" : "📺";
    }
    // Update camera container aspect ratio
    const cameraContainer = document.querySelector(".camera-container");
    if (cameraContainer) {
      if (this.currentOrientation === "landscape") {
        cameraContainer.classList.add("landscape");
      } else {
        cameraContainer.classList.remove("landscape");
      }
    }
  }

  async toggleOrientation() {
    // Don't allow if day is already recorded
    if (this.isDayRecorded()) {
      return;
    }

    this.currentOrientation =
      this.currentOrientation === "portrait" ? "landscape" : "portrait";
    try {
      await this.startCamera();
      this.updateOrientationIcon();
      showToast(`Switched to ${this.currentOrientation} mode`, "success");
    } catch (error) {
      console.error("Failed to toggle orientation:", error);
      showToast("Failed to change orientation", "error");
    }
  }

  async switchCamera() {
    // Don't allow if day is already recorded
    if (this.isDayRecorded()) {
      return;
    }

    const newFacingMode =
      this.currentFacingMode === "user" ? "environment" : "user";
    try {
      await this.startCamera(newFacingMode);
      this.updateOrientationIcon(); // Ensure icon stays correct after camera switch
      showToast(
        `Switched to ${newFacingMode === "user" ? "front" : "back"} camera`,
        "success",
      );
    } catch (error) {
      console.error("Failed to switch camera:", error);
      showToast("Could not switch camera", "error");
    }
  }

  async handleRecordClick() {
    if (this.isRecording) {
      return;
    }

    // Check if already recorded for target date
    const targetDate = this.getTargetDate();
    if (this.clipsCache.has(targetDate)) {
      const dateDisplay = CONFIG.formatDateStringForDisplay(targetDate);
      showToast(
        `Already recorded for ${dateDisplay}! Check the gallery.`,
        "error",
      );
      return;
    }

    await this.startCountdownAndRecord();
  }

  async startCountdownAndRecord() {
    // Disable button during countdown and recording
    this.setRecordingEnabled(false);

    // Countdown
    for (let i = CONFIG.VIDEO_COUNTDOWN_SECONDS; i > 0; i--) {
      this.countdownEl.textContent = i;
      this.countdownEl.classList.remove("hidden");
      await this.sleep(1000);
    }
    this.countdownEl.classList.add("hidden");

    // Start recording and wait for it to be ready
    await this.startRecording();

    // Record for slightly longer than 1 second to ensure full capture
    await this.sleep(CONFIG.VIDEO_DURATION_MS + 300);

    // Stop recording
    await this.stopRecording();
  }

  async startRecording() {
    this.chunks = [];

    const mimeType = this.getSupportedMimeType();
    const options = mimeType ? { mimeType } : {};

    try {
      this.mediaRecorder = new MediaRecorder(this.stream, options);
    } catch (error) {
      console.error("MediaRecorder error:", error);
      this.mediaRecorder = new MediaRecorder(this.stream);
    }

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    // Wait for MediaRecorder to actually start
    return new Promise((resolve) => {
      this.mediaRecorder.onstart = () => {
        console.log("MediaRecorder started, state:", this.mediaRecorder.state);
        resolve();
      };

      // Start without timeslice - captures all data at once (more efficient)
      this.mediaRecorder.start();
      this.isRecording = true;
      this.recordBtn.classList.add("recording");
      this.recordingIndicator.classList.remove("hidden");
    });
  }

  getSupportedMimeType() {
    const types = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4",
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log("Using MIME type:", type);
        return type;
      }
    }
    return null;
  }

  async stopRecording() {
    return new Promise((resolve) => {
      this.mediaRecorder.onstop = async () => {
        this.isRecording = false;
        this.recordBtn.classList.remove("recording");
        this.recordingIndicator.classList.add("hidden");

        const mimeType = this.mediaRecorder.mimeType || "video/webm";
        const blob = new Blob(this.chunks, { type: mimeType });

        console.log("Recording stopped, blob size:", blob.size);

        // Upload to server
        await this.uploadRecording(blob);

        resolve(blob);
      };

      this.mediaRecorder.stop();
    });
  }

  async uploadRecording(blob) {
    const uploadingModal = document.getElementById("uploading-modal");
    uploadingModal.classList.remove("hidden");

    try {
      const targetDate = this.getTargetDate();
      const fileName = `${targetDate}.webm`;

      const result = await API.uploadClip(blob, fileName);

      const dateDisplay = CONFIG.formatDateStringForDisplay(targetDate);
      showToast(`Moment saved for ${dateDisplay}! 🎉`, "success");

      // Update cache
      this.clipsCache.set(targetDate, result.file);

      // Reset target date to today
      this.targetDate = null;

      // Refresh gallery and update streak if app is available
      if (typeof app !== "undefined") {
        if (app.loadClips) {
          await app.loadClips();
        }
        if (app.checkTodayStatus) {
          app.checkTodayStatus();
        }
      }

      // Day is now recorded - disable button and stop camera
      this.updateRecordingState(true);
    } catch (error) {
      console.error("Upload failed:", error);
      showToast("Failed to upload. Please try again.", "error");
      // Re-enable button on error so user can try again
      this.setRecordingEnabled(true);
    } finally {
      uploadingModal.classList.add("hidden");
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  destroy() {
    // Stop any ongoing recording
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
      this.isRecording = false;
    }
    // Stop all tracks
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.preview.srcObject = null;
    console.log("VideoRecorder destroyed");
  }
}

// Toast notification helper
function showToast(message, type = "success") {
  document.querySelectorAll(".toast").forEach((t) => t.remove());

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// Export for global use
window.VideoRecorder = VideoRecorder;
window.showToast = showToast;
