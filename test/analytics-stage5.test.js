'use strict';

// Analytics Stage 5: dashboard tabs over synthetic rows.
const test = require('node:test');
const assert = require('node:assert');
const dash = require('../server/analytics/dashboard');

const real = { id: 'p-real', created_at: '2026-11-01T08:00:00Z', first_source: 'test', first_campaign: 'audit' };
const staff = { id: 'p-staff', created_at: '2026-11-01T08:00:00Z', is_internal: true };
const base = () => ({
  now: Date.parse('2026-11-25T12:00:00Z'), idleMs: 30 * 60000,
  players: [real, staff],
  results: [
    { player_id: 'p-real', at: '2026-11-20T23:30:00Z', match_id: 'm1', mode: 'quick', end_reason: 'completed', device_class: 'phone', trades: 3, cards: 1 },
    { player_id: 'p-staff', at: '2026-11-20T10:00:00Z', match_id: 'm2', mode: 'blitz', end_reason: 'left', device_class: 'desktop', trades: 1, cards: 0 },
  ],
  trades: [], events: [], allServerEvents: [], lastEventAt: null,
});
const ctx = (over = {}) => ({ fromDay: '2026-11-20', toDay: '2026-11-21', tz: 'dubai', includeInternal: false, filters: {}, ...over });
const daily = (out) => Object.fromEntries(out.tables[0].rows.map((r) => [r[0], r[1]]));

test('a match at 23:30 UTC is on the next Asia/Dubai day, and on the same day with the UTC switch', () => {
  assert.deepStrictEqual(daily(dash.run('overview', base(), ctx())), { '2026-11-20': 0, '2026-11-21': 1 });
  assert.deepStrictEqual(daily(dash.run('overview', base(), ctx({ tz: 'utc' }))), { '2026-11-20': 1, '2026-11-21': 0 });
});

test('internal accounts are excluded, and the toggle includes them', () => {
  const off = dash.run('modes', base(), ctx({ tz: 'utc' }));
  const on = dash.run('modes', base(), ctx({ tz: 'utc', includeInternal: true }));
  assert.deepStrictEqual(off.tables[0].rows.map((r) => r[0]), ['quick']);
  assert.deepStrictEqual(on.tables[0].rows.map((r) => r[0]).sort(), ['blitz', 'quick']);
});

test('filters: device and source narrow the numbers', () => {
  assert.strictEqual(dash.run('modes', base(), ctx({ tz: 'utc', filters: { device: 'desktop' } })).tables[0].rows.length, 0);
  const f = dash.run('funnels', { ...base(), players: [{ ...real, created_at: '2026-11-20T09:00:00Z' }, { id: 'p2', created_at: '2026-11-20T09:00:00Z', first_source: 'google.com' }] }, ctx({ tz: 'utc', filters: { source: 'test' } }));
  assert.strictEqual(f.tables[0].rows.find((r) => r[0] === 'Sign-up submitted')[1], 1, 'only the test-source sign-up');
});

test('every tab answers with tiles/series/tables, and CSV export carries them', () => {
  for (const tab of dash.TABS) {
    const out = dash.run(tab, { ...base(), gaps: [], recent48: [] }, ctx());
    assert.ok(Array.isArray(out.tiles) && Array.isArray(out.tables) && Array.isArray(out.series), tab);
  }
  const csv = dash.toCsv(dash.run('modes', base(), ctx({ tz: 'utc' })), 'meta');
  assert.match(csv, /By mode/);
  assert.match(csv, /quick/);
});
