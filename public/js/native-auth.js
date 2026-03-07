/* native-auth.js — Auth bridge for Capacitor native app
 *
 * On native platforms the OAuth flow runs in the system browser.
 * After Google login, the server redirects back via deep link with a
 * one-time token. The app exchanges that token for a real WebView session.
 */
const NativeAuth = (() => {
  let _initialised = false;

  function _getPlugins() {
    const plugins = window.Capacitor?.Plugins || {};
    return {
      App: plugins.App,
      Browser: plugins.Browser,
    };
  }

  async function _exchangeToken(token) {
    const response = await fetch(
      `/auth/token-exchange-native?token=${encodeURIComponent(token)}`,
      {
        credentials: "include",
      },
    );

    if (!response.ok) {
      throw new Error(`Token exchange failed (${response.status})`);
    }

    return response.json();
  }

  /**
   * Initialise native auth listeners.  Call once at app startup.
   * On web this is a no-op.
   */
  async function init() {
    if (_initialised) return;
    if (!Platform.isNative()) return;
    _initialised = true;

    const { App, Browser } = _getPlugins();
    if (!App) {
      console.error("[NativeAuth] Capacitor App plugin is unavailable");
      return;
    }

    App.addListener("appUrlOpen", async (event) => {
      console.log("[NativeAuth] Deep link received:", event.url);
      try {
        const url = new URL(event.url);
        if (url.host === "auth" && url.pathname === "/callback") {
          const token = url.searchParams.get("token");
          if (token) {
            await _exchangeToken(token);
            if (Browser?.close) {
              await Browser.close();
            }
            window.location.replace("/");
          }
        }
      } catch (e) {
        console.error("[NativeAuth] Failed to process deep link:", e);
      }
    });
  }

  /** Start the login flow by opening the system browser. */
  async function login() {
    const { Browser } = _getPlugins();
    if (!Browser?.open) {
      throw new Error("Capacitor Browser plugin is unavailable");
    }

    // Determine the server URL.  In dev mode the Capacitor config
    // points the WebView at http://10.0.2.2:3000 but the system
    // browser runs outside the emulator so it should use localhost
    // or the real hostname.  We read the current origin which is
    // already correct from the WebView's perspective — the server
    // itself resolves the right base URL via getBaseUrl().
    const loginUrl = `${window.location.origin}/auth/login-native`;
    console.log("[NativeAuth] Opening system browser:", loginUrl);

    await Browser.open({ url: loginUrl });
  }

  return { init, login };
})();
