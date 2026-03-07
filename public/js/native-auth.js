/* native-auth.js — Auth bridge for Capacitor native app
 *
 * On native platforms the normal browser-based OAuth redirect doesn't work
 * inside the WebView. Instead we:
 *  1. Open /auth/login-native in the system browser (Chrome Custom Tab)
 *  2. The server does the OAuth dance and redirects back to the app via
 *     a deep link: com.coolmyll.moments365://auth/callback?sessionId=<sid>
 *  3. When the app receives the deep link it sets the session cookie so
 *     the WebView can make authenticated API requests.
 */
const NativeAuth = (() => {
  let _initialised = false;

  /** Set a cookie on the current domain (the Capacitor dev/prod server). */
  function _setSessionCookie(sessionId) {
    // The Express session middleware looks for the cookie named in
    // server.js (default "connect.sid"). We percent-encode the value
    // with the "s:" prefix that express-session expects for signed
    // cookies — but since we're passing the raw session ID the server
    // will still recognise it when it reads the store.  For simplicity
    // we set the unsigned form: express-session also accepts the plain
    // session ID as the cookie value (it just won't be signed).
    document.cookie = `connect.sid=s%3A${encodeURIComponent(sessionId)}; path=/; SameSite=Lax`;
  }

  /**
   * Initialise native auth listeners.  Call once at app startup.
   * On web this is a no-op.
   */
  async function init() {
    if (_initialised) return;
    if (!Platform.isNative()) return;
    _initialised = true;

    // Listen for deep link returns (the "appUrlOpen" event).
    const { App: CapApp } =
      await import("https://cdn.jsdelivr.net/npm/@capacitor/app@latest/+esm");
    CapApp.addListener("appUrlOpen", (event) => {
      console.log("[NativeAuth] Deep link received:", event.url);
      try {
        const url = new URL(event.url);
        if (url.host === "auth" && url.pathname === "/callback") {
          const sessionId = url.searchParams.get("sessionId");
          if (sessionId) {
            _setSessionCookie(sessionId);
            // Reload the app so it picks up the authenticated session
            window.location.replace("/");
          }
        }
      } catch (e) {
        console.error("[NativeAuth] Failed to process deep link:", e);
      }
    });
  }

  /**
   * Start the login flow by opening the system browser.
   * Returns a promise that resolves when the browser is opened (the actual
   * auth completion happens via the deep link listener above).
   */
  async function login() {
    const { Browser } =
      await import("https://cdn.jsdelivr.net/npm/@capacitor/browser@latest/+esm");

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
