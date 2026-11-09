'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const v = require('../server/emailVerification');

const SECRET = 'test-secret';
const NOW = 1_800_000_000_000;

test('a verification token round-trips and lower-cases the email', () => {
  const token = v.createToken({ userId: 'u1', email: 'A@Example.com' }, SECRET, NOW);
  assert.deepStrictEqual(v.readToken(token, SECRET, NOW + 1000), { userId: 'u1', email: 'a@example.com' });
});

test('a verification token expires after 24 hours', () => {
  const token = v.createToken({ userId: 'u1', email: 'a@b.co' }, SECRET, NOW);
  assert.ok(v.readToken(token, SECRET, NOW + v.TOKEN_TTL_MS - 1).userId);
  assert.deepStrictEqual(v.readToken(token, SECRET, NOW + v.TOKEN_TTL_MS), { expired: true });
});

test('forged, altered and malformed tokens are refused', () => {
  const token = v.createToken({ userId: 'u1', email: 'a@b.co' }, SECRET, NOW);
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'victim', e: 'v@b.co', x: NOW + 1e9 })).toString('base64url');
  assert.strictEqual(v.readToken(token, 'other-secret', NOW), null);
  assert.strictEqual(v.readToken(`${forged}.${sig}`, SECRET, NOW), null);
  assert.strictEqual(v.readToken(`${payload}.`, SECRET, NOW), null);
  assert.strictEqual(v.readToken(`${token}.extra`, SECRET, NOW), null);
  for (const bad of ['', 'nope', null, undefined, 42, {}]) assert.strictEqual(v.readToken(bad, SECRET, NOW), null);
});

test('resending is limited per account', () => {
  const allow = v.createResendGuard({ cooldownMs: 60000, maxPerHour: 3 });
  assert.strictEqual(allow('a', NOW), true);
  assert.strictEqual(allow('a', NOW + 1000), false, 'inside the cooldown');
  assert.strictEqual(allow('b', NOW + 1000), true, 'other accounts are separate');
  assert.strictEqual(allow('a', NOW + 61000), true);
  assert.strictEqual(allow('a', NOW + 122000), true);
  assert.strictEqual(allow('a', NOW + 183000), false, 'hourly cap');
  assert.strictEqual(allow('a', NOW + 3600000 + 2000), true, 'cap clears after the hour');
});

test('links never use an Origin that is not on the allowed list', () => {
  const live = { allowedOrigins: ['https://www.spikeandcrush.com'], siteUrl: 'https://spikeandcrush.com/', port: 3000 };
  assert.strictEqual(v.publicSiteUrl({ ...live, origin: 'https://evil.example' }), 'https://www.spikeandcrush.com');
  assert.strictEqual(v.publicSiteUrl({ ...live, origin: undefined }), 'https://www.spikeandcrush.com');
  assert.strictEqual(v.publicSiteUrl({ ...live, origin: 'https://www.spikeandcrush.com' }), 'https://www.spikeandcrush.com');
  assert.strictEqual(
    v.publicSiteUrl({ origin: 'https://evil.example', allowedOrigins: ['https://www.spikeandcrush.com'], port: 3000 }),
    'https://www.spikeandcrush.com'
  );
  assert.strictEqual(v.publicSiteUrl({ origin: 'https://evil.example', port: 3000 }), 'http://localhost:3000');
  assert.strictEqual(v.publicSiteUrl({ origin: 'http://localhost:3078', port: 3000 }), 'http://localhost:3078');
});

test('every outside script is pinned to an exact version with a tamper check', () => {
  const dir = path.join(__dirname, '..', 'client');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const [tag] of html.matchAll(/<script\b[^>]*\bsrc="https?:\/\/[^>]*>/g)) {
      assert.match(tag, /integrity="sha384-/, `${file}: ${tag}`);
      assert.match(tag, /crossorigin="anonymous"/, `${file}: ${tag}`);
      assert.match(tag, /@\d+\.\d+\.\d+\//, `${file}: ${tag}`);
    }
  }
});

test('every browser script parses', () => {
  const vm = require('node:vm');
  const dir = path.join(__dirname, '..', 'client', 'js');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8');
    if (/^\s*(import|export)\s/m.test(code)) continue; // ES modules can't be compiled as plain scripts
    assert.doesNotThrow(() => new vm.Script(code, { filename: file }), file);
  }
});
