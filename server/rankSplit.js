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
function lobbyTierFor(rankName) {
  const tiers = config().tiers;
  const t = tiers.find((x) => x.ranks.includes(rankName));
  return t ? t.id : tiers[0].id;
}

function tierIndex(id) {
  return config().tiers.findIndex((t) => t.id === id);
}

// May a player whose lobby tier is `playerTier` join a lobby of `lobbyTier`?
// Own tier, or up to joinUpTiers above - never down.
function mayJoin(playerTier, lobbyTier) {
  const p = tierIndex(playerTier);
  const l = tierIndex(lobbyTier);
  if (p === -1 || l === -1) return true;
  return l >= p && l - p <= (Number(config().joinUpTiers) || 0);
}

function tierLabel(id) {
  const t = config().tiers.find((x) => x.id === id);
  return t ? t.label : null;
}

module.exports = { RANKED_PUBLIC_MODES, isSplitMode, enabled, lobbyTierFor, mayJoin, tierLabel, tierIndex };
