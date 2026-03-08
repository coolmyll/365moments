/* native-auth.js — Auth bridge for Capacitor native app
 *
 * On native platforms the OAuth flow runs in the system browser.
 * After Google login, the server redirects back via deep link with a
 * one-time token. The app exchanges that token for a real WebView session.
 */
const NativeAuth = (() => {
  let _initialised = false;

  async function _handleIncomingUrl(urlString, browser) {
    console.log("[NativeAuth] Deep link received:", urlString);

    try {
      const url = new URL(urlString);
      if (url.host === "auth" && url.pathname === "/callback") {
        const token = url.searchParams.get("token");
        if (token) {
          await _exchangeToken(token);
          if (browser?.close) {
            await browser.close();
          }
          window.location.replace("/");
        }
      }
    } catch (error) {
      console.error("[NativeAuth] Failed to process deep link:", error);
    }
  }

  function _getPlugins() {
    const plugins = window.Capacitor?.Plugins || {};
    return {
      App: plugins.App,
      Browser: plugins.Browser,
    };
  }

  async function _exchangeToken(token) {
    const response = await fetch(
      `/auth/token-exchange?token=${encodeURIComponent(token)}`,
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
      await _handleIncomingUrl(event.url, Browser);
    });

    if (App.getLaunchUrl) {
      const launchUrl = await App.getLaunchUrl();
      if (launchUrl?.url) {
        await _handleIncomingUrl(launchUrl.url, Browser);
      }
    }
  }

  /** Start the login flow by opening the system browser. */
  async function login() {
    const { Browser } = _getPlugins();
    if (!Browser?.open) {
      throw new Error("Capacitor Browser plugin is unavailable");
    }

    const loginUrl = `${window.location.origin}/auth/login?from=app`;
    console.log("[NativeAuth] Opening system browser:", loginUrl);
    await Browser.open({ url: loginUrl });
  }

  return { init, login };
})();
