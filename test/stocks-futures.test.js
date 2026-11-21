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
  // MCL (NYMEX Micro WTI, 100 barrels): SELL 1 contract at 78.40, price 77.90 -> 0.50 x 100 = 50.00
  assert.strictEqual(Number(instruments.calculatePnL('SELL', 1, 78.4, 77.9, 'MCL').toFixed(2)), 50.0);
  // MES (CME Micro E-mini S&P 500, $5 a point): BUY 1 at 5000.00, price 4990.00 -> -10 x 5 = -50.00
  assert.strictEqual(Number(instruments.calculatePnL('BUY', 1, 5000.0, 4990.0, 'MES').toFixed(2)), -50.0);
  // MNQ ($2 a point): one 0.25 tick on 10 contracts = $5
  assert.strictEqual(Number(instruments.calculatePnL('BUY', 10, 20000.0, 20000.25, 'MNQ').toFixed(2)), 5.0);
  // ZB stays a full-size contract (no micro exists): 1/32 = $31.25
  assert.strictEqual(Number(instruments.calculatePnL('BUY', 1, 110.0, 110.03125, 'ZB').toFixed(2)), 31.25);
});

test('futures carry the real exchange tick and tick value (micros where the exchange lists one)', () => {
  const spec = { MES: [5, 0.25, 1.25], MNQ: [2, 0.25, 0.5], MYM: [0.5, 1, 0.5], M2K: [5, 0.1, 0.5], MCL: [100, 0.01, 1], MGC: [10, 0.1, 1], SIL: [1000, 0.005, 5], MHG: [2500, 0.0005, 1.25], M6E: [12500, 0.0001, 1.25], ZB: [1000, 0.03125, 31.25], ZS: [50, 0.25, 12.5], KC: [375, 0.05, 18.75] };
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
  assert.strictEqual(instruments.sizeError('MES', 1), null);
  assert.match(instruments.sizeError('MES', 0.5), /at least 1 contract/);
  assert.match(instruments.sizeError('MES', 1.5), /whole contracts/);
  assert.match(instruments.sizeError('NVDA', 2.5), /whole shares/);
  assert.strictEqual(instruments.sizeError('EURUSD', 0.01), null);
  assert.match(instruments.sizeError('EURUSD', 0.001), /0.01 lots/);
  assert.strictEqual(instruments.floorToStep('MES', 2.9), 2);
  assert.strictEqual(instruments.floorToStep('EURUSD', 2.999), 2.99);
  assert.strictEqual(instruments.unitWord('MES', 1), 'contract');
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

test('futures spreads are the real exchange size: 1 tick on deep contracts, 2 on thin ones', () => {
  const one = ['MES', 'MNQ', 'MYM', 'M2K', 'MCL', 'BZ', 'NG', 'MGC', 'SIL', 'MHG', 'M6E', 'ZB'];
  for (const [sym, c] of Object.entries(instruments.INSTRUMENTS)) {
    if (c.category !== 'futures') continue;
    const ticks = Math.round((c.spread / c.pipSize) * 1000) / 1000;
    assert.strictEqual(ticks, one.includes(sym) ? 1 : 2, `${sym} spread is ${ticks} ticks`);
  }
});

test('old full-size tickers still resolve for old trade rows', () => {
  for (const [old, micro] of [['ES', 'MES'], ['NQ', 'MNQ'], ['CL', 'MCL'], ['GC', 'MGC'], ['6E', 'M6E']]) {
    assert.ok(!instruments.INSTRUMENTS[old], `${old} is no longer offered`);
    assert.strictEqual(instruments.getInstrument(old), instruments.INSTRUMENTS[micro]);
  }
});

test('The Pit plays on a $25,000 account; every other mode keeps $10,000', async () => {
  const { createGameEngine } = require('../server/gameEngine');
  const room = { emit() {} };
  const engine = createGameEngine({ to: () => room, emit() {} }, () => {}, () => {}, () => {}, () => true);
  const pit = await engine.createMatch('futures');
  engine.joinMatch(pit, { id: 'cap1', username: 'Cap', war_rating: 1000 });
  assert.strictEqual(pit.players.cap1.balance, 25000);
  assert.strictEqual(pit.players.cap1.startingCapital, 25000);
  const quick = await engine.createMatch('quick');
  engine.joinMatch(quick, { id: 'cap2', username: 'Cap2', war_rating: 1000 });
  assert.strictEqual(quick.players.cap2.balance, 10000);
  // P&L on the board is measured from the seat's own starting capital.
  pit.status = 'active';
  pit.startedAt = Date.now() - 5000;
  const status = engine.getLiveMatchStatus('cap1');
  assert.strictEqual(status.pnl, 0);
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
    instruments.assignMatchWindow(`sf-${i}`, 'MCL', `seed-${i}`, 15, {});
    shapes.push(instruments.getMarketInfo(`sf-${i}`).MCL.shape);
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
