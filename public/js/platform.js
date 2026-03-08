// Platform detection for 365 Moments
// Determines whether the app is running inside a Capacitor native shell
// or in a regular browser.

const Platform = {
  // Returns true when running inside the Capacitor Android/iOS shell
  isNative() {
    return (
      typeof window !== "undefined" &&
      window.Capacitor !== undefined &&
      typeof window.Capacitor.isNativePlatform === "function" &&
      window.Capacitor.isNativePlatform()
    );
  },

  // Returns "android", "ios", or "web"
  getPlatform() {
    if (this.isNative() && window.Capacitor.getPlatform) {
      return window.Capacitor.getPlatform();
    }
    return "web";
  },

  isAndroid() {
    return this.getPlatform() === "android";
  },

  isIOS() {
    return this.getPlatform() === "ios";
  },
};

Object.freeze(Platform);
window.Platform = Platform;
