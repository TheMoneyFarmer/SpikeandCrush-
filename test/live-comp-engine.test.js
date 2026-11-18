'use strict';

// A live-data competition end to end in the engine, offline: the shared live
// market is fed by hand; a replay competition next to it keeps replay prices.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const now = Date.now();
const nowSec = Math.floor(now / 1000);
const comps = {
  live: { id: 'live', title: 'Weekend Open', status: 'active', is_published: true, type: 'native', instruments: ['BTCUSD'], data_source: 'live', starts_at: new Date(now - 60000).toISOString(), ends_at: new Date(now + 3600000).toISOString(), data_window_start: new Date(now - 60000).toISOString(), replay_speed: 1 },
  replay: { id: 'replay', title: 'Daily War', status: 'active', is_published: true, type: 'native', instruments: ['BTCUSD'], starts_at: new Date(now - 60000).toISOString(), ends_at: new Date(now + 3600000).toISOString(), data_window_start: new Date(now - 86400000).toISOString(), replay_speed: 1 },
};
const account = (cid) => ({ id: `a-${cid}`, competition_id: cid, player_id: 'pa', status: 'active', balance: 10000, equity: 10000, starting_capital: 10000 });
const inserted = [];
const created = [];
const fakeDb = new Proxy({
  getCompetitionById: async (id) => comps[id],
  getCompAccount: async (cid) => account(cid),
  listCompPositions: async () => [],
  insertCompPosition: async (row) => { inserted.push(row); return { id: 'p' + inserted.length, status: 'open', opened_at: new Date().toISOString(), ...row }; },
  incrementCompTradeCount: async () => {},
  listRecentWindowStarts: async () => [],
  createCompetitionRow: async (row) => { created.push(row); return row; },
}, { get: (t, k) => t[k] || (async () => null) });
const dbPath = path.resolve(__dirname, '../server/database.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const replayClock = require('../server/replayClock');
replayClock.getPriceAt = () => ({ bid: 9000, ask: 9015, mid: 9007.5, marketClosed: false });
replayClock.pathBetween = () => [];
const market = require('../server/liveMarket').liveMarket();
market._setOpen(true);
market._addTick('BTCUSD', nowSec - 2, 64000);
market._addTick('ETHUSD', nowSec - 2, 1800);
market.chartSeries = async (sym, g) => (g === 3600 ? [[nowSec - 400000, 1, 2, 0.5, 1.5]] : []);

const { createCompEngine } = require('../server/compEngine');
const engine = createCompEngine({ io: { of: () => ({}), to: () => ({ emit() {} }), emit() {}, sockets: {} }, notifyPlayer: () => {} });

test('a live competition trades at the live price; a replay one keeps replay prices', async () => {
  await engine.openTrade('live', 'pa', { symbol: 'BTCUSD', side: 'BUY', lots: 0.01 });
  assert.strictEqual(inserted.at(-1).entry_price, 64007.5, 'live ask = 64000 + half the 15 spread');
  await engine.openTrade('replay', 'pa', { symbol: 'BTCUSD', side: 'BUY', lots: 0.01 });
  assert.strictEqual(inserted.at(-1).entry_price, 9015, 'replay competition untouched by the live feed');
});

test('a live competition refuses new trades while the feed is down', async () => {
  market._setOpen(false);
  await assert.rejects(engine.openTrade('live', 'pa', { symbol: 'BTCUSD', side: 'BUY', lots: 0.01 }), /Market closed/);
  market._setOpen(true);
});

test('creating a live competition: real-time window, live instruments only, honest rules line', async () => {
  const startsAt = new Date(now + 3600000);
  const row = await engine.createCompetition({ frequency: 'weekend', title: 'Weekend Open', description: 'x', instruments: ['BTCUSD', 'ETHUSD', 'EURUSD'], startsAt, endsAt: new Date(now + 2 * 86400000), entryFee: 0, payouts: [{ rank: 1, coins: 0 }], dataSource: 'live' });
  assert.strictEqual(row.data_source, 'live');
  assert.strictEqual(row.data_window_start, startsAt.toISOString());
  assert.deepStrictEqual(row.instruments.sort(), ['BTCUSD', 'ETHUSD']);
  assert.match(row.rules, /live market prices/);
  const replay = await engine.createCompetition({ frequency: 'daily', title: 'Daily', description: 'x', instruments: ['EURUSD'], startsAt, endsAt: new Date(now + 86400000), entryFee: 0, payouts: [{ rank: 1, coins: 0 }] }).catch((e) => e);
  if (!(replay instanceof Error)) assert.ok(!('data_source' in replay) || replay.data_source !== 'live', 'replay stays replay');
});

test('live chart: unshifted times, history from the feed', async () => {
  const d = await engine.getChartData('live', 'pa', 'BTCUSD');
  assert.ok(Math.abs(d.compTime - nowSec) <= 2, 'chart clock is real time');
  assert.strictEqual(d.quote.mid, 64000);
  assert.strictEqual(d.bars.h1.length, 1, 'hourly history from the live feed, not the replay files');
});
