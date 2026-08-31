'use strict';

const crypto = require('crypto');

// Minimal RFC 4226 / RFC 6238 (HOTP/TOTP) implementation - no external
// service, no network calls. Secrets are base32-encoded per the standard
// otpauth:// URI format so any authenticator app (Google Authenticator,
// Authy, 1Password, etc.) can scan the QR code.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder) {
    const chunk = bits.slice(bits.length - remainder).padEnd(5, '0');
    output += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return output;
}

function base32Decode(base32) {
  const clean = base32.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160-bit secret, standard for TOTP
}

function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binCode % 1000000).padStart(6, '0');
}

function generateTotp(secretBase32, { step = 30, at = Date.now() } = {}) {
  const counter = Math.floor(at / 1000 / step);
  return hotp(secretBase32, counter);
}

// Accepts a code from the current window or one step before/after to absorb
// clock drift between the server and the user's device.
function verifyTotp(secretBase32, token, { step = 30, window = 1, at = Date.now() } = {}) {
  if (!/^\d{6}$/.test(String(token || ''))) return false;
  const counter = Math.floor(at / 1000 / step);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    if (hotp(secretBase32, counter + errorWindow) === String(token)) return true;
  }
  return false;
}

function buildOtpAuthUri({ secret, accountName, issuer = 'Spike & Crush' }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, generateTotp, verifyTotp, buildOtpAuthUri };
