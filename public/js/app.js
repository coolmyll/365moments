// Main Application for 365 Moments

class App {
  constructor() {
    this.recorder = null;
    this.user = null;
    this.clips = [];
    this.clipsByDate = new Map();
    this.selectedMusicData = null;
    this.selectedMusicTitle = null;
    this.uploadPreviewUrl = null;
    this.activeModalId = null;
    this.lastFocusedElement = null;
    this.pendingConfirmation = null;
    this.modalCloseTimers = new Map();
    this.uploadingDelightInterval = null;
    this.themePreference = "color";
    this.systemThemeMediaQuery = null;
    this.systemThemeListener = null;
    this.screens = {
      loading: document.getElementById("loading-screen"),
      auth: document.getElementById("auth-screen"),
      main: document.getElementById("main-screen"),
      gallery: document.getElementById("gallery-screen"),
    };
  }

  async init() {
    this.initializeThemePreference();

    // Show loading screen
    this.showScreen("loading");
    this.updateLoadingSubtext();

    // Initialise native auth deep-link listener (no-op on web)
    await NativeAuth.init();

    try {
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
    } catch (error) {
      console.error("Init auth check failed:", error);
      this.showScreen("auth");
    }

    // Set up event listeners
    this.setupEventListeners();

    // Handle Android hardware back button
    this.setupBackButton();

    // Update date display
    this.updateDateDisplay();
  }

  updateLoadingSubtext() {
    const loadingSubtext = document.getElementById("loading-subtext");
    if (!loadingSubtext) {
      return;
    }

    const hour = new Date().getHours();
    if (hour < 12) {
      loadingSubtext.textContent = "Making room for a fresh start...";
      return;
    }

    if (hour < 18) {
      loadingSubtext.textContent = "Gathering today while it is still warm...";
      return;
    }

    loadingSubtext.textContent = "Bringing the day back into focus...";
  }

  startUploadingDelight(kind = "video") {
    const note = document.getElementById("uploading-rotating-note");
    if (!note) {
      return;
    }

    this.stopUploadingDelight();

    const sharedMessages = [
      "Finding the right place for this memory...",
      "Tucking this moment into your timeline...",
      "Keeping the details intact while we save it...",
    ];
    const kindSpecificMessages =
      kind === "image"
        ? [
            "Framing this still moment for future you...",
            "Giving this image its one-second spotlight...",
          ]
        : [
            "Trimming this clip down to its strongest second...",
            "Keeping the part you will want to replay later...",
          ];

    const messages = [...sharedMessages, ...kindSpecificMessages];
    let index = 0;
    note.textContent = messages[index];

    this.uploadingDelightInterval = setInterval(() => {
      index = (index + 1) % messages.length;
      note.textContent = messages[index];
    }, 1700);
  }

  stopUploadingDelight(finalMessage = "") {
    if (this.uploadingDelightInterval) {
      clearInterval(this.uploadingDelightInterval);
      this.uploadingDelightInterval = null;
    }

    const note = document.getElementById("uploading-rotating-note");
    if (note) {
      note.textContent = finalMessage;
    }
  }

  setupEventListeners() {
    const googleSignInBtn = document.getElementById("google-signin-btn");
    if (googleSignInBtn) {
      googleSignInBtn.addEventListener("click", async (event) => {
        if (!Platform.isNative()) {
          return;
        }

        event.preventDefault();
        await NativeAuth.login();
      });
    }

    // Profile dropdown toggle
    const userInfoBtn = document.getElementById("user-info-btn");
    const profileDropdown = document.getElementById("profile-dropdown");
    const chevron = userInfoBtn.querySelector(".header-chevron");

    userInfoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = !profileDropdown.classList.contains("hidden");
      profileDropdown.classList.toggle("hidden");
      chevron.classList.toggle("open", !isOpen);
      userInfoBtn.setAttribute("aria-expanded", String(!isOpen));
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", () => {
      profileDropdown.classList.add("hidden");
      chevron.classList.remove("open");
      userInfoBtn.setAttribute("aria-expanded", "false");
    });
    profileDropdown.addEventListener("click", (e) => e.stopPropagation());

    document.addEventListener("keydown", (e) => {
      this.handleGlobalKeydown(e);
    });

    document
      .getElementById("theme-option-list")
      ?.addEventListener("click", (e) => {
        const themeButton = e.target.closest("[data-theme-option]");
        if (!themeButton) {
          return;
        }

        this.setThemePreference(themeButton.dataset.themeOption);
      });

    // Signout
    document
      .getElementById("signout-btn")
      .addEventListener("click", async () => {
        profileDropdown.classList.add("hidden");
        await API.logout();
        window.location.reload();
      });

    // Settings / Reminders
    document.getElementById("settings-btn").addEventListener("click", () => {
      profileDropdown.classList.add("hidden");
      chevron.classList.remove("open");
      this.openSettings();
    });

    document
      .getElementById("close-settings-btn")
      .addEventListener("click", () => {
        this.closeSettings();
      });

    document
      .getElementById("close-compile-modal")
      .addEventListener("click", () => {
        this.closeCompileModal();
      });

    document
      .getElementById("close-compilations-modal")
      .addEventListener("click", () => {
        this.closeCompilationsModal();
      });

    document
      .getElementById("reminder-enabled")
      .addEventListener("change", (e) => {
        const opts = document.getElementById("reminder-options");
        if (e.target.checked) {
          opts.classList.remove("disabled");
        } else {
          opts.classList.add("disabled");
        }
      });

    document
      .getElementById("save-reminder-btn")
      .addEventListener("click", () => {
        this.saveReminderSettings();
      });

    // Permission error logout button
    const permissionLogoutBtn = document.getElementById(
      "permission-logout-btn",
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

    document.getElementById("calendar-view").addEventListener("click", (e) => {
      const dayButton = e.target.closest("[data-gallery-date]");
      if (!dayButton) return;

      this.handleGalleryDaySelection(dayButton.dataset.galleryDate);
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

    document
      .getElementById("compilations-list")
      .addEventListener("click", (e) => {
        const actionButton = e.target.closest("[data-compilation-action]");
        if (!actionButton) {
          return;
        }

        const { compilationAction, compilationId } = actionButton.dataset;
        if (!compilationId) {
          return;
        }

        if (compilationAction === "play") {
          this.playCompilation(compilationId);
          return;
        }

        if (compilationAction === "delete") {
          this.deleteCompilation(compilationId);
        }
      });

    document
      .getElementById("confirm-cancel-btn")
      .addEventListener("click", () => {
        this.closeConfirmModal(false);
      });

    document
      .getElementById("close-confirm-modal")
      .addEventListener("click", () => {
        this.closeConfirmModal(false);
      });

    document
      .getElementById("confirm-action-btn")
      .addEventListener("click", () => {
        this.closeConfirmModal(true);
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

    document.getElementById("compile-modal").addEventListener("click", (e) => {
      if (e.target.id === "compile-modal") {
        this.closeCompileModal();
      }
    });

    document.getElementById("settings-modal").addEventListener("click", (e) => {
      if (e.target.id === "settings-modal") {
        this.closeSettings();
      }
    });

    document.getElementById("confirm-modal").addEventListener("click", (e) => {
      if (e.target.id === "confirm-modal") {
        this.closeConfirmModal(false);
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

  supportsSystemTheme() {
    if (!Platform.isNative() || !window.matchMedia) {
      return false;
    }

    const prefersDarkScheme = window.matchMedia("(prefers-color-scheme: dark)");
    return typeof prefersDarkScheme.matches === "boolean";
  }

  syncThemeOptionVisibility() {
    const systemThemeOption = document.getElementById("system-theme-option");
    if (!systemThemeOption) {
      return;
    }

    systemThemeOption.hidden = !this.supportsSystemTheme();
  }

  getSystemThemeFromDevice() {
    if (!this.supportsSystemTheme()) {
      return null;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "color";
  }

  getSystemThemeDescription() {
    const effectiveTheme = this.getSystemThemeFromDevice();
    return effectiveTheme === "dark"
      ? "Following your device dark theme"
      : "Following your device light theme";
  }

  initializeThemePreference() {
    this.syncThemeOptionVisibility();

    const savedTheme = localStorage.getItem("themePreference") || "color";
    let initialTheme = savedTheme;

    if (initialTheme === "warm") {
      initialTheme = "color";
    }

    if (initialTheme === "system" && !this.supportsSystemTheme()) {
      initialTheme = "color";
    }

    if (savedTheme !== initialTheme) {
      localStorage.setItem("themePreference", initialTheme);
    }

    this.setThemePreference(initialTheme, { persist: false });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.themePreference === "system") {
        this.applyThemePreference();
      }
    });
  }

  startSystemThemeSync() {
    this.stopSystemThemeSync();

    if (!this.supportsSystemTheme()) {
      return;
    }

    this.systemThemeMediaQuery = window.matchMedia(
      "(prefers-color-scheme: dark)",
    );
    this.systemThemeListener = () => {
      if (this.themePreference === "system") {
        this.applyThemePreference();
      }
    };

    if (typeof this.systemThemeMediaQuery.addEventListener === "function") {
      this.systemThemeMediaQuery.addEventListener(
        "change",
        this.systemThemeListener,
      );
      return;
    }

    if (typeof this.systemThemeMediaQuery.addListener === "function") {
      this.systemThemeMediaQuery.addListener(this.systemThemeListener);
    }
  }

  stopSystemThemeSync() {
    if (!this.systemThemeMediaQuery || !this.systemThemeListener) {
      return;
    }

    if (typeof this.systemThemeMediaQuery.removeEventListener === "function") {
      this.systemThemeMediaQuery.removeEventListener(
        "change",
        this.systemThemeListener,
      );
    } else if (
      typeof this.systemThemeMediaQuery.removeListener === "function"
    ) {
      this.systemThemeMediaQuery.removeListener(this.systemThemeListener);
    }

    this.systemThemeMediaQuery = null;
    this.systemThemeListener = null;
  }

  applyThemePreference() {
    let effectiveTheme = this.themePreference;

    if (this.themePreference === "system") {
      effectiveTheme = this.getSystemThemeFromDevice();
      if (!effectiveTheme) {
        this.stopSystemThemeSync();
        return;
      }
    }

    document.documentElement.dataset.theme = effectiveTheme;
    this.updateThemeControls(effectiveTheme);

    if (this.themePreference === "system") {
      this.startSystemThemeSync();
    } else {
      this.stopSystemThemeSync();
    }
  }

  updateThemeControls(effectiveTheme) {
    document.querySelectorAll("[data-theme-option]").forEach((button) => {
      const isSelected = button.dataset.themeOption === this.themePreference;
      button.setAttribute("aria-pressed", String(isSelected));
      button.classList.toggle("active", isSelected);
    });

    const systemLabel = document.getElementById("system-theme-label");
    if (systemLabel) {
      systemLabel.textContent =
        this.themePreference === "system"
          ? this.getSystemThemeDescription()
          : "Follows your device appearance";
    }

    document.documentElement.dataset.themeMode = this.themePreference;
    document.documentElement.dataset.effectiveTheme = effectiveTheme;
  }

  setThemePreference(themeName, { persist = true } = {}) {
    const validThemes = new Set(["color", "dark"]);
    if (this.supportsSystemTheme()) {
      validThemes.add("system");
    }

    if (!validThemes.has(themeName)) {
      return;
    }

    this.themePreference = themeName;
    if (persist) {
      localStorage.setItem("themePreference", themeName);
    }

    this.applyThemePreference();
  }

  async handleSignIn() {
    // Update UI with user info
    document.getElementById("user-avatar").src = this.user.picture || "";

    // Load clips from Drive - this may show permission error screen
    const clipsLoaded = await this.loadClips();
    if (!clipsLoaded) {
      // Permission error occurred, don't continue
      return;
    }

    // Initialize video recorder — use native recorder on Capacitor, web otherwise
    if (Platform.isNative()) {
      this.recorder = new NativeRecorder();
    } else {
      this.recorder = new VideoRecorder();
    }
    await this.recorder.init();
    this.recorder.setClipsCache(this.clips);

    // Initialize daily reminder notifications (native only)
    await Notifications.init();
    const savedReminder = JSON.parse(
      localStorage.getItem("reminderSettings") || "{}",
    );
    if (savedReminder.enabled !== false) {
      const [h, m] = (savedReminder.time || "20:00").split(":").map(Number);
      if (savedReminder.frequency === "weekly") {
        await Notifications.scheduleWeekly(h, m);
      } else {
        await Notifications.scheduleDaily(h, m);
      }
    }

    // Check if recorded today
    this.checkTodayStatus();

    // Show main screen
    this.showScreen("main");

    if (this.recorder?.resumePreview) {
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      await this.recorder.resumePreview();
    }

    // Scroll to top after everything is loaded (mobile browsers preserve scroll position)
    setTimeout(() => window.scrollTo(0, 0), 100);

    showToast(`Welcome, ${this.user.name.split(" ")[0]}!`, "success");
  }

  async loadClips() {
    try {
      const data = await API.getClips();
      this.clips = data.clips || [];
      this.rebuildClipIndexes();

      if (this.recorder) {
        this.recorder.setClipsCache(this.clips);
      }
      return true;
    } catch (error) {
      console.error("Failed to load clips:", error);
      return false;
    }
  }

  rebuildClipIndexes() {
    this.clipsByDate = new Map();

    this.clips.forEach((clip) => {
      if (!clip?.date) return;
      this.clipsByDate.set(clip.date, clip);
    });
  }

  getClipForDate(dateString) {
    return this.clipsByDate.get(dateString) || null;
  }

  getFocusableElement(container, preferredSelector = null) {
    if (!container) return null;

    if (preferredSelector) {
      const preferred = container.querySelector(preferredSelector);
      if (preferred) return preferred;
    }

    return container.querySelector(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
  }

  openModal(modalId, preferredSelector = null) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    const existingTimer = this.modalCloseTimers.get(modalId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.modalCloseTimers.delete(modalId);
    }

    this.lastFocusedElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.activeModalId = modalId;
    modal.classList.remove("is-closing");
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    modal.scrollTop = 0;

    const focusTarget =
      this.getFocusableElement(modal, preferredSelector) || modal;
    requestAnimationFrame(() => {
      focusTarget.focus();
    });
  }

  closeModal(modalId, { restoreFocus = true } = {}) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    const existingTimer = this.modalCloseTimers.get(modalId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.modalCloseTimers.delete(modalId);
    }

    const focusTarget =
      restoreFocus &&
      this.lastFocusedElement &&
      this.lastFocusedElement.isConnected
        ? this.lastFocusedElement
        : null;

    modal.classList.add("is-closing");
    modal.setAttribute("aria-hidden", "true");

    if (this.activeModalId === modalId) {
      this.activeModalId = null;
    }

    this.lastFocusedElement = null;

    const closeTimer = setTimeout(() => {
      modal.classList.add("hidden");
      modal.classList.remove("is-closing");

      if (focusTarget) {
        focusTarget.focus();
      }

      this.modalCloseTimers.delete(modalId);
    }, 180);

    this.modalCloseTimers.set(modalId, closeTimer);
  }

  dismissActiveModal({ restoreFocus = true } = {}) {
    if (!this.activeModalId) {
      return;
    }

    switch (this.activeModalId) {
      case "video-preview-modal":
        this.closeVideoModal({ restoreFocus });
        break;
      case "day-options-modal":
        this.closeDayOptionsModal({ restoreFocus });
        break;
      case "compile-modal":
        this.closeCompileModal({ restoreFocus });
        break;
      case "compilations-modal":
        this.closeCompilationsModal({ restoreFocus });
        break;
      case "upload-modal":
        this.closeUploadModal({ restoreFocus });
        break;
      case "settings-modal":
        this.closeSettings({ restoreFocus });
        break;
      case "confirm-modal":
        this.closeConfirmModal(false, { restoreFocus });
        break;
      default:
        this.closeModal(this.activeModalId, { restoreFocus });
    }
  }

  requestConfirmation({
    title,
    message,
    confirmLabel = "Confirm",
    destructive = false,
  }) {
    return new Promise((resolve) => {
      const confirmTitle = document.getElementById("confirm-modal-title");
      const confirmMessage = document.getElementById("confirm-modal-message");
      const confirmActionBtn = document.getElementById("confirm-action-btn");

      this.pendingConfirmation = resolve;
      confirmTitle.textContent = title;
      confirmMessage.textContent = message;
      confirmActionBtn.textContent = confirmLabel;
      confirmActionBtn.classList.toggle("destructive", destructive);
      this.openModal("confirm-modal", "#confirm-cancel-btn");
    });
  }

  closeConfirmModal(confirmed = false, { restoreFocus = true } = {}) {
    const confirmActionBtn = document.getElementById("confirm-action-btn");
    const pendingConfirmation = this.pendingConfirmation;

    this.pendingConfirmation = null;
    confirmActionBtn.classList.remove("destructive");
    this.closeModal("confirm-modal", { restoreFocus });

    if (pendingConfirmation) {
      pendingConfirmation(confirmed);
    }
  }

  handleGlobalKeydown(event) {
    if (event.key !== "Escape") {
      return;
    }

    const dropdown = document.getElementById("profile-dropdown");
    if (this.activeModalId) {
      event.preventDefault();
      this.dismissActiveModal();
      return;
    }

    if (dropdown && !dropdown.classList.contains("hidden")) {
      dropdown.classList.add("hidden");
      document
        .querySelector("#user-info-btn .header-chevron")
        ?.classList.remove("open");
      document
        .getElementById("user-info-btn")
        ?.setAttribute("aria-expanded", "false");
    }
  }

  handleGalleryDaySelection(dateString) {
    if (!dateString) return;
    this.showDayOptions(dateString, this.getClipForDate(dateString));
  }

  showScreen(screenName) {
    Object.values(this.screens).forEach((screen) => {
      screen.classList.remove("active");
    });
    this.screens[screenName].classList.add("active");
    document.body.dataset.activeScreen = screenName;
    window.scrollTo(0, 0);
  }

  setupBackButton() {
    const CapApp = window.Capacitor?.Plugins?.App;
    if (!CapApp) return;

    CapApp.addListener("backButton", async () => {
      // Close any open modals first
      if (this.activeModalId) {
        this.dismissActiveModal({ restoreFocus: false });
        return;
      }

      // Close profile dropdown if open
      const dropdown = document.querySelector(".profile-dropdown:not(.hidden)");
      if (dropdown) {
        dropdown.classList.add("hidden");
        document
          .querySelector("#user-info-btn .header-chevron")
          ?.classList.remove("open");
        return;
      }

      // Navigate back from gallery to main
      if (this.screens.gallery.classList.contains("active")) {
        this.showScreen("main");
        if (this.recorder) {
          await this.recorder.resumePreview();
        }
        return;
      }

      // On main screen, minimize the app
      if (this.screens.main.classList.contains("active")) {
        CapApp.minimizeApp();
      }
    });
  }

  updateDateDisplay() {
    const now = new Date();
    document.getElementById("current-date").textContent =
      CONFIG.formatDateForDisplay(now);
    document.getElementById("day-counter").textContent =
      `Day ${CONFIG.getDayOfYear(now)} of ${CONFIG.getCurrentYear()}`;
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
    if (streak >= 365) return "LEGENDARY! A full year!";
    if (streak >= 350) return "So close to a full year!";
    if (streak >= 300) return "Incredible dedication!";
    if (streak >= 250) return "Quarter thousand! Wow!";
    if (streak >= 200) return "Unstoppable!";
    if (streak >= 150) return "150 days of memories!";
    if (streak >= 100) return "Triple digits! Amazing!";
    if (streak >= 90) return "Three months strong!";
    if (streak >= 75) return "You're on fire!";
    if (streak >= 60) return "Two months! Impressive!";
    if (streak >= 50) return "Halfway to 100!";
    if (streak >= 40) return "40 days! Crushing it!";
    if (streak >= 30) return "One month strong!";
    if (streak >= 21) return "Habit formed!";
    if (streak >= 14) return "Two weeks and counting!";
    if (streak >= 10) return "Double digits!";
    if (streak >= 7) return "One week down!";
    if (streak >= 5) return "Great progress!";
    if (streak >= 3) return "Keep it going!";
    if (streak >= 2) return "Day two! Nice!";
    return "First step taken!";
  }

  isMilestone(streak) {
    const milestones = [
      7, 14, 21, 30, 50, 60, 75, 90, 100, 150, 200, 250, 300, 350, 365,
    ];
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

    // Render calendar
    const calendarView = document.getElementById("calendar-view");
    const calendarFragment = document.createDocumentFragment();

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
      const monthSection = document.createElement("section");
      monthSection.className = "month-section";
      monthSection.style.setProperty("--month-index", String(monthIndex));

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
        const clip = this.getClipForDate(dateString);

        const isFutureDay = date > today;
        const isInteractive = !isFutureDay;
        const dayCell = document.createElement(
          isInteractive ? "button" : "div",
        );
        dayCell.className = "day-cell";

        if (isInteractive) {
          dayCell.type = "button";
          dayCell.dataset.galleryDate = dateString;
        }

        if (isFutureDay) {
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
            thumb.loading = "lazy";
            thumb.decoding = "async";
            dayCell.appendChild(thumb);
          }

          // Add day number overlay
          const dayNum = document.createElement("span");
          dayNum.className = "day-number";
          dayNum.textContent = day;
          dayCell.appendChild(dayNum);
        } else {
          dayCell.textContent = day;
          dayCell.classList.add("no-video");
        }

        if (isInteractive) {
          const formattedDate = CONFIG.formatDateStringForDisplay(dateString);
          const label = clip
            ? `${formattedDate}. ${clip.type === "image" ? "Image saved" : "Video saved"}. Activate for options.`
            : `${formattedDate}. No moment recorded yet. Activate to record or upload.`;
          dayCell.setAttribute("aria-label", label);
        }

        if (date.toDateString() === today.toDateString()) {
          dayCell.classList.add("today");
        }

        daysGrid.appendChild(dayCell);
      }

      monthSection.appendChild(daysGrid);
      calendarFragment.appendChild(monthSection);
    });

    calendarView.replaceChildren(calendarFragment);
  }

  showDayOptions(dateString, clip) {
    const modal = document.getElementById("day-options-modal");
    const title = document.getElementById("day-options-title");
    const buttonsContainer = document.getElementById("day-options-buttons");

    // Format date for display (using helper to avoid timezone issues)
    const formattedDate = CONFIG.formatDateStringForDisplay(dateString);
    title.textContent = formattedDate;

    // Clear existing buttons
    buttonsContainer.innerHTML = "";

    if (clip) {
      // Day has a video/image - show view, replace, delete options
      const isImage = clip.type === "image";

      const viewBtn = document.createElement("button");
      viewBtn.className = "day-option-btn primary";
      viewBtn.innerHTML = isImage
        ? '<span class="material-symbols-rounded">image</span> View Image'
        : '<span class="material-symbols-rounded">play_circle</span> View Video';
      viewBtn.addEventListener("click", () => {
        this.closeDayOptionsModal();
        this.showVideoPreview(dateString, clip);
      });
      buttonsContainer.appendChild(viewBtn);

      const replaceBtn = document.createElement("button");
      replaceBtn.className = "day-option-btn secondary";
      replaceBtn.innerHTML = isImage
        ? '<span class="material-symbols-rounded">sync</span> Replace Image'
        : '<span class="material-symbols-rounded">sync</span> Replace Video';
      replaceBtn.addEventListener("click", () => {
        this.closeDayOptionsModal();
        this.openUploadModal(dateString, true); // true = replace mode
      });
      buttonsContainer.appendChild(replaceBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "day-option-btn danger";
      deleteBtn.innerHTML = isImage
        ? '<span class="material-symbols-rounded">delete</span> Delete Image'
        : '<span class="material-symbols-rounded">delete</span> Delete Video';
      deleteBtn.addEventListener("click", () => {
        this.closeDayOptionsModal();
        this.deleteClip(clip);
      });
      buttonsContainer.appendChild(deleteBtn);
    } else {
      // No video for this day - show record and upload options
      const recordBtn = document.createElement("button");
      recordBtn.className = "day-option-btn primary";
      recordBtn.innerHTML =
        '<span class="material-symbols-rounded">videocam</span> Record Now';
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
      uploadBtn.innerHTML =
        '<span class="material-symbols-rounded">upload</span> Upload Video';
      uploadBtn.addEventListener("click", () => {
        this.closeDayOptionsModal();
        this.openUploadModal(dateString);
      });
      buttonsContainer.appendChild(uploadBtn);
    }

    this.openModal("day-options-modal", ".day-option-btn");
  }

  closeDayOptionsModal(options) {
    this.closeModal("day-options-modal", options);
  }

  async deleteClip(clip) {
    const confirmed = await this.requestConfirmation({
      title: "Delete this moment?",
      message:
        "This removes the selected video or image for that day. This action cannot be undone.",
      confirmLabel: "Delete moment",
      destructive: true,
    });

    if (!confirmed) {
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

    this.openModal("video-preview-modal", "#close-modal");

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

  closeVideoModal(options) {
    const video = document.getElementById("preview-video");
    const image = document.getElementById("preview-image");

    video.pause();
    video.src = "";
    image.src = "";
    this.closeModal("video-preview-modal", options);
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
        "error",
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
    this.openModal("compile-modal", "#compile-start-date");
  }

  closeCompileModal(options) {
    this.closeModal("compile-modal", options);
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
    const startCompileBtn = document.getElementById("start-compile-btn");
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

    startCompileBtn.disabled = true;
    startCompileBtn.textContent = "Starting...";

    this.closeCompileModal();

    try {
      const result = await API.compileVideo(startDate, endDate, musicData);
      if (result.status === "started") {
        showToast("Compilation started! Check status in menu.", "success");
        this.startCompileStatusPolling();
      } else if (result.status === "already_compiling") {
        showToast("A compilation is already in progress", "info");
      } else {
        showToast(result.message, "error");
      }
    } catch (error) {
      showToast("Failed to start compilation.", "error");
    } finally {
      startCompileBtn.disabled = false;
      startCompileBtn.textContent = "Create video";
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
            "success",
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

    this.openModal("compilations-modal", ".close-btn");
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
      list.innerHTML = '<p class="list-feedback">Loading...</p>';
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
      this.renderCompilationsList(compilations);
    } catch (error) {
      console.error("Failed to load compilations", error);
      list.innerHTML =
        '<p class="list-feedback list-feedback-error">Failed to load compilations</p>';
    }
  }

  renderCompilationsList(compilations) {
    const list = document.getElementById("compilations-list");
    const fragment = document.createDocumentFragment();

    list.innerHTML = "";

    compilations.forEach((compilation) => {
      const item = document.createElement("div");
      item.className = "compilation-item";
      item.dataset.id = compilation.id;

      const info = document.createElement("div");
      info.className = "compilation-info";

      const name = document.createElement("div");
      name.className = "compilation-name";
      name.textContent = compilation.name;

      const meta = document.createElement("div");
      meta.className = "compilation-meta";
      meta.textContent = `${new Date(compilation.createdAt).toLocaleDateString("en-GB")} • ${compilation.size}`;

      info.append(name, meta);

      const actions = document.createElement("div");
      actions.className = "compilation-actions";

      const playButton = document.createElement("button");
      playButton.type = "button";
      playButton.className = "play-btn";
      playButton.dataset.compilationAction = "play";
      playButton.dataset.compilationId = compilation.id;
      playButton.setAttribute(
        "aria-label",
        `Play compilation ${compilation.name}`,
      );
      playButton.innerHTML =
        '<span class="material-symbols-rounded">play_circle</span><span>Play</span>';

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "delete-btn";
      deleteButton.dataset.compilationAction = "delete";
      deleteButton.dataset.compilationId = compilation.id;
      deleteButton.setAttribute(
        "aria-label",
        `Delete compilation ${compilation.name}`,
      );
      deleteButton.innerHTML =
        '<span class="material-symbols-rounded">delete</span><span class="sr-only">Delete</span>';

      actions.append(playButton, deleteButton);
      item.append(info, actions);
      fragment.appendChild(item);
    });

    list.appendChild(fragment);
  }

  closeCompilationsModal(options) {
    this.closeModal("compilations-modal", options);
  }

  playCompilation(id) {
    // Open in a new tab for now (or could use video modal)
    window.open(API.getCompilationUrl(id), "_blank");
  }

  async deleteCompilation(id) {
    const confirmed = await this.requestConfirmation({
      title: "Delete this compilation?",
      message:
        "This removes the exported video from your compilations list. This action cannot be undone.",
      confirmLabel: "Delete compilation",
      destructive: true,
    });

    if (!confirmed) return;

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
    const dateInput = document.getElementById("video-date");
    const dateDisplay = document.getElementById("video-date-display");
    const uploadFileLabel = document.querySelector(
      "#upload-modal .file-input-label",
    );

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
    document.getElementById("trim-start-group").hidden = false;
    document.getElementById("upload-preview").classList.add("hidden");
    document.getElementById("upload-preview-image").classList.add("hidden");
    document.getElementById("submit-upload").disabled = true;
    this.syncUploadSubmitButton();
    uploadFileLabel?.classList.remove("has-file");

    this.selectedFile = null;

    this.openModal("upload-modal", "#video-file-input");
  }

  closeUploadModal(options) {
    const videoPreview = document.getElementById("upload-preview");
    const imagePreview = document.getElementById("upload-preview-image");

    videoPreview.pause();
    videoPreview.src = "";
    imagePreview.src = "";

    if (this.uploadPreviewUrl) {
      URL.revokeObjectURL(this.uploadPreviewUrl);
      this.uploadPreviewUrl = null;
    }

    this.closeModal("upload-modal", options);
  }

  handleFileSelect(file) {
    if (!file) return;

    this.selectedFile = file;
    const isImage = file.type.startsWith("image/");

    // Update UI
    document.getElementById("file-name").textContent = file.name;
    document
      .querySelector("#upload-modal .file-input-label")
      ?.classList.add("has-file");
    document.getElementById("submit-upload").disabled = false;
    this.syncUploadSubmitButton(file);

    // Show/hide trim controls based on file type
    const trimGroup = document.getElementById("trim-start-group");
    if (trimGroup) {
      trimGroup.hidden = isImage;
    }

    // Show appropriate preview
    const videoPreview = document.getElementById("upload-preview");
    const imagePreview = document.getElementById("upload-preview-image");
    if (this.uploadPreviewUrl) {
      URL.revokeObjectURL(this.uploadPreviewUrl);
    }

    const fileUrl = URL.createObjectURL(file);
    this.uploadPreviewUrl = fileUrl;

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
      showToast("Please select a video or image", "error");
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
    submitBtn.textContent = "Saving...";

    // Show uploading modal
    const uploadingModal = document.getElementById("uploading-modal");
    const uploadingTitle = document.getElementById("uploading-title");
    const uploadingMessage = document.getElementById("uploading-message");
    const uploadingDetails = document.getElementById("uploading-details");
    const uploadingDetailText = document.getElementById(
      "uploading-detail-text",
    );

    const isImage = this.selectedFile.type.startsWith("image/");
    uploadingTitle.textContent = isImage
      ? "Saving image moment"
      : "Saving video moment";
    uploadingMessage.textContent = isImage
      ? "Uploading your image and preparing it for playback..."
      : "Uploading your video and trimming it to one second...";
    uploadingDetailText.textContent = `File: ${this.selectedFile.name} (${(this.selectedFile.size / 1024 / 1024).toFixed(2)} MB)`;
    uploadingDetails.classList.remove("hidden");
    uploadingModal.classList.remove("hidden");
    this.startUploadingDelight(isImage ? "image" : "video");

    try {
      const result = await API.uploadAndTrim(
        this.selectedFile,
        date,
        startTime,
      );

      // Success
      uploadingMessage.textContent = "Moment saved. Refreshing your library...";
      this.stopUploadingDelight("A small future favorite is ready.");
      await new Promise((resolve) => setTimeout(resolve, 500));

      window.celebrateMomentSaved?.("#uploading-modal .modal-content");
      showToast(`Clip saved for ${date}!`, "success");

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

      // Show detailed error message
      let errorMsg = "Upload failed";
      if (error.message) {
        errorMsg = error.message;
      }
      if (error.message && error.message.includes("413")) {
        errorMsg = "File is too large. Please choose a smaller video.";
      } else if (error.message && error.message.includes("422")) {
        errorMsg = "Video format not supported or invalid after trimming.";
      } else if (error.message && error.message.includes("500")) {
        errorMsg = "Server error. Please try again later.";
      }

      uploadingTitle.textContent = "Could not save moment";
      uploadingMessage.textContent = errorMsg;
      uploadingDetailText.textContent =
        "Tap outside this dialog to dismiss and try again.";
      this.stopUploadingDelight("Let’s try that one more time.");

      showToast(errorMsg, "error");
    } finally {
      submitBtn.disabled = false;
      this.syncUploadSubmitButton(this.selectedFile);

      // Hide uploading modal after 3 seconds on success, keep on error
      if (uploadingTitle.textContent !== "Could not save moment") {
        setTimeout(() => {
          uploadingModal.classList.add("hidden");
          this.stopUploadingDelight();
        }, 1500);
      } else {
        this.stopUploadingDelight("Let’s try that one more time.");
      }
    }
  }

  syncUploadSubmitButton(file = null) {
    const submitBtn = document.getElementById("submit-upload");
    if (!submitBtn) {
      return;
    }

    if (!file) {
      submitBtn.textContent = "Save moment";
      return;
    }

    submitBtn.textContent = file.type.startsWith("image/")
      ? "Save image"
      : "Save video";
  }

  // ---- Settings / Reminders ----

  openSettings() {
    // Load saved settings from localStorage
    const saved = JSON.parse(localStorage.getItem("reminderSettings") || "{}");
    const enabled = saved.enabled !== false; // default on
    const time = saved.time || "20:00";
    const frequency = saved.frequency || "daily";

    document.getElementById("reminder-enabled").checked = enabled;
    document.getElementById("reminder-time").value = time;
    document.getElementById("reminder-frequency").value = frequency;

    const opts = document.getElementById("reminder-options");
    if (enabled) {
      opts.classList.remove("disabled");
    } else {
      opts.classList.add("disabled");
    }

    this.openModal("settings-modal", "#reminder-enabled");
  }

  closeSettings(options) {
    this.closeModal("settings-modal", options);
  }

  async saveReminderSettings() {
    const enabled = document.getElementById("reminder-enabled").checked;
    const time = document.getElementById("reminder-time").value;
    const frequency = document.getElementById("reminder-frequency").value;
    const [hour, minute] = time.split(":").map(Number);

    const settings = { enabled, time, frequency };
    localStorage.setItem("reminderSettings", JSON.stringify(settings));

    if (enabled) {
      if (frequency === "weekly") {
        await Notifications.scheduleWeekly(hour, minute);
      } else {
        await Notifications.scheduleDaily(hour, minute);
      }
      showToast("Reminder saved", "success");
    } else {
      await Notifications.cancelDaily();
      showToast("Reminders disabled", "success");
    }

    this.closeSettings();
  }
}

// Initialize app when DOM is ready
let app;

document.addEventListener("DOMContentLoaded", () => {
  app = new App();
  app.init();
});
