'use strict';

// Rank-split lobbies for RANKED public matches only (Part 2F). Ships switched
// off (gameFeel.rankSplit.enabled = false): with it off every ranked player
// shares one pool and rank is only displayed.
//
// "Ranked" here = public online matches against other live players that feed
// the global ranking: Quick War and Grand War. Never split: Blitz (unrated),
// Private War, Solo (AI only), Async, Tournament, ghost challenges, and the
// Spike & Crush / sponsor competitions (a separate system).

const gameFeel = require('./config/gameFeel');

const RANKED_PUBLIC_MODES = ['quick', 'grand'];

function isSplitMode(mode) {
  return RANKED_PUBLIC_MODES.includes(mode);
}

function config() {
  return gameFeel.get().rankSplit;
}

function enabled() {
  return Boolean(config().enabled);
}

// Lobby tier id for a rating tier name (gameEngine TIERS), from the config.
// An admin can move one player to another lobby tier by hand
// (rankSplit.playerOverrides { playerId: tierId }, set with a logged reason).
function lobbyTierFor(rankName, playerId = null) {
  const tiers = config().tiers;
  const forced = playerId && config().playerOverrides && config().playerOverrides[playerId];
  if (forced && tiers.some((t) => t.id === forced)) return forced;
  const t = tiers.find((x) => x.ranks.includes(rankName));
  return t ? t.id : tiers[0].id;
}

function tierIndex(id) {
  return config().tiers.findIndex((t) => t.id === id);
}

// May a player whose lobby tier is `playerTier` join a lobby of `lobbyTier`?
// Own tier, or up to joinUpTiers above - never down.
// extraUp: the empty-lobby fallback may offer exactly one tier more.
function mayJoin(playerTier, lobbyTier, extraUp = 0) {
  const p = tierIndex(playerTier);
  const l = tierIndex(lobbyTier);
  if (p === -1 || l === -1) return true;
  return l >= p && l - p <= (Number(config().joinUpTiers) || 0) + extraUp;
}

// The lobby tier one step above, or null at the top.
function tierAbove(id) {
  const i = tierIndex(id);
  const tiers = config().tiers;
  return i >= 0 && i + 1 < tiers.length ? tiers[i + 1].id : null;
}

function tierLabel(id) {
  const t = config().tiers.find((x) => x.id === id);
  return t ? t.label : null;
}

module.exports = { RANKED_PUBLIC_MODES, isSplitMode, enabled, lobbyTierFor, mayJoin, tierAbove, tierLabel, tierIndex };
