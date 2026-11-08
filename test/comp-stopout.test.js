'use strict';

// Competitions: margin rules decide, there is no fixed maximum loss.
// Runs the real tick against a fake database and fake prices.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const closes = [];
const updates = {};
let accounts = [];
let positions = [];
const comp = {
  id: 'c1', title: 'Test', status: 'active', instruments: ['EURUSD'],
  starts_at: new Date(Date.now() - 60000).toISOString(),
  ends_at: new Date(Date.now() + 3600000).toISOString(),
  data_window_start: new Date(Date.now() - 86400000).toISOString(),
  replay_speed: 1, notices_sent: ['60', '30', '15', '5', '1'],
};
const fakeDb = new Proxy({
  tryCompJobLock: async () => true,
  listNativeCompetitionsByStatus: async (s) => (s.includes('active') ? [comp] : []),
  listCompPositions: async () => positions.filter((p) => p.status === 'open'),
  listCompAccounts: async () => accounts,
  compClosePosition: async (id, exit, reason, pnl) => { closes.push({ id, reason, pnl }); positions.find((p) => p.id === id).status = 'closed'; return true; },
  updateCompAccount: async (id, fields) => { updates[id] = { ...updates[id], ...fields }; },
}, { get: (t, k) => t[k] || (async () => []) });

const dbPath = path.resolve(__dirname, '../server/database.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const replayClock = require('../server/replayClock');
const PRICE = 1.0;
replayClock.getPriceAt = () => ({ bid: PRICE, ask: PRICE, mid: PRICE });
replayClock.pathBetween = () => [];
const { createCompEngine } = require('../server/compEngine');

const emitted = [];
const io = { of: () => io, to: () => ({ emit: (ev, d) => emitted.push([ev, d]) }), emit: () => {} };
const engine = createCompEngine({ io, notifyPlayer: () => {} });

const acc = (id) => ({ id, player_id: 'p' + id, status: 'active', balance: 10000, equity: 10000, starting_capital: 10000, last_snapshot_at: new Date().toISOString() });
const pos = (id, accId, side, lots, entry) => ({ id, account_id: accId, player_id: 'p' + accId, competition_id: 'c1', symbol: 'EURUSD', side, lots, entry_price: entry, status: 'open', opened_at: new Date(Date.now() - 30000).toISOString() });

test('competition stop-out', async (t) => {
  await t.test('down more than 50% on a small position: it stays open, account active', async () => {
    closes.length = 0;
    accounts = [acc('a')];
    positions = [pos('small', 'a', 'BUY', 1, 1.06)]; // -$6,000: equity $4,000, margin $1,000, level 400%
    await engine.tickOnce();
    assert.deepStrictEqual(closes, []);
    assert.strictEqual(accounts[0].status, 'active');
    assert.strictEqual(updates.a.equity, 4000);
  });

  await t.test('at the stop-out level the biggest loser closes first, the rest stay, account active', async () => {
    closes.length = 0;
    accounts = [acc('b')];
    positions = [pos('winner', 'b', 'BUY', 1, 0.99), pos('loser', 'b', 'BUY', 8, 1.01)]; // equity $3,000, margin $9,000, level about 33%
    await engine.tickOnce();
    assert.deepStrictEqual(closes.map((c) => c.id), ['loser']);
    assert.strictEqual(closes[0].reason, 'loss_limit');
    assert.ok(positions.find((p) => p.id === 'winner').status === 'open');
    assert.strictEqual(accounts[0].status, 'active');
    assert.ok(emitted.some(([ev]) => ev === 'comp:stop_out'));
  });
});
