'use strict';

// Every tunable number for "make every minute fire": market curation, replay
// speed, earned cards, Heat, missions, spike alerts, crown, progression, rank
// split and Discover. Game code reads from here, never from literals.
//
// Admin edits are stored in app_settings under the key 'game_feel' as a
// partial object and merged over these defaults at runtime (see
// applyOverrides) - every change is audit-logged by the admin server.
//
// Nothing in here touches GAME_RULES or MODE_DURATIONS (server/gameEngine.js):
// capital, positions, leverage, margin call, stop-out and mode lengths stay
// exactly as they were.

const DEFAULTS = {
  // ---- Part 1: market data ----------------------------------------------------
  market: {
    // Off = matches use the old random window from the raw 1-minute file.
    curatedPlaylists: true,
    // Off = new competitions pick a raw 5-minute window as before. Running
    // competitions always keep the series they started on.
    curatedCompetitions: true,
    // Instruments excluded from every selector (lobby, solo picker, async,
    // private, tournament, competitions). Filled from data/curated/catalog.json
    // at build time; admin can enable/disable on top of that.
    enabledOverride: {}, // { SYMBOL: true|false } - admin switch per instrument
    enabledPerMode: {}, // { SYMBOL: { blitz: false, ... } }
    // Replay speed per mode (data seconds per real second). Chosen from the
    // measured table in docs/fire/replay-speed.md: the lowest speed that meets
    // the guarantee. Competitions always 1.
    replaySpeed: { quick: 1, blitz: 1, grand: 1, private: 1, solo: 1, tournament: 1, async: 1 },
    maxReplaySpeed: 5,
    // No-flat guarantee (seconds-level). A price may stay unchanged at most
    // this many consecutive seconds inside a curated match window.
    flatLimitSeconds: 3,
    // Curated prices stay within this band of the instrument's historical median.
    priceBandPct: 15,
    // Seam test tolerance: jump at a seam <= this x the local typical 1s move.
    seamJumpFactor: 3,
  },

  // ---- Part 2: cards ----------------------------------------------------------
  cards: {
    earnedCards: true, // feature flag: streak-earned cards
    handSize: 5, // every mode deals 5 at the start (owner decision 2026-11-11)
    // A qualifying win: net profit >= this share of starting capital...
    minWinPctOfCapital: 0.002, // 0.2% = 20 on 10,000 (see docs/fire/README.md for the measurement)
    // ...held at least this long (real seconds)...
    minHoldSeconds: 5,
    // ...and not opened and closed in the same second.
    // Rewards by streak length: cards granted when the streak reaches N.
    streakRewards: { 1: 1, 2: 1, 3: 2 },
    refillAtStreak: 5, // streak 5: every empty slot refilled
    perWinAfterRefill: 1, // each further qualifying win while streak >= 5
    // Full hand: an extra reward becomes this much Heat instead.
    heatPerOverflowCard: 25,
    maxCardsPerMinute: 3,
    maxCardsPerMatch: 12,
    // Sabotage protection: a player hit by an attack card is shielded this long.
    hitShieldSeconds: 10,
    // At most one targeting card on the same target within this window.
    sameTargetCooldownSeconds: 4,
    // Rarity weights for random fills (from the unlocked pool only).
    rarityWeights: { common: 60, rare: 28, epic: 10, legendary: 2 },
    // Damage guard: a card may never take the target's equity below this
    // share of starting capital in one hit (the stop-out line, GAME_RULES).
    floorPctOfCapital: 0.5,
  },

  // ---- Part 2E: progression ---------------------------------------------------
  progression: {
    enabled: true,
    xp: {
      matchCompleted: 40,
      win: 60, // finished 1st
      podium: 25, // finished 2nd or 3rd
      qualifyingWin: 8, // per qualifying trade win
      bestStreakPerStep: 5, // x best streak in the match
      missionCompleted: 30,
      profitPctPerPoint: 4, // per 1% profit on starting capital
      profitXpCapPerMatch: 60,
      perMatchCap: 250,
      perDayCap: 1500,
      minMatchSecondsForXp: 60, // abandoned in the first minute = no XP
    },
    // XP needed to reach each level (index = level - 1). Level 1 at 0.
    levelThresholds: [0, 150, 350, 600, 900, 1300, 1800, 2400, 3100, 3900, 4800, 5800, 7000, 8400, 10000, 12000, 14500, 17500, 21000, 25000],
    // Starting cards in hand by rating tier (names from gameEngine TIERS).
    startingCardsByTier: { Recruit: 0, Trader: 0, Broker: 1, Analyst: 1, Veteran: 1, Elite: 2, 'War Lord': 2 },
    // Top tiers get one extra card at streak 3 instead (never both).
    fasterStreakTiers: [],
  },

  // ---- Part 2F: rank split (ranked public matches only) -----------------------
  rankSplit: {
    enabled: false,
    // Lobby tiers grouped from the rating ladder.
    tiers: [
      { id: 'rookie', label: 'Rookie', ranks: ['Recruit'] },
      { id: 'trader', label: 'Trader', ranks: ['Trader', 'Broker'] },
      { id: 'veteran', label: 'Veteran', ranks: ['Analyst', 'Veteran'] },
      { id: 'warlord', label: 'Warlord', ranks: ['Elite', 'War Lord'] },
    ],
    joinUpTiers: 1,
    // Empty-lobby fallback: alone in a ranked lobby this long -> offer a lobby
    // one tier up, or Solo / a ghost challenge.
    emptyLobbyFallbackSeconds: 60,
    // Admin moves: { playerId: tierId } (each change audit-logged with a reason).
    playerOverrides: {},
    suggestedTriggerConcurrent: 200,
  },

  // ---- Part 3: engagement -----------------------------------------------------
  heat: {
    enabled: true,
    multipliers: [1, 1.5, 2, 3], // streak 0, 1, 2, 3+
    basePerWin: 100,
    sabotageLeaderBonus: 40,
  },
  missions: {
    enabled: true,
    perMatch: 2,
    coinsPerMission: 3,
    perMatchCoinCap: 6,
    perDayCoinCap: 30,
  },
  spikeAlerts: {
    enabled: true,
    leadDataSeconds: 10,
    resultShowSeconds: 4,
    topPercent: 1,
    // Long competitions: at most one alert per this many data seconds.
    minGapSecondsLong: 1800,
  },
  crown: {
    enabled: true,
    dethroneCard: true,
    dethroneCooldownSeconds: 60,
  },
  ghostChallenge: {
    enabled: true,
    expiryDays: 7,
  },

  // ---- Part 3B: Discover ------------------------------------------------------
  discover: {
    enabled: true,
    pageSize: 30,
    suggestionCacheSeconds: 60,
    weights: { friendsOfFriends: 3, similarRank: 2, sameModes: 1.5, similarHours: 1, playedTogether: 2, proximity: 0.5 },
  },
};

let overrides = {};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

let cached = DEFAULTS;

function get() {
  return cached;
}

// Admin edits (partial objects) merged over the defaults. Unknown top-level
// sections are ignored so a typo can't create a parallel config.
function applyOverrides(partial) {
  overrides = {};
  if (isObj(partial)) for (const k of Object.keys(partial)) if (k in DEFAULTS) overrides[k] = partial[k];
  cached = merge(DEFAULTS, overrides);
  return cached;
}

function getOverrides() {
  return overrides;
}

module.exports = { DEFAULTS, get, applyOverrides, getOverrides, merge };
