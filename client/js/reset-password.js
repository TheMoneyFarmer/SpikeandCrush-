'use strict';

// Reset password, step 2 (the link from the email). Supabase turns the link
// into a recovery session (PASSWORD_RECOVERY). The new password goes to our
// server with that session (/api/auth/complete-reset), which applies the
// password rules, signs out every other device and sends a confirmation
// email; this device stays signed in and goes to the game. An expired, used
// or broken link shows a page with a button for a new one, never a blank page.

(function () {
  const $ = (id) => document.getElementById(id);
  const statusEl = $('resetStatus');
  const formEl = $('resetForm');
  const expiredEl = $('resetExpired');
  const errEl = $('resetError');

  document.querySelectorAll('[data-eye]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });

  function showExpired() {
    statusEl.classList.add('hidden');
    formEl.classList.add('hidden');
    expiredEl.classList.remove('hidden');
  }

  function rulesProblem(pw) {
    if (pw.length < 8) return 'Use at least 8 characters.';
    if (pw.length > 72) return 'Use at most 72 characters.';
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letters and at least one number.';
    return null;
  }

  async function start() {
    // Supabase puts link errors in the address (expired, already used, bad link).
    const hash = new URLSearchParams(location.hash.slice(1));
    const query = new URLSearchParams(location.search);
    if (hash.get('error') || hash.get('error_code') || query.get('error') || query.get('error_code')) return showExpired();

    if (window.TW && TW.authReady) await TW.authReady;
    const sb = window.supabaseClient;
    if (!sb) {
      statusEl.textContent = 'Sign-in service is unavailable right now. Please try again in a minute.';
      return;
    }
    // The recovery session arrives with the page; wait briefly for it.
    let session = null;
    const recovered = new Promise((resolve) => {
      const { data } = sb.auth.onAuthStateChange((event, s) => {
        if (event === 'PASSWORD_RECOVERY' && s) resolve(s);
      });
      setTimeout(() => {
        data?.subscription?.unsubscribe?.();
        resolve(null);
      }, 4000);
    });
    const first = await sb.auth.getSession();
    session = (first && first.data && first.data.session) || (await recovered);
    if (!session) return showExpired();

    statusEl.classList.add('hidden');
    formEl.classList.remove('hidden');
    $('newPassword').focus();

    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.textContent = '';
      const pw = $('newPassword').value;
      const problem = rulesProblem(pw);
      if (problem) {
        errEl.textContent = problem;
        return;
      }
      if (pw !== $('confirmPassword').value) {
        errEl.textContent = 'The two passwords do not match.';
        return;
      }
      const btn = $('resetSubmit');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const res = await fetch('/api/auth/complete-reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ password: pw }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (data.expired || res.status === 401) return showExpired();
          errEl.textContent = data.error || 'Could not save your password. Please try again.';
          btn.disabled = false;
          btn.textContent = 'Save new password';
          return;
        }
        formEl.classList.add('hidden');
        $('resetSuccess').classList.remove('hidden');
        // Signed in fresh on this device with the session from the link.
        const me = await fetch('/api/player/me', { headers: { Authorization: `Bearer ${session.access_token}` } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        // The Supabase client already holds this session (from the link), so
        // only our own login needs storing; asking the client to set it again
        // while it is still settling the recovery session can hang.
        if (window.TW && TW.setSession) TW.setSession(session.access_token, me && (me.player || me));
        history.replaceState(null, '', '/reset-password');
        setTimeout(() => { location.href = '/play'; }, 2000);
      } catch (err) {
        errEl.textContent = 'Could not reach the server. Check your connection and try again.';
        btn.disabled = false;
        btn.textContent = 'Save new password';
      }
    });
  }

  start();
})();
