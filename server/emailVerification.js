'use strict';

// Email verification for password sign-ups. Whether an address is verified is
// stored by Supabase Auth (email_confirmed_at), so this needs no table: the
// link carries a signed, expiring token and the mail goes through Resend, the
// same sender as every other email.

const crypto = require('crypto');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function signingKey(secret) {
  return crypto.createHash('sha256').update(`email-verification:${secret}`).digest();
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', signingKey(secret)).update(payload).digest('base64url');
}

function createToken({ userId, email }, secret, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, e: String(email).toLowerCase(), x: now + TOKEN_TTL_MS })
  ).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

// Returns { userId, email }, { expired: true } when genuine but too old, or
// null for anything forged or malformed.
function readToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1000) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { u, e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!u || !e || !Number.isFinite(x)) return null;
    if (x <= now) return { expired: true };
    return { userId: u, email: e };
  } catch (err) {
    return null;
  }
}

// Stops the resend button being used to flood someone's inbox. In memory: a
// restart resetting it is harmless, and the route also has the per-IP limit.
function createResendGuard({ cooldownMs = 60 * 1000, maxPerHour = 5 } = {}) {
  const sent = new Map(); // account key -> timestamps
  return function allow(key, now = Date.now()) {
    const recent = (sent.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= maxPerHour || (recent.length && now - recent[recent.length - 1] < cooldownMs)) {
      sent.set(key, recent);
      return false;
    }
    recent.push(now);
    sent.set(key, recent);
    return true;
  };
}

function verificationEmail({ username, link }) {
  return {
    subject: 'Verify your Spike & Crush email',
    text: `Hi ${username},\n\nVerify your email to start playing:\n${link}\n\nThe link works for 24 hours. If you didn't sign up, you can ignore this email.`,
    html: `<p>Hi ${username},</p>
<p>Verify your email to start playing Spike &amp; Crush.</p>
<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#1fd38a;color:#0b1220;border-radius:8px;font-weight:700;text-decoration:none">Verify my email</a></p>
<p>The link works for 24 hours. If you didn't sign up, you can ignore this email.</p>`,
  };
}

function passwordResetEmail({ link }) {
  return {
    subject: 'Reset your Spike & Crush password',
    text: `Reset your Spike & Crush password:\n${link}\n\nIf you didn't ask for this, you can ignore this email and your password stays the same.`,
    html: `<p>Reset your Spike &amp; Crush password.</p>
<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#1fd38a;color:#0b1220;border-radius:8px;font-weight:700;text-decoration:none">Choose a new password</a></p>
<p>If you didn't ask for this, you can ignore this email and your password stays the same.</p>`,
  };
}

// The address links and redirects are built from. A caller's Origin header is
// only ever used if it is on the allowed list, because anyone can send any
// Origin, and this value ends up inside emails sent to players.
function publicSiteUrl({ origin, allowedOrigins = [], siteUrl, port }) {
  if (origin && allowedOrigins.includes(origin)) return origin;
  const configured = String(siteUrl || '')
    .replace(/\/$/, '')
    .replace('://spikeandcrush.com', '://www.spikeandcrush.com');
  if (configured) return configured;
  if (allowedOrigins.length) return allowedOrigins[0];
  if (origin && /^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  return `http://localhost:${port}`;
}

module.exports = { TOKEN_TTL_MS, createToken, readToken, createResendGuard, verificationEmail, passwordResetEmail, publicSiteUrl };
