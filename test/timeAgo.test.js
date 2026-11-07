'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { timeAgo } = require('../client/js/time-ago');

const NOW = Date.parse('2026-10-30T12:00:00Z');
const ago = (s) => NOW - s * 1000;

test('null, undefined, empty, garbage -> just now', () => {
  for (const v of [null, undefined, '', 'not a date', NaN, 0, -5, {}]) assert.strictEqual(timeAgo(v, NOW), 'just now');
});

test('future timestamps -> just now', () => {
  assert.strictEqual(timeAgo(NOW + 3600e3, NOW), 'just now');
});

test('under a minute -> just now', () => {
  assert.strictEqual(timeAgo(ago(59), NOW), 'just now');
});

test('minutes, hours, days', () => {
  assert.strictEqual(timeAgo(ago(60), NOW), '1m ago');
  assert.strictEqual(timeAgo(ago(59 * 60), NOW), '59m ago');
  assert.strictEqual(timeAgo(ago(3600), NOW), '1h ago');
  assert.strictEqual(timeAgo(ago(23 * 3600 + 3599), NOW), '23h ago');
  assert.strictEqual(timeAgo(ago(86400), NOW), '1d ago');
  assert.strictEqual(timeAgo(ago(6 * 86400), NOW), '6d ago');
});

test('a week or more -> short date', () => {
  assert.strictEqual(timeAgo(ago(7 * 86400), NOW), '23 Oct');
  assert.strictEqual(timeAgo('2026-10-12T08:00:00Z', NOW), '12 Oct');
});

test('the 1312h case that triggered the bug -> a date, never "1312h ago"', () => {
  // Last real match in dev ended 2026-09-05 18:59 UTC; the old formatter
  // rendered that as "1312h ago" on 2026-10-30.
  const out = timeAgo('2026-09-05T18:59:07.811Z', NOW);
  assert.strictEqual(out, '5 Sep');
  assert.strictEqual(timeAgo(ago(1312 * 3600), NOW), '5 Sep');
});

test('seconds, milliseconds, numeric strings and ISO all agree', () => {
  const t = NOW - 2 * 3600e3;
  assert.strictEqual(timeAgo(t, NOW), '2h ago');
  assert.strictEqual(timeAgo(t / 1000, NOW), '2h ago');
  assert.strictEqual(timeAgo(String(t / 1000), NOW), '2h ago');
  assert.strictEqual(timeAgo(new Date(t).toISOString(), NOW), '2h ago');
  assert.strictEqual(timeAgo(new Date(t), NOW), '2h ago');
});
