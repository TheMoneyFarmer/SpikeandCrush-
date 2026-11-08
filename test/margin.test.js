'use strict';

// The margin rules inside a real match: free margin decides size, the position
// limit holds, and stop-out closes the worst trade first while play continues.
process.env.SUPABASE_SERVICE_KEY = '';
const test = require('node:test');
const assert = require('node:assert');
const instruments = require('../server/instruments');
const { createGameEngine, GAME_RULES } = require('../server/gameEngine');

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
    // A big profit banked, so the 50%-of-capital floor is far away and only
    // the margin rules can act.
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
    assert.ok(!player.eliminated, 'not eliminated: the 50% floor was not reached');
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
  await t.test('the 50% limit still ends trading when it is reached first', async () => {
    player.positions.length = 0;
    player.balance = 10000;
    player.softLocked = false;
    const r = open({ symbol: 'EURUSD', direction: 'BUY', lots: 1 });
    assert.ok(r.success, r.error);
    player.positions[0].entryPrice += 0.06; // about -$6,000: equity near $4,000
    for (let i = 0; i < 40 && !player.eliminated; i++) await sleep(100);
    assert.ok(player.eliminated, 'eliminated at the 50% loss limit');
    assert.strictEqual(player.positions.length, 0);
  });
});
