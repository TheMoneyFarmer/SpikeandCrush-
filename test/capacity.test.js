'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { visitorIp } = require('../server/originLock');
const { isLost, refundsDue, createMatchRecovery } = require('../server/matchRecovery');
const { runPool, createMemo } = require('../server/concurrency');
const { verifyTurnstile } = require('../server/turnstile');
const { runRetention } = require('../server/retention');
const { createOpsMonitor } = require('../server/opsMonitor');

const MODES = { quick: { durationSeconds: 600 }, grand: { durationSeconds: 1200 } };
const NOW = Date.parse('2026-11-09T12:00:00Z');
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
const CF = '162.158.1.1'; // in Cloudflare's published ranges

test('rate limits see the real visitor behind Cloudflare, and it cannot be faked', () => {
  const via = { 'x-forwarded-for': `203.0.113.9, ${CF}`, 'cf-connecting-ip': '203.0.113.9' };
  assert.strictEqual(visitorIp({ headers: via, ip: CF }), '203.0.113.9');
  // Two visitors through the same Cloudflare data centre don't share a bucket.
  assert.notStrictEqual(visitorIp({ headers: { ...via, 'cf-connecting-ip': '198.51.100.7' }, ip: CF }), visitorIp({ headers: via, ip: CF }));
  // Direct to the server with a made-up header: the header is ignored.
  const direct = { 'x-forwarded-for': '8.8.8.8', 'cf-connecting-ip': '1.2.3.4' };
  assert.strictEqual(visitorIp({ headers: direct, ip: '8.8.8.8' }), '8.8.8.8');
  // Faked X-Forwarded-For ending in a non-Cloudflare address, likewise.
  assert.strictEqual(visitorIp({ headers: { 'x-forwarded-for': `${CF}, 9.9.9.9`, 'cf-connecting-ip': '1.2.3.4' }, ip: '9.9.9.9' }), '9.9.9.9');
  // Garbage in the header falls back safely.
  assert.strictEqual(visitorIp({ headers: { 'x-forwarded-for': CF, 'cf-connecting-ip': 'not-an-ip' }, ip: CF }), CF);
});

test('a match only counts as lost once it cannot still be running', () => {
  assert.strictEqual(isLost({ mode: 'quick', status: 'active', created_at: ago(15), start_time: ago(15) }, MODES, NOW), false);
  assert.strictEqual(isLost({ mode: 'quick', status: 'active', created_at: ago(25), start_time: ago(25) }, MODES, NOW), true);
  assert.strictEqual(isLost({ mode: 'grand', status: 'active', created_at: ago(25), start_time: ago(25) }, MODES, NOW), false);
  assert.strictEqual(isLost({ mode: 'grand', status: 'active', created_at: ago(35), start_time: ago(35) }, MODES, NOW), true);
  assert.strictEqual(isLost({ mode: 'quick', status: 'waiting', created_at: ago(70) }, MODES, NOW), false);
  assert.strictEqual(isLost({ mode: 'quick', status: 'waiting', created_at: ago(80) }, MODES, NOW), true);
  assert.strictEqual(isLost({ mode: 'tournament', status: 'waiting', created_at: ago(9999) }, MODES, NOW), false);
  assert.strictEqual(isLost({ mode: 'quick', status: 'finished', created_at: ago(9999) }, MODES, NOW), false);
});

test('refunds match what the ledger says was paid, minus what already came back', () => {
  const ledger = [
    { id: 't1', player_id: 'a', type: 'match_entry', amount: -10 },
    { id: 't2', player_id: 'b', type: 'match_entry', amount: -10 },
    { id: 't3', player_id: 'b', type: 'match_refund', amount: 10 }, // left the lobby
    { id: 't4', player_id: 'c', type: 'match_entry', amount: -25 },
  ];
  assert.deepStrictEqual(refundsDue(ledger), [
    { playerId: 'a', amount: 10, key: 'lost-match-refund:t1' },
    { playerId: 'c', amount: 25, key: 'lost-match-refund:t4' },
  ]);
  assert.deepStrictEqual(refundsDue([]), []);
});

function recoveryDb(rows, ledger) {
  const calls = { credits: [], voided: [] };
  return {
    calls,
    isConfigured: true,
    listOpenMatches: async () => rows,
    listMatchLedger: async () => ledger,
    listHumanMatchPlayerIds: async () => ['a', 'z'],
    creditCoins: async (id, amount, opts) => calls.credits.push({ id, amount, key: opts.idempotencyKey }),
    updateMatch: async (id, fields) => calls.voided.push({ id, status: fields.status }),
  };
}

test('recovery refunds and closes a lost match, and leaves one still in memory alone', async () => {
  const db = recoveryDb([{ id: 'lost', mode: 'quick', status: 'active', created_at: ago(40), start_time: ago(40) }, { id: 'mine', mode: 'quick', status: 'active', created_at: ago(40), start_time: ago(40) }], [{ id: 't1', player_id: 'a', type: 'match_entry', amount: -10 }]);
  const told = [];
  const recovery = createMatchRecovery({ db, gameEngine: { MATCH_MODES: MODES, getMatch: (id) => (id === 'mine' ? {} : null) }, notifyPlayer: (id, type, text) => told.push({ id, text }) });
  const result = await recovery.sweep(NOW);
  assert.deepStrictEqual(result, { voided: 1, refunded: 1 });
  assert.deepStrictEqual(db.calls.credits, [{ id: 'a', amount: 10, key: 'lost-match-refund:t1' }]);
  assert.deepStrictEqual(db.calls.voided, [{ id: 'lost', status: 'voided' }]);
  assert.match(told.find((t) => t.id === 'a').text, /refunded/);
  assert.doesNotMatch(told.find((t) => t.id === 'z').text, /refunded/);
});

test('a failed refund keeps the match open so the next sweep retries', async () => {
  const db = recoveryDb([{ id: 'lost', mode: 'quick', status: 'active', created_at: ago(40), start_time: ago(40) }], [{ id: 't1', player_id: 'a', type: 'match_entry', amount: -10 }]);
  db.creditCoins = async () => { throw new Error('db down'); };
  const recovery = createMatchRecovery({ db, gameEngine: { MATCH_MODES: MODES, getMatch: () => null } });
  const original = console.error; console.error = () => {};
  try { assert.strictEqual((await recovery.sweep(NOW)).voided, 0); } finally { console.error = original; }
  assert.deepStrictEqual(db.calls.voided, []);
});

test('runPool caps concurrency, tries everything, then reports the failure', async () => {
  let running = 0, peak = 0;
  const seen = [];
  await assert.rejects(runPool([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (n) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 2));
    running--; seen.push(n);
    if (n === 2) throw new Error('boom');
  }), /boom/);
  assert.strictEqual(peak, 3);
  assert.strictEqual(seen.length, 9);
});

test('memo shares one computation between simultaneous callers and expires', async () => {
  const memo = createMemo();
  let computed = 0;
  const compute = async () => { computed++; await new Promise((r) => setTimeout(r, 5)); return computed; };
  const [a, b] = await Promise.all([memo('k', 1000, compute), memo('k', 1000, compute)]);
  assert.strictEqual(a, 1); assert.strictEqual(b, 1);
  assert.strictEqual(await memo('k', 1000, compute), 1);
  await new Promise((r) => setTimeout(r, 3));
  assert.strictEqual(await memo('k', 1, compute), 2);
});

test('memo does not keep a failure', async () => {
  const memo = createMemo();
  await assert.rejects(memo('k', 1000, async () => { throw new Error('nope'); }));
  assert.strictEqual(await memo('k', 1000, async () => 'ok'), 'ok');
});

test('Turnstile: off without keys, requires a token when on, survives Cloudflare being down', async () => {
  delete process.env.TURNSTILE_SECRET_KEY; delete process.env.TURNSTILE_SITE_KEY;
  assert.strictEqual(await verifyTurnstile(undefined, '1.1.1.1'), true);
  process.env.TURNSTILE_SECRET_KEY = 's'; process.env.TURNSTILE_SITE_KEY = 'p';
  try {
    assert.strictEqual(await verifyTurnstile(undefined, '1.1.1.1'), false);
    assert.strictEqual(await verifyTurnstile('t', '1.1.1.1', async () => ({ json: async () => ({ success: true }) })), true);
    assert.strictEqual(await verifyTurnstile('t', '1.1.1.1', async () => ({ json: async () => ({ success: false }) })), false);
    const warn = console.warn; console.warn = () => {};
    try { assert.strictEqual(await verifyTurnstile('t', '1.1.1.1', async () => { throw new Error('down'); }), true); } finally { console.warn = warn; }
  } finally {
    delete process.env.TURNSTILE_SECRET_KEY; delete process.env.TURNSTILE_SITE_KEY;
  }
});

test('retention only touches replays, read notifications and old curves, and 0 turns it off', async () => {
  const deletes = [];
  const db = {
    deleteOlderThan: async (table, column, before, opts) => { deletes.push({ table, column, opts }); return 1; },
    pruneEndedCompSnapshots: async () => 2,
  };
  assert.deepStrictEqual(await runRetention(db, NOW), { replays: 1, notifications: 1, snapshots: 2 });
  assert.deepStrictEqual(deletes.map((d) => d.table), ['replays', 'notifications']);
  assert.strictEqual(deletes[0].opts.idColumn, 'match_id');
  const filtered = []; deletes[1].opts.extra({ eq: (k, v) => filtered.push([k, v]) });
  assert.deepStrictEqual(filtered, [['read', true]]);
  process.env.REPLAY_RETENTION_DAYS = '0';
  try {
    deletes.length = 0;
    assert.strictEqual((await runRetention(db, NOW)).replays, 0);
    assert.ok(!deletes.some((d) => d.table === 'replays'));
  } finally { delete process.env.REPLAY_RETENTION_DAYS; }
});

function monitor(matches = 0, extra = {}) {
  return createOpsMonitor({ liveMatches: () => matches, connectedSockets: () => 0, sendAlert: async () => {}, ...extra });
}

test('new matches are refused when the server is full, with a friendly message', () => {
  assert.strictEqual(monitor(10).hasRoom(), true);
  const full = monitor(1e9);
  assert.strictEqual(full.hasRoom(), false);
  let status, body, passed = false;
  const warn = console.warn; console.warn = () => {};
  try {
    full.blockNewMatchesWhenFull({}, { status(s) { status = s; return this; }, json(b) { body = b; } }, () => { passed = true; });
  } finally { console.warn = warn; }
  assert.strictEqual(passed, false);
  assert.strictEqual(status, 503);
  assert.match(body.error, /busy/);
});

test('one error does not take the server down; a burst of them restarts it', () => {
  let exited = 0;
  const m = monitor(0, { exit: () => { exited++; } });
  const error = console.error; console.error = () => {};
  try {
    assert.strictEqual(m.onError('unhandledRejection', new Error('a')), false);
    for (let i = 0; i < 9; i++) assert.strictEqual(m.onError('uncaughtException', new Error('b')), false);
    assert.strictEqual(exited, 0);
    assert.strictEqual(m.onError('uncaughtException', new Error('b')), true);
    assert.strictEqual(exited, 1);
  } finally { console.error = error; }
});

test('alerts are throttled', async () => {
  const sent = [];
  const m = monitor(0, { sendAlert: async (subject) => sent.push(subject) });
  m.alert('x', 'one', {}); m.alert('x', 'two', {}); m.alert('y', 'three', {});
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(sent, ['one', 'three']);
});
