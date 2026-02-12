// Configuration for 365 Moments (Client-side)

const CONFIG = {
  // Video recording settings
  VIDEO_DURATION_MS: 1000, // 1 second
  VIDEO_COUNTDOWN_SECONDS: 3,

  // Video quality settings
  VIDEO_CONSTRAINTS: {
    video: {
      width: { ideal: 1080 },
      height: { ideal: 1920 },
      facingMode: "user",
      frameRate: { ideal: 30 },
    },
    audio: true,
  },

  // Get the current year
  getCurrentYear() {
    return new Date().getFullYear();
  },

  // Format date for file naming (YYYY-MM-DD) - local timezone
  formatDateForFile(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },

  // Format date for display (European style)
  formatDateForDisplay(date = new Date()) {
    return date.toLocaleDateString("en-GB", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  },

  // Parse a YYYY-MM-DD string to a Date object (avoiding timezone issues)
  parseDateString(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    return new Date(year, month - 1, day);
  },

  // Format date string for display (European style)
  formatDateStringForDisplay(dateString) {
    const date = this.parseDateString(dateString);
    return date.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  },

  // Get day of year (1-365/366)
  getDayOfYear(date = new Date()) {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    const oneDay = 1000 * 60 * 60 * 24;
    return Math.floor(diff / oneDay);
  },
};

// Freeze config
Object.freeze(CONFIG);
Object.freeze(CONFIG.VIDEO_CONSTRAINTS);
