'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createPasswordSignIn, isSignInRateLimited, SignInBusyError } = require('../server/passwordSignIn');

const LIMITED = { error: { status: 429, code: 'over_request_rate_limit', message: 'Request rate limit reached' }, data: {} };
const WRONG = { error: { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' }, data: {} };
const OK = { error: null, data: { session: { access_token: 't' } } };

function setup(replies, keys = {}) {
  const made = [];
  let calls = 0;
  const createClient = (url, key, opts) => {
    made.push({ key, headers: opts.global?.headers || {} });
    return { auth: { signInWithPassword: async () => replies[Math.min(calls++, replies.length - 1)] } };
  };
  let warned = 0;
  const signIn = createPasswordSignIn({ createClient, url: 'u', serviceKey: 'service', onRateLimited: () => warned++, sleep: async () => {}, ...keys });
  return { signIn, made, calls: () => calls, warned: () => warned };
}

test('without the new key it uses the service key and sends no forwarded address', async () => {
  const t = setup([OK]);
  assert.strictEqual((await t.signIn({}, '203.0.113.9')).error, null);
  assert.deepStrictEqual(t.made, [{ key: 'service', headers: {} }]);
});

test('with the new key each sign-in is counted against the real visitor', async () => {
  const t = setup([OK], { secretKey: 'sb_secret_x' });
  await t.signIn({}, '203.0.113.9');
  assert.deepStrictEqual(t.made, [{ key: 'sb_secret_x', headers: { 'sb-forwarded-for': '203.0.113.9' } }]);
});

test('a brief rate limit is retried and the player never notices', async () => {
  const t = setup([LIMITED, OK]);
  assert.strictEqual((await t.signIn({})).error, null);
  assert.strictEqual(t.calls(), 2);
  assert.strictEqual(t.warned(), 0);
});

test('a lasting rate limit stops, warns the owner and is not a wrong password', async () => {
  const t = setup([LIMITED]);
  const result = await t.signIn({});
  assert.strictEqual(isSignInRateLimited(result.error), true);
  assert.strictEqual(t.calls(), 3, 'bounded retries');
  assert.strictEqual(t.warned(), 1);
  assert.match(new SignInBusyError().message, /Lots of players/);
  assert.strictEqual(new SignInBusyError().code, 'SIGN_IN_BUSY');
});

test('a wrong password is never retried or called busy', async () => {
  const t = setup([WRONG]);
  const result = await t.signIn({});
  assert.strictEqual(t.calls(), 1);
  assert.strictEqual(isSignInRateLimited(result.error), false);
});
