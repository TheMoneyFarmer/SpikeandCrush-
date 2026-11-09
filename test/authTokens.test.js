'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTokenVerifier } = require('../server/authTokens');

const URL_ = 'https://proj.supabase.co';
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' };
const NOW = 1_800_000_000_000;

function sign(claims, { key = privateKey, kid = 'k1', alg = 'ES256' } = {}) {
  const head = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const good = (extra = {}) => ({ iss: `${URL_}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: 'user-1', email: 'a@b.c', exp: NOW / 1000 + 3600, user_metadata: { email_verified: true }, app_metadata: { provider: 'email' }, ...extra });

function setup({ jwksOk = true, remote = null } = {}) {
  const calls = { jwks: 0, remote: 0 };
  const fetchImpl = async () => { calls.jwks++; return jwksOk ? { ok: true, json: async () => ({ keys: [jwk] }) } : { ok: false, status: 503 }; };
  const supabaseAdmin = { auth: { getUser: async () => { calls.remote++; return remote ? { data: { user: remote }, error: null } : { data: { user: null }, error: { message: 'bad' } }; } } };
  const v = createTokenVerifier({ supabaseUrl: URL_, supabaseAdmin, fetchImpl, now: () => NOW });
  return { v, calls };
}

test('a valid token is checked locally, with no call to Supabase Auth', async () => {
  const { v, calls } = setup();
  for (let i = 0; i < 50; i++) {
    const user = await v.getUser(sign(good()), { requireVerifiedEmail: true });
    assert.strictEqual(user.id, 'user-1');
    assert.ok(user.email_confirmed_at);
    assert.strictEqual(user.app_metadata.provider, 'email');
  }
  assert.strictEqual(calls.remote, 0);
  assert.strictEqual(calls.jwks, 1, 'keys fetched once and reused');
});

test('forged, tampered, expired or wrong-project tokens are refused', async () => {
  const { v, calls } = setup();
  assert.strictEqual(await v.getUser(sign(good(), { key: other.privateKey })), null, 'signed with another key');
  const t = sign(good()).split('.');
  const tampered = `${t[0]}.${Buffer.from(JSON.stringify(good({ sub: 'someone-else' }))).toString('base64url')}.${t[2]}`;
  assert.strictEqual(await v.getUser(tampered), null, 'claims changed after signing');
  assert.strictEqual(await v.getUser(sign(good({ exp: NOW / 1000 - 120 }))), null, 'expired');
  assert.strictEqual(await v.getUser(sign(good({ iss: 'https://evil.supabase.co/auth/v1' }))), null, 'other project');
  assert.strictEqual(await v.getUser(sign(good({ aud: 'service' }))), null, 'wrong audience');
  assert.strictEqual(await v.getUser(sign(good({ role: 'anon' }))), null, 'anon role');
  assert.strictEqual(await v.getUser('not.a.token'), null);
  assert.strictEqual(await v.getUser(''), null);
  assert.strictEqual(calls.remote, 0, 'never needed Supabase to say no');
});

test('alg "none" and shared-secret tokens are never trusted locally', async () => {
  const { v, calls } = setup();
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')}.${Buffer.from(JSON.stringify(good())).toString('base64url')}.`;
  assert.strictEqual(await v.getUser(none), null);
  assert.strictEqual(calls.remote, 1, 'handed to Supabase, which refused it');
  const hs = sign(good(), { alg: 'HS256' });
  assert.strictEqual(await v.getUser(hs), null);
});

test('an unverified email is double-checked with Supabase, then remembered', async () => {
  const { v, calls } = setup({ remote: { id: 'user-1', email_confirmed_at: '2026-01-01T00:00:00Z' } });
  const token = sign(good({ user_metadata: {} }));
  assert.ok((await v.getUser(token, { requireVerifiedEmail: true })).email_confirmed_at);
  assert.strictEqual(calls.remote, 1);
  await v.getUser(token, { requireVerifiedEmail: true });
  assert.strictEqual(calls.remote, 1, 'remembered');
});

test('if the keys cannot be fetched it falls back to Supabase, so nobody is locked out', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const { v, calls } = setup({ jwksOk: false, remote: { id: 'user-1', email_confirmed_at: 'x' } });
    assert.strictEqual((await v.getUser(sign(good()))).id, 'user-1');
    assert.strictEqual(calls.remote, 1);
  } finally { console.warn = warn; }
});
