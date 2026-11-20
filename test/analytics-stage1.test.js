'use strict';

// Analytics Stage 1: correctness. Viewer identity behind the proxy, the one
// definition of "active", exclusions, time zones.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const ctx = require('../server/analytics/context');
const def = require('../server/analytics/definitions');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

test('two clients behind the Railway proxy are two viewers; the same client is one', async () => {
  const { createSponsorSlots } = require('../server/sponsorSlots');
  const bumps = [];
  const slots = createSponsorSlots({ db: { bumpSponsorStats: async (x) => bumps.push(x) }, secret: 'test-secret', optionalViewerId: async () => null });
  const app = express();
  app.use(express.json());
  app.use(slots.router());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const P = '11111111-2222-3333-4444-555555555555';
  // Railway's shape: X-Forwarded-For = [visitor, Railway edge]; req.ip is the edge for everyone.
  const seen = (ip) => fetch(`${base}/api/slots/seen`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, 'accept-language': 'en', 'x-forwarded-for': `${ip}, 100.64.0.2` }, body: JSON.stringify({ ids: [P] }) }).then((r) => r.json());
  assert.deepStrictEqual(await seen('203.0.113.10'), { counted: 1 });
  assert.deepStrictEqual(await seen('198.51.100.20'), { counted: 1 }, 'a second visitor through the same proxy is a second viewer');
  assert.deepStrictEqual(await seen('203.0.113.10'), { counted: 0 }, 'the same visitor again in the same visit: not counted twice');
  await slots.flush();
  const total = bumps.reduce((a, b) => ({ impressions: a.impressions + b.impressions, unique: a.unique + b.unique }), { impressions: 0, unique: 0 });
  assert.deepStrictEqual(total, { impressions: 2, unique: 2 });
  server.close();
});

test('the visitor hash rotates daily and never contains the address', () => {
  const req = { headers: { 'user-agent': UA, 'x-forwarded-for': '203.0.113.10, 100.64.0.2' } };
  const a = ctx.visitorDayHash(req, '2026-11-20');
  const b = ctx.visitorDayHash(req, '2026-11-21');
  assert.notStrictEqual(a, b, 'a new salt every day: visits cannot be linked across days');
  assert.strictEqual(a, ctx.visitorDayHash(req, '2026-11-20'));
  assert.ok(!a.includes('203') && /^[0-9a-f]{32}$/.test(a));
});

test('bot detection: crawlers, tools and browsers without the usual headers', () => {
  const r = (h) => ({ headers: h });
  assert.strictEqual(ctx.isBot(r({ 'user-agent': UA, 'accept-language': 'en-GB' })), false);
  assert.strictEqual(ctx.isBot(r({ 'user-agent': UA })), true, 'no Accept-Language');
  assert.strictEqual(ctx.isBot(r({ 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.0)', 'accept-language': 'en' })), true);
  assert.strictEqual(ctx.isBot(r({ 'user-agent': 'HeadlessChrome/131', 'accept-language': 'en' })), true);
  assert.strictEqual(ctx.isBot(r({ 'user-agent': 'curl/8.4.0', 'accept-language': 'en' })), true);
  assert.strictEqual(ctx.isBot(r({ 'accept-language': 'en' })), true, 'no browser string');
});

test('active = played or traded, never logins; internal and computer players excluded unless included', () => {
  const players = new Map([
    ['a', { id: 'a' }], ['b', { id: 'b' }], ['staff', { id: 'staff', is_internal: true }], ['bot', { id: 'bot', is_persona: true }],
  ]);
  const activity = [
    { player_id: 'a', at: '2026-11-20T10:00:00Z' },
    { player_id: 'staff', at: '2026-11-20T10:00:00Z' },
    { player_id: 'bot', at: '2026-11-20T10:00:00Z' },
    { player_id: null, at: '2026-11-20T10:00:00Z' }, // a computer seat
  ];
  // 'b' only logged in: no activity row, so not active.
  const days = def.activeDays(activity, players);
  assert.deepStrictEqual(def.activeCounts(days, '2026-11-20'), { dau: 1, wau: 1, mau: 1 });
  const withInternal = def.activeDays(activity, players, { includeInternal: true });
  assert.strictEqual(def.activeCounts(withInternal, '2026-11-20').dau, 3, 'toggle on: staff and persona count');
});

test('time zones: 23:30 UTC is the next day in Asia/Dubai and the same day in UTC', () => {
  assert.strictEqual(def.dayOf('2026-11-20T23:30:00Z', 'dubai'), '2026-11-21');
  assert.strictEqual(def.dayOf('2026-11-20T23:30:00Z', 'utc'), '2026-11-20');
  const [from, to] = def.rangeMs('2026-11-21', '2026-11-21', 'dubai');
  assert.strictEqual(new Date(from).toISOString(), '2026-11-20T20:00:00.000Z');
  assert.strictEqual(new Date(to).toISOString(), '2026-11-21T20:00:00.000Z');
});

test('retention: day N counts players active on day N or later; young cohorts are not reported', () => {
  const players = [
    { id: 'p1', created_at: '2026-11-02T08:00:00Z' },
    { id: 'p2', created_at: '2026-11-02T09:00:00Z' },
    { id: 'p3', created_at: '2026-11-19T09:00:00Z' },
  ];
  const byId = new Map(players.map((p) => [p.id, p]));
  const days = def.activeDays([
    { player_id: 'p1', at: '2026-11-03T10:00:00Z' }, // day 1
    { player_id: 'p1', at: '2026-11-10T10:00:00Z' }, // day 8
    { player_id: 'p2', at: '2026-11-02T10:00:00Z' }, // sign-up day only
  ], byId);
  const rows = def.retention(players, days, { today: '2026-11-20', by: 'day' });
  const nov2 = rows.find((r) => r.cohort === '2026-11-02');
  assert.deepStrictEqual(nov2.d1, { returned: 1, eligible: 2, rate: 50 });
  assert.deepStrictEqual(nov2.d7, { returned: 1, eligible: 2, rate: 50 });
  assert.strictEqual(nov2.d30, null, 'not 30 days old yet');
  assert.strictEqual(rows.find((r) => r.cohort === '2026-11-19').d7, null);
});

test('end reasons map to the dashboard words', () => {
  assert.strictEqual(def.endReason('completed'), 'finished');
  assert.strictEqual(def.endReason('left'), 'forfeited');
  assert.strictEqual(def.endReason('disconnect'), 'disconnected');
  assert.strictEqual(def.endReason(null), 'unknown');
});
