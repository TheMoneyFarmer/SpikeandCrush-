'use strict';

// Sponsor logo + link validation. Logos are accepted as PNG, WebP or SVG
// only, decided by the file's actual bytes - never its name or the browser's
// claimed MIME type - so an .exe renamed to .png is rejected. SVGs are
// sanitised (no scripts, foreignObject, event handlers, external/JS links,
// DOCTYPE/entities) and re-checked; anything still suspicious is rejected.

const MAX_LOGO_BYTES = 1024 * 1024;

function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  const head = buf.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

const DANGEROUS_ELEMENTS = ['script', 'foreignObject', 'iframe', 'embed', 'object', 'handler', 'listener', 'set', 'animate', 'animateTransform', 'animateMotion'];
const STILL_DANGEROUS = /<\s*(\w+:)?(script|foreignObject|iframe|embed|object)\b|\son[a-z]+\s*=|javascript\s*:|<!ENTITY|<!DOCTYPE/i;

function sanitizeSvg(text) {
  let out = String(text);
  let prev;
  // Repeat until nothing changes, so nested tricks like <scr<script>ipt> don't survive.
  do {
    prev = out;
    out = out.replace(/<!DOCTYPE[\s\S]*?(\[[\s\S]*?\])?\s*>/gi, '').replace(/<!ENTITY[\s\S]*?>/gi, '');
    for (const tag of DANGEROUS_ELEMENTS) {
      const t = `(\\w+:)?${tag}`;
      out = out.replace(new RegExp(`<\\s*${t}\\b[\\s\\S]*?<\\s*/\\s*${t}\\s*>`, 'gi'), '');
      out = out.replace(new RegExp(`<\\s*${t}\\b[^>]*>`, 'gi'), '');
    }
    out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // Links may only point inside the document (#id) or at http(s).
    out = out.replace(/\s+((?:xlink:)?href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, attr, val) => {
      const v = val.replace(/^["']|["']$/g, '').trim();
      return /^(#|https?:\/\/)/i.test(v) ? m : '';
    });
    out = out.replace(/javascript\s*:/gi, '');
  } while (out !== prev);
  return out;
}

// Returns { ok, ext, contentType, buffer } or { ok: false, error }.
function validateLogo(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: 'No file uploaded' };
  if (buf.length > MAX_LOGO_BYTES) return { ok: false, error: 'Logo must be 1 MB or smaller' };
  const type = sniffImageType(buf);
  if (!type) return { ok: false, error: 'Logo must be a PNG, SVG or WebP image' };
  if (type === 'png') return { ok: true, ext: 'png', contentType: 'image/png', buffer: buf };
  if (type === 'webp') return { ok: true, ext: 'webp', contentType: 'image/webp', buffer: buf };
  const clean = sanitizeSvg(buf.toString('utf8'));
  if (STILL_DANGEROUS.test(clean) || !/<svg[\s>]/i.test(clean)) return { ok: false, error: 'SVG contains content that is not allowed' };
  return { ok: true, ext: 'svg', contentType: 'image/svg+xml', buffer: Buffer.from(clean, 'utf8'), sanitized: clean !== buf.toString('utf8') };
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

module.exports = { MAX_LOGO_BYTES, sniffImageType, sanitizeSvg, validateLogo, isHttpUrl };
