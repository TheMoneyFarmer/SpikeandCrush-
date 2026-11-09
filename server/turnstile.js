'use strict';

// Cloudflare Turnstile on sign-up, to keep scripts from mass-creating accounts.
// Off until both keys are set. If Cloudflare can't be reached the sign-up goes
// ahead: an outage on their side must not stop real players joining.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const siteKey = () => process.env.TURNSTILE_SITE_KEY || null;
const isOn = () => Boolean(process.env.TURNSTILE_SECRET_KEY && process.env.TURNSTILE_SITE_KEY);

async function verifyTurnstile(token, ip, fetchImpl = fetch) {
  if (!isOn()) return true;
  if (!token) return false;
  try {
    const res = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET_KEY, response: String(token).slice(0, 2048), remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    console.warn('[turnstile] could not reach Cloudflare, allowing this sign-up:', e.message);
    return true;
  }
}

module.exports = { verifyTurnstile, isOn, siteKey };
