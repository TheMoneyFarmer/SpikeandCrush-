'use strict';

// Player avatar validation, decided by the file's actual bytes - never the
// browser's claimed MIME type or the original filename. Before this, an
// .html file labelled image/png was stored with its .html extension and served
// as text/html from the game's own origin (audit URGENT 2: stored XSS that
// could read players' session tokens from localStorage).

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const TYPES = {
  png: { ext: 'png', contentType: 'image/png' },
  jpeg: { ext: 'jpg', contentType: 'image/jpeg' },
  gif: { ext: 'gif', contentType: 'image/gif' },
  webp: { ext: 'webp', contentType: 'image/webp' },
};

function sniffRasterImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const sig6 = buf.toString('ascii', 0, 6);
  if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Returns { ok: true, ext, contentType } or { ok: false, error }.
function validateAvatar(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: 'No file uploaded' };
  if (buf.length > MAX_AVATAR_BYTES) return { ok: false, error: 'Avatar must be 2 MB or smaller' };
  const type = sniffRasterImage(buf);
  if (!type) return { ok: false, error: 'Avatar must be a PNG, JPEG, GIF or WebP image' };
  // Polyglot guard: real images don't contain HTML/script markup near the start.
  const head = buf.subarray(0, 4096).toString('latin1').toLowerCase();
  if (/<\s*(script|html|svg|iframe|body)\b/.test(head)) return { ok: false, error: 'Image contains content that is not allowed' };
  return { ok: true, ...TYPES[type] };
}

module.exports = { MAX_AVATAR_BYTES, sniffRasterImage, validateAvatar };
