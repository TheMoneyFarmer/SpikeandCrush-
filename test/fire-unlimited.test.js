'use strict';
// Multiplayer modes have no player cap; fixed formats keep theirs.
process.env.SUPABASE_SERVICE_KEY = '';
const test = require('node:test');
const assert = require('node:assert');
const matchmaking = require('../server/matchmaking');
const { createGameEngine } = require('../server/gameEngine');

const fakeIo = () => ({ to: () => ({ emit() {} }) });
const p = (id) => ({ id, username: id, war_rating: 1000 });

test('60 players all land in the same open Quick War lobby; Private War takes 100; Grand War has no cap', async () => {
  const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
  const ids = new Set();
  for (let i = 0; i < 60; i++) ids.add((await matchmaking.quickPlay(engine, p(`q${i}`))).matchId);
  assert.strictEqual(ids.size, 1, `split into ${ids.size} lobbies`);
  assert.strictEqual(Object.keys(engine.getMatch([...ids][0]).players).length, 60);
  const priv = await matchmaking.createPrivateWar(engine, p('host'));
  const room = engine.getMatch(priv.matchId);
  for (let i = 0; i < 99; i++) assert.ok(matchmaking.joinByRoomCode(engine, room.roomCode, p(`f${i}`)).success, `friend ${i}`);
  assert.strictEqual(Object.keys(room.players).length, 100);
  assert.strictEqual(room.status, 'waiting', 'an unlimited lobby must not auto-start when it gets big');
  const grand = await matchmaking.grandPlay(engine, p('g0'));
  for (let i = 1; i < 30; i++) await matchmaking.grandPlay(engine, p(`g${i}`));
  assert.strictEqual(Object.keys(engine.getMatch(grand.matchId).players).length, 30);
  assert.strictEqual(engine.buildMatchStatePayloadFor(room, null).maxPlayers, null);
});

test('fixed formats keep their size: Solo 1 + 3 AI seats, Tournament 2', async () => {
  const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
  const solo = await engine.createMatch('solo');
  for (let i = 0; i < 4; i++) engine.joinMatch(solo, p(`s${i}`));
  // Full: the 4th seat starts the countdown, so a 5th is refused either way.
  assert.strictEqual(engine.joinMatch(solo, p('s9')).success, false);
  const t = await engine.createMatch('tournament');
  engine.joinMatch(t, p('a'));
  engine.joinMatch(t, p('b'));
  assert.strictEqual(engine.joinMatch(t, p('c')).success, false);
  await engine.forceEndMatch(solo.id).catch(() => {});
  await engine.forceEndMatch(t.id).catch(() => {});
});
