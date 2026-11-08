'use strict';

// One-image attachments for support chat: png / jpg / webp, max 3 MB.
// - The type is decided from the file's magic bytes, never from its name or
//   the browser's Content-Type, so an .exe renamed .png is rejected.
// - Metadata (EXIF incl. GPS, XMP, IPTC, text chunks, comments) is stripped
//   by rewriting the container without those segments - no image decoding,
//   no native dependency, pixels untouched.
// - Files live in the private 'support-attachments' bucket and are only ever
//   reached via a 60-second signed URL minted after an ownership check.

const crypto = require('crypto');

const BUCKET = 'support-attachments';
const MAX_BYTES = 3 * 1024 * 1024;
const SIGNED_URL_SECONDS = 60;

function sniff(buf) {
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

// JPEG: keep SOI, drop APP1 (EXIF/XMP), APP12-APP15 (incl. APP13 IPTC) and
// COM segments; copy everything from SOS to the end unchanged.
function stripJpeg(buf) {
  const out = [buf.slice(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw new Error('Corrupt JPEG');
    const marker = buf[i + 1];
    if (marker === 0xd9) {
      out.push(buf.slice(i, i + 2));
      return Buffer.concat(out);
    }
    if (marker === 0xda) {
      out.push(buf.slice(i));
      return Buffer.concat(out);
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      out.push(buf.slice(i, i + 2));
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw new Error('Corrupt JPEG');
    const drop = marker === 0xe1 || (marker >= 0xec && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(buf.slice(i, i + 2 + len));
    i += 2 + len;
  }
  throw new Error('Corrupt JPEG');
}

// PNG: drop eXIf, tEXt, iTXt, zTXt and tIME chunks; others are copied as-is
// (each chunk carries its own CRC, so nothing needs recomputing).
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
function stripPng(buf) {
  const out = [buf.slice(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw new Error('Corrupt PNG');
    if (!PNG_DROP.has(type)) out.push(buf.slice(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

// WebP: drop EXIF and XMP chunks, clear their flags in VP8X, fix RIFF size.
function stripWebp(buf) {
  const chunks = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (end > buf.length + 1) throw new Error('Corrupt WebP');
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      const chunk = Buffer.from(buf.slice(i, Math.min(end, buf.length)));
      if (fourcc === 'VP8X') chunk[8] &= ~(0x08 | 0x04); // EXIF + XMP flags
      chunks.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

function validateAndStrip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { error: 'The file is empty.' };
  if (buf.length > MAX_BYTES) return { error: 'Images must be 3 MB or smaller.' };
  const kind = sniff(buf);
  if (!kind) return { error: 'Only PNG, JPG or WebP images can be attached.' };
  let clean;
  try {
    clean = kind.mime === 'image/jpeg' ? stripJpeg(buf) : kind.mime === 'image/png' ? stripPng(buf) : stripWebp(buf);
  } catch (e) {
    return { error: 'That image could not be read. Try another file.' };
  }
  return { ...kind, buffer: clean };
}

function createUploads(supabase) {
  async function store(conversationId, buf) {
    const v = validateAndStrip(buf);
    if (v.error) return v;
    const path = `${conversationId}/${crypto.randomUUID()}.${v.ext}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, v.buffer, { contentType: v.mime, upsert: false });
    if (error) throw error;
    return { path, mime: v.mime, size: v.buffer.length };
  }

  async function signedUrl(path) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
    if (error) throw error;
    return data.signedUrl;
  }

  return { store, signedUrl };
}

module.exports = { createUploads, validateAndStrip, sniff, stripJpeg, stripPng, stripWebp, MAX_BYTES, BUCKET, SIGNED_URL_SECONDS };
