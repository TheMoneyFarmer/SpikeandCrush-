'use strict';

// Shared check for the private bridge between the game server and the admin
// panel. Callers need the shared secret (compared in constant time) and must
// be on this machine, unless SUPPORT_BRIDGE_ALLOW_REMOTE=1. In production the
// two run as separate services, so remote mode relies on the secret alone:
// it refuses a secret shorter than 32 characters.
const crypto = require('crypto');

const MIN_REMOTE_SECRET = 32;

function bridgeCallAllowed(req) {
  const expected = process.env.INTERNAL_ADMIN_SECRET;
  const given = String(req.headers['x-internal-secret'] || '');
  if (!expected || given.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return false;
  if (process.env.SUPPORT_BRIDGE_ALLOW_REMOTE === '1') return expected.length >= MIN_REMOTE_SECRET;
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function requireBridgeSecret(req, res, next) {
  if (!bridgeCallAllowed(req)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

module.exports = { bridgeCallAllowed, requireBridgeSecret, MIN_REMOTE_SECRET };
