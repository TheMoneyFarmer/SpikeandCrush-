'use strict';

// Leaving the game screen keeps the seat while the player is anywhere on the
// site; only being gone from the site altogether for 60s forfeits. Runs the
// real engine with fake sockets and a fake clock, no database.

const test = require('node:test');
const assert = require('node:assert');

const { createGameEngine, LIVE_MATCH_BUSY_ERROR } = require('../server/gameEngine');
const instruments = require('../server/instruments');

const fakeIo = () => {
  const events = [];
  const room = { emit: (event, payload) => events.push({ event, payload }) };
  return { events, to: () => room };
};
const fakeSocket = (id, playerId) => ({ id, data: { player: { id: playerId } }, join() {} });

async function setup(t) {
  await instruments.preloadAll?.();
  const io = fakeIo();
  const online = new Set();
  const notes = [];
  const engine = createGameEngine(io, (...a) => notes.push(a), () => {}, () => {}, (id) => online.has(id));
  const match = await engine.createMatch('quick');
  engine.joinMatch(match, { id: 'p1', username: 'One', war_rating: 1000 });
  match.status = 'active';
  match.startedAt = Date.now();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The real order of events when a socket closes: the site registry first,
  // then the match session (server/index.js).
  const closeSocket = (s) => {
    online.delete('p1');
    engine.noteSiteDisconnected('p1');
    engine.handleDisconnect(s.id);
  };
  const openPage = () => {
    online.add('p1');
    engine.noteSiteConnected('p1');
  };
  const game = fakeSocket('game', 'p1');
  openPage();
  engine.bindSocket(game, match.id);
  return { engine, match, io, notes, game, closeSocket, openPage, online };
}
const flush = () => new Promise((r) => setImmediate(r));
const inMatch = (match) => Boolean(match.players.p1);

test('browsing other pages never forfeits, however long', async (t) => {
  const { match, game, closeSocket, openPage } = await setup(t);
  closeSocket(game);
  t.mock.timers.tick(300);
  openPage(); // the next page's socket
  t.mock.timers.tick(10 * 60 * 1000);
  await flush();
  assert.ok(inMatch(match));
  assert.strictEqual(match.players.p1.forfeited, undefined);
});

test('moving between pages is not announced to the room', async (t) => {
  const { io, game, closeSocket, openPage } = await setup(t);
  closeSocket(game);
  t.mock.timers.tick(300);
  openPage();
  t.mock.timers.tick(10000);
  assert.ok(!io.events.some((e) => e.event === 'match:player_disconnected' || e.event === 'match:player_reconnected'));
});

test('gone from the site for 60s forfeits; 59s then back does not', async (t) => {
  const { match, game, closeSocket, openPage } = await setup(t);
  closeSocket(game);
  t.mock.timers.tick(59000);
  await flush();
  assert.ok(inMatch(match));
  openPage();
  await flush();
  // A fresh 60 seconds next time, not what was left of the old timer.
  closeSocket({ id: 'page' });
  t.mock.timers.tick(59000);
  await flush();
  assert.ok(inMatch(match));
  t.mock.timers.tick(1000);
  await flush();
  assert.ok(!inMatch(match));
});

test('a real connection loss is announced, and the return too', async (t) => {
  const { io, game, closeSocket, openPage } = await setup(t);
  closeSocket(game);
  t.mock.timers.tick(6000);
  assert.ok(io.events.some((e) => e.event === 'match:player_disconnected'));
  openPage();
  assert.ok(io.events.some((e) => e.event === 'match:player_reconnected'));
});

test('an old game tab closing does not unbind the newer one', async (t) => {
  const { engine, match, game } = await setup(t);
  engine.bindSocket(fakeSocket('game2', 'p1'), match.id);
  engine.handleDisconnect(game.id);
  assert.strictEqual(match.players.p1.socketId, 'game2');
});

test('status reports the player\'s own P&L and trades', async (t) => {
  const { engine, match } = await setup(t);
  const symbol = match.instruments[0];
  const opened = engine.openTrade(match.id, 'p1', { symbol, direction: 'BUY', lots: 0.1 });
  assert.ok(opened.success, opened.error);
  const live = engine.getLiveMatchStatus('p1');
  assert.strictEqual(live.matchId, match.id);
  assert.strictEqual(live.positions.length, 1);
  assert.strictEqual(live.positions[0].symbol, symbol);
  // Each figure is rounded to the cent on its own, so they can differ by one.
  assert.ok(Math.abs(live.pnl - live.positions[0].pnl) <= 0.011, `${live.pnl} vs ${live.positions[0].pnl}`);
  assert.strictEqual(live.rank, 1);
  assert.strictEqual(engine.getLiveMatchStatus('someone-else'), null);
});

test('Smoke Screen hides the rank on the card too', async (t) => {
  const { engine, match } = await setup(t);
  match.marketEffects.smokeScreenUntil = Date.now() + 10000;
  match.marketEffects.smokeScreenCasterId = 'other';
  assert.strictEqual(engine.getLiveMatchStatus('p1').rank, null);
  match.marketEffects.smokeScreenCasterId = 'p1';
  assert.strictEqual(engine.getLiveMatchStatus('p1').rank, 1);
});

test('a second match is refused; forfeit needs the right match and frees the player', async (t) => {
  const { engine, match } = await setup(t);
  const other = await engine.createMatch('quick');
  const refused = engine.joinMatch(other, { id: 'p1', username: 'One', war_rating: 1000 });
  assert.deepStrictEqual([refused.success, refused.error], [false, LIVE_MATCH_BUSY_ERROR]);

  assert.strictEqual((await engine.forfeitLiveMatch('p1', other.id)).success, false);
  assert.strictEqual((await engine.forfeitLiveMatch('stranger', match.id)).success, false);
  assert.ok(inMatch(match));

  assert.strictEqual((await engine.forfeitLiveMatch('p1', match.id)).success, true);
  assert.ok(!inMatch(match));
  assert.strictEqual(engine.getLiveMatchStatus('p1'), null);
  assert.strictEqual(engine.joinMatch(other, { id: 'p1', username: 'One', war_rating: 1000 }).success, true);
});

test('history sends played prices but nothing past the clock', async (t) => {
  const { engine, match } = await setup(t);
  const symbol = match.instruments[0];
  match.startedAt = Date.now() - 30000;
  const ticks = engine.getPreMatchHistory(match.id)[symbol].ticks;
  const played = ticks.filter((x) => x.t >= 0);
  assert.ok(played.length >= 30);
  assert.ok(Math.max(...played.map((x) => x.t)) <= 31);
});

test('Blitz War deals 5 instruments and 2 card slots (its own identity) in 3 minutes', async () => {
  await instruments.preloadAll?.();
  const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
  const match = await engine.createMatch('blitz');
  engine.joinMatch(match, { id: 'p1', username: 'One', war_rating: 1000 });
  assert.strictEqual(match.config.durationSeconds, 180);
  assert.strictEqual(match.instruments.length, 5);
  assert.strictEqual(new Set(match.instruments).size, 5);
  assert.strictEqual(match.players.p1.cards.length, 2);
  assert.strictEqual(match.rules.cards.handSize, 2);
});

test('saved deck: every card comes from it when it holds enough (per-mode hand and card pool)', async () => {
  await instruments.preloadAll?.();
  const sabotage = require('../server/sabotage');
  const cardRules = require('../server/cards');
  const all = Object.keys(sabotage.CARDS);
  for (const mode of ['quick', 'blitz', 'solo', 'private', 'tournament', 'grand']) {
    const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
    const match = await engine.createMatch(mode);
    // The deck holds 5 cards this mode may deal (Blitz: no heavy cards, Solo: defense only).
    const deck = cardRules.allowedPool(match, { unlockedCards: all }).slice(0, 5);
    engine.joinMatch(match, { id: 'p1', username: 'One', war_rating: 1000, deck, unlockedCards: all });
    const r = match.rules.cards;
    const want = r.startingHand ? Math.min(r.handSize, r.startingHand.count) : Math.min(r.handSize, match.config.cardsPerPlayer);
    const cards = match.players.p1.cards.map((c) => c.type);
    assert.strictEqual(cards.length, Math.min(want, deck.length), mode);
    assert.strictEqual(new Set(cards).size, cards.length, mode + ' has duplicates');
    if (!r.startingHand) assert.ok(cards.every((t) => deck.includes(t)), mode + ' dealt outside the deck');
    await engine.forceEndMatch(match.id).catch(() => {});
  }
});

test('saved deck: short, empty, duplicate and unknown entries still deal a full valid hand', () => {
  const sabotage = require('../server/sabotage');
  const [a, b] = Object.keys(sabotage.CARDS);
  const short = sabotage.dealCards(3, [a]).map((c) => c.type);
  assert.strictEqual(short.length, 3);
  assert.ok(short.includes(a));
  assert.strictEqual(new Set(short).size, 3);
  const messy = sabotage.dealCards(3, [b, b, 'not_a_card', null]).map((c) => c.type);
  assert.strictEqual(new Set(messy).size, 3);
  assert.ok(messy.includes(b));
  assert.ok(messy.every((t) => sabotage.CARDS[t]));
  assert.strictEqual(sabotage.dealCards(3).length, 3);
  assert.strictEqual(sabotage.dealCards(3, undefined).length, 3);
  assert.strictEqual(sabotage.dealCards(0, [a]).length, 0);
});

test('saved deck: never shown to other players, and Grand War can still change cards in the lobby', async () => {
  await instruments.preloadAll?.();
  const sabotage = require('../server/sabotage');
  const all = Object.keys(sabotage.CARDS);
  const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
  const match = await engine.createMatch('grand');
  engine.joinMatch(match, { id: 'p1', username: 'One', war_rating: 1000, deck: all.slice(0, 5) });
  assert.strictEqual(match.players.p1.deck, undefined);
  assert.ok(!JSON.stringify(engine.buildMatchStatePayloadFor(match, null)).includes('"deck"'));
  // Grand War's pick follows its starting hand: 2 basic or mid cards.
  const choice = engine.buildMatchStatePayloadFor(match, 'p1').loadoutChoice;
  assert.strictEqual(choice.count, 2);
  const swapped = choice.allowed.slice(1, 3);
  assert.strictEqual(engine.selectLoadoutCards(match.id, 'p1', swapped).success, true);
  assert.deepStrictEqual(match.players.p1.cards.map((c) => c.type), swapped);
  // Heavy cards and the wrong count are refused.
  const heavy = all.find((id) => !choice.allowed.includes(id));
  assert.strictEqual(engine.selectLoadoutCards(match.id, 'p1', [choice.allowed[0], heavy]).success, false);
  assert.strictEqual(engine.selectLoadoutCards(match.id, 'p1', choice.allowed.slice(0, 3)).success, false);
});
