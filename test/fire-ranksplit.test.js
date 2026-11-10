'use strict';

// Test 15e: rank-split lobbies (ranked public modes only), flag on in the
// test, then default off = one shared pool.
process.env.SUPABASE_SERVICE_KEY = '';
const test = require('node:test');
const assert = require('node:assert');
const gameFeel = require('../server/config/gameFeel');
const matchmaking = require('../server/matchmaking');
const { createGameEngine } = require('../server/gameEngine');

const fakeIo = () => ({ to: () => ({ emit() {} }) });
const player = (id, rating) => ({ id, username: id, war_rating: rating });
// Ratings: Recruit <1000 (rookie), Trader 1000+ / Broker 1500+ (trader),
// Analyst 2000+ / Veteran 2500+ (veteran), Elite 3000+ / War Lord 3500+ (warlord).

test.afterEach(() => gameFeel.applyOverrides({}));

test('flag ON: own tier and one tier up only, a new lobby when none fits, never down', async () => {
  gameFeel.applyOverrides({ rankSplit: { enabled: true, joinUpTiers: 1 } });
  const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
  const rookieLobby = await matchmaking.quickPlay(engine, player('r1', 800));
  const m1 = engine.getMatch(rookieLobby.matchId);
  assert.strictEqual(m1.lobbyTier, 'rookie');
  // A veteran (2 tiers above rookie) does not land in the rookie lobby: joining down is never allowed.
  const vet = await matchmaking.quickPlay(engine, player('v1', 2200));
  assert.notStrictEqual(vet.matchId, rookieLobby.matchId);
  assert.strictEqual(engine.getMatch(vet.matchId).lobbyTier, 'veteran');
  // With no Trader lobby open, a Trader joins one tier up (the Veteran lobby).
  const traderUp = await matchmaking.quickPlay(engine, player('t1', 1200));
  assert.strictEqual(traderUp.matchId, vet.matchId);
  // An own-tier lobby is preferred once one exists.
  const traderRoom = await engine.createMatch('quick');
  traderRoom.lobbyTier = 'trader';
  const t2 = await matchmaking.quickPlay(engine, player('t2', 1300));
  assert.strictEqual(t2.matchId, traderRoom.id);
  const traderLobby = { matchId: traderRoom.id };
  // Rookie may join one tier up (trader) but not two (veteran).
  const byCodeUpOne = matchmaking.joinByRoomCode(engine, engine.getMatch(traderLobby.matchId).roomCode, player('r2', 700));
  assert.ok(byCodeUpOne.success, byCodeUpOne.error);
  const byCodeUpTwo = matchmaking.joinByRoomCode(engine, engine.getMatch(vet.matchId).roomCode, player('r3', 700));
  assert.strictEqual(byCodeUpTwo.success, false);
  assert.match(byCodeUpTwo.error, /Veteran tier/);
  const down = matchmaking.joinByRoomCode(engine, m1.roomCode, player('w1', 3600));
  assert.strictEqual(down.success, false, 'a War Lord joined a Rookie lobby');
});

test('flag ON: join-up 0 means exact tier only; tier boundary edits apply to new lobbies only', async () => {
  gameFeel.applyOverrides({ rankSplit: { enabled: true, joinUpTiers: 0 } });
  const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
  const t = await matchmaking.quickPlay(engine, player('t1', 1200));
  const r = matchmaking.joinByRoomCode(engine, engine.getMatch(t.matchId).roomCode, player('r1', 700));
  assert.strictEqual(r.success, false);
  const running = engine.getMatch(t.matchId);
  // Move Trader into the rookie group: the running lobby keeps its tier id.
  gameFeel.applyOverrides({ rankSplit: { enabled: true, joinUpTiers: 0, tiers: [{ id: 'rookie', label: 'Rookie', ranks: ['Recruit', 'Trader'] }, { id: 'trader', label: 'Trader', ranks: ['Broker'] }, { id: 'veteran', label: 'Veteran', ranks: ['Analyst', 'Veteran'] }, { id: 'warlord', label: 'Warlord', ranks: ['Elite', 'War Lord'] }] } });
  assert.strictEqual(running.lobbyTier, 'trader');
  const fresh = await matchmaking.quickPlay(engine, player('t2', 1100));
  assert.strictEqual(engine.getMatch(fresh.matchId).lobbyTier, 'rookie');
});

test('flag ON: non-ranked modes accept every tier (blitz, private, solo)', async () => {
  gameFeel.applyOverrides({ rankSplit: { enabled: true, joinUpTiers: 0 } });
  const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
  const b = await matchmaking.blitzPlay(engine, player('r1', 700));
  assert.strictEqual(engine.getMatch(b.matchId).lobbyTier, undefined);
  assert.ok(matchmaking.joinByRoomCode(engine, engine.getMatch(b.matchId).roomCode, player('w1', 3700)).success);
  const p = await matchmaking.createPrivateWar(engine, player('r2', 700));
  assert.ok(matchmaking.joinByRoomCode(engine, engine.getMatch(p.matchId).roomCode, player('w2', 3700)).success);
  const s = await matchmaking.soloPlay(engine, player('w3', 3700));
  assert.ok(s.success);
});

test('flag OFF (the default): every ranked player shares one pool', async () => {
  assert.strictEqual(gameFeel.get().rankSplit.enabled, false);
  const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
  const a = await matchmaking.quickPlay(engine, player('r1', 700));
  const b = await matchmaking.quickPlay(engine, player('w1', 3700));
  assert.strictEqual(a.matchId, b.matchId);
  assert.strictEqual(engine.getMatch(a.matchId).lobbyTier, undefined);
});

test('admin tier override moves one player; fallback allows exactly one tier up, never two', async () => {
  const rankSplit = require('../server/rankSplit');
  gameFeel.applyOverrides({ rankSplit: { enabled: true, joinUpTiers: 0, playerOverrides: { moved1: 'veteran' } } });
  assert.strictEqual(rankSplit.lobbyTierFor('Recruit', 'moved1'), 'veteran');
  assert.strictEqual(rankSplit.lobbyTierFor('Recruit', 'someone'), 'rookie');
  const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
  const lobby = await matchmaking.quickPlay(engine, player('moved1', 700));
  assert.strictEqual(engine.getMatch(lobby.matchId).lobbyTier, 'veteran');
  // Fallback: joinUpTiers 0 still lets a lonely player go one tier up, not two.
  assert.strictEqual(rankSplit.mayJoin('rookie', 'trader', 0), false);
  assert.strictEqual(rankSplit.mayJoin('rookie', 'trader', 1), true);
  assert.strictEqual(rankSplit.mayJoin('rookie', 'veteran', 1), false);
  assert.strictEqual(rankSplit.tierAbove('trader'), 'veteran');
  assert.strictEqual(rankSplit.tierAbove('warlord'), null);
  const traderRoom = await engine.createMatch('quick');
  traderRoom.lobbyTier = 'trader';
  assert.strictEqual(engine.joinMatch(traderRoom, player('r9', 700)).success, false);
  assert.strictEqual(engine.joinMatch(traderRoom, { ...player('r9', 700), fallbackUp: true }).success, true);
});
