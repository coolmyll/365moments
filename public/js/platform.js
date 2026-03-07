// Platform detection for 365 Moments
// Determines whether the app is running inside a Capacitor native shell
// or in a regular browser.

const Platform = {
  _isNative: null,

  // Returns true when running inside the Capacitor Android/iOS shell
  isNative() {
    if (this._isNative === null) {
      this._isNative =
        typeof window !== "undefined" &&
        window.Capacitor !== undefined &&
        window.Capacitor.isNativePlatform();
    }
    return this._isNative;
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
