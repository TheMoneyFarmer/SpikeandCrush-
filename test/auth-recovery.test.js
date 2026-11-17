'use strict';

// Account recovery: password rules, reset limits, the "signed out everywhere
// else" token check, the emails, and the sign-in screen markup.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const recovery = require('../server/authRecovery');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'ES256' })}.${b64(claims)}.sig`;

test('password rules: 8+ characters with letters and a number, at most 72', () => {
  assert.match(recovery.passwordProblem('abc123'), /at least 8/);
  assert.match(recovery.passwordProblem('abcdefgh'), /number/);
  assert.match(recovery.passwordProblem('12345678'), /letters/);
  assert.match(recovery.passwordProblem(`a1${'x'.repeat(80)}`), /at most 72/);
  assert.strictEqual(recovery.passwordProblem('trader2026'), null);
});

test('reset limit trips on the 4th request for one email and recovers after the window', () => {
  const c = recovery.createWindowCounter(3, 1000);
  const t0 = 1_000_000;
  assert.ok(c.take('a@x.com', t0));
  assert.ok(c.take('a@x.com', t0 + 1));
  assert.ok(c.take('a@x.com', t0 + 2));
  assert.strictEqual(c.take('a@x.com', t0 + 3), false, '4th refused');
  assert.ok(c.take('b@x.com', t0 + 3), 'another email is not affected');
  assert.ok(c.take('a@x.com', t0 + 1005), 'allowed again after the window');
});

test('signed out everywhere else: older tokens from other sessions are refused, the kept session is not', () => {
  const after = Date.parse('2026-11-16T12:00:00Z');
  const player = { auth_valid_after: new Date(after).toISOString(), auth_keep_session: 'keep-me' };
  const before = Math.floor((after - 60_000) / 1000);
  const later = Math.floor((after + 60_000) / 1000);
  assert.strictEqual(recovery.tokenRetired(player, jwt({ iat: before, session_id: 'other' })), true);
  assert.strictEqual(recovery.tokenRetired(player, jwt({ iat: before, session_id: 'keep-me' })), false);
  assert.strictEqual(recovery.tokenRetired(player, jwt({ iat: later, session_id: 'new-login' })), false);
  assert.strictEqual(recovery.tokenRetired({}, jwt({ iat: before })), false, 'no sign-out recorded');
});

test('reset and password-changed emails: subject, expiry, ignore line, plain text, no emoji', () => {
  const r = recovery.resetEmail({ link: 'https://example.invalid/x', expiresMinutes: 60 });
  assert.strictEqual(r.subject, 'Reset your Spike & Crush password');
  for (const part of [r.text, r.html]) {
    assert.match(part, /expires in 60 minutes/);
    assert.match(part, /If you did not ask for this, ignore this email; your password is unchanged\./);
  }
  assert.match(r.html, /#07090F/);
  assert.match(r.html, /#F5B83D/);
  const c = recovery.passwordChangedEmail({ username: 'modetest1' });
  assert.match(c.text, /Not you\? Contact hello@spikeandcrush\.com/);
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  for (const part of [r.text, r.html, c.text, c.html]) assert.ok(!emoji.test(part), 'no emoji');
});

test('sign-in screen: Forgot password? sits under the password field; sign-up has rules, eye and Sign in link', () => {
  const html = read('client/landing.html');
  const pw = html.indexOf('id="lpLoginPassword"');
  const forgot = html.indexOf('id="lpForgotLink"');
  const submit = html.indexOf('id="lpLoginSubmit"');
  assert.ok(pw > 0 && forgot > pw && forgot < submit, 'link between the password field and the button');
  assert.match(html, /href="\/forgot-password">Forgot password\?/);
  assert.match(html, /id="lpPwRules"/);
  assert.match(html, /class="pw-eye"/);
  assert.match(html, /Already have an account\? <a [^>]*>Sign in<\/a>/);
  assert.match(html, /Wrong username or password\. <a href="\/forgot-password">Forgot password\?<\/a>/);
});

test('no reset link or token is ever logged by the server code', () => {
  const src = read('server/index.js');
  for (const m of src.matchAll(/console\.(log|warn|error)\(([^;]*)\);/g)) {
    const code = m[2].replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
    assert.ok(!/action_link|\blink\b|access_token|refresh_token|hashed_token|\btoken\b/.test(code), `logs a secret: ${m[0].slice(0, 80)}`);
  }
});
