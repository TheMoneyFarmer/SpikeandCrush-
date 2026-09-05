'use strict';

window.TW = window.TW || {};

// Supabase Auth integration layer. Builds on top of the existing TW.setSession
// / TW.getToken / TW.api (main.js) rather than replacing them - those already
// do exactly what's needed for storing and sending the bearer token, and
// dozens of existing call sites depend on them working unchanged.
(function () {
  let supabaseClient = null;

  // The Supabase URL/anon key come from the server's own .env (via
  // /api/config/public) rather than being hardcoded here, so the same
  // client bundle works against dev or prod depending only on which
  // deployment served it. The anon key is safe to expose client-side by
  // design - RLS enforces access, not secrecy of this key. Every exported
  // TW.* function below awaits `ready` first so nothing races this fetch.
  const ready = (async () => {
    if (!window.supabase) {
      console.error('[auth.js] the Supabase JS CDN script must be included before auth.js');
      return;
    }
    let config;
    try {
      const res = await fetch('/api/config/public');
      config = await res.json();
    } catch (e) {
      console.error('[auth.js] could not load Supabase config from server:', e.message);
      return;
    }
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      console.error('[auth.js] server did not return a Supabase URL/anon key');
      return;
    }
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    window.supabaseClient = supabaseClient;

    setInterval(refreshTokenIfNeeded, 50 * 60 * 1000);

    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        // Only react if WE still think we're logged in - avoids a redirect
        // loop on pages the SDK considers "signed out" before a session was
        // ever established (e.g. a fresh tab that hasn't logged in yet).
        if (TW.getToken()) {
          TW.clearSession();
          if (window.location.pathname !== '/' && !window.location.pathname.startsWith('/index')) {
            window.location.href = '/';
          }
        }
      }
      if (event === 'TOKEN_REFRESHED' && session) {
        localStorage.setItem('sc_token', session.access_token);
      }
    });
  })();

  // Stores the token/player via the existing helpers (so TW.api/TW.connectSocket
  // keep working unchanged) AND hydrates the Supabase SDK's own session state
  // via setSession. That second part matters: our login/register/oauth-callback
  // endpoints hand back raw access_token/refresh_token strings from a
  // server-side sign-in, so the client SDK has no idea a session exists until
  // told - without this, getSession()/auto-refresh/onAuthStateChange would
  // silently never fire for email+password users (only OAuth users, who sign
  // in via the SDK directly, would get it for free).
  TW.establishSession = async function establishSession(token, refreshToken, player) {
    TW.setSession(token, player);
    await ready;
    if (refreshToken && supabaseClient) {
      try {
        await supabaseClient.auth.setSession({ access_token: token, refresh_token: refreshToken });
      } catch (e) {
        console.warn('[auth.js] setSession failed (token refresh will not work for this session):', e.message);
      }
    }
  };

  TW.loginWithGoogle = async function loginWithGoogle() {
    await ready;
    if (!supabaseClient) return TW.toast('Sign-in is unavailable right now', 'danger');
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth-callback` },
    });
    if (error) TW.toast(error.message, 'danger');
  };

  TW.loginWithApple = async function loginWithApple() {
    await ready;
    if (!supabaseClient) return TW.toast('Sign-in is unavailable right now', 'danger');
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'apple',
      options: { redirectTo: `${window.location.origin}/auth-callback` },
    });
    if (error) TW.toast(error.message, 'danger');
  };

  TW.handleForgotPassword = async function handleForgotPassword() {
    const email = prompt('Enter your email address:');
    if (!email) return;
    try {
      await TW.api('/api/auth/reset-password', { method: 'POST', body: { email } });
    } catch (e) {
      // The endpoint always returns success by design (never reveal whether
      // an email exists) - a thrown error here means the request itself
      // failed, not that the email was unknown.
    }
    alert('If that email exists, you will receive a reset link shortly.');
  };

  // Supabase access tokens are short-lived (1 hour) unlike the old 7-day
  // custom JWT, so this refresh loop is what keeps a long browsing/gameplay
  // session (e.g. a 20-minute Grand War) from silently expiring mid-match.
  async function refreshTokenIfNeeded() {
    if (!supabaseClient || !TW.getToken()) return null;
    try {
      const {
        data: { session },
        error,
      } = await supabaseClient.auth.getSession();
      if (error || !session) return null; // not hydrated (e.g. legacy tab) or genuinely signed out elsewhere
      if (session.access_token !== TW.getToken()) {
        localStorage.setItem('sc_token', session.access_token);
      }
      return session.access_token;
    } catch (e) {
      return null;
    }
  }
  TW.refreshTokenIfNeeded = async function refreshTokenIfNeededPublic() {
    await ready;
    return refreshTokenIfNeeded();
  };

  // Exposed so pages that touch window.supabaseClient directly (auth-callback,
  // reset-password) can await config load before checking it, instead of
  // racing the /api/config/public fetch this file kicks off above.
  TW.authReady = ready;
})();
