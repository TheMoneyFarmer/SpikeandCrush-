'use strict';

// Big competitions, against a fake database that behaves like Supabase where it
// matters and counts every call.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

let accounts = [];
let positions = [];
const calls = { tickWrites: 0, tickRows: 0, snapshots: 0, closes: [], paid: new Set(), payCalls: 0, updates: {}, inFlight: 0, peak: 0 };
const comp = {
  id: 'big', title: 'Big', status: 'active', instruments: ['EURUSD'], type: 'native', is_test: true,
  starts_at: new Date(Date.now() - 60000).toISOString(),
  ends_at: new Date(Date.now() + 3600000).toISOString(),
  data_window_start: new Date(Date.now() - 86400000).toISOString(),
  replay_speed: 1, notices_sent: ['1h', '10m'],
  prize_payouts: [{ rank: 1, coins: 500 }, { rank: 1500, coins: 7 }],
};
const fakeTarget = {
  tryCompJobLock: async () => true,
  getCompetitionById: async () => comp,
  listNativeCompetitionsByStatus: async (s) => (s.includes('active') ? [comp] : []),
  listOpenCompPositions: async () => positions.filter((p) => p.status === 'open'),
  listCompAccounts: async () => accounts,
  compApplyTicks: async (rows) => {
    calls.tickWrites++; calls.tickRows += rows.length;
    for (const r of rows) { if (r.snapshot) calls.snapshots++; const a = accounts.find((x) => x.id === r.id); if (a) a.equity = r.equity; }
  },
  compClosePosition: async (id) => { const p = positions.find((x) => x.id === id); if (!p || p.status !== 'open') return false; p.status = 'closed'; calls.closes.push(id); return true; },
  updateCompAccount: async (id, fields) => {
    calls.inFlight++; calls.peak = Math.max(calls.peak, calls.inFlight);
    await new Promise((r) => setImmediate(r));
    calls.inFlight--;
    calls.updates[id] = { ...calls.updates[id], ...fields };
    Object.assign(accounts.find((a) => a.id === id) || {}, fields);
  },
  compPayPrize: async (id) => { calls.payCalls++; if (calls.paid.has(id)) return false; calls.paid.add(id); Object.assign(accounts.find((a) => a.id === id), { prize_paid: true }); return true; },
  getPlayerById: async (id) => ({ id, war_rating: 1000, total_matches: 1, wins: 0, losses: 0 }),
  updatePlayer: async () => ({}),
  updateCompetition: async (id, fields) => Object.assign(comp, fields),
};
const fakeDb = new Proxy(fakeTarget, { get: (t, k) => t[k] || (async () => []) });

const dbPath = path.resolve(__dirname, '../server/database.js');
const realDatabase = require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const { createCompEngine } = require('../server/compEngine');
const replayClock = require('../server/replayClock');
replayClock.getPriceAt = () => ({ bid: 1.1, ask: 1.1, mid: 1.1 });
replayClock.pathBetween = () => [];

const io = { of: () => io, to: () => ({ emit: () => {} }), emit: () => {}, sockets: { adapter: { rooms: new Map() } } };
const engine = createCompEngine({ io, notifyPlayer: () => {} });

const acc = (i) => ({ id: `a${i}`, player_id: `p${i}`, status: 'active', balance: 10000, equity: 10000, starting_capital: 10000, trade_count: i, created_at: new Date(1e12 + i).toISOString(), last_snapshot_at: new Date().toISOString(), prize_paid: false, final_rank: null });
const pos = (i) => ({ id: `pos${i}`, account_id: `a${i}`, player_id: `p${i}`, competition_id: 'big', symbol: 'EURUSD', side: 'BUY', lots: 0.1, entry_price: 1.1, status: 'open', opened_at: new Date(Date.now() - 86400000).toISOString() });

test('a 10,000 entrant tick writes in batches and leaves idle accounts alone', async () => {
  accounts = Array.from({ length: 10000 }, (_, i) => acc(i));
  positions = Array.from({ length: 200 }, (_, i) => pos(i));
  for (let i = 0; i < 200; i++) accounts[i].equity = 9999; // these moved since last tick
  await engine.tickOnce();
  assert.strictEqual(calls.tickWrites, 1, 'one write call from the engine');
  assert.strictEqual(calls.tickRows, 200, 'only the accounts that changed');
  assert.deepStrictEqual(calls.updates, {}, 'no per-account updates on a tick');
  assert.ok(comp.last_tick_data_time !== undefined);
});

test('snapshots are thinned out in big competitions and only taken for accounts in play', async () => {
  calls.snapshots = 0; calls.tickRows = 0;
  for (const a of accounts) a.last_snapshot_at = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago
  await engine.tickOnce();
  assert.strictEqual(calls.snapshots, 0, 'large competitions wait 15 minutes');
  for (const a of accounts) a.last_snapshot_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  await engine.tickOnce();
  assert.strictEqual(calls.snapshots, 200, 'idle accounts add no curve points');
});

test('a player past rank 1000 still gets ranked, closed out and paid at settlement', async () => {
  comp.ends_at = new Date(Date.now() - 1000).toISOString();
  accounts.forEach((a, i) => { a.equity = 20000 - i; a.balance = 20000 - i; });
  const result = await engine.settle('big');
  assert.strictEqual(result.accounts, 10000);
  assert.strictEqual(result.newlyPaid, 10000);
  assert.strictEqual(calls.closes.length, 200, 'every open position closed');
  assert.ok(calls.peak > 1 && calls.peak <= 8, `ran in parallel, capped (peak ${calls.peak})`);
  assert.strictEqual(calls.updates.a0.prize_coins, 500);
  assert.strictEqual(calls.updates.a1499.prize_coins, 7, 'rank 1500 prize');
  assert.strictEqual(calls.updates.a1499.final_rank, 1500);
  assert.strictEqual(calls.updates.a9999.final_rank, 10000);
  assert.strictEqual(comp.status, 'ended');
});

test('settling again pays nobody twice and does no extra work', async () => {
  calls.updates = {}; calls.payCalls = 0;
  const again = await engine.settle('big');
  assert.strictEqual(again.newlyPaid, 0);
  assert.strictEqual(calls.payCalls, 0);
  assert.deepStrictEqual(calls.updates, {});
});

test('settlement interrupted part way finishes on the next run, paying each player once', async () => {
  comp.status = 'active'; comp.settled_at = null;
  accounts = Array.from({ length: 50 }, (_, i) => acc(i));
  positions = [];
  calls.paid = new Set();
  const realPay = fakeTarget.compPayPrize;
  let fail = true;
  let n = 0;
  // The 10th payment fails once.
  fakeTarget.compPayPrize = async (id) => { n++; if (fail && n === 10) { fail = false; throw new Error('db blip'); } return realPay(id); };
  await assert.rejects(engine.settle('big'), /db blip/);
  assert.strictEqual(comp.status, 'active', 'not marked ended until everyone is done');
  assert.strictEqual(calls.paid.size, 49);
  const finish = await engine.settle('big');
  assert.strictEqual(finish.newlyPaid, 1);
  assert.strictEqual(calls.paid.size, 50);
  assert.strictEqual(comp.status, 'ended');
  fakeTarget.compPayPrize = realPay;
});

test('paging reads past Supabase\'s 1000 row cap and stops at the end', async () => {
  // The real helper, not the fake database above.
  delete require.cache[dbPath];
  if (realDatabase) require.cache[dbPath] = realDatabase;
  const { fetchAllRows } = require('../server/database');
  const table = Array.from({ length: 2345 }, (_, i) => ({ id: i }));
  const ranges = [];
  const rows = await fetchAllRows(() => ({
    range: async (from, to) => { ranges.push([from, to]); return { data: table.slice(from, Math.min(to + 1, from + 1000)), error: null }; },
  }));
  assert.strictEqual(rows.length, 2345);
  assert.deepStrictEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
  await assert.rejects(fetchAllRows(() => ({ range: async () => ({ data: null, error: new Error('bad') }) })), /bad/);
});
