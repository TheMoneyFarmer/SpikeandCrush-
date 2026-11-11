'use strict';

// Competition trades: stop loss / take profit sent in pips are measured on
// the server from the price at that moment (a client conversion used a stale
// quote and a fast market put the stop on the wrong side - "it disappears").
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const now = Date.now();
const comp = {
  id: 'c1', title: 'Daily War', status: 'active', is_published: true, type: 'native', instruments: ['EURUSD'],
  starts_at: new Date(now - 60000).toISOString(), ends_at: new Date(now + 3600000).toISOString(),
  data_window_start: new Date(now - 86400000).toISOString(), replay_speed: 1,
};
const account = { id: 'a', competition_id: 'c1', player_id: 'pa', status: 'active', balance: 10000, equity: 10000, starting_capital: 10000 };
const inserted = [];
const fakeDb = new Proxy({
  getCompetitionById: async () => comp,
  getCompAccount: async () => account,
  listCompPositions: async () => [],
  insertCompPosition: async (row) => { inserted.push(row); return { id: 'p' + inserted.length, status: 'open', opened_at: new Date().toISOString(), ...row }; },
  incrementCompTradeCount: async () => {},
}, { get: (t, k) => t[k] || (async () => null) });
const dbPath = path.resolve(__dirname, '../server/database.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const replayClock = require('../server/replayClock');
replayClock.getPriceAt = () => ({ bid: 1.1, ask: 1.1002, mid: 1.1001 });
replayClock.pathBetween = () => [];
replayClock.dataTimeFor = () => 1_000_000;
const { createCompEngine } = require('../server/compEngine');
const engine = createCompEngine({ io: { of: () => ({}), to: () => ({ emit() {} }), emit() {}, sockets: {} }, notifyPlayer: () => {} });

test('pips SL/TP are measured from the live closing price, on the right sides', async () => {
  await engine.openTrade('c1', 'pa', { symbol: 'EURUSD', side: 'BUY', lots: 0.1, stopLossPips: 20, takeProfitPips: 40 });
  const buy = inserted.at(-1);
  assert.strictEqual(buy.stop_loss, 1.098); // bid 1.1 - 20 pips
  assert.strictEqual(buy.take_profit, 1.104);
  await engine.openTrade('c1', 'pa', { symbol: 'EURUSD', side: 'SELL', lots: 0.1, stopLossPips: 20, takeProfitPips: 40 });
  const sell = inserted.at(-1);
  assert.strictEqual(sell.stop_loss, 1.1022); // ask 1.1002 + 20 pips
  assert.strictEqual(sell.take_profit, 1.0962);
});

test('an exact price still wins over pips, and a wrong-side price is refused', async () => {
  await engine.openTrade('c1', 'pa', { symbol: 'EURUSD', side: 'BUY', lots: 0.1, stopLoss: 1.09, stopLossPips: 20 });
  assert.strictEqual(inserted.at(-1).stop_loss, 1.09);
  await assert.rejects(engine.openTrade('c1', 'pa', { symbol: 'EURUSD', side: 'BUY', lots: 0.1, stopLoss: 1.2 }), /below/);
});
