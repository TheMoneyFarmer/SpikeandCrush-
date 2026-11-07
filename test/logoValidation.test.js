'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateLogo, sanitizeSvg, isHttpUrl } = require('../admin/lib/logoValidation');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

test('real PNG accepted', () => {
  const r = validateLogo(PNG);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.contentType, 'image/png');
});

test('exe renamed to .png rejected (bytes decide, not the name)', () => {
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
  const r = validateLogo(exe);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /PNG, SVG or WebP/);
});

test('oversized file rejected', () => {
  assert.strictEqual(validateLogo(Buffer.concat([PNG, Buffer.alloc(1024 * 1024)])).ok, false);
});

test('SVG script, foreignObject, handlers and JS links are stripped', () => {
  const evil = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]>
<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" width="10" height="10">
  <script>alert('xss')</script><svg:script>alert(2)</svg:script>
  <foreignObject><iframe src="https://evil.example"></iframe></foreignObject>
  <a xlink:href="javascript:alert(3)"><rect width="10" height="10" onclick='steal()' fill="#F5B83D"/></a>
  <scr<script>ipt>alert(4)</script>
</svg>`;
  const r = validateLogo(Buffer.from(evil));
  assert.strictEqual(r.ok, true, r.error);
  const out = r.buffer.toString();
  for (const bad of [/<script/i, /alert\(/, /foreignObject/i, /onload/i, /onclick/i, /javascript:/i, /<!ENTITY/i, /iframe/i]) {
    assert.doesNotMatch(out, bad);
  }
  assert.match(out, /<rect/);
  assert.strictEqual(r.sanitized, true);
});

test('clean SVG passes untouched', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 3h18v18H3z"/></svg>';
  assert.strictEqual(sanitizeSvg(svg), svg);
});

test('sponsor links: http(s) only', () => {
  assert.strictEqual(isHttpUrl('https://broker.example/promo'), true);
  assert.strictEqual(isHttpUrl('http://broker.example'), true);
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,hi', 'ftp://x.example', '//evil.example', 'not a url', '']) {
    assert.strictEqual(isHttpUrl(bad), false, bad);
  }
});
