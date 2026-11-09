'use strict';

const test = require('node:test');
const assert = require('node:assert');
const instruments = require('../server/instruments');

const SYMBOLS = ['EURUSD', 'XAUUSD', 'BTCUSD', 'AAPL', 'USDJPY'];

test('live prices stay the same for a given second and round to the instrument', () => {
  instruments.assignMatchWindow('w1', 'EURUSD', null);
  const first = instruments.getCurrentPrice('w1', 'EURUSD', 30);
  instruments.getCurrentPrice('w1', 'EURUSD', 31);
  const again = instruments.getCurrentPrice('w1', 'EURUSD', 30);
  assert.deepStrictEqual(again, first);
  assert.strictEqual(first.t, 30);
  assert.strictEqual(first.mid, Number(first.mid.toFixed(instruments.getInstrument('EURUSD').decimals)));
  assert.ok(first.bid < first.ask);
  instruments.releaseMatchWindows('w1');
});

test('out of range seconds clamp to the ends of the window', () => {
  instruments.assignMatchWindow('w2', 'EURUSD', null);
  assert.strictEqual(instruments.getCurrentPrice('w2', 'EURUSD', -5).t, 0);
  const series = instruments.getFullLiveSeries('w2', 'EURUSD');
  assert.strictEqual(instruments.getCurrentPrice('w2', 'EURUSD', 1e6).t, series.length - 1);
  instruments.releaseMatchWindows('w2');
});

test('replay series matches what players were shown', () => {
  instruments.assignMatchWindow('w3', 'XAUUSD', null);
  const series = instruments.getFullLiveSeries('w3', 'XAUUSD');
  assert.strictEqual(series.length, 600);
  for (const second of [0, 1, 299, 599]) {
    assert.strictEqual(series[second].t, second);
    assert.strictEqual(series[second].mid, instruments.getCurrentPrice('w3', 'XAUUSD', second).mid);
  }
  instruments.releaseMatchWindows('w3');
});

test('pre-match history is 2 hours per second, ends just before the start, rounded, and stable', () => {
  for (const symbol of SYMBOLS) {
    instruments.assignMatchWindow('w4', symbol, null);
    const ticks = instruments.getPreMatchHistory('w4', symbol);
    assert.strictEqual(ticks.length, 7200, symbol);
    assert.strictEqual(ticks[0].t, -7200);
    assert.strictEqual(ticks[7199].t, -1);
    const decimals = instruments.getInstrument(symbol).decimals;
    for (const tick of [ticks[0], ticks[3600], ticks[7199]]) {
      assert.strictEqual(tick.mid, Number(tick.mid.toFixed(decimals)), symbol);
      assert.ok(tick.bid <= tick.mid && tick.mid <= tick.ask, symbol);
    }
    assert.deepStrictEqual(instruments.getPreMatchHistory('w4', symbol), ticks, symbol);
  }
  instruments.releaseMatchWindows('w4');
});

test('chart history is only from before the match and is the same for every request', () => {
  instruments.assignMatchWindow('w5', 'EURUSD', null);
  const a = instruments.getChartContext('w5', 'EURUSD');
  assert.ok(a.context.m1.length > 0);
  for (const key of ['m1', 'h1', 'd1']) {
    for (const row of a.context[key]) assert.ok(row[0] < -7200 + 1, `${key} bar at ${row[0]} is not history`);
  }
  assert.deepStrictEqual(instruments.getChartContext('w5', 'EURUSD'), a);
  instruments.releaseMatchWindows('w5');
  assert.strictEqual(instruments.getChartContext('w5', 'EURUSD'), null);
  assert.strictEqual(instruments.getPreMatchHistory('w5', 'EURUSD'), null);
});

test('a match window stays small', () => {
  instruments.assignMatchWindow('w6', 'EURUSD', null);
  // Bytes held in typed arrays for one instrument (was about 1.4 MB of objects).
  const seconds = instruments.getFullLiveSeries('w6', 'EURUSD').length;
  assert.strictEqual(seconds, 600);
  instruments.releaseMatchWindows('w6');
  if (global.gc) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 50; i++) for (const symbol of SYMBOLS) instruments.assignMatchWindow(`m${i}`, symbol, null);
    global.gc();
    const perMatch = (process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - before) / 50;
    assert.ok(perMatch < 500 * 1024, `per match ${Math.round(perMatch / 1024)} KB`);
    for (let i = 0; i < 50; i++) instruments.releaseMatchWindows(`m${i}`);
  }
});

test('a longer match gets live prices for its whole length', () => {
  instruments.assignMatchWindow('w7', 'EURUSD', null, 20);
  assert.strictEqual(instruments.getFullLiveSeries('w7', 'EURUSD').length, 1200);
  const late = new Set();
  for (let second = 600; second < 1200; second += 30) late.add(instruments.getCurrentPrice('w7', 'EURUSD', second).mid);
  assert.ok(late.size > 1, 'price must keep moving after 10 minutes');
  instruments.releaseMatchWindows('w7');
});
