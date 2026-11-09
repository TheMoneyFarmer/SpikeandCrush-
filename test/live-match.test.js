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
  assert.strictEqual(live.pnl, live.positions[0].pnl);
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
