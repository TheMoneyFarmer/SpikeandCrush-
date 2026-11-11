'use strict';

// Outbound destinations and referral, IB and discount codes are company
// revenue: encrypted at rest (AES-256-GCM) and only ever read server-side by
// the /go/ redirect and by a super admin's "reveal". The key comes from env
// LISTING_SECRETS_KEY (32 bytes, base64 or hex). There is no default key: with
// no key, nothing can be saved and every outbound link counts as not set up.

const crypto = require('crypto');

function key() {
  const raw = process.env.LISTING_SECRETS_KEY;
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

const configured = () => Boolean(key());

function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const k = key();
  if (!k) throw Object.assign(new Error('LISTING_SECRETS_KEY is not set, so links and codes cannot be saved'), { status: 503 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

function decrypt(blob) {
  if (!blob) return null;
  const k = key();
  if (!k) return null;
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

// "AB12-SECRET" -> "AB•••••••ET"; never more than 4 characters shown.
function mask(plain) {
  if (!plain) return '';
  const s = String(plain);
  if (s.length <= 4) return '•'.repeat(s.length);
  return `${s.slice(0, 2)}${'•'.repeat(Math.min(12, s.length - 4))}${s.slice(-2)}`;
}

// The outbound URL with codes appended. Returns null when not set up or not https.
function outboundUrl(secret, { utm = {} } = {}) {
  if (!secret) return null;
  const base = decrypt(secret.outbound_enc);
  if (!base) return null;
  let u;
  try { u = new URL(base); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  for (const [p, enc] of [[secret.ref_param, secret.ref_code_enc], [secret.ib_param, secret.ib_code_enc], [secret.discount_param, secret.discount_code_enc]]) {
    const v = decrypt(enc);
    if (p && v) u.searchParams.set(p, v);
  }
  for (const [k, v] of Object.entries(utm)) if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
}

module.exports = { encrypt, decrypt, mask, outboundUrl, configured };
