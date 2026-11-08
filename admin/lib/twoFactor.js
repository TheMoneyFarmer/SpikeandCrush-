'use strict';

// Admin two-factor login (authenticator-app codes). Works from any place and any
// machine, which is why it replaces the idea of an IP allowlist.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { generateSecret, matchTotpStep, buildOtpAuthUri } = require('../../server/totp');

const SETUP_TOKEN_MINUTES = 10;
const CODE_FAILURE_LIMIT = 10;
const CODE_FAILURE_WINDOW_MS = 15 * 60 * 1000;

// ADMIN_REQUIRE_2FA=1 turns off the shared ADMIN_USERNAME/ADMIN_PASSWORD login
// (it has no phone attached) and refuses to log in without the 2FA columns.
const twoFactorRequired = () => process.env.ADMIN_REQUIRE_2FA === '1';

// The secret is encrypted at rest, so a leaked database alone can't produce codes.
const encryptionKey = () => crypto.createHash('sha256').update(`admin-totp:${process.env.ADMIN_SECRET}`).digest();

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

function decryptSecret(stored) {
  const [iv, tag, body] = String(stored).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

// Proves the password was right a moment ago. It has no admin role, so requireAdmin
// and sessionStillValid refuse it everywhere except the two setup endpoints.
function signSetupToken(adminId) {
  return jwt.sign({ purpose: 'totp_setup', adminId }, process.env.ADMIN_SECRET, { expiresIn: `${SETUP_TOKEN_MINUTES}m`, algorithm: 'HS256' });
}

function readSetupToken(token) {
  try {
    const decoded = jwt.verify(String(token || ''), process.env.ADMIN_SECRET, { algorithms: ['HS256'] });
    return decoded.purpose === 'totp_setup' ? decoded.adminId : null;
  } catch (e) {
    return null;
  }
}

// Per account, across every IP: the login lockout is per username+IP, and a six-digit
// code needs its own ceiling against someone who already has the password.
const codeFailures = new Map();

function codeAttemptsBlocked(adminId, now = Date.now()) {
  const entry = codeFailures.get(adminId);
  if (!entry || now - entry.first > CODE_FAILURE_WINDOW_MS) return false;
  return entry.count >= CODE_FAILURE_LIMIT;
}

function noteCodeFailure(adminId, now = Date.now()) {
  const entry = codeFailures.get(adminId);
  if (!entry || now - entry.first > CODE_FAILURE_WINDOW_MS) codeFailures.set(adminId, { count: 1, first: now });
  else entry.count += 1;
}

const clearCodeFailures = (adminId) => codeFailures.delete(adminId);

module.exports = {
  twoFactorRequired, encryptSecret, decryptSecret, signSetupToken, readSetupToken,
  codeAttemptsBlocked, noteCodeFailure, clearCodeFailures,
  generateSecret, matchTotpStep, buildOtpAuthUri,
};
