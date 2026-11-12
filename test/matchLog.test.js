'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createMatchLog, downsample } = require('../server/matchLog');

test('events are batched into one insert per flush, in order', async () => {
  const batches = [];
  const log = createMatchLog({ insert: async (rows) => { batches.push(rows); }, flushMs: 10_000 });
  for (let i = 0; i < 5; i++) log.record({ matchId: 'm', kind: 'order_open', payload: { i }, dataS: i * 1.23456 });
  await log.flush();
  assert.strictEqual(batches.length, 1);
  assert.deepStrictEqual(batches[0].map((r) => r.payload.i), [0, 1, 2, 3, 4]);
  assert.strictEqual(batches[0][1].data_s, 1.235);
  assert.strictEqual(log.stats().written, 5);
  await log.stop();
});

test('a failed write keeps the rows for the next flush', async () => {
  let fail = true;
  const got = [];
  const log = createMatchLog({ insert: async (rows) => { if (fail) throw new Error('timeout'); got.push(...rows); }, flushMs: 10_000, warn: () => {} });
  log.record({ kind: 'close' });
  await log.flush();
  assert.strictEqual(got.length, 0);
  assert.strictEqual(log.stats().queued, 1);
  fail = false;
  await log.flush();
  assert.strictEqual(got.length, 1);
  await log.stop();
});

test('the queue is bounded: oldest rows are dropped and counted', async () => {
  const log = createMatchLog({ insert: async () => { throw new Error('down'); }, maxQueue: 100, flushMs: 10_000, warn: () => {} });
  for (let i = 0; i < 250; i++) log.record({ kind: 'x', payload: { i } });
  assert.strictEqual(log.stats().queued, 100);
  assert.strictEqual(log.stats().dropped, 150);
  await log.stop();
});

test('a missing match_events table switches the log off instead of retrying forever', async () => {
  let calls = 0;
  const log = createMatchLog({ insert: async () => { calls++; throw new Error('relation "public.match_events" does not exist'); }, flushMs: 10_000, warn: () => {} });
  log.record({ kind: 'x' });
  await log.flush();
  log.record({ kind: 'y' });
  await log.flush();
  assert.strictEqual(calls, 1);
  assert.strictEqual(log.stats().disabled, true);
});

test('rows without a kind are ignored', async () => {
  const rows = [];
  const log = createMatchLog({ insert: async (r) => rows.push(...r), flushMs: 10_000 });
  log.record({ matchId: 'm' });
  log.record(null);
  await log.flush();
  assert.strictEqual(rows.length, 0);
});

test('downsample keeps first, last and the lowest point', () => {
  const pts = Array.from({ length: 1201 }, (_, t) => ({ t, equity: 10000 + Math.sin(t / 50) * 300 - (t === 777 ? 5000 : 0) }));
  const out = downsample(pts, 300);
  assert.ok(out.length <= 301);
  assert.strictEqual(out[0].t, 0);
  assert.strictEqual(out[out.length - 1].t, 1200);
  assert.ok(out.some((p) => p.t === 777), 'lowest point kept so max drawdown survives');
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t >= out[i - 1].t);
  assert.strictEqual(downsample(pts.slice(0, 10), 300).length, 10);
});
