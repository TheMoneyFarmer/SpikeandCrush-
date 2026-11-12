'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolveRange, bucketIndex, zonedTime } = require('../server/dateRange');

const H = 3600000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();

test('today and yesterday are local midnight to midnight in the admin zone', () => {
  const now = Date.parse('2026-11-12T03:30:00Z'); // 07:30 in Dubai (UTC+4)
  const r = resolveRange({ preset: 'today', tz: 'Asia/Dubai' }, now);
  assert.strictEqual(iso(r.start), '2026-11-11T20:00:00.000Z');
  assert.strictEqual(iso(r.end), '2026-11-12T20:00:00.000Z');
  assert.strictEqual(r.unit, 'hour');
  assert.strictEqual(r.buckets.length, 24);
  const y = resolveRange({ preset: 'yesterday', tz: 'Asia/Dubai' }, now);
  assert.strictEqual(iso(y.start), '2026-11-10T20:00:00.000Z');
  assert.strictEqual(iso(y.end), iso(r.start));
  // the same instant is still "yesterday" (Nov 11) in UTC
  const u = resolveRange({ preset: 'today', tz: 'UTC' }, now);
  assert.strictEqual(iso(u.start), '2026-11-12T00:00:00.000Z');
});

test('DST: the fall-back day has 25 hours and the spring-forward day 23', () => {
  const fall = resolveRange({ preset: 'today', tz: 'America/New_York' }, Date.parse('2026-11-01T16:00:00Z'));
  assert.strictEqual(fall.end - fall.start, 25 * H);
  assert.strictEqual(fall.buckets.length, 25);
  const spring = resolveRange({ preset: 'today', tz: 'America/New_York' }, Date.parse('2026-03-08T16:00:00Z'));
  assert.strictEqual(spring.end - spring.start, 23 * H);
  // a 7-day range across the change still has 7 local-day buckets
  const week = resolveRange({ preset: '7d', tz: 'America/New_York' }, Date.parse('2026-11-04T16:00:00Z'));
  assert.strictEqual(week.unit, 'day');
  assert.strictEqual(week.buckets.length, 7);
  const lengths = week.buckets.map((b) => (b.end - b.start) / H);
  assert.ok(lengths.includes(25) && lengths.filter((x) => x === 24).length === 6, `bucket hours ${lengths}`);
  // every bucket starts at local midnight
  for (const b of week.buckets) assert.ok(/T0[45]:00:00/.test(iso(b.start)), iso(b.start));
});

test('presets: n days include today; months and year-to-date', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  for (const [p, n] of [['7d', 7], ['14d', 14], ['30d', 30], ['90d', 90]]) {
    const r = resolveRange({ preset: p, tz: 'UTC' }, now);
    assert.strictEqual((r.end - r.start) / D, n, p);
    assert.strictEqual(iso(r.end), '2026-11-13T00:00:00.000Z');
  }
  const tm = resolveRange({ preset: 'this_month', tz: 'UTC' }, now);
  assert.strictEqual(iso(tm.start), '2026-11-01T00:00:00.000Z');
  const lm = resolveRange({ preset: 'last_month', tz: 'Asia/Dubai' }, now);
  assert.strictEqual(iso(lm.start), '2026-09-30T20:00:00.000Z');
  assert.strictEqual(iso(lm.end), '2026-10-31T20:00:00.000Z');
  const jan = resolveRange({ preset: 'last_month', tz: 'UTC' }, Date.parse('2027-01-05T00:00:00Z'));
  assert.strictEqual(iso(jan.start), '2026-12-01T00:00:00.000Z');
  const ytd = resolveRange({ preset: 'ytd', tz: 'UTC' }, now);
  assert.strictEqual(iso(ytd.start), '2026-01-01T00:00:00.000Z');
  assert.strictEqual(ytd.unit, 'week');
});

test('comparison is the previous equal period, and can be switched off', () => {
  const r = resolveRange({ preset: '30d', tz: 'UTC' }, Date.parse('2026-11-12T10:00:00Z'));
  assert.strictEqual(r.prevEnd, r.start);
  assert.strictEqual(r.start - r.prevStart, r.end - r.start);
  const off = resolveRange({ preset: '30d', tz: 'UTC', compare: '0' }, Date.parse('2026-11-12T10:00:00Z'));
  assert.strictEqual(off.prevStart, null);
});

test('custom ranges: local dates with time, whole-day "to", instants, validation', () => {
  const r = resolveRange({ from: '2026-11-01T09:30', to: '2026-11-03', tz: 'Asia/Dubai' });
  assert.strictEqual(r.preset, 'custom');
  assert.strictEqual(iso(r.start), '2026-11-01T05:30:00.000Z');
  assert.strictEqual(iso(r.end), '2026-11-03T20:00:00.000Z', 'date-only "to" includes that whole local day');
  const y = resolveRange({ preset: 'custom', from: '2025-11-12', to: '2026-11-12', tz: 'UTC' });
  assert.strictEqual(y.unit, 'week');
  assert.throws(() => resolveRange({ preset: 'custom', from: '2026-11-05', to: '2026-11-01', tz: 'UTC' }), /after its start/);
  assert.throws(() => resolveRange({ preset: 'custom', from: '2020-01-01', to: '2026-11-01', tz: 'UTC' }), /three years/);
  // a bad zone falls back to UTC instead of failing
  assert.strictEqual(resolveRange({ preset: 'today', tz: 'Not/AZone' }).tz, 'UTC');
  // old ?days=30 still works
  assert.strictEqual(resolveRange({ days: '30', tz: 'UTC' }).preset, '30d');
});

test('bucketIndex finds the bucket by time across a DST boundary', () => {
  const week = resolveRange({ preset: '7d', tz: 'America/New_York' }, Date.parse('2026-11-04T16:00:00Z'));
  for (let i = 0; i < week.buckets.length; i++) {
    assert.strictEqual(bucketIndex(week.buckets, week.buckets[i].start), i);
    assert.strictEqual(bucketIndex(week.buckets, week.buckets[i].end - 1), i);
  }
  assert.strictEqual(bucketIndex(week.buckets, week.start - 1), -1);
  assert.strictEqual(bucketIndex(week.buckets, week.end), -1);
  // seeded events either side of New York's local midnight land on the right days
  const nyMidnight = zonedTime(2026, 11, 2, 0, 0, 'America/New_York');
  const before = bucketIndex(week.buckets, nyMidnight - 60000);
  const after = bucketIndex(week.buckets, nyMidnight + 60000);
  assert.strictEqual(after - before, 1);
});
