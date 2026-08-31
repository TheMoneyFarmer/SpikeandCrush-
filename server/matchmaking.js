'use strict';

const db = require('./database');

// Routes players into matches. gameEngine owns match lifecycle/state; this
// module only decides *which* match a player lands in.

// Quick War, Blitz War, and Grand War all use the same "join an open lobby of
// this mode, or start a fresh one" pattern - only the mode differs.
async function joinOpenLobby(gameEngine, mode, playerInfo) {
  const idealPlayers = gameEngine.MATCH_MODES[mode].idealPlayers;
  const open = gameEngine
    .listWaitingMatchesByMode(mode)
    .find((m) => Object.keys(m.players).length < idealPlayers);
  const match = open || (await gameEngine.createMatch(mode));
  const result = gameEngine.joinMatch(match, playerInfo);
  if (!result.success) return result;
  return { success: true, matchId: match.id, roomCode: match.roomCode };
}

function quickPlay(gameEngine, playerInfo) {
  return joinOpenLobby(gameEngine, 'quick', playerInfo);
}

function blitzPlay(gameEngine, playerInfo) {
  return joinOpenLobby(gameEngine, 'blitz', playerInfo);
}

// Grand War's instrument set is randomly rotated the same way Quick War's is -
// a full host-driven instrument-picker-before-lobby screen is a larger UI
// feature not built in this pass (see the final status report).
function grandPlay(gameEngine, playerInfo) {
  return joinOpenLobby(gameEngine, 'grand', playerInfo);
}

// Solo Ranked always creates its own fresh match (1 human + AI, instant start)
// rather than sharing a lobby - there's nothing to share.
async function soloPlay(gameEngine, playerInfo, favouriteInstruments) {
  const match = await gameEngine.createMatch('solo', {
    instrumentList: favouriteInstruments && favouriteInstruments.length ? favouriteInstruments.slice(0, 2) : undefined,
  });
  const result = gameEngine.joinMatch(match, playerInfo);
  if (!result.success) return result;
  return { success: true, matchId: match.id, roomCode: match.roomCode };
}

async function createPrivateWar(gameEngine, playerInfo) {
  const match = await gameEngine.createMatch('private');
  const result = gameEngine.joinMatch(match, playerInfo);
  if (!result.success) return result;
  return { success: true, matchId: match.id, roomCode: match.roomCode };
}

// Async Daily Challenge - one attempt per player per UTC calendar day. The
// instrument set and price window are seeded from today's date in
// gameEngine.createMatch, so every player who plays today gets the same
// challenge even though each gets their own private match instance.
async function asyncPlay(gameEngine, playerInfo) {
  if (db.isConfigured) {
    const already = await db.getAsyncResultToday(playerInfo.id);
    if (already) return { success: false, error: 'You already completed today\'s Async Daily Challenge - come back tomorrow.' };
  }
  const match = await gameEngine.createMatch('async');
  const result = gameEngine.joinMatch(match, playerInfo);
  if (!result.success) return result;
  return { success: true, matchId: match.id, roomCode: match.roomCode };
}

function joinByRoomCode(gameEngine, roomCode, playerInfo) {
  const match = gameEngine.getMatchByRoomCode(roomCode);
  if (!match) return { success: false, error: 'Room code not found' };
  const result = gameEngine.joinMatch(match, playerInfo);
  if (!result.success) return result;
  return { success: true, matchId: match.id, roomCode: match.roomCode };
}

module.exports = { quickPlay, blitzPlay, grandPlay, soloPlay, asyncPlay, createPrivateWar, joinByRoomCode };
