'use strict';

// Forgot password, step 1. The server answers the same way for every email
// (account or not), so this page always shows the same message.
(function () {
  const form = document.getElementById('forgotForm');
  const done = document.getElementById('forgotDone');
  const errEl = document.getElementById('forgotError');
  const email = document.getElementById('forgotEmail');
  const btn = document.getElementById('forgotSubmit');
  const prefill = new URLSearchParams(location.search).get('email');
  if (prefill) email.value = prefill;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const value = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      errEl.textContent = 'Enter a valid email address.';
      email.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      const res = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: value }) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429 || res.status === 400) {
        errEl.textContent = data.error || 'Please try again later.';
      } else {
        form.classList.add('hidden');
        done.classList.remove('hidden');
        document.getElementById('forgotAgain').focus();
      }
    } catch (err) {
      errEl.textContent = 'Could not reach the server. Check your connection and try again.';
    }
    btn.disabled = false;
    btn.textContent = 'Send reset link';
  });

  document.getElementById('forgotAgain').addEventListener('click', () => {
    done.classList.add('hidden');
    form.classList.remove('hidden');
    email.value = '';
    email.focus();
  });
})();
