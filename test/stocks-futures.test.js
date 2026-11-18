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

test('P&L on a stock and a futures contract matches a hand calculation (real contract specs)', () => {
  // NVDA: BUY 10 shares at 120.00, price 121.50 -> 1.50 x 10 shares = 15.00
  assert.strictEqual(Number(instruments.calculatePnL('BUY', 10, 120.0, 121.5, 'NVDA').toFixed(2)), 15.0);
  // CL (NYMEX WTI, 1,000 barrels): SELL 1 contract at 78.40, price 77.90 -> 0.50 x 1,000 = 500.00
  assert.strictEqual(Number(instruments.calculatePnL('SELL', 1, 78.4, 77.9, 'CL').toFixed(2)), 500.0);
  // ES (CME E-mini S&P 500, $50 a point): BUY 1 at 5000.00, price 4990.00 -> -10 x 50 = -500.00
  assert.strictEqual(Number(instruments.calculatePnL('BUY', 1, 5000.0, 4990.0, 'ES').toFixed(2)), -500.0);
  // NQ ($20 a point): one 0.25 tick on 2 contracts = $10
  assert.strictEqual(Number(instruments.calculatePnL('BUY', 2, 20000.0, 20000.25, 'NQ').toFixed(2)), 10.0);
});

test('futures carry the real exchange tick and tick value', () => {
  const spec = { ES: [50, 0.25, 12.5], NQ: [20, 0.25, 5], YM: [5, 1, 5], RTY: [50, 0.1, 5], CL: [1000, 0.01, 10], GC: [100, 0.1, 10], SI: [5000, 0.005, 25], HG: [25000, 0.0005, 12.5], ZB: [1000, 0.03125, 31.25], '6E': [125000, 0.00005, 6.25], ZS: [50, 0.25, 12.5], KC: [375, 0.05, 18.75] };
  for (const [sym, [cs, tick, tv]] of Object.entries(spec)) {
    const c = instruments.INSTRUMENTS[sym];
    assert.strictEqual(c.contractSize, cs, `${sym} multiplier`);
    assert.strictEqual(c.pipSize, tick, `${sym} tick`);
    assert.ok(Math.abs(c.pipSize * c.contractSize - tv) < 1e-9 && c.pipValue === tv, `${sym} tick value`);
  }
});

test('futures trade in whole contracts, stocks in whole shares, forex in 0.01 lots', () => {
  for (const [sym, c] of Object.entries(instruments.INSTRUMENTS)) {
    if (c.category === 'futures') assert.deepStrictEqual([c.unit, c.lotStep, c.minLot], ['contract', 1, 1], sym);
    if (c.category === 'stocks') assert.deepStrictEqual([c.unit, c.lotStep, c.minLot], ['share', 1, 1], sym);
  }
  assert.strictEqual(instruments.sizeError('ES', 1), null);
  assert.match(instruments.sizeError('ES', 0.5), /at least 1 contract/);
  assert.match(instruments.sizeError('ES', 1.5), /whole contracts/);
  assert.match(instruments.sizeError('NVDA', 2.5), /whole shares/);
  assert.strictEqual(instruments.sizeError('EURUSD', 0.01), null);
  assert.match(instruments.sizeError('EURUSD', 0.001), /0.01 lots/);
  assert.strictEqual(instruments.floorToStep('ES', 2.9), 2);
  assert.strictEqual(instruments.floorToStep('EURUSD', 2.999), 2.99);
  assert.strictEqual(instruments.unitWord('ES', 1), 'contract');
  assert.strictEqual(instruments.unitWord('NVDA', 3), 'shares');
});

test('the game screens get every instrument\'s contract size from the server', () => {
  const specs = instruments.clientSpecs(Object.keys(instruments.INSTRUMENTS));
  for (const [sym, c] of Object.entries(instruments.INSTRUMENTS)) {
    assert.ok(specs[sym].contractSize > 0, `${sym} contractSize`);
    assert.strictEqual(specs[sym].contractSize, c.contractSize);
    assert.ok(['lot', 'share', 'contract'].includes(specs[sym].unit), sym);
  }
  assert.strictEqual(specs.USDJPY.usdBase, true);
});

test('The Pit: whole contracts open, fractions are refused, bots size in contracts', async () => {
  const { createGameEngine } = require('../server/gameEngine');
  const room = { emit() {} };
  const engine = createGameEngine({ to: () => room, emit() {} }, () => {}, () => {}, () => {}, () => true);
  const match = await engine.createMatch('futures');
  engine.joinMatch(match, { id: 'pit1', username: 'Pit', war_rating: 1000 });
  match.status = 'active';
  match.startedAt = Date.now() - 5000;
  const sym = match.instruments.find((s) => instruments.INSTRUMENTS[s].contractSize * 3000 < 400000) || match.instruments[0];
  const half = engine.openTrade(match.id, 'pit1', { symbol: sym, direction: 'BUY', lots: 0.5 });
  assert.strictEqual(half.success, false);
  assert.match(half.error, /contract/);
  const one = engine.openTrade(match.id, 'pit1', { symbol: sym, direction: 'BUY', lots: 1 });
  assert.ok(one.success, one.error);
  assert.strictEqual(match.players.pit1.positions[0].lots, 1);
  assert.ok(match.instruments.every((s) => instruments.sizeRules(s).unit === 'contract'));
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
