'use strict';

// Security and integrity pass, section A: spend caps, email limits, bot probes.

const test = require('node:test');
const assert = require('node:assert');
const { createSupportBudget, limitMessage } = require('../server/support/budget');
const { createEmailGuard } = require('../admin/lib/emailGuard');
const { createProbeGuard, isProbe } = require('../server/probeGuard');

const T0 = Date.UTC(2026, 10, 21, 10, 0, 0);

test('support budget: off switch, daily cap, long chat, hourly limit, in that order', async () => {
  let t = T0;
  const settings = { enabled: true, dailyTokenCap: 1000 };
  const budget = createSupportBudget({ perHour: 3, perConversation: 2, now: () => t, store: { loadSettings: async () => settings, loadUsage: async () => null, saveUsage: async () => {} } });
  await budget.refresh();
  assert.deepStrictEqual(budget.check('p:a', 'c1'), { ok: true });
  budget.record('p:a', { input_tokens: 100, output_tokens: 50 }, 'c1');
  budget.record('p:a', { input_tokens: 100 }, 'c1');
  assert.strictEqual(budget.check('p:a', 'c1').reason, 'conversation_long', '2 AI answers in one chat is the limit here');
  assert.deepStrictEqual(budget.check('p:a', 'c2'), { ok: true });
  budget.record('p:a', {}, 'c2');
  assert.strictEqual(budget.check('p:a', 'c3').reason, 'owner_hourly');
  assert.deepStrictEqual(budget.check('p:b', 'c4'), { ok: true }, 'other players unaffected');
  budget.record('p:b', { output_tokens: 800 }, 'c4');
  assert.strictEqual(budget.check('p:c', 'c5').reason, 'daily_spend', '1,050 tokens is over the 1,000 cap');
  settings.enabled = false;
  await budget.refresh();
  assert.strictEqual(budget.check('p:c', 'c5').reason, 'disabled', 'admin off switch wins');
  t += 24 * 60 * 60 * 1000;
  settings.enabled = true;
  await budget.refresh();
  assert.deepStrictEqual(budget.check('p:c', 'c5'), { ok: true }, 'a new UTC day starts at zero');
});

test('support budget: survives a restart and alerts once each at 50, 80 and 100%', async () => {
  let saved = null;
  const alerts = [];
  const store = { loadSettings: async () => ({ dailyTokenCap: 1000 }), loadUsage: async () => saved, saveUsage: async (u) => { saved = u; }, alert: async (level) => alerts.push(level) };
  const a = createSupportBudget({ now: () => T0, store });
  await a.refresh();
  a.record('p:x', { input_tokens: 600 });
  a.record('p:x', { input_tokens: 10 });
  await new Promise((r) => setTimeout(r, 1700)); // the save is debounced
  assert.strictEqual(saved.tokens, 610);
  const b = createSupportBudget({ now: () => T0, store }); // a restarted server
  await b.refresh();
  assert.strictEqual(b.stats().tokensToday, 610, 'the count is loaded, not reset');
  b.record('p:y', { input_tokens: 400 });
  assert.deepStrictEqual(alerts, [50, 80, 100], 'each level once, even across the restart');
  assert.strictEqual(b.check('p:z').reason, 'daily_spend');
});

test('the player always gets words, never an error', () => {
  for (const r of ['disabled', 'daily_spend', 'conversation_long', 'owner_hourly']) assert.ok(limitMessage(r).length > 20);
  assert.match(limitMessage('daily_spend'), /hello@spikeandcrush\.com/);
});

test('email guard: per-recipient hourly cap, own domain exempt, daily cap with alerts', () => {
  let t = T0;
  const g = createEmailGuard({ perRecipientHour: 2, dailyCap: 5, now: () => t });
  assert.ok(g.check('victim@example.com').ok);
  g.record('victim@example.com');
  g.record('Victim@Example.com ');
  assert.strictEqual(g.check('victim@example.com').reason, 'recipient_hourly', 'same address, any case');
  assert.ok(g.check('someone-else@example.com').ok);
  assert.ok(g.check('hello@spikeandcrush.com').ok);
  g.record('hello@spikeandcrush.com');
  assert.strictEqual(g.record('a@example.com'), 80, '4 of 5 is 80%');
  assert.strictEqual(g.record('b@example.com'), 100);
  assert.strictEqual(g.check('c@example.com').reason, 'daily_cap');
  assert.ok(g.check('c@example.com', { isAlert: true }).ok, 'alerts still go out');
  t += 61 * 60 * 1000;
  assert.strictEqual(g.check('victim@example.com').reason, 'daily_cap', 'the day cap still holds');
  t += 24 * 60 * 60 * 1000;
  assert.ok(g.check('victim@example.com').ok, 'next day clears');
});

test('probe paths are recognised, real pages are not', () => {
  for (const p of ['/.env', '/.env.production', '/a/.git/config', '/.DS_Store', '/wp-admin/', '/wp-login.php', '/x.php', '/index.php?x=1', '/db.sql', '/backup.zip', '/server.js.bak', '/phpmyadmin', '/%2Eenv', '/cgi-bin/x', '/vendor/phpunit/x'])
    assert.ok(isProbe(p), p);
  for (const p of ['/', '/play', '/help', '/js/main.js', '/css/main.css', '/api/stats/live', '/competition/daily-open', '/assets/x.webp', '/sw.js', '/manifest.webmanifest', '/.well-known/security.txt', '/favicon.ico', '/sitemap.xml'])
    assert.ok(!isProbe(p), p);
});

test('probe guard: 404 fast, then blocks a repeat prober, never /health', () => {
  let t = T0;
  const seen = [];
  const guard = createProbeGuard({ blockAfter: 3, visitorIp: (req) => req.ip, onProbe: (k, p, b) => seen.push({ k, p, b }), now: () => t });
  const run = (url, ip = '198.51.100.1') => {
    const res = { headers: {}, statusCode: 200, body: null, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    let passed = false;
    guard.middleware({ originalUrl: url, ip }, res, () => { passed = true; });
    return passed ? 'next' : res.statusCode;
  };
  assert.strictEqual(run('/play'), 'next');
  assert.strictEqual(run('/.env'), 404);
  assert.strictEqual(run('/.git/config'), 404);
  assert.strictEqual(run('/wp-login.php'), 404);
  assert.strictEqual(run('/play'), 429, 'blocked after 3 probes');
  assert.strictEqual(run('/health'), 'next', 'health checks always pass');
  assert.strictEqual(run('/play', '198.51.100.2'), 'next', 'other visitors unaffected');
  assert.ok(seen.every((s) => /^[0-9a-f]{16}$/.test(s.k)), 'only a hashed visitor id is recorded');
  assert.ok(!JSON.stringify(seen).includes('198.51.100.1'), 'never the raw address');
  t += 16 * 60 * 1000;
  assert.strictEqual(run('/play'), 'next', 'the block ends after 15 minutes');
});
