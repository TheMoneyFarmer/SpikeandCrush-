'use strict';

// The margin rules inside a real match: free margin decides size, the position
// limit holds, and stop-out closes the worst trade first while play continues.
process.env.SUPABASE_SERVICE_KEY = '';
const test = require('node:test');
const assert = require('node:assert');
const instruments = require('../server/instruments');
const { createGameEngine, GAME_RULES } = require('../server/gameEngine');
// These tests are about margin arithmetic on EURUSD. Market curation drops
// EURUSD from play (docs/fire/curation.md), so it is switched off here to keep
// testing the same arithmetic on the same instrument.
require('../server/config/gameFeel').applyOverrides({ market: { curatedPlaylists: false } });

const io = { to: () => ({ emit() {} }), emit() {}, in: () => ({ emit() {} }), sockets: { sockets: new Map() } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startMatch(engine) {
  const match = await engine.createMatch('solo', { instrumentList: ['NAS100', 'EURUSD'] });
  const me = { id: 'player-1', username: 'Tester', war_rating: 1000, tier: 'Trader' };
  engine.joinMatch(match, me);
  engine.forceStartLobby(match.id);
  for (let i = 0; i < 80 && match.status !== 'active'; i++) await sleep(100);
  assert.strictEqual(match.status, 'active', 'match should start');
  return { match, player: match.players[me.id], open: (o) => engine.openTrade(match.id, me.id, o) };
}

test('margin rules in a live match', { timeout: 40000 }, async (t) => {
  instruments.preloadAll && instruments.preloadAll();
  const engine = createGameEngine(io, () => {}, () => {}, () => {});
  const { match, player, open } = await startMatch(engine);
  t.after(() => engine.voidMatch(match.id));

  const nas = instruments.getInstrument('NAS100');
  assert.ok(nas);
  await t.test('a size that would round to 0 lots is refused', () => {
    for (const lots of [0.001, 0.004, 0.009]) {
      const r = open({ symbol: 'EURUSD', direction: 'BUY', lots });
      assert.strictEqual(r.success, false);
      assert.match(r.error, /at least 0\.01/);
    }
  });
  await t.test('more than 10 lots is allowed when margin covers it', () => {
    const r = open({ symbol: 'NAS100', direction: 'BUY', lots: 12 });
    assert.ok(r.success, r.error);
  });
  await t.test('a trade bigger than free margin is refused, and says how much would fit', () => {
    const r = open({ symbol: 'EURUSD', direction: 'BUY', lots: 500 });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /Not enough free margin\. You can open up to [\d.]+ lots of EURUSD/);
    assert.strictEqual(player.positions.length, 1);
  });
  await t.test('positions stop at the limit', () => {
    while (player.positions.length < GAME_RULES.MAX_POSITIONS) {
      const r = open({ symbol: 'NAS100', direction: 'BUY', lots: 0.01 });
      assert.ok(r.success, r.error);
    }
    const r = open({ symbol: 'NAS100', direction: 'BUY', lots: 0.01 });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /Maximum open positions/);
  });
  await t.test('stop-out closes the biggest loser first, then stops, and play continues', async () => {
    player.positions.length = 0;
    player.balance = 40000;
    const big = open({ symbol: 'EURUSD', direction: 'BUY', lots: 10 });
    const small = open({ symbol: 'EURUSD', direction: 'BUY', lots: 10 });
    assert.ok(big.success && small.success, `${big.error} ${small.error}`);
    const [a, b] = player.positions;
    // Mark the first as the bigger loser by moving its entry price up.
    a.entryPrice += 0.03; // about -$30,000 on 10 lots
    b.entryPrice += 0.001; // about -$1,000 on 10 lots
    for (let i = 0; i < 40 && player.positions.length === 2; i++) await sleep(100);
    assert.strictEqual(player.positions.length, 1, 'only the worst position should close');
    assert.strictEqual(player.positions[0].id, b.id, 'the biggest loser goes first');
    assert.ok(!player.eliminated, 'still in the match');
    assert.ok(match.feed.some((f) => /was stopped out/.test(f.text || f.message || String(f))), 'stop-out appears in the feed');
    // Still under the margin call level, so new trades wait until margin is freed.
    const blocked = open({ symbol: 'NAS100', direction: 'BUY', lots: 0.01 });
    assert.match(blocked.error, /No free margin/);
    assert.ok(engine.closeTrade(match.id, 'player-1', b.id, 'manual').success);
    const again = open({ symbol: 'NAS100', direction: 'BUY', lots: 0.01 });
    assert.ok(again.success, `player can keep trading: ${again.error}`);
  });
  await t.test('margin call: no free margin blocks new trades', async () => {
    player.positions.length = 0;
    player.balance = 10000;
    // Ask for far too much: the refusal says exactly how much fits. Open that.
    const asked = open({ symbol: 'NAS100', direction: 'BUY', lots: 100000 });
    const most = Number(/up to ([\d.]+) lots/.exec(asked.error)[1]);
    assert.ok(most > 10, `more than the old 10-lot cap fits: ${most}`);
    const filled = open({ symbol: 'NAS100', direction: 'BUY', lots: most });
    assert.ok(filled.success, filled.error);
    const blocked = open({ symbol: 'EURUSD', direction: 'BUY', lots: 5 });
    assert.strictEqual(blocked.success, false);
    assert.match(blocked.error, /free margin/i);
  });
  await t.test('no fixed maximum loss: a small position can ride through more than 50%', async () => {
    player.positions.length = 0;
    player.balance = 10000;
    const r = open({ symbol: 'EURUSD', direction: 'BUY', lots: 1 });
    assert.ok(r.success, r.error);
    player.positions[0].entryPrice += 0.06; // about -$6,000: equity near $4,000, margin level far above 100%
    await new Promise((res) => setTimeout(res, 1500));
    assert.strictEqual(player.positions.length, 1, 'the position stays open');
    assert.ok(!player.eliminated, 'not eliminated');
  });
  await t.test('from a fresh account at full size, stop-out does the closing', async () => {
    player.positions.length = 0;
    player.balance = 10000;
    player.softLocked = false;
    const asked = open({ symbol: 'EURUSD', direction: 'BUY', lots: 100000 });
    const most = Number(/up to ([\d.]+) lots/.exec(asked.error)[1]);
    const r = open({ symbol: 'EURUSD', direction: 'BUY', lots: most });
    assert.ok(r.success, r.error);
    player.positions[0].entryPrice += 0.1; // far past the stop-out level
    for (let i = 0; i < 40 && player.positions.length; i++) await new Promise((res) => setTimeout(res, 100));
    assert.strictEqual(player.positions.length, 0, 'stopped out');
    assert.ok(!player.eliminated, 'still in the match');
  });
});
