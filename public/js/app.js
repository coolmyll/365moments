// Main Application for 365 Moments

class App {
  constructor() {
    this.recorder = null;
    this.user = null;
    this.clips = [];
    this.selectedMusicData = null;
    this.selectedMusicTitle = null;
    this.screens = {
      loading: document.getElementById("loading-screen"),
      auth: document.getElementById("auth-screen"),
      main: document.getElementById("main-screen"),
      gallery: document.getElementById("gallery-screen"),
    };
  }

  async init() {
    console.log("Initializing 365 Moments...");

    // Show loading screen
    this.showScreen("loading");

    // Check authentication status
    const authStatus = await API.checkAuth();

    if (authStatus.authenticated) {
      this.user = authStatus.user;
      await this.handleSignIn();
      // Check for ongoing compilation
      this.checkCompileStatus();
    } else {
      this.showScreen("auth");
    }

    // Set up event listeners
    this.setupEventListeners();

    // Update date display
    this.updateDateDisplay();

    console.log("App initialized");
  }

  setupEventListeners() {
    // Signout
    document
      .getElementById("signout-btn")
      .addEventListener("click", async () => {
        await API.logout();
        window.location.reload();
      });

    // Permission error logout button
    const permissionLogoutBtn = document.getElementById(
      "permission-logout-btn"
    );
    if (permissionLogoutBtn) {
      permissionLogoutBtn.addEventListener("click", async () => {
        await API.logout();
        window.location.reload();
      });
    }

    // Navigation
    document.getElementById("gallery-btn").addEventListener("click", () => {
      // Stop camera when going to gallery
      if (this.recorder) {
        this.recorder.stopCamera();
      }
      this.showScreen("gallery");
      this.renderGallery();
    });

    // Go to gallery button in camera-off overlay
    document
      .getElementById("go-to-gallery-btn")
      .addEventListener("click", () => {
        this.showScreen("gallery");
        this.renderGallery();
      });

    document.getElementById("back-btn").addEventListener("click", async () => {
      this.showScreen("main");
      // Resume camera preview after returning from gallery
      if (this.recorder) {
        await this.recorder.resumePreview();
      }
    });

    // Gallery
    document.getElementById("close-modal").addEventListener("click", () => {
      this.closeVideoModal();
    });

    document.getElementById("compile-btn").addEventListener("click", () => {
      this.showCompileModal();
    });

    document
      .getElementById("start-compile-btn")
      .addEventListener("click", () => {
        this.startCompile();
      });

    // Update clip count when dates change
    document
      .getElementById("compile-start-date")
      .addEventListener("change", () => {
        this.updateCompileClipCount();
      });
    document
      .getElementById("compile-end-date")
      .addEventListener("change", () => {
        this.updateCompileClipCount();
      });

    // Music file upload
    document
      .getElementById("music-file-input")
      .addEventListener("change", (e) => {
        this.handleMusicFileSelect(e);
      });
    document
      .getElementById("remove-music-btn")
      .addEventListener("click", () => {
        this.clearSelectedMusic();
      });

    document
      .getElementById("compilations-btn")
      .addEventListener("click", () => {
        this.showCompilationsModal();
      });

    // Modal backdrop click
    document
      .getElementById("video-preview-modal")
      .addEventListener("click", (e) => {
        if (e.target.id === "video-preview-modal") {
          this.closeVideoModal();
        }
      });

    // Day options modal
    document
      .getElementById("close-day-options")
      .addEventListener("click", () => {
        this.closeDayOptionsModal();
      });

    document
      .getElementById("day-options-modal")
      .addEventListener("click", (e) => {
        if (e.target.id === "day-options-modal") {
          this.closeDayOptionsModal();
        }
      });

    // Upload modal
    document
      .getElementById("close-upload-modal")
      .addEventListener("click", () => {
        this.closeUploadModal();
      });

    document.getElementById("upload-modal").addEventListener("click", (e) => {
      if (e.target.id === "upload-modal") {
        this.closeUploadModal();
      }
    });

    // Compilations modal backdrop
    document
      .getElementById("compilations-modal")
      .addEventListener("click", (e) => {
        if (e.target.id === "compilations-modal") {
          this.closeCompilationsModal();
        }
      });

    // File input change
    document
      .getElementById("video-file-input")
      .addEventListener("change", (e) => {
        this.handleFileSelect(e.target.files[0]);
      });

    // Submit upload
    document.getElementById("submit-upload").addEventListener("click", () => {
      this.submitUpload();
    });
  }

  async handleSignIn() {
    console.log("User signed in:", this.user.name);

    // Update UI with user info
    document.getElementById("user-avatar").src = this.user.picture || "";
    document.getElementById("user-name").textContent = this.user.name;

    // Load clips from Drive - this may show permission error screen
    const clipsLoaded = await this.loadClips();
    if (!clipsLoaded) {
      // Permission error occurred, don't continue
      return;
    }

    // Initialize video recorder
    this.recorder = new VideoRecorder();
    await this.recorder.init();
    this.recorder.setClipsCache(this.clips);

    // Check if recorded today
    this.checkTodayStatus();

    // Show main screen
    this.showScreen("main");

    // Scroll to top after everything is loaded (mobile browsers preserve scroll position)
    setTimeout(() => window.scrollTo(0, 0), 100);

    showToast(`Welcome, ${this.user.name.split(" ")[0]}!`, "success");
  }

  async loadClips() {
    try {
      const data = await API.getClips();
      this.clips = data.clips || [];
      console.log(`Loaded ${this.clips.length} clips`);

      if (this.recorder) {
        this.recorder.setClipsCache(this.clips);
      }
      return true;
    } catch (error) {
      console.error("Failed to load clips:", error);
      return false;
    }
  }

  showScreen(screenName) {
    Object.values(this.screens).forEach((screen) => {
      screen.classList.remove("active");
    });
    this.screens[screenName].classList.add("active");
  }

  updateDateDisplay() {
    const now = new Date();
    document.getElementById("current-date").textContent =
      CONFIG.formatDateForDisplay(now);
    document.getElementById(
      "day-counter"
    ).textContent = `Day ${CONFIG.getDayOfYear(
      now
    )} of ${CONFIG.getCurrentYear()}`;
  }

  // Update the recording indicator based on target date
  updateRecordingIndicator() {
    const targetDate =
      this.recorder?.getTargetDate() || CONFIG.formatDateForFile();
    const today = CONFIG.formatDateForFile();

    // Show "recording for" message if not today
    const recordingForEl = document.getElementById("recording-for-date");
    if (targetDate !== today) {
      const formattedDate = CONFIG.formatDateStringForDisplay(targetDate);
      recordingForEl.textContent = `Recording for: ${formattedDate}`;
      recordingForEl.classList.remove("hidden");
    } else {
      recordingForEl.classList.add("hidden");
    }
  }

  checkTodayStatus() {
    this.updateRecordingIndicator();
    this.updateStreakDisplay();

    // Update camera/button state based on whether day is recorded
    if (this.recorder) {
      const targetDate = this.recorder.getTargetDate();
      const hasClip = this.clips.some((clip) => clip.date === targetDate);
      this.recorder.updateRecordingState(hasClip);
    }
  }

  updateStreakDisplay() {
    const streak = this.calculateStreak();
    const streakDisplay = document.getElementById("streak-display");
    const streakCount = document.getElementById("streak-count");
    const streakMessage = document.getElementById("streak-message");

    if (streak > 0) {
      streakDisplay.classList.remove("hidden");
      streakCount.textContent = streak;

      // Get motivational message based on streak
      const message = this.getStreakMessage(streak);
      streakMessage.textContent = message;

      // Add milestone class for special celebrations
      if (this.isMilestone(streak)) {
        streakDisplay.classList.add("milestone");
      } else {
        streakDisplay.classList.remove("milestone");
      }
    } else {
      streakDisplay.classList.add("hidden");
    }
  }

  getStreakMessage(streak) {
    // Milestone messages
    if (streak >= 365) return "🏆 LEGENDARY! A full year!";
    if (streak >= 300) return "👑 Incredible dedication!";
    if (streak >= 200) return "🌟 Unstoppable!";
    if (streak >= 100) return "💯 Triple digits! Amazing!";
    if (streak >= 50) return "🚀 Halfway to 100!";
    if (streak >= 30) return "🎉 One month strong!";
    if (streak >= 21) return "💪 Habit formed!";
    if (streak >= 14) return "✨ Two weeks!";
    if (streak >= 7) return "🔥 One week down!";
    if (streak >= 5) return "⭐ Great progress!";
    if (streak >= 3) return "👍 Keep it going!";
    return "🌱 Building momentum!";
  }

  isMilestone(streak) {
    const milestones = [7, 14, 21, 30, 50, 100, 150, 200, 250, 300, 365];
    return milestones.includes(streak);
  }

  calculateStreak() {
    const clipDates = new Set(this.clips.map((c) => c.date));
    const today = new Date();
    let streak = 0;
    let currentDate = new Date(today);

    while (true) {
      const dateString = CONFIG.formatDateForFile(currentDate);
      if (clipDates.has(dateString)) {
        streak++;
        currentDate.setDate(currentDate.getDate() - 1);
      } else {
        if (
          streak === 0 &&
          currentDate.toDateString() === today.toDateString()
        ) {
          currentDate.setDate(currentDate.getDate() - 1);
          continue;
        }
        break;
      }
    }

    return streak;
  }

  renderGallery() {
    const year = CONFIG.getCurrentYear();

    // Update stats - count unique dates only
    const uniqueDates = new Set(this.clips.map((c) => c.date).filter(Boolean));
    document.getElementById("total-clips").textContent = uniqueDates.size;
    document.getElementById("current-streak").textContent =
      this.calculateStreak();

    // Create clips map for quick lookup
    const clipsMap = new Map();
    this.clips.forEach((clip) => {
      if (clip.date) {
        clipsMap.set(clip.date, clip);
      }
    });

    // Render calendar
    const calendarView = document.getElementById("calendar-view");
    calendarView.innerHTML = "";

    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    const today = new Date();

    months.forEach((monthName, monthIndex) => {
      const monthSection = document.createElement("div");
      monthSection.className = "month-section";

      const monthHeader = document.createElement("h3");
      monthHeader.textContent = monthName;
      monthSection.appendChild(monthHeader);

      const daysGrid = document.createElement("div");
      daysGrid.className = "days-grid";

      const firstDay = new Date(year, monthIndex, 1);
      const lastDay = new Date(year, monthIndex + 1, 0);
      const daysInMonth = lastDay.getDate();

      // Add empty cells for days before the first day
      for (let i = 0; i < firstDay.getDay(); i++) {
        const emptyCell = document.createElement("div");
        emptyCell.className = "day-cell empty";
        daysGrid.appendChild(emptyCell);
      }

      // Add day cells
      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, monthIndex, day);
        const dateString = CONFIG.formatDateForFile(date);
        const clip = clipsMap.get(dateString);

        const dayCell = document.createElement("div");
        dayCell.className = "day-cell";

        if (date > today) {
          dayCell.textContent = day;
          dayCell.classList.add("future");
        } else if (clip) {
          dayCell.classList.add("has-video");

          // Add thumbnail if available
          if (clip.thumbnail) {
            const thumb = document.createElement("img");
            thumb.src = clip.thumbnail;
            thumb.className = "day-thumbnail";
            thumb.alt = "";
            dayCell.appendChild(thumb);
          }

          // Add day number overlay
          const dayNum = document.createElement("span");
          dayNum.className = "day-number";
          dayNum.textContent = day;
          dayCell.appendChild(dayNum);

          dayCell.addEventListener("click", () =>
            this.showDayOptions(dateString, clip)
          );
        } else {
          dayCell.textContent = day;
          dayCell.classList.add("no-video");
          // Add click handler for past days without video
          dayCell.addEventListener("click", () =>
            this.showDayOptions(dateString, null)
          );
        }

        if (date.toDateString() === today.toDateString()) {
          dayCell.classList.add("today");
        }

        daysGrid.appendChild(dayCell);
      }

      monthSection.appendChild(daysGrid);
      calendarView.appendChild(monthSection);
    });
  }

  showDayOptions(dateString, clip) {
    const modal = document.getElementById("day-options-modal");
    const title = document.getElementById("day-options-title");
    const buttonsContainer = document.getElementById("day-options-buttons");

    // Format date for display (using helper to avoid timezone issues)
    const formattedDate = CONFIG.formatDateStringForDisplay(dateString);
    title.textContent = `📅 ${formattedDate}`;

    // Clear existing buttons
    buttonsContainer.innerHTML = "";

    if (clip) {
      // Day has a video/image - show view, replace, delete options
      const isImage = clip.type === "image";

      const viewBtn = document.createElement("button");
      viewBtn.className = "day-option-btn primary";
      viewBtn.innerHTML = isImage ? "🖼️ View Image" : "▶️ View Video";
      viewBtn.addEventListener("click", () => {
        this.closeDayOptionsModal();
        this.showVideoPreview(dateString, clip);
      });
      buttonsContainer.appendChild(viewBtn);

      const replaceBtn = document.createElement("button");
      replaceBtn.className = "day-option-btn secondary";
      replaceBtn.innerHTML = isImage ? "🔄 Replace Image" : "🔄 Replace Video";
      replaceBtn.addEventListener("click", () => {
        this.closeDayOptionsModal();
        this.openUploadModal(dateString, true); // true = replace mode
      });
      buttonsContainer.appendChild(replaceBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "day-option-btn danger";
      deleteBtn.innerHTML = isImage ? "🗑️ Delete Image" : "🗑️ Delete Video";
      deleteBtn.addEventListener("click", () => {
        this.closeDayOptionsModal();
        this.deleteClip(clip);
      });
      buttonsContainer.appendChild(deleteBtn);
    } else {
      // No video for this day - show record and upload options
      const recordBtn = document.createElement("button");
      recordBtn.className = "day-option-btn primary";
      recordBtn.innerHTML = "📹 Record Now";
      recordBtn.addEventListener("click", async () => {
        this.closeDayOptionsModal();
        this.showScreen("main");
        // Set the target date for recording
        if (this.recorder) {
          this.recorder.setTargetDate(dateString);
          // Start/resume the camera for this date
          await this.recorder.startCamera();
          this.recorder.updateRecordingState(false); // Enable recording
        }
        // Update the indicator to show target date status
        this.updateRecordingIndicator();
        showToast(`Recording for ${formattedDate}`, "info");
      });
      buttonsContainer.appendChild(recordBtn);

      const uploadBtn = document.createElement("button");
      uploadBtn.className = "day-option-btn secondary";
      uploadBtn.innerHTML = "📤 Upload Video";
      uploadBtn.addEventListener("click", () => {
        this.closeDayOptionsModal();
        this.openUploadModal(dateString);
      });
      buttonsContainer.appendChild(uploadBtn);
    }

    modal.classList.remove("hidden");
  }

  closeDayOptionsModal() {
    const modal = document.getElementById("day-options-modal");
    modal.classList.add("hidden");
  }

  async deleteClip(clip) {
    if (!confirm("Are you sure you want to delete this video?")) {
      return;
    }

    try {
      await API.deleteClip(clip.id);
      showToast("Video deleted", "success");
      await this.loadClips();
      this.checkTodayStatus();
      this.renderGallery();
    } catch (error) {
      console.error("Delete error:", error);
      showToast("Failed to delete video", "error");
    }
  }

  showVideoPreview(dateString, clip) {
    const modal = document.getElementById("video-preview-modal");
    const video = document.getElementById("preview-video");
    const image = document.getElementById("preview-image");
    const dateDisplay = document.getElementById("preview-date");

    modal.classList.remove("hidden");

    const isImage = clip.type === "image";
    if (isImage) {
      video.classList.add("hidden");
      video.src = "";
      image.src = API.getVideoUrl(clip.id);
      image.classList.remove("hidden");
    } else {
      image.classList.add("hidden");
      image.src = "";
      video.src = API.getVideoUrl(clip.id);
      video.classList.remove("hidden");
    }

    const date = CONFIG.parseDateString(dateString);
    dateDisplay.textContent = date.toLocaleDateString("en-GB", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  closeVideoModal() {
    const modal = document.getElementById("video-preview-modal");
    const video = document.getElementById("preview-video");
    const image = document.getElementById("preview-image");

    video.pause();
    video.src = "";
    image.src = "";
    modal.classList.add("hidden");
  }

  // ============ COMPILE MODAL ============

  showCompileModal() {
    // Minimum clips: 2 for dev (localhost), 7 for production
    const isDev =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    const minClips = isDev ? 2 : 7;

    if (this.clips.length < minClips) {
      showToast(
        `Record at least ${minClips} days before compiling. You have ${this.clips.length}.`,
        "error"
      );
      return;
    }

    const modal = document.getElementById("compile-modal");
    const startInput = document.getElementById("compile-start-date");
    const endInput = document.getElementById("compile-end-date");

    // Find date range from clips (use the date property, not filename)
    const dates = this.clips
      .map((c) => c.date)
      .filter(Boolean)
      .sort();
    const minDate = dates[0];
    const maxDate = dates[dates.length - 1];

    startInput.value = minDate;
    startInput.min = minDate;
    startInput.max = maxDate;

    endInput.value = maxDate;
    endInput.min = minDate;
    endInput.max = maxDate;

    this.updateCompileClipCount();
    modal.classList.remove("hidden");
  }

  closeCompileModal() {
    document.getElementById("compile-modal").classList.add("hidden");
    // Reset music selection when closing modal
    this.clearSelectedMusic();
  }

  handleMusicFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.includes("audio") && !file.name.endsWith(".mp3")) {
      showToast("Please select an MP3 file", "error");
      return;
    }

    // Validate file size (max 20MB)
    if (file.size > 20 * 1024 * 1024) {
      showToast("File too large. Max 20MB.", "error");
      return;
    }

    // Read file as base64
    const reader = new FileReader();
    reader.onload = (event) => {
      this.selectedMusicData = event.target.result; // base64 data URL
      this.selectedMusicTitle = file.name;

      // Update UI
      document.getElementById("music-file-name").textContent = file.name;
      document.getElementById("selected-music-title").textContent = file.name;
      document.getElementById("selected-music").classList.remove("hidden");

      // Set up audio preview
      const audioPlayer = document.getElementById("music-preview-audio");
      audioPlayer.src = event.target.result;
      audioPlayer.classList.remove("hidden");

      showToast("Music added!", "success");
    };
    reader.readAsDataURL(file);
  }

  clearSelectedMusic() {
    this.selectedMusicData = null;
    this.selectedMusicTitle = null;

    document.getElementById("music-file-input").value = "";
    document.getElementById("music-file-name").textContent =
      "Choose MP3 file...";
    document.getElementById("selected-music").classList.add("hidden");

    const audioPlayer = document.getElementById("music-preview-audio");
    if (audioPlayer) {
      audioPlayer.pause();
      audioPlayer.src = "";
      audioPlayer.classList.add("hidden");
    }
  }

  getUniqueDatesInRange(startDate, endDate) {
    const uniqueDates = new Set();

    this.clips.forEach((clip) => {
      if (!clip.date) return;
      if (startDate && clip.date < startDate) return;
      if (endDate && clip.date > endDate) return;
      uniqueDates.add(clip.date);
    });

    return uniqueDates;
  }

  updateCompileClipCount() {
    const startDate = document.getElementById("compile-start-date").value;
    const endDate = document.getElementById("compile-end-date").value;
    const countEl = document.getElementById("compile-clip-count");

    const uniqueDates = this.getUniqueDatesInRange(startDate, endDate);
    const count = uniqueDates.size;

    countEl.textContent = `${count} clip${
      count !== 1 ? "s" : ""
    } in selected range`;
  }

  async startCompile() {
    const startDate = document.getElementById("compile-start-date").value;
    const endDate = document.getElementById("compile-end-date").value;

    const uniqueDates = this.getUniqueDatesInRange(startDate, endDate);
    const count = uniqueDates.size;

    if (count < 2) {
      showToast("Need at least 2 unique days in range", "error");
      return;
    }

    // Save music data before closing modal (closeCompileModal clears it)
    const musicData = this.selectedMusicData;

    this.closeCompileModal();

    try {
      const result = await API.compileVideo(startDate, endDate, musicData);
      if (result.status === "started") {
        showToast("Compilation started! Check status in 📼 menu.", "success");
        this.startCompileStatusPolling();
      } else if (result.status === "already_compiling") {
        showToast("A compilation is already in progress", "info");
      } else {
        showToast(result.message, "error");
      }
    } catch (error) {
      showToast("Failed to start compilation.", "error");
    }
  }

  // Poll for compilation status
  startCompileStatusPolling() {
    if (this.compileStatusInterval) {
      clearInterval(this.compileStatusInterval);
    }

    this.compileStatusInterval = setInterval(async () => {
      try {
        const status = await API.getCompileStatus();
        this.renderCompilationStatus(status);

        if (status.status === "complete") {
          clearInterval(this.compileStatusInterval);
          this.compileStatusInterval = null;
          showToast(
            `Compilation complete! ${status.clipCount} clips compiled.`,
            "success"
          );
          await API.clearCompileStatus();
          await this.loadCompilationsList();
        } else if (status.status === "error") {
          clearInterval(this.compileStatusInterval);
          this.compileStatusInterval = null;
          showToast(`Compilation failed: ${status.error}`, "error");
          await API.clearCompileStatus();
          await this.loadCompilationsList();
        }
      } catch (error) {
        // Ignore polling errors
      }
    }, 3000); // Check every 3 seconds
  }

  // Check for any ongoing compilation on page load
  async checkCompileStatus() {
    try {
      const status = await API.getCompileStatus();
      this.renderCompilationStatus(status);
      if (status.status === "compiling") {
        showToast(`Compilation in progress: ${status.progress}`, "info");
        this.startCompileStatusPolling();
      }
    } catch (error) {
      // Ignore
    }
  }

  // ============ COMPILATIONS MODAL ============

  async showCompilationsModal() {
    const modal = document.getElementById("compilations-modal");
    if (!modal) return;

    modal.classList.remove("hidden");
    await this.loadCompilationsList({ showLoading: true });
  }

  renderCompilationStatus(status) {
    const container = document.getElementById("compilation-status-container");
    if (!container) return;

    if (status?.status === "compiling") {
      const progressText = status.progress || "Processing...";
      container.innerHTML = `
        <div class="compilation-status">
          <div class="status-spinner"></div>
          <div class="status-info">
            <div class="status-title">⏳ Compilation in progress</div>
            <div class="status-progress">${progressText}</div>
          </div>
        </div>
      `;
    } else {
      container.innerHTML = "";
    }
  }

  async loadCompilationsList({ showLoading = false } = {}) {
    const modal = document.getElementById("compilations-modal");
    if (!modal || modal.classList.contains("hidden")) return;

    const list = document.getElementById("compilations-list");
    const emptyState = document.getElementById("no-compilations");

    if (showLoading) {
      list.innerHTML =
        '<p style="text-align: center; color: var(--text-secondary);">Loading...</p>';
      emptyState.classList.add("hidden");
    }

    try {
      let status = null;
      try {
        status = await API.getCompileStatus();
      } catch (statusError) {
        console.error("Failed to fetch compilation status", statusError);
      }

      this.renderCompilationStatus(status);

      const { compilations } = await API.getCompilations();

      if (!compilations.length) {
        list.innerHTML = "";
        if (status?.status === "compiling") {
          emptyState.classList.add("hidden");
        } else {
          emptyState.classList.remove("hidden");
        }
        return;
      }

      emptyState.classList.add("hidden");
      list.innerHTML = compilations
        .map(
          (comp) => `
        <div class="compilation-item" data-id="${comp.id}">
          <div class="compilation-info">
            <div class="compilation-name">${comp.name}</div>
            <div class="compilation-meta">
              ${new Date(comp.createdAt).toLocaleDateString("en-GB")} • ${
            comp.size
          }
            </div>
          </div>
          <div class="compilation-actions">
            <button class="play-btn" onclick="app.playCompilation('${
              comp.id
            }')">▶️ Play</button>
            <button class="delete-btn" onclick="app.deleteCompilation('${
              comp.id
            }')">🗑️</button>
          </div>
        </div>
      `
        )
        .join("");
    } catch (error) {
      console.error("Failed to load compilations", error);
      list.innerHTML =
        '<p style="text-align: center; color: #f87171;">Failed to load compilations</p>';
    }
  }

  closeCompilationsModal() {
    document.getElementById("compilations-modal").classList.add("hidden");
  }

  playCompilation(id) {
    // Open in a new tab for now (or could use video modal)
    window.open(API.getCompilationUrl(id), "_blank");
  }

  async deleteCompilation(id) {
    if (!confirm("Delete this compilation?")) return;

    try {
      await API.deleteCompilation(id);
      showToast("Compilation deleted", "success");
      await this.loadCompilationsList({ showLoading: true });
    } catch (error) {
      showToast("Failed to delete compilation", "error");
    }
  }

  // ============ UPLOAD MODAL ============

  openUploadModal(presetDate = null, replaceMode = false) {
    const modal = document.getElementById("upload-modal");
    const dateInput = document.getElementById("video-date");
    const dateDisplay = document.getElementById("video-date-display");

    // Set date to preset or today
    const dateValue = presetDate || CONFIG.formatDateForFile();
    dateInput.value = dateValue;

    // Display in European format (dd-mm-yyyy)
    dateDisplay.textContent = CONFIG.formatDateStringForDisplay(dateValue);

    // Store replace mode
    this.uploadReplaceMode = replaceMode;

    // Reset form
    document.getElementById("video-file-input").value = "";
    document.getElementById("file-name").textContent = "Choose file...";
    document.getElementById("trim-start").value = "0";
    document.getElementById("trim-start-group").style.display = "block";
    document.getElementById("upload-preview").classList.add("hidden");
    document.getElementById("upload-preview-image").classList.add("hidden");
    document.getElementById("submit-upload").disabled = true;
    document.querySelector(".file-input-label").classList.remove("has-file");

    this.selectedFile = null;

    modal.classList.remove("hidden");
  }

  closeUploadModal() {
    const modal = document.getElementById("upload-modal");
    const videoPreview = document.getElementById("upload-preview");
    const imagePreview = document.getElementById("upload-preview-image");

    videoPreview.pause();
    videoPreview.src = "";
    imagePreview.src = "";
    modal.classList.add("hidden");
  }

  handleFileSelect(file) {
    if (!file) return;

    this.selectedFile = file;
    const isImage = file.type.startsWith("image/");

    // Update UI
    document.getElementById("file-name").textContent = file.name;
    document.querySelector(".file-input-label").classList.add("has-file");
    document.getElementById("submit-upload").disabled = false;

    // Show/hide trim controls based on file type
    const trimGroup = document.getElementById("trim-start-group");
    if (trimGroup) {
      trimGroup.style.display = isImage ? "none" : "block";
    }

    // Show appropriate preview
    const videoPreview = document.getElementById("upload-preview");
    const imagePreview = document.getElementById("upload-preview-image");
    const fileUrl = URL.createObjectURL(file);

    if (isImage) {
      videoPreview.classList.add("hidden");
      videoPreview.pause();
      videoPreview.src = "";
      imagePreview.src = fileUrl;
      imagePreview.classList.remove("hidden");
    } else {
      imagePreview.classList.add("hidden");
      imagePreview.src = "";
      videoPreview.src = fileUrl;
      videoPreview.classList.remove("hidden");
    }
  }

  async submitUpload() {
    if (!this.selectedFile) {
      showToast("Please select a video file", "error");
      return;
    }

    const date = document.getElementById("video-date").value;
    const startTime =
      parseFloat(document.getElementById("trim-start").value) || 0;

    if (!date) {
      showToast("Please select a date", "error");
      return;
    }

    // Check if date already has a clip (unless in replace mode)
    const existingClip = this.clips.find((c) => c.date === date);
    if (existingClip && !this.uploadReplaceMode) {
      showToast(`You already have a clip for ${date}`, "error");
      return;
    }

    // If replacing, delete the old clip first
    if (existingClip && this.uploadReplaceMode) {
      try {
        await API.deleteClip(existingClip.id);
      } catch (error) {
        console.error("Failed to delete existing clip:", error);
        showToast("Failed to replace video", "error");
        return;
      }
    }

    const submitBtn = document.getElementById("submit-upload");
    submitBtn.disabled = true;
    submitBtn.textContent = "Processing...";

    try {
      const result = await API.uploadAndTrim(
        this.selectedFile,
        date,
        startTime
      );

      showToast(`Clip saved for ${date}! 🎉`, "success");

      // Refresh clips and close modal
      await this.loadClips();
      this.checkTodayStatus();
      this.closeUploadModal();

      // Refresh gallery if visible
      if (this.screens.gallery.classList.contains("active")) {
        this.renderGallery();
      }
    } catch (error) {
      console.error("Upload error:", error);
      showToast(error.message || "Upload failed", "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Upload & Trim to 1 Second";
    }
  }
}

// Initialize app when DOM is ready
let app;

document.addEventListener("DOMContentLoaded", () => {
  app = new App();
  app.init();
});

window.app = app;
