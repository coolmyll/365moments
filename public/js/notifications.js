// Daily Reminder Notifications for 365 Moments (Capacitor)
//
// Schedules a daily local notification reminding the user to record their moment.
// Only active when running inside the Capacitor native shell.

const Notifications = {
  REMINDER_ID: 365,
  DEFAULT_HOUR: 20, // 8 PM
  DEFAULT_MINUTE: 0,

  async init() {
    if (!Platform.isNative()) {
      console.log("Notifications: skipped (not native)");
      return;
    }

    const LocalNotifications = window.Capacitor?.Plugins?.LocalNotifications;
    if (!LocalNotifications) {
      console.warn("LocalNotifications plugin not available");
      return;
    }

    // Request permission
    const perm = await LocalNotifications.requestPermissions();
    if (perm.display !== "granted") {
      console.warn("Notification permission not granted");
      return;
    }

    console.log("Notifications: initialized");
  },

  // Schedule a daily reminder at the given hour/minute (24h format).
  // Call this once after login or when the user changes the time.
  async scheduleDaily(hour, minute) {
    if (!Platform.isNative()) return;

    const LocalNotifications = window.Capacitor?.Plugins?.LocalNotifications;
    if (!LocalNotifications) return;

    // Cancel any existing reminder first
    try {
      await LocalNotifications.cancel({
        notifications: [{ id: this.REMINDER_ID }],
      });
    } catch {
      /* ignore if nothing to cancel */
    }

    await LocalNotifications.schedule({
      notifications: [
        {
          id: this.REMINDER_ID,
          title: "365 Moments",
          body: "Don't forget to record your 1-second moment today!",
          schedule: {
            on: {
              hour: hour ?? this.DEFAULT_HOUR,
              minute: minute ?? this.DEFAULT_MINUTE,
            },
            repeats: true,
            allowWhileIdle: true,
          },
          sound: "default",
          smallIcon: "ic_stat_icon",
        },
      ],
    });

    console.log(
      `Notifications: daily reminder set for ${hour}:${String(minute).padStart(2, "0")}`,
    );
  },

  // Cancel the daily reminder
  async cancelDaily() {
    if (!Platform.isNative()) return;

    const LocalNotifications = window.Capacitor?.Plugins?.LocalNotifications;
    if (!LocalNotifications) return;

    await LocalNotifications.cancel({
      notifications: [{ id: this.REMINDER_ID }],
    });
    console.log("Notifications: reminder cancelled");
  },

  // Schedule a weekly reminder (every Sunday) at the given hour/minute.
  async scheduleWeekly(hour, minute) {
    if (!Platform.isNative()) return;

    const LocalNotifications = window.Capacitor?.Plugins?.LocalNotifications;
    if (!LocalNotifications) return;

    // Cancel existing first
    try {
      await LocalNotifications.cancel({
        notifications: [{ id: this.REMINDER_ID }],
      });
    } catch {
      /* ignore */
    }

    await LocalNotifications.schedule({
      notifications: [
        {
          id: this.REMINDER_ID,
          title: "365 Moments",
          body: "Don't forget to record your moments this week!",
          schedule: {
            on: {
              weekday: 1, // Sunday (1-based: 1=Sun, 2=Mon, ... 7=Sat)
              hour: hour ?? this.DEFAULT_HOUR,
              minute: minute ?? this.DEFAULT_MINUTE,
            },
            repeats: true,
            allowWhileIdle: true,
          },
          sound: "default",
          smallIcon: "ic_stat_icon",
        },
      ],
    });

    console.log(
      `Notifications: weekly reminder set for Sun ${hour}:${String(minute).padStart(2, "0")}`,
    );
  },

  // Suppress today's reminder if the user already recorded
  async suppressIfRecorded(clipsCache) {
    if (!Platform.isNative()) return;

    const today = CONFIG.formatDateForFile();
    if (clipsCache.has(today)) {
      // No built-in "suppress once" in Capacitor — we simply don't cancel
      // the recurring schedule. The notification will fire but the user already
      // knows they recorded. A future improvement could track last-recorded date
      // and conditionally show/hide via a pending notification listener.
      console.log("Notifications: user already recorded today");
    }
  },
};

Object.freeze(Notifications);
window.Notifications = Notifications;
