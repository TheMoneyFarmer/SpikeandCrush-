'use strict';

// Bell Rush (stocks only) and The Pit (futures only).

process.env.SUPABASE_URL = '';
const test = require('node:test');
const assert = require('node:assert');
const instruments = require('../server/instruments');
const modeIdentity = require('../server/config/modeIdentity');
const { MATCH_MODES } = require('../server/gameEngine');

instruments.preloadAll();
const ORIGINAL_MODES = ['quick', 'blitz', 'grand', 'tournament', 'solo', 'async', 'private'];
const catOf = (s) => instruments.INSTRUMENTS[s].category;

test('no stock or futures symbol in any other mode across 200 generated matches each', () => {
  for (const mode of ORIGINAL_MODES) {
    const rules = modeIdentity.rulesFor(mode);
    for (let i = 0; i < 200; i++) {
      const picked = mode === 'async'
        ? instruments.selectDailyInstruments(`day-${i}`, 5, mode, rules.instrumentClasses)
        : instruments.selectMatchInstruments(MATCH_MODES[mode].instrumentCount, mode, { classes: rules.instrumentClasses, dataSeconds: MATCH_MODES[mode].durationSeconds });
      for (const s of picked) assert.ok(!['stocks', 'futures'].includes(catOf(s)), `${mode} drew ${s}`);
    }
  }
});

test('guard: only Bell Rush may list stocks and only The Pit may list futures', () => {
  for (const key of Object.keys(modeIdentity.DEFAULTS)) {
    const classes = modeIdentity.rulesFor(key).instrumentClasses;
    if (key !== 'stocks') assert.ok(!classes.includes('stocks'), `${key} must not offer stocks`);
    if (key !== 'futures') assert.ok(!classes.includes('futures'), `${key} must not offer futures`);
  }
  assert.deepStrictEqual(modeIdentity.rulesFor('stocks').instrumentClasses, ['stocks']);
  assert.deepStrictEqual(modeIdentity.rulesFor('futures').instrumentClasses, ['futures']);
  // A private room may be a Bell Rush or The Pit room, never a mix.
  assert.deepStrictEqual(modeIdentity.rulesFor('private', modeIdentity.hostOptions({ flavor: 'stocks' })).instrumentClasses, ['stocks']);
});

test('Bell Rush draws about 8 stocks and The Pit about 6 futures, all with busy windows', () => {
  for (const [mode, cls, n] of [['stocks', 'stocks', 8], ['futures', 'futures', 6]]) {
    const rules = modeIdentity.rulesFor(mode);
    for (let i = 0; i < 50; i++) {
      const picked = instruments.selectMatchInstruments(MATCH_MODES[mode].instrumentCount, mode, { classes: rules.instrumentClasses, dataSeconds: MATCH_MODES[mode].durationSeconds });
      assert.strictEqual(picked.length, n);
      for (const s of picked) {
        assert.strictEqual(catOf(s), cls);
        assert.ok(instruments.actionWindowCount(s, MATCH_MODES[mode].durationSeconds) >= 40, `${s} busy windows`);
      }
    }
  }
});

test('P&L on a stock and a futures contract matches a hand calculation (existing lot maths)', () => {
  // NVDA: BUY 10 lots (shares) at 120.00, price 121.50 -> 1.50 x 10 x contractSize 1 = 15.00
  assert.strictEqual(Number(instruments.calculatePnL('BUY', 10, 120.0, 121.5, 'NVDA').toFixed(2)), 15.0);
  // CL (crude, simulated futures): SELL 0.5 lots at 78.40, price 77.90 -> 0.50 x 0.5 x 1000 = 250.00
  assert.strictEqual(Number(instruments.calculatePnL('SELL', 0.5, 78.4, 77.9, 'CL').toFixed(2)), 250.0);
  // ES: BUY 1 lot at 5000.0, price 4990.0 -> -10 x 1 x 1 = -10.00
  assert.strictEqual(Number(instruments.calculatePnL('BUY', 1, 5000.0, 4990.0, 'ES').toFixed(2)), -10.0);
});

test('hidden dates, price scale and mirror apply to the new instruments too', () => {
  const id = 'sf-shape';
  instruments.assignMatchWindow(id, 'NVDA', 'seed-sf', 10, {});
  const info = instruments.getMarketInfo(id).NVDA;
  assert.ok(info.curated, 'curated playlist (hidden real dates)');
  instruments.releaseMatchWindows(id);
  // Across seeds both flips appear and every scale is within 0.8..1.2.
  const shapes = [];
  for (let i = 0; i < 30; i++) {
    instruments.assignMatchWindow(`sf-${i}`, 'CL', `seed-${i}`, 15, {});
    shapes.push(instruments.getMarketInfo(`sf-${i}`).CL.shape);
    instruments.releaseMatchWindows(`sf-${i}`);
  }
  assert.ok(shapes.some((x) => x.flip) && shapes.some((x) => !x.flip), 'both directions');
  assert.ok(shapes.every((x) => x.scale >= 0.8 && x.scale <= 1.2), 'scale range');
  assert.ok(new Set(shapes.map((x) => x.scale)).size > 10, 'scales vary');
});

test('modes stay closed until their data has busy windows (data health gate)', () => {
  const ready = (mode) => instruments.playableSymbols(mode).filter((s) => modeIdentity.rulesFor(mode).instrumentClasses.includes(catOf(s)) && instruments.actionWindowCount(s, MATCH_MODES[mode].durationSeconds) >= 40).length;
  assert.ok(ready('stocks') >= 8, `Bell Rush has ${ready('stocks')} ready stocks`);
  assert.ok(ready('futures') >= 6, `The Pit has ${ready('futures')} ready contracts`);
});
