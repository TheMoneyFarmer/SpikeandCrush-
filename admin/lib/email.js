'use strict';

// Minimal transactional email sender via Resend's plain HTTP API (no SDK
// dependency needed - it's a single POST). Used right now only for prize
// claim status emails (see routes/monetisation.js's /prize-claims/:id/paid
// and /reject). Silently no-ops (with a console warning) if RESEND_API_KEY
// isn't set, so the rest of the claim-processing flow keeps working in an
// environment that hasn't configured email yet - the in-app notification
// still goes out either way.
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || 'Spike & Crush <hello@spikeandcrush.com>';
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set - skipping email to', to, '(subject:', subject + ')');
    return { skipped: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[email] Resend responded', res.status, JSON.stringify(json));
      return { skipped: false, error: json };
    }
    return { skipped: false, id: json.id };
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return { skipped: false, error: e.message };
  }
}

module.exports = { sendEmail };
