'use strict';

// Regression tests for the 2026-11-08 security fixes (docs/AUDIT_REPORT.md).
const test = require('node:test');
const assert = require('node:assert');
const { validateAvatar, sniffRasterImage } = require('../server/imageValidation');
const { securityHeaders, buildCsp } = require('../server/securityHeaders');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);

test('avatar: real images are accepted with an extension from their bytes', () => {
  assert.deepStrictEqual(validateAvatar(PNG), { ok: true, ext: 'png', contentType: 'image/png' });
  assert.strictEqual(validateAvatar(JPEG).ext, 'jpg');
  assert.strictEqual(validateAvatar(GIF).ext, 'gif');
  assert.strictEqual(validateAvatar(WEBP).ext, 'webp');
});

test('avatar: HTML labelled as an image is rejected (audit URGENT 2)', () => {
  const html = Buffer.from('<script>document.title="XSS"</script>harmless');
  assert.strictEqual(sniffRasterImage(html), null);
  assert.strictEqual(validateAvatar(html).ok, false);
});

test('avatar: SVG and polyglots are rejected', () => {
  assert.strictEqual(validateAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>')).ok, false);
  const polyglot = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('<script>alert(1)</script>'), Buffer.alloc(64)]);
  assert.strictEqual(validateAvatar(polyglot).ok, false);
});

test('avatar: size limit', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
  assert.strictEqual(validateAvatar(big).ok, false);
});

test('security headers are all set', () => {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, removeHeader: () => {} };
  securityHeaders()({ secure: true }, res, () => {});
  for (const h of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'strict-transport-security', 'permissions-policy']) {
    assert.ok(headers[h], `missing ${h}`);
  }
  assert.strictEqual(headers['x-content-type-options'], 'nosniff');
});

test('CSP blocks framing, plugins and unknown script hosts', () => {
  const csp = buildCsp({ supabaseUrl: 'https://abc.supabase.co' });
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /connect-src [^;]*https:\/\/abc\.supabase\.co/);
  assert.doesNotMatch(csp.match(/script-src[^;]*/)[0], /\*/);
});

test('admin 2FA: a code matches its time step, and only around now', () => {
  const { generateSecret, generateTotp, matchTotpStep } = require('../server/totp');
  const secret = generateSecret();
  const at = 1800000000000;
  const step = Math.floor(at / 30000);
  assert.strictEqual(matchTotpStep(secret, generateTotp(secret, { at }), { at }), step);
  assert.strictEqual(matchTotpStep(secret, generateTotp(secret, { at: at - 30000 }), { at }), step - 1);
  assert.strictEqual(matchTotpStep(secret, generateTotp(secret, { at: at - 300000 }), { at }), null);
  assert.strictEqual(matchTotpStep(secret, 'abcdef', { at }), null);
});

test('admin 2FA: secret is encrypted at rest and bound to ADMIN_SECRET', () => {
  process.env.ADMIN_SECRET = 'test-secret-a';
  const tf = require('../admin/lib/twoFactor');
  const stored = tf.encryptSecret('JBSWY3DPEHPK3PXP');
  assert.ok(!stored.includes('JBSWY3DPEHPK3PXP'));
  assert.strictEqual(tf.decryptSecret(stored), 'JBSWY3DPEHPK3PXP');
  process.env.ADMIN_SECRET = 'test-secret-b';
  assert.throws(() => tf.decryptSecret(stored));
});

test('admin 2FA: a setup token is not an admin session', () => {
  process.env.ADMIN_SECRET = 'test-secret-a';
  const jwt = require('jsonwebtoken');
  const tf = require('../admin/lib/twoFactor');
  const token = tf.signSetupToken('admin-1');
  assert.strictEqual(tf.readSetupToken(token), 'admin-1');
  assert.strictEqual(jwt.decode(token).role, undefined);
  const session = jwt.sign({ username: 'x', role: 'admin' }, process.env.ADMIN_SECRET);
  assert.strictEqual(tf.readSetupToken(session), null);
  assert.strictEqual(tf.readSetupToken('garbage'), null);
});

test('admin 2FA: wrong codes are capped per account', () => {
  const tf = require('../admin/lib/twoFactor');
  const now = 1000000;
  for (let i = 0; i < 9; i++) tf.noteCodeFailure('a', now);
  assert.strictEqual(tf.codeAttemptsBlocked('a', now), false);
  tf.noteCodeFailure('a', now);
  assert.strictEqual(tf.codeAttemptsBlocked('a', now), true);
  assert.strictEqual(tf.codeAttemptsBlocked('a', now + 16 * 60 * 1000), false);
  tf.clearCodeFailures('a');
  assert.strictEqual(tf.codeAttemptsBlocked('a', now), false);
});
