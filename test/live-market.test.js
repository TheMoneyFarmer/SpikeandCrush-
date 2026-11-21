'use strict';

// Live market feed (server/liveMarket.js) and the live data source, offline:
// ticks are fed by hand, nothing connects to Coinbase.
const test = require('node:test');
const assert = require('node:assert');
const { createLiveMarket } = require('../server/liveMarket');
const { makeLiveFeed, forComp } = require('../server/marketDataSource');
const liveFeed = require('../server/liveFeed');

const T0 = 1795000200; // a whole 5-minute boundary
function market(nowSec = T0 + 100) {
  const m = createLiveMarket({ WebSocketImpl: null, now: () => nowSec * 1000, log: { log() {}, warn() {} } });
  m._setOpen(true);
  return m;
}

test('ticker messages become one price per second; out-of-order trades are ignored', () => {
  const m = market();
  const msg = (sec, price, product = 'BTC-USD') => m._onMessage(JSON.stringify({ type: 'ticker', product_id: product, price: String(price), time: new Date(sec * 1000).toISOString() }));
  msg(T0, 100); msg(T0, 101); msg(T0 + 2, 103); msg(T0 + 1, 999); msg(T0, 1, 'DOGE-USD');
  assert.deepStrictEqual(m.midAt('BTCUSD', T0), { mid: 101, stale: false }, 'last trade of the second wins');
  assert.strictEqual(m.midAt('BTCUSD', T0 + 1).mid, 101, 'between trades: the last price');
  assert.strictEqual(m.midAt('BTCUSD', T0 + 2).mid, 103, 'late trade for an earlier second ignored');
  assert.strictEqual(m.midAt('BTCUSD', T0 - 1), null, 'nothing before the first data');
  assert.strictEqual(m.midAt('EURUSD', T0), null, 'unsupported symbol');
});

test('health: socket open and every symbol traded in the last 30 s', () => {
  let now = T0 + 10;
  const m = createLiveMarket({ WebSocketImpl: null, now: () => now * 1000, log: { log() {}, warn() {} } });
  m._setOpen(true);
  m._addTick('BTCUSD', T0, 100);
  assert.strictEqual(m.healthy(), false, 'ETH has not traded');
  m._addTick('ETHUSD', T0 + 5, 10);
  assert.strictEqual(m.healthy(), true);
  now = T0 + 45;
  assert.strictEqual(m.healthy(), false, 'BTC stale after 30 s');
  m._addTick('BTCUSD', T0 + 44, 100); m._addTick('ETHUSD', T0 + 44, 10);
  assert.strictEqual(m.healthy(), true);
  m._setOpen(false);
  assert.strictEqual(m.healthy(), false, 'socket closed');
});

test('restart gap: prices before the first tick walk the 1-minute bar; SL/TP paths include its wicks', () => {
  const m = market();
  m._addMinute('BTCUSD', T0 - 120, [100, 110, 95, 105]); // up bar: open, low, high, close
  m._addTick('BTCUSD', T0 + 10, 106);
  assert.strictEqual(m.midAt('BTCUSD', T0 - 120).mid, 100);
  assert.strictEqual(m.midAt('BTCUSD', T0 - 100).mid, 95, 'low at 20 s');
  assert.strictEqual(m.midAt('BTCUSD', T0 - 80).mid, 110, 'high at 40 s');
  const pts = m.pathPoints('BTCUSD', T0 - 121, T0 + 20).map((p) => p.mid);
  assert.ok(pts.includes(95) && pts.includes(110), 'both wicks are on the path');
  assert.strictEqual(pts[pts.length - 1], 106, 'path ends at the live price');
});

test('5-minute bars from minute bars and ticks, cut at data time', () => {
  const m = market();
  m._addMinute('ETHUSD', T0 - 300, [10, 12, 9, 11]);
  m._addTick('ETHUSD', T0 + 1, 11.5); m._addTick('ETHUSD', T0 + 60, 13); m._addTick('ETHUSD', T0 + 200, 8);
  const bars = m.bars5('ETHUSD', T0 - 600, T0 + 100);
  assert.deepStrictEqual(bars.map((b) => b[0]), [T0 - 300, T0]);
  assert.deepStrictEqual(bars[0].slice(1), [10, 12, 9, 11]);
  assert.deepStrictEqual(bars[1].slice(1), [11.5, 13, 11.5, 13], 'the 8 at T0+200 is after data time');
});

test('live data source: wall-clock time, spread applied, stale quotes block new trades, unknown instruments dropped', () => {
  const m = market(T0 + 5);
  m._addTick('BTCUSD', T0, 64000); m._addTick('ETHUSD', T0, 1800);
  const F = makeLiveFeed(() => m, () => (T0 + 5) * 1000);
  assert.strictEqual(F.dataTimeFor({ starts_at: '2020-01-01' }, (T0 + 5) * 1000), T0 + 5);
  assert.strictEqual(F.timeShiftFor({}), 0);
  const q = F.getPriceAt('BTCUSD', T0 + 5);
  const half = require('../server/instruments').INSTRUMENTS.BTCUSD.spread / 2;
  assert.deepStrictEqual(q, { mid: 64000, bid: 64000 - half, ask: 64000 + half, marketClosed: false });
  assert.strictEqual(F.getPriceAt('BTCUSD', T0 + 120).marketClosed, true, 'no trade for 2 minutes: closing only');
  m._setOpen(false);
  assert.strictEqual(F.getPriceAt('BTCUSD', T0 + 5).marketClosed, true, 'feed down: closing only');
  const w = F.chooseDataWindow({ startsAt: new Date(T0 * 1000), instruments: ['BTCUSD', 'EURUSD'] });
  assert.deepStrictEqual(w.instruments, ['BTCUSD']);
  assert.strictEqual(w.dataWindowStart, new Date(T0 * 1000).toISOString(), 'data time = real time');
  assert.match(w.dropped[0].reason, /no live feed/);
  assert.strictEqual(F.compSpikeBetween('BTCUSD', 0, 1e12), null, 'no spike alerts from the future');
});

test('a replay competition never switches to live prices', () => {
  assert.strictEqual(forComp({ data_source: 'replay' }).name, 'historical');
  assert.strictEqual(forComp({ data_source: undefined }).name, 'historical');
});

test('admin process: feed health comes from a fresh game-server heartbeat', () => {
  liveFeed.noteHeartbeat(new Date().toISOString());
  assert.strictEqual(liveFeed.healthy(), true);
  liveFeed.noteHeartbeat(new Date(Date.now() - 120000).toISOString());
  assert.strictEqual(liveFeed.healthy(), false, 'older than 60 s');
  liveFeed.noteHeartbeat(null);
  assert.strictEqual(liveFeed.healthy(), false);
});
