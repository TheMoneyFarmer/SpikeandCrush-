'use strict';

// Minimal transactional email sender via Resend's plain HTTP API (no SDK
// dependency needed - it's a single POST). Used right now only for prize
// claim status emails (see routes/monetisation.js's /prize-claims/:id/paid
// and /reject). Silently no-ops (with a console warning) if RESEND_API_KEY
// isn't set, so the rest of the claim-processing flow keeps working in an
// environment that hasn't configured email yet - the in-app notification
// still goes out either way.
// idempotencyKey: Resend drops a repeat with the same key (24h), so a double
// click or a retry can never send the same email twice.
const { createEmailGuard } = require('./emailGuard');

const guard = createEmailGuard();

// isAlert: our own alert emails, which always go out (and are what the daily
// cap alert itself is sent as).
async function sendEmail({ to, subject, html, text, idempotencyKey, isAlert = false }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || 'Spike & Crush <hello@spikeandcrush.com>';
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set - skipping email (subject:', subject + ')');
    return { skipped: true };
  }
  const allowed = guard.check(to, { isAlert });
  if (!allowed.ok) {
    console.warn('[email] not sent:', allowed.reason, '(subject:', subject + ')');
    return { skipped: true, reason: allowed.reason };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      signal: AbortSignal.timeout(10000),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {}),
      },
      body: JSON.stringify(text ? { from, to, subject, html, text } : { from, to, subject, html }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[email] Resend responded', res.status, JSON.stringify(json));
      return { skipped: false, error: json };
    }
    const level = isAlert ? null : guard.record(to);
    if (level) {
      const st = guard.stats();
      sendEmail({
        to: process.env.ALERT_EMAIL || 'hello@spikeandcrush.com',
        isAlert: true,
        idempotencyKey: `email-daily-cap:${st.day}:${level}`,
        subject: `Email sending at ${level}% of today's cap`,
        text: `This server has sent ${st.sentToday} of ${st.dailyCap} emails today.${level >= 100 ? ' No more go out until midnight UTC, except alerts.' : ''} Raise EMAIL_DAILY_CAP on Railway if this is real traffic.`,
      }).catch(() => {});
    }
    return { skipped: false, id: json.id };
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return { skipped: false, error: e.message };
  }
}

// Shared {{placeholder}} substitution for admin-editable templates
// (message_templates table) - an unrecognized {{key}} is left as-is rather
// than silently dropped, so a typo'd placeholder in the admin editor is
// obvious in the sent email instead of just vanishing.
function renderTemplate(text, data = {}) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, key) => (key in data ? data[key] : m));
}

module.exports = { sendEmail, renderTemplate, emailStats: () => guard.stats() };
