'use strict';

const crypto = require('crypto');
const instruments = require('./instruments');
const marginRules = require('./marginRules');
const referralRules = require('./referralRules');
const sabotage = require('./sabotage');
const db = require('./database');
const battlepass = require('./battlepass');
const tournamentLib = require('./tournament');
const personas = require('./personas');
const gameFeel = require('./config/gameFeel');
const cardRules = require('./cards');
const modeIdentity = require('./config/modeIdentity');
const progression = require('./progression');
const rankSplit = require('./rankSplit');
const cosmetics = require('./cosmetics');
const intrabar = require('./intrabar');

// Replay speed for a short-mode match (data seconds per real second), from
// server/config/gameFeel.js market.replaySpeed - never from MODE_DURATIONS.
// Clamped to [1, maxReplaySpeed]; whole numbers only so data time stays on
// whole seconds.
function marketReplaySpeed(mode) {
  const m = gameFeel.get().market;
  const v = Math.floor(Number(m.replaySpeed && m.replaySpeed[mode]) || 1);
  return Math.max(1, Math.min(Number(m.maxReplaySpeed) || 1, v));
}

// Multiplayer modes have no player cap (maxPlayers: null = unlimited). Kept
// only as an exported constant for older callers; no check uses it.
const MAX_PLAYERS = null;
const MIN_PLAYERS = 2;
const STARTING_CAPITAL = 10000;
const MAX_POSITIONS = 10;
const SOFT_LOSS_WINDOW_SECONDS = 120; // 2 minutes
const SOFT_LOSS_PCT = 0.2; // 20% of starting capital lost within the current window -> locked out until it resets
const RECONNECT_GRACE_MS = 60000; // disconnect grace before a mid-match forfeit (startDisconnectGrace)
const LIVE_MATCH_BUSY_ERROR = 'You have a match in progress. Continue or forfeit it first.';
const DISCONNECT_NOTICE_DELAY_MS = 5000; // a page change drops the socket briefly: don't announce that to the room
// The core trading rules, shared with long-form competitions (compEngine.js)
// so both play by the same numbers.
const GAME_RULES = { STARTING_CAPITAL, MAX_POSITIONS, ...marginRules.MARGIN_RULES };
const ALLOWED_CHAT_MESSAGES = ['GL HF', "Let's go", 'May the best trader win', 'Ready to war'];

// Private War stays free to join for invited friends - MATCH_MODES.private's
// own entryCoins deliberately stays 0 so the shared per-player entry/prize-pool
// machinery (join charges, prize splits) never touches private matches. This
// is a separate one-time hosting fee charged only to whoever created the
// room, only once the match actually activates - see activateMatch().
const PRIVATE_WAR_HOST_FEE = 1;

// A waiting room with nobody connected for this long is closed and refunded, and
// no waiting room outlives the second limit even with someone sitting in it.
const LOBBY_IDLE_MS = (Number(process.env.LOBBY_IDLE_SECONDS) || 180) * 1000;
const LOBBY_MAX_AGE_MS = (Number(process.env.LOBBY_MAX_AGE_MINUTES) || 60) * 60 * 1000;
const LOBBY_EXPIRED_MESSAGE = 'This lobby closed because it was left waiting. Any entry coins have been refunded.';

const EXPERIENCE_LEVELS = [
  { min: 0, max: 4, label: 'Beginner' },
  { min: 5, max: 14, label: 'Developing' },
  { min: 15, max: 29, label: 'Intermediate' },
  { min: 30, max: 49, label: 'Experienced' },
  { min: 50, max: 99, label: 'Advanced' },
  { min: 100, max: 199, label: 'Expert' },
  { min: 200, max: 499, label: 'Professional' },
  { min: 500, max: Infinity, label: 'Master Trader' },
];

function getExperienceLevel(totalMatches) {
  const n = totalMatches || 0;
  return (EXPERIENCE_LEVELS.find((l) => n >= l.min && n <= l.max) || EXPERIENCE_LEVELS[0]).label;
}

// Per-mode lobby/match rules. `ratingKey` names which field on the player
// record this mode's result affects (war_rating for Quick/Blitz/Private,
// grand_war_rating / solo_rating for their own separate leaderboards, null
// for unranked modes) - createPlayerState reads the right one per match.
const MATCH_MODES = {
  quick: {
    label: 'Quick War', idealPlayers: 4, minPlayers: 2, maxPlayers: null,
    lobbyTimeoutMs: 45000, countdownSeconds: 5, durationSeconds: 600,
    instrumentCount: 5, cardsPerPlayer: 3, entryCoins: 10, ranked: true, ratingKey: 'war_rating',
    fillMethod: 'ai',
  },
  blitz: {
    label: 'Blitz War', idealPlayers: 4, minPlayers: 2, maxPlayers: null,
    lobbyTimeoutMs: 20000, countdownSeconds: 5, durationSeconds: 180,
    instrumentCount: 5, cardsPerPlayer: 3, entryCoins: 5, ranked: false, ratingKey: null,
    fillMethod: 'ai',
  },
  grand: {
    label: 'Grand War', idealPlayers: 8, minPlayers: 4, maxPlayers: null,
    lobbyTimeoutMs: 90000, countdownSeconds: 5, durationSeconds: 1200,
    instrumentCount: 5, cardsPerPlayer: 5, entryCoins: 25, ranked: true, ratingKey: 'grand_war_rating',
    fillMethod: 'ai', deckSelection: true,
  },
  private: {
    label: 'Private War', idealPlayers: 4, minPlayers: 2, maxPlayers: null,
    lobbyTimeoutMs: 45000, countdownSeconds: 5, durationSeconds: 600,
    instrumentCount: 5, cardsPerPlayer: 3, entryCoins: 0, ranked: false, ratingKey: null,
    fillMethod: 'host',
  },
  solo: {
    label: 'Solo Ranked', idealPlayers: 1, minPlayers: 1, maxPlayers: 4,
    lobbyTimeoutMs: 0, countdownSeconds: 5, durationSeconds: 600,
    instrumentCount: 2, cardsPerPlayer: 3, entryCoins: 0, ranked: true, ratingKey: 'solo_rating',
    fillMethod: 'ai_only', aiOpponents: 3,
  },
  // Public Elimination mode (display name from server/config/modeIdentity.js).
  // Bracket rounds of user-made tournaments reuse this key with their own
  // overrides (2 players, no fill, no fee) - see index.js.
  tournament: {
    label: 'Elimination', idealPlayers: 8, minPlayers: 2, maxPlayers: null,
    lobbyTimeoutMs: 60000, countdownSeconds: 5, durationSeconds: 900,
    instrumentCount: 5, cardsPerPlayer: 3, entryCoins: 10, ranked: false, ratingKey: null,
    fillMethod: 'ai',
  },
  async: {
    label: 'Async Daily Challenge', idealPlayers: 1, minPlayers: 1, maxPlayers: 1,
    lobbyTimeoutMs: 0, countdownSeconds: 0, durationSeconds: 600,
    instrumentCount: 3, cardsPerPlayer: 0, entryCoins: 5, ranked: false, ratingKey: null,
    fillMethod: 'none',
  },
};

// Read-only view of each mode's match length in seconds, for code that must
// quote the real rules (the support assistant's knowledge). Getters read
// MATCH_MODES live, so admin config overrides (applyConfigOverrides mutates
// MATCH_MODES in place) are reflected without a second copy of the numbers.
const MODE_DURATIONS = Object.freeze(
  Object.keys(MATCH_MODES).reduce((acc, mode) => {
    Object.defineProperty(acc, mode, { enumerable: true, get: () => MATCH_MODES[mode].durationSeconds });
    return acc;
  }, {})
);

// Rank-based share of the 85%-of-pool prize (15% platform cut) - replaces the
// old flat MATCH_COIN_REWARDS table now that entry fees vary by mode.
const PRIZE_SHARE_BY_RANK = { 1: 0.5, 2: 0.25, 3: 0.15, 4: 0.1 };

// ---- draws / ties -----------------------------------------------------------
//
// Two or more players finishing at identical final P&L share every rank
// position they collectively occupy: their prize percentages are summed and
// split evenly, and their rating changes are averaged. AI players never
// receive coins (pre-existing rule) - within a tied group, a human's prize
// share is boosted by redistributing what any AI member of the same group
// would otherwise have gotten, proportionally among the group's humans
// (which, since a tie is already an equal split, just means "divide the
// group's combined prize by the human count instead of the full group size").
// Solo Ranked never detects a draw at all: it's always exactly 1 human vs AI
// who never get coins/rating anyway, so a human/AI tie there should just mean
// the human wins outright, not an averaged-down result - see the
// `groupByTiedPnl` call site in endMatch().

const PNL_CENT = 100; // final P&L is compared to the nearest cent, never with raw float ===

function samePnl(a, b) {
  return Math.round(a * PNL_CENT) === Math.round(b * PNL_CENT);
}

// Groups an already-pnl-sorted-descending list of { player, pnl } entries
// into consecutive runs of equal P&L. `enableTies=false` returns every entry
// as its own singleton group (Solo Ranked's "no draws" override).
function groupByTiedPnl(sortedEntries, enableTies) {
  const groups = [];
  let current = [sortedEntries[0]];
  // A tie only within the same elimination round (or both survivors).
  const sameRound = (a, b) => ((a.player && a.player.eliminatedRound) || 0) === ((b.player && b.player.eliminatedRound) || 0);
  for (let i = 1; i < sortedEntries.length; i++) {
    if (enableTies && samePnl(sortedEntries[i].pnl, sortedEntries[i - 1].pnl) && sameRound(sortedEntries[i], sortedEntries[i - 1])) {
      current.push(sortedEntries[i]);
    } else {
      groups.push(current);
      current = [sortedEntries[i]];
    }
  }
  groups.push(current);
  return groups;
}

// The rating change a single, undisputed finish in `pos` (out of
// `totalPlayers`) would earn - the same per-rank table endMatch always used,
// factored out so a tied group can average it across the positions it spans.
function baseRatingForPosition(pos, totalPlayers) {
  if (pos === 1) return 25;
  // Checked before 2nd/3rd so last place always costs 25: in a 2-player match
  // it used to pay +10, and in a 3-player match 0, including for a forfeit.
  if (pos === totalPlayers) return -25;
  if (pos === 2) return 10;
  if (pos === 3) return 0;
  return -10;
}

const TIERS = [
  { name: 'Recruit', min: 0, max: 999 },
  { name: 'Trader', min: 1000, max: 1499 },
  { name: 'Broker', min: 1500, max: 1999 },
  { name: 'Analyst', min: 2000, max: 2499 },
  { name: 'Veteran', min: 2500, max: 2999 },
  { name: 'Elite', min: 3000, max: 3499 },
  { name: 'War Lord', min: 3500, max: Infinity },
];

function tierForRating(rating) {
  const tier = TIERS.find((t) => rating >= t.min && rating <= t.max);
  return tier ? tier.name : 'War Lord';
}

// Pure and standalone on purpose (no closure over `match`) so it's directly
// unit-testable without spinning up sockets/db - endMatch() just calls this
// with the live match's player list, mode, and config. `players` only needs
// { id, username, isAI, warRating, tier, balance, cardsPlayed, tradesMade,
// bestTrade, worstTrade, equityHistory }; `balance` is compared against
// STARTING_CAPITAL to get each player's final P&L.
function computeMatchResults(players, mode, config) {
  // Elimination: survivors first (by P&L), then knocked-out players by the
  // round they were cut in (later = better), then P&L at the cut. Every
  // other mode: P&L only (no player has eliminatedRound).
  const roundOf = (p) => p.eliminatedRound || Infinity;
  const ranked = players
    .map((p) => ({ player: p, pnl: Math.round((p.balance - STARTING_CAPITAL) * 100) / 100 }))
    .sort((a, b) => (roundOf(a.player) !== roundOf(b.player) ? roundOf(b.player) - roundOf(a.player) : b.pnl - a.pnl));

  const avgOpponentRatingFor = (playerId) => {
    const others = ranked.filter((r) => r.player.id !== playerId).map((r) => r.player.warRating);
    if (others.length === 0) return 1000;
    return others.reduce((s, r) => s + r, 0) / others.length;
  };

  // Persona-filled slots never pay a real entry fee (see fillWithAI), so
  // sizing the pool off payingPlayers alone caps it at whatever the one or
  // two real humans put in - in a now-typical 1 human + 3 persona lobby that
  // makes even 1st place pay out less than the entry fee itself, so winning
  // nets a loss. The pool is sized off the full table instead (persona seats
  // count same as a human one) so a human's win pays out like it would in a
  // genuinely full paid lobby; the platform keeps 15%, the rest splits by
  // finish position (1st/2nd/3rd/4th get 50/25/15/10%, 5th+ nothing).
  const payingPlayers = ranked.length;
  const prizePool = Math.round(config.entryCoins * payingPlayers * 0.85);

  // Solo Ranked is always exactly 1 human vs AI who never receive coins or
  // rating anyway - a tie there should just mean the human wins outright,
  // not an averaged-down draw, so it never groups players into ties at all.
  const drawDetectionEnabled = mode !== 'solo';
  const groups = groupByTiedPnl(ranked, drawDetectionEnabled);

  const results = [];
  let rankPosition = 1;
  for (const group of groups) {
    const groupSize = group.length;
    const isDraw = groupSize > 1;

    // Prize: sum the percentages of every rank position this group spans,
    // then split among the group's HUMAN members only. AI never receive
    // coins (pre-existing rule) - their share of the group's combined
    // prize is redistributed to the humans they're tied with rather than
    // forfeited, which for an equal split just means dividing by the human
    // count instead of the full group size.
    let combinedPrizeFraction = 0;
    for (let i = 0; i < groupSize; i++) combinedPrizeFraction += PRIZE_SHARE_BY_RANK[rankPosition + i] || 0;
    const humansInGroup = group.filter((e) => !e.player.isAI).length;
    const humanPrizeFraction = humansInGroup > 0 ? combinedPrizeFraction / humansInGroup : 0;

    // Rating: average the base rating change across the positions this
    // group spans, then apply the existing per-player opponent-strength
    // adjustment on top of that average (unchanged from before).
    let combinedBaseRating = 0;
    for (let i = 0; i < groupSize; i++) combinedBaseRating += baseRatingForPosition(rankPosition + i, ranked.length);
    const avgBaseRating = Math.round(combinedBaseRating / groupSize);

    for (const entry of group) {
      let ratingChange = 0;
      let newRating = entry.player.warRating;

      if (config.ranked) {
        const avgOpp = avgOpponentRatingFor(entry.player.id);
        let bonus = 0;
        if (avgBaseRating > 0 && entry.player.warRating < avgOpp) bonus = 5;
        if (avgBaseRating < 0 && entry.player.warRating > avgOpp) bonus = -5;

        ratingChange = avgBaseRating + bonus;
        newRating = Math.max(0, entry.player.warRating + ratingChange);
      }

      const coinsAwarded = entry.player.isAI ? 0 : Math.round(prizePool * humanPrizeFraction);

      results.push({
        playerId: entry.player.id,
        username: entry.player.username,
        isAI: entry.player.isAI,
        pnl: entry.pnl,
        rank: rankPosition,
        oldRating: entry.player.warRating,
        oldTier: entry.player.tier,
        newRating,
        newTier: tierForRating(newRating),
        ratingChange,
        cardsPlayed: entry.player.cardsPlayed,
        tradesMade: entry.player.tradesMade,
        bestTrade: entry.player.bestTrade || 0,
        worstTrade: entry.player.worstTrade || 0,
        coinsAwarded,
        equityHistory: entry.player.equityHistory || undefined,
        isDraw,
        drawWith: isDraw ? group.filter((e) => e.player.id !== entry.player.id).map((e) => e.player.username) : [],
        splitCount: isDraw ? humansInGroup || 1 : 1,
        // Percentages as human-readable numbers (75, not 0.75) - these feed
        // the results screen and match:draw_detected directly.
        combinedPrizePercentage: isDraw ? Math.round(combinedPrizeFraction * 1000) / 10 : null,
        prizePercentage: entry.player.isAI ? 0 : Math.round(humanPrizeFraction * 1000) / 10,
      });
    }

    rankPosition += groupSize;
  }

  return results;
}

const PERSONA_STYLES = ['aggressive', 'patient', 'chaos'];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// Resolves a slot-filling player to one of the persistent persona accounts
// (seeded via server/seedPersonas.js) - looked up fresh every time (not
// cached) so a persona's war_rating/tier reflect whatever it's accumulated
// from prior matches, same as a real player. Falls back to an ephemeral
// in-memory record only if the DB is unreachable or the seed script hasn't
// been run yet, so a match can still fill without crashing.
async function ensurePersonaPlayer(matchId, style) {
  const persona = personas.getPersona(style, matchId);
  let record = null;
  if (db.isConfigured) {
    try {
      record = await db.getPlayerByUsername(persona.username);
    } catch (e) {
      console.warn(`[gameEngine] could not look up persona player ${persona.username}:`, e.message);
    }
  }
  const resolved = record || {
    id: crypto.randomUUID(),
    username: persona.username,
    war_rating: persona.rating,
    tier: tierForRating(persona.rating),
  };
  return { ...resolved, personality: persona.style };
}

// Last 24h of per-match market telemetry (Fire monitor). Persisted to
// match_market_stats too when that table exists.
const MARKET_STATS = [];
const MARKET_STATS_MAX = 20000;

// Player cap: null (or 0) = unlimited. Only fixed-format modes (Solo with its
// AI seats, Tournament 1v1, Async solo) have one.
function hasCap(match) {
  const cap = Number(match.config.maxPlayers);
  return Number.isFinite(cap) && cap > 0;
}
function isFull(match) {
  return hasCap(match) && Object.keys(match.players).length >= Number(match.config.maxPlayers);
}

function createGameEngine(io, notifyPlayer, updatePresence, notifyFriendsOfWin, isPlayerOnSite) {
  let onFlatAlert = null; // set by index.js: throttled email when a match goes flat
  const matches = new Map();
  const roomCodeIndex = new Map(); // roomCode -> matchId
  const socketSessions = new Map(); // socketId -> { matchId, playerId }
  const disconnectTimers = new Map(); // "matchId:playerId" -> Timeout, while a grace period is counting down

  function roomName(matchId) {
    return `match:${matchId}`;
  }

  // `meta` carries structured fields (type/playerId/symbol/direction/lots/
  // price/pnl/cardType/ticket) for the callers that have them - the replay
  // page's trade markers and structured event feed read these directly
  // instead of parsing `text`. Callers that don't pass meta (join/AI-fill/
  // lock-reset) just produce a plain text-only feed entry, same as before.
  function pushFeed(match, text, meta) {
    const entry = { ts: Date.now(), text, ...meta };
    match.feed.push(entry);
    if (match.feed.length > 100) match.feed.shift();
    io.to(roomName(match.id)).emit('match:feed', entry);
  }

  function emitToPlayer(match, playerId, event, payload) {
    const p = match.players[playerId];
    if (p && p.socketId) io.to(p.socketId).emit(event, payload);
  }

  function emitToAll(match, event, payload) {
    io.to(roomName(match.id)).emit(event, payload);
  }

  // Never include isAI/isPersona here - personas.js and this flag exist so
  // slot-filling can look and behave exactly like a real player join to
  // every client. Server-side logic reads p.isAI directly off the internal
  // match.players record instead, never off this sanitized client payload.
  function publicPlayer(p, isSelf) {
    return {
      id: p.id,
      username: p.username,
      country: p.country,
      warRating: p.warRating,
      tier: p.tier,
      ready: p.ready,
      balance: isSelf ? p.balance : undefined,
      positions: isSelf ? p.positions : undefined,
      openPositions: p.positions.length,
      cardsPlayed: p.cardsPlayed,
      tradesMade: p.tradesMade,
      eliminated: p.eliminated,
      softLocked: p.softLocked,
      cards: p.cards.map((c) => (isSelf ? { type: c.type, used: c.used, earned: Boolean(c.earned) } : { type: c.used ? c.type : null, used: c.used })),
      level: p.level || null,
      streak: isSelf ? p.streak || 0 : undefined,
      heat: isSelf ? p.heat || 0 : undefined,
      missions: isSelf ? p.missions || [] : undefined,
      spectator: Boolean(p.spectator),
      outRound: p.eliminatedRound || null,
    };
  }

  // What the client needs to draw the card tray, Heat meter, crown, missions
  // and spike strip - feature flags and display numbers only.
  function modeRulesForClient(match) {
    const r = match.rules;
    if (!r) return null;
    const el = match.elimination || {};
    return {
      mode: match.mode,
      displayName: match.config.tournamentId ? 'Tournament round' : r.identity.displayName,
      winShort: r.identity.winShort,
      banner: match.config.tournamentId ? 'Tournament round: 15 minutes, 1 vs 1, highest equity wins.' : r.identity.banner,
      handSize: r.cards.enabled ? r.cards.handSize : 0,
      sabotage: r.cards.sabotage,
      elimination: r.elimination ? { active: Boolean(el.active), schedule: el.schedule || [], nextIdx: el.nextIdx || 0, reason: el.reason || null, rounds: (el.rounds || []).map((x) => ({ round: x.round, remaining: x.remaining })) } : null,
      events: (match.marketEvents || []).map((e) => ({ no: e.no, minute: e.minute, found: e.found })),
      checkpointMinute: r.checkpointMinute,
      host: r.host || null,
      resultHighlights: r.resultHighlights,
    };
  }

  function fireClientConfig(match) {
    const f = gameFeel.get();
    const mc = match && match.rules && match.rules.cards;
    return {
      // The mode's own slot count (Blitz 2) wins over the global hand size.
      handSize: mc ? (mc.enabled ? mc.handSize : 0) : f.cards.handSize,
      earnedCards: f.cards.earnedCards,
      streakRewards: f.cards.streakRewards,
      refillAtStreak: f.cards.refillAtStreak,
      heat: { enabled: f.heat.enabled, multipliers: f.heat.multipliers },
      missions: f.missions.enabled,
      spikeAlerts: f.spikeAlerts.enabled,
      crown: f.crown.enabled,
      ghostChallenge: f.ghostChallenge.enabled,
    };
  }

  function buildMatchStatePayloadFor(match, viewerId) {
    return {
      matchId: match.id,
      roomCode: match.roomCode,
      mode: match.mode,
      modeLabel: match.config.label || (match.mode === 'private' ? 'Private War' : match.mode),
      status: match.status,
      instruments: match.instruments,
      durationSeconds: match.config.durationSeconds,
      lobbyDeadline: match.status === 'waiting' ? match.lobbyDeadline : null,
      maxPlayers: match.config.maxPlayers,
      minPlayers: match.config.minPlayers,
      lobbyTargetSize: match.config.idealPlayers,
      hostId: match.hostId || null,
      cardsPerPlayer: match.config.cardsPerPlayer,
      entryCoins: match.config.entryCoins,
      rules: { ...marginRules.MARGIN_RULES, maxPositions: MAX_POSITIONS, softLossPct: SOFT_LOSS_PCT, softLossWindowSeconds: SOFT_LOSS_WINDOW_SECONDS },
      cardCatalog: sabotage.getCardCatalog(),
      fire: fireClientConfig(match),
      // Grand War lobby picker: how many cards this viewer picks, from which.
      loadoutChoice: match.status === 'waiting' && viewerId && match.players[viewerId] ? (({ count, allowed }) => ({ count, allowed }))(loadoutRules(match, match.players[viewerId])) : null,
      // The mode's rules as the player should see them. Never the instrument,
      // size or direction of a coming market event (that would be future data).
      modeRules: modeRulesForClient(match),
      marketSpeed: match.replaySpeed || 1,
      leaderId: match.leaderId || null,
      challenge: match.config.challenge ? { username: match.config.challenge.username, pnl: match.config.challenge.pnl } : null,
      // Rank-split lobby tier badge (ranked public modes, only when the split is on).
      lobbyTier: match.lobbyTier || null,
      feed: match.feed.slice(-30),
      players: Object.values(match.players).map((p) => publicPlayer(p, p.id === viewerId)),
      you: viewerId,
    };
  }

  function emitMatchStateToAll(match) {
    for (const p of Object.values(match.players)) {
      if (!p.socketId) continue;
      io.to(p.socketId).emit('match:state', buildMatchStatePayloadFor(match, p.id));
    }
  }

  function getElapsedSeconds(match, nowMs) {
    if (!match.startedAt) return 0;
    return Math.max(0, Math.min(match.config.durationSeconds, Math.floor((nowMs - match.startedAt) / 1000)));
  }

  function reversalOffset(reversal, symbol, nowMs) {
    if (!reversal || nowMs > reversal.until) return 0;
    const pip = instruments.getInstrument(symbol).pipSize;
    const totalMs = reversal.until - reversal.startedAt;
    const elapsedMs = nowMs - reversal.startedAt;
    const progress = totalMs > 0 ? elapsedMs / totalMs : 1;
    const magnitude = Math.max(0, 1 - Math.abs(progress - 0.5) * 2);
    return reversal.direction * pip * 10 * magnitude;
  }

  // viewerId is whoever's account this price is being computed FOR (the
  // trader opening/closing/holding a position, or a specific socket's
  // price:update) - null means "no one is exempt", i.e. the fully-affected
  // price, which is what the room-wide broadcast (spectators included)
  // still gets unchanged. Passing the real viewer lets market-wide sabotage
  // cards (volatility_surge, spread_spike) exempt the player who cast them,
  // per FIX: sabotage cards must not affect the caster - reversal_flash is
  // deliberately NOT exempted here since the spec calls for it to still
  // move a shared price for everyone; the caster's edge is a private
  // warning before it starts, handled in playSabotageCard/sabotage.js.
  function getEffectivePrice(match, symbol, elapsedSeconds, nowMs, viewerId = null) {
    // time_warp: everyone except the caster reads prices from 3 seconds in
    // the past for the effect's duration - getCurrentPrice already clamps
    // an out-of-range index to 0, so this is safe even early in a match.
    const immune = (casterId) => marketImmune(match, viewerId, casterId, nowMs);
    const timeWarpActive = nowMs < match.marketEffects.timeWarpUntil && !immune(match.marketEffects.timeWarpCasterId);
    const effectiveElapsed = timeWarpActive ? elapsedSeconds - 3 : elapsedSeconds;

    const raw = instruments.getCurrentPrice(match.id, symbol, effectiveElapsed);
    let mid = raw.mid;

    // createMarketEffects() only seeds EURUSD/XAUUSD entries (its hardcoded,
    // pre-instrument-rotation default) - lazily seed any other symbol here so
    // sabotage cards and AI trading don't crash on the other 17 instruments.
    if (!match.marketEffects[symbol]) {
      match.marketEffects[symbol] = { spreadMultiplier: 1, spreadUntil: 0, reversal: null };
    }

    if (
      nowMs < match.marketEffects.volatilitySurgeUntil &&
      match.marketEffects.volatilitySurgeBaseline &&
      !immune(match.marketEffects.volatilitySurgeCasterId)
    ) {
      const baseline = match.marketEffects.volatilitySurgeBaseline[symbol];
      mid = baseline + (mid - baseline) * 2;
    }

    // dead_calm: price stays pinned at the value it had the instant the card
    // was cast, for everyone except the caster - baseline captured by
    // playSabotageCard right after sabotage.js's playCard() returns, exactly
    // like volatility_surge's baseline just above.
    if (
      nowMs < match.marketEffects.deadCalmUntil &&
      match.marketEffects.deadCalmBaseline &&
      !immune(match.marketEffects.deadCalmCasterId)
    ) {
      mid = match.marketEffects.deadCalmBaseline[symbol];
    }

    const reversal = match.marketEffects[symbol].reversal;
    if (reversal) {
      if (nowMs >= reversal.startedAt && nowMs < reversal.until) {
        mid += reversalOffset(reversal, symbol, nowMs);
      } else if (nowMs >= reversal.until) {
        match.marketEffects[symbol].reversal = null;
      }
    }

    // fog_of_war: random jitter thrown into the feed for everyone except the
    // caster - the true price underneath is untouched, so the chart snaps
    // back to where it actually was once the effect ends.
    if (nowMs < match.marketEffects.fogOfWarUntil && !immune(match.marketEffects.fogOfWarCasterId)) {
      const pipSize = instruments.getInstrument(symbol)?.pipSize || 0.0001;
      // Seeded by match, symbol and second (not Math.random), so every
      // affected player sees the same jitter and a replay reproduces it.
      const jitter = intrabar.rngFor(match.marketSeed || match.id, `fog:${symbol}:${Math.floor(nowMs / 1000)}`)();
      mid += (jitter * 2 - 1) * 4 * pipSize;
    }

    const baseSpread = instruments.getSpread(symbol);
    const spreadActive =
      nowMs < match.marketEffects[symbol].spreadUntil && !immune(match.marketEffects[symbol].spreadCasterId);
    const doubleSpreadActive =
      nowMs < match.marketEffects.doubleSpreadUntil && !immune(match.marketEffects.doubleSpreadCasterId);
    let spread = spreadActive ? baseSpread * match.marketEffects[symbol].spreadMultiplier : baseSpread;
    if (doubleSpreadActive) spread *= 2;
    // Spread Blowout: only the targeted player's quotes widen.
    const viewer = viewerId ? match.players[viewerId] : null;
    if (viewer && viewer.effects.spread_blowout && nowMs < viewer.effects.spread_blowout.until) spread *= viewer.effects.spread_blowout.multiplier;

    const decimals = instruments.getInstrument(symbol)?.decimals ?? (symbol === 'EURUSD' ? 5 : 2);
    mid = Number(mid.toFixed(decimals));
    const bid = Number((mid - spread / 2).toFixed(decimals));
    const ask = Number((mid + spread / 2).toFixed(decimals));
    return { mid, bid, ask, spread: Number(spread.toFixed(decimals)) };
  }

  function computeEquity(match, player, elapsedSeconds, nowMs) {
    let equity = player.balance;
    for (const pos of player.positions) {
      const price = getEffectivePrice(match, pos.symbol, elapsedSeconds, nowMs, player.id);
      const exitPrice = pos.direction === 'BUY' ? price.bid : price.ask;
      equity += instruments.calculatePnL(pos.direction, pos.lots, pos.entryPrice, exitPrice, pos.symbol);
    }
    return equity;
  }

  function marginStats(match, player, elapsedSeconds, nowMs) {
    const equity = computeEquity(match, player, elapsedSeconds, nowMs);
    const used = marginRules.usedMargin(player.positions, (pos) => marginRules.mid(getEffectivePrice(match, pos.symbol, elapsedSeconds, nowMs, player.id)));
    return { equity, used, level: marginRules.marginLevel(equity, used) };
  }

  // Stop-out closes the biggest loser, then the next, until the margin level
  // recovers. The player keeps trading with what's left.
  function applyMarginRules(match, player, elapsedSeconds, nowMs) {
    let m = marginStats(match, player, elapsedSeconds, nowMs);
    let closed = 0;
    while (m.level !== null && m.level <= marginRules.STOP_OUT_LEVEL && player.positions.length) {
      let worst = null;
      let worstPnl = Infinity;
      for (const pos of player.positions) {
        const px = getEffectivePrice(match, pos.symbol, elapsedSeconds, nowMs, player.id);
        const pnl = instruments.calculatePnL(pos.direction, pos.lots, pos.entryPrice, pos.direction === 'BUY' ? px.bid : px.ask, pos.symbol);
        if (pnl < worstPnl) {
          worstPnl = pnl;
          worst = pos;
        }
      }
      if (!closeTrade(match.id, player.id, worst.id, 'stop_out').success) break;
      closed += 1;
      m = marginStats(match, player, elapsedSeconds, nowMs);
    }
    if (closed) {
      pushFeed(match, `${player.username} was stopped out - ${closed} position${closed === 1 ? '' : 's'} closed`, { type: 'margin_warning', timestamp: elapsedSeconds, playerId: player.id, pnl: Math.round(m.equity - STARTING_CAPITAL) });
      emitToPlayer(match, player.id, 'margin:warning', { level: 'stop_out', closed, equity: Math.round(m.equity) });
    }
    if (m.level !== null && m.level <= marginRules.MARGIN_CALL_LEVEL) {
      if (!player.marginCalled) {
        player.marginCalled = true;
        emitToPlayer(match, player.id, 'margin:warning', { level: 'margin_call', equity: Math.round(m.equity), marginLevel: Math.round(m.level) });
      }
    } else {
      player.marginCalled = false;
    }
  }

  // ---- lifecycle: creation, joining, lobby, countdown --------------------

  function generateRoomCode() {
    let code;
    do {
      code = String(Math.floor(100000 + Math.random() * 900000));
    } while (roomCodeIndex.has(code));
    return code;
  }

  // `opts.instrumentList` lets a caller pin the exact instruments (Solo Ranked's
  // player-chosen favourites, a future Grand War instrument picker, Tournament/
  // Async's server-chosen daily set) instead of a fresh random draw.
  async function createMatch(mode, opts = {}) {
    const modeConfig = MATCH_MODES[mode];
    if (!modeConfig) throw new Error(`Unknown match mode: ${mode}`);

    const matchId = crypto.randomUUID();
    const roomCode = generateRoomCode();
    // Async Daily Challenge needs every player to see the identical
    // instrument set and identical price window, so both draws are seeded
    // from today's UTC calendar day instead of Math.random().
    const dailySeed = mode === 'async' ? new Date().toISOString().slice(0, 10) : null;
    // The mode's rules for this match (server/config/modeIdentity.js),
    // snapshotted now so admin edits only reach new matches.
    const rules = modeIdentity.rulesFor(mode, mode === 'private' ? opts.hostOptions || modeIdentity.hostOptions({}) : null);
    // A pinned list (Solo favourites, tournament/async sets, ghost challenges)
    // only keeps instruments that are still playable; an empty result falls
    // back to a fresh draw so a disabled instrument can never be traded.
    const pinned = (opts.instrumentList || []).filter((s) => instruments.isPlayable(s, mode));
    const matchInstruments = pinned.length
      ? pinned
      : dailySeed
        ? instruments.selectDailyInstruments(dailySeed, modeConfig.instrumentCount, mode)
        : instruments.selectMatchInstruments(modeConfig.instrumentCount, mode, rules.instrumentPool === 'top' ? { topN: rules.instrumentPoolSize || 6 } : {});

    const liveMinutes = Math.ceil((opts.configOverrides?.durationSeconds ?? modeConfig.durationSeconds) / 60);
    // Every match gets one market seed shared by all its players (a ghost
    // challenge passes the original match's seed and start offsets back in).
    const marketSeed = opts.marketSeed || dailySeed || matchId;
    const replaySpeed = marketReplaySpeed(mode);
    for (const symbol of matchInstruments) {
      const startIndex = opts.marketStarts && Number.isInteger(opts.marketStarts[symbol]) ? opts.marketStarts[symbol] : undefined;
      instruments.assignMatchWindow(matchId, symbol, marketSeed, liveMinutes, { speed: replaySpeed, startIndex });
    }

    const match = {
      id: matchId,
      mode,
      config: { ...modeConfig, ...opts.configOverrides },
      roomCode,
      status: 'waiting',
      instruments: matchInstruments,
      marketSeed,
      replaySpeed,
      rules,
      // Elimination state (cuts), market events and the half-time checkpoint.
      elimination: { cuts: [], nextCutIndex: 0, active: false, warned: {} },
      marketEvents: [],
      checkpointShown: false,
      // Seeded generator for card draws, ghost trades and other in-match
      // chance, so a replay of the match log reproduces every amount.
      rand: intrabar.rngFor(marketSeed, `${matchId}:cards`),
      cardLog: [], // every card play: attacker, target, card, amounts, time
      cardTargetedAt: {},
      leaderId: null,
      spikePlan: [],
      players: {},
      playerOrder: [],
      createdAt: Date.now(),
      lobbyDeadline: Date.now() + (opts.configOverrides?.lobbyTimeoutMs ?? modeConfig.lobbyTimeoutMs),
      startedAt: null,
      marketEffects: sabotage.createMarketEffects(),
      feed: [],
      dbMatchId: null,
      timers: {},
      pnlSnapshots: {}, // playerId -> [{second, pnl}] - one entry per elapsed second, for the replay's equity curves
      hostId: null, // first human to join (or the creator, for Private War) - the only one who can press Start War
    };
    matches.set(matchId, match);
    roomCodeIndex.set(roomCode, matchId);

    if (db.isConfigured) {
      try {
        const row = await db.createMatch({ id: matchId, mode, roomCode, instrumentList: matchInstruments });
        match.dbMatchId = row.id;
      } catch (e) {
        console.warn('[gameEngine] createMatch persistence failed:', e.message);
      }
    }

    // lobbyTimeoutMs > 0 marks a waiting-lobby mode (quick/blitz/grand/
    // private) - those no longer auto-start on a timer at all, since that
    // was firing mid-invite just like the idealPlayers/all-ready triggers
    // did (Blitz War's 20s timeout in particular was short enough to fire
    // before a host even hit Ready). The host's Start War button, or any
    // player's "Start Now" escape hatch, are the only ways these start now.
    // lobbyDeadline is kept purely as display metadata for the lobby screen.
    return match;
  }

  function getMatch(matchId) {
    return matches.get(matchId) || null;
  }

  function getMatchByRoomCode(roomCode) {
    const id = roomCodeIndex.get(roomCode);
    return id ? matches.get(id) : null;
  }

  function getPreMatchHistory(matchId) {
    const match = matches.get(matchId);
    if (!match || match.endPayload) return null;
    // A finished match releases its price windows immediately (endMatch) but the
    // match record itself lingers in `matches` for a few more minutes before
    // cleanup - in that gap, history is simply no longer available rather than
    // an error worth a 500.
    try {
      const history = {};
      for (const symbol of match.instruments) {
        let symbolHistory = instruments.getPreMatchHistory(matchId, symbol);
        // Self-heal rather than hand the client a null: createMatch() assigns
        // every instrument's window up front, so this should never actually
        // be missing, but a client fetching this before that finishes (or
        // any other timing edge case) shouldn't leave that one chart
        // permanently blank for the rest of the match - just assign it now.
        if (!symbolHistory) {
          console.warn(`[gameEngine] pre-match window missing for ${symbol} in match ${matchId} - assigning it now`);
          // Same seed rule as createMatch() - async needs every player to see
          // an identical window, keyed off today's UTC date, not per-match.
          instruments.assignMatchWindow(matchId, symbol, match.marketSeed, Math.ceil(match.config.durationSeconds / 60), { speed: match.replaySpeed });
          symbolHistory = instruments.getPreMatchHistory(matchId, symbol);
        }
        // Prices already played, so a player returning mid-match sees their
        // chart filled in. Never anything past the clock: this route is public.
        const played = match.startedAt
          ? instruments.getFullLiveSeries(matchId, symbol).slice(0, instruments.dataSecondsFor(matchId, symbol, getElapsedSeconds(match, Date.now())) + 1)
          : [];
        history[symbol] = { ticks: symbolHistory.concat(played), ...instruments.getChartContext(matchId, symbol) };
      }
      return history;
    } catch (e) {
      console.warn('[gameEngine] getPreMatchHistory failed:', e.message);
      return null;
    }
  }

  function listWaitingQuickMatches() {
    return listWaitingMatchesByMode('quick');
  }

  function listWaitingMatchesByMode(mode) {
    return Array.from(matches.values()).filter((m) => m.mode === mode && m.status === 'waiting');
  }

  function createPlayerState(info, socketId, isAI, personality, modeConfig = MATCH_MODES.quick, matchInstruments = ['EURUSD', 'XAUUSD']) {
    // Grand War / Solo Ranked track their own separate ratings (grand_war_rating,
    // solo_rating) rather than the main war_rating - ratingKey picks which field
    // on the player record this match's result should read from and update.
    const ratingField = modeConfig.ratingKey || 'war_rating';
    const rating = info[ratingField] ?? info.warRating ?? 1000;
    const tier = tierForRating(rating);
    // Cards come only from the player's unlocked pool (server/progression.js).
    // A real player's unlocks arrive on `info.unlockedCards` from index.js;
    // personas and test players without one get the deck their rating tier
    // would have earned, and never anything locked for a new account.
    const unlocked = Array.isArray(info.unlockedCards) && info.unlockedCards.length
      ? info.unlockedCards
      : progression.unlockedCards(progression.standing({ total_matches: (TIERS.findIndex((t) => t.name === tier) + 1) * 8, wins: TIERS.findIndex((t) => t.name === tier) * 3 }));
    // Starting hand: the mode's deal plus the rank bonus, never more than the
    // hand size (gameFeel cards.handSize).
    const handSize = gameFeel.get().cards.handSize;
    const dealt = Math.min(handSize, (modeConfig.cardsPerPlayer || 0) + (modeConfig.cardsPerPlayer ? progression.startingBonusCards(tier) : 0));
    const state = {
      id: info.id,
      username: info.username,
      country: info.country || null,
      warRating: rating,
      tier,
      level: Number(info.level) || null,
      isAI,
      aiPersonality: personality,
      aiState: isAI ? createAIState(personality, matchInstruments) : null,
      ready: isAI,
      socketId,
      balance: STARTING_CAPITAL,
      positions: [],
      cards: sabotage.dealCards(dealt, info.deck, unlocked),
      cardsPlayed: 0,
      tradesMade: 0,
      effects: sabotage.createPlayerEffects(),
      marginCalled: false,
      eliminated: false,
      softLocked: false,
      riskWindowIndex: 0,
      riskWindowStartEquity: STARTING_CAPITAL,
      bestTrade: 0,
      worstTrade: 0,
      equityHistory: isAI ? null : [{ t: 0, equity: STARTING_CAPITAL }],
    };
    return cardRules.initPlayer(state, { unlockedCards: unlocked });
  }

  // The starting hand under this match's mode rules (modeIdentity): no cards
  // where the mode has none, the mode's hand size, Grand's starting hand from
  // the basic/mid tiers, and only cards the player has unlocked and the mode
  // allows (Blitz: no heavy cards; Solo: defensive only).
  function dealForMode(match, player, deck) {
    const r = match.rules && match.rules.cards;
    if (!r) return;
    if (!r.enabled) {
      player.cards = [];
      return;
    }
    let pool = cardRules.allowedPool(match, player);
    let count = Math.min(r.handSize, player.cards.length);
    if (r.startingHand) {
      const basic = progression.BASIC_DECK;
      pool = pool.filter((id) => r.startingHand.tiers.includes(modeIdentity.cardTier(id, basic, sabotage.CARDS[id].rarity)));
      count = Math.min(r.handSize, r.startingHand.count);
    }
    player.cards = sabotage.dealCards(count, deck || [], pool);
  }

  // Per-second mode work: Elimination warnings and cuts, Grand's half-time
  // standings, and each player's deepest drawdown (Steady Hand badge).
  function modeTick(match, elapsedSeconds, nowMs) {
    const rules = match.rules;
    if (!rules) return;
    if (rules.steadyHandBadge) {
      for (const p of Object.values(match.players)) {
        const eq = computeEquity(match, p, elapsedSeconds, nowMs);
        p.peakEquity = Math.max(p.peakEquity || STARTING_CAPITAL, eq);
        p.maxDrawdown = Math.max(p.maxDrawdown || 0, p.peakEquity - eq);
      }
    }
    if (rules.checkpointMinute && !match.checkpointShown && elapsedSeconds >= rules.checkpointMinute * 60) {
      match.checkpointShown = true;
      const rows = standingsNow(match, elapsedSeconds, nowMs).slice(0, 5);
      emitToAll(match, 'mode:checkpoint', { minute: rules.checkpointMinute, crown: match.leaderId ? match.players[match.leaderId]?.username : null, top: rows.map((r) => ({ username: r.username, pnl: r.pnl })) });
    }
    const el = match.elimination;
    if (!el || !el.active || el.nextIdx >= el.schedule.length) return;
    const cfg = rules.elimination;
    const at = el.schedule[el.nextIdx];
    if (el.warnedIdx < el.nextIdx && elapsedSeconds >= at - cfg.warnSeconds) {
      el.warnedIdx = el.nextIdx;
      emitToAll(match, 'elim:warning', { round: el.nextIdx + 1, cutAt: at, inSeconds: Math.max(1, at - elapsedSeconds), cutCount: cutCountFor(match) });
    }
    if (elapsedSeconds >= at) runCut(match, elapsedSeconds, nowMs);
  }

  function aliveIn(match) {
    return Object.values(match.players).filter((p) => !p.spectator);
  }

  // Bottom share of the players still in; at least 1 once 4+ remain; never
  // everyone (Elimination, server/config/modeIdentity.js).
  function cutCountFor(match) {
    const cfg = match.rules && match.rules.elimination;
    if (!cfg) return 0;
    const n = aliveIn(match).length;
    if (n < cfg.minPlayersToStart) return 0;
    return Math.min(n - 1, Math.max(1, Math.floor(n * cfg.cutShare)));
  }

  function standingsNow(match, elapsedSeconds, nowMs) {
    return Object.values(match.players)
      .map((p) => ({ id: p.id, username: p.username, equity: computeEquity(match, p, elapsedSeconds, nowMs), pnl: 0, spectator: Boolean(p.spectator) }))
      .map((r) => ({ ...r, pnl: Math.round((r.equity - STARTING_CAPITAL) * 100) / 100 }))
      .sort((a, b) => b.equity - a.equity);
  }

  // One Elimination cut: the lowest-equity players still in are knocked out
  // (offline players included - the match keeps running for them). A Lifeline
  // holder in the cut zone is skipped once and the next lowest goes instead.
  // Their open positions close at market now; they become spectators.
  function runCut(match, elapsedSeconds, nowMs) {
    const el = match.elimination;
    const round = el.nextIdx + 1;
    el.nextIdx += 1;
    const count = cutCountFor(match);
    const alive = aliveIn(match)
      .map((p) => ({ p, equity: computeEquity(match, p, elapsedSeconds, nowMs) }))
      .sort((a, b) => a.equity - b.equity);
    const dangerIds = new Set(alive.slice(0, count).map((x) => x.p.id));
    const out = [];
    const saved = [];
    for (const x of alive) {
      if (out.length >= count) break;
      const life = x.p.effects.lifeline;
      if (life && life.charges > 0) {
        life.charges -= 1;
        x.p.effects.lifeline = null;
        saved.push(x.p);
        continue;
      }
      out.push(x.p);
    }
    for (const p of out) {
      for (const pos of p.positions.slice()) closeTrade(match.id, p.id, pos.id, 'elimination');
      p.spectator = true;
      p.eliminatedRound = round;
      p.equityAtCut = Math.round(p.balance * 100) / 100;
      emitToPlayer(match, p.id, 'elim:out', { round, equity: p.equityAtCut });
    }
    for (const p of aliveIn(match)) missionProgress(match, p, { type: 'cut_survived', inDangerAtCut: dangerIds.has(p.id) });
    el.rounds.push({ round, at: elapsedSeconds, cut: out.map((p) => p.id), saved: saved.map((p) => p.id), remaining: aliveIn(match).length });
    pushFeed(match, out.length ? `Cut ${round}: ${out.map((p) => p.username).join(', ')} knocked out. ${aliveIn(match).length} left.` : `Cut ${round}: nobody knocked out.`, { type: 'elimination', timestamp: elapsedSeconds, round });
    emitToAll(match, 'elim:cut', { round, out: out.map((p) => ({ id: p.id, username: p.username })), saved: saved.map((p) => p.username), remaining: aliveIn(match).length, nextCutAt: el.schedule[el.nextIdx] ?? null });
    emitMatchStateToAll(match);
  }

  // Spike alerts, Grand War's scheduled market events and Elimination's cuts
  // for this match, from its mode rules (server/config/modeIdentity.js).
  // The run to race against, loaded once when the match goes live (never
  // blocks the start). Ghost challenge link: the challenger's run. Solo: your
  // own best Solo run. Daily Challenge: today's top run. The curve is the
  // replay's per-second P&L (replays.pnl_snapshots) - nothing new is stored.
  async function loadGhost(match) {
    if (!db.isConfigured) return;
    const humans = Object.values(match.players).filter((p) => !p.isAI);
    if (humans.length !== 1) return;
    const me = humans[0];
    const c = match.config.challenge;
    let ref = null;
    let label = null;
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    if (c && c.sourceMatchId) {
      ref = { matchId: c.sourceMatchId, playerId: c.creatorId, username: c.username, pnl: c.pnl };
      label = `${c.username}'s run`;
    } else if (match.mode === 'solo') {
      const [best, yesterday] = await Promise.all([
        db.getBestRun({ mode: 'solo', playerId: me.id }),
        db.getBestRun({ mode: 'solo', playerId: me.id, sinceIso: new Date(dayStart.getTime() - 86400000).toISOString(), untilIso: dayStart.toISOString() }),
      ]);
      match.personal = { best: best ? best.pnl : null, yesterday: yesterday ? yesterday.pnl : null };
      ref = best;
      label = 'Your best run';
    } else if (match.mode === 'async') {
      ref = await db.getBestRun({ mode: 'async', sinceIso: dayStart.toISOString() });
      if (ref && ref.playerId === me.id) label = 'Your best today';
      else if (ref) label = `${ref.username}, today's leader`;
    }
    if (!ref || match.status !== 'active') return;
    const replay = await db.getReplay(ref.matchId).catch(() => null);
    const snaps = replay && replay.pnl_snapshots && replay.pnl_snapshots[ref.playerId];
    const curve = [];
    if (Array.isArray(snaps)) for (const x of snaps) if (Number.isFinite(x.second)) curve[x.second] = Math.round(Number(x.pnl) || 0);
    match.ghost = { label, username: ref.username, pnl: ref.pnl, curve: curve.length ? Array.from(curve, (v) => v ?? null) : null };
    emitToAll(match, 'mode:ghost', { label, username: ref.username, pnl: ref.pnl, curve: match.ghost.curve, personal: match.personal || null });
  }

  function getGhost(matchId) {
    const match = matches.get(matchId);
    return match ? { ghost: match.ghost || null, personal: match.personal || null } : null;
  }

  function planModeSchedule(match, spikeEvents) {
    const rules = match.rules || modeIdentity.rulesFor(match.mode);
    const dataDuration = match.config.durationSeconds * (match.replaySpeed || 1);
    // Grand: the biggest real move near each scheduled minute (never invented).
    const events = [];
    if (rules.events && rules.events.minutes && rules.events.minutes.length) {
      // Two passes, both real moves only: the top topPercent first, then the
      // wider fallbackTopPercent (measured: 10% alone finds all three events
      // in 64% of matches, with the 25% fallback 98% - scripts/measure-grand-events.js).
      const movesAt = (pct) => match.instruments.flatMap((symbol) => instruments.getBigMoves(match.id, symbol, pct));
      const strong = movesAt(rules.events.topPercent || 10);
      const wide = rules.events.fallbackTopPercent ? movesAt(rules.events.fallbackTopPercent) : [];
      rules.events.minutes.forEach((minute, k) => {
        const at = minute * 60;
        const pick = (list) => list
          .filter((e) => Math.abs(e.dataSecond - at) <= (rules.events.searchWindowSeconds || 120) && !events.some((x) => x.dataSecond === e.dataSecond))
          .sort((a, b) => b.rangeBps - a.rangeBps)[0];
        const near = pick(strong) || pick(wide);
        match.marketEvents.push({ no: k + 1, minute, found: Boolean(near), dataSecond: near ? near.dataSecond : null, symbol: near ? near.symbol : null, movePct: near ? near.movePct : null });
        if (near) events.push({ ...near, kind: 'event', eventNo: k + 1, id: `event-${k + 1}`, alerted: false, resolved: false });
      });
    }
    // Regular spike alerts, kept a minute away from any scheduled event.
    const regular = cardRules.planSpikes(spikeEvents, dataDuration, rules).filter((sp) => !events.some((e) => Math.abs(e.dataSecond - sp.dataSecond) < 60));
    match.spikePlan = [...events, ...regular].sort((a, b) => a.dataSecond - b.dataSecond);
    // Elimination: real-time cut checkpoints; needs enough players at the start.
    const el = rules.elimination;
    const starters = Object.values(match.players).length;
    if (el && starters >= el.minPlayersToStart) {
      const schedule = [];
      for (let t = el.firstCutMinute * 60; t < match.config.durationSeconds; t += el.everyMinutes * 60) schedule.push(t);
      match.elimination = { active: true, schedule, nextIdx: 0, warnedIdx: -1, rounds: [] };
    } else {
      match.elimination = { active: false, schedule: [], nextIdx: 0, warnedIdx: -1, rounds: [], reason: el ? `Fewer than ${el.minPlayersToStart} players: no cuts this match` : null };
    }
  }

  function isInLiveMatch(playerId) {
    return liveMatchesFor(playerId).length > 0;
  }

  function joinMatch(match, playerInfo, socketId = null) {
    if (match.status !== 'waiting') return { success: false, error: 'Match already started' };
    if (match.players[playerInfo.id]) {
      return { success: true, alreadyJoined: true, match };
    }
    // Leaving the game screen keeps the seat, so a second match has to wait.
    // Tournament brackets seat both players themselves on their schedule.
    if (match.mode !== 'tournament' && isInLiveMatch(playerInfo.id)) {
      return { success: false, error: LIVE_MATCH_BUSY_ERROR };
    }
    if (isFull(match)) return { success: false, error: 'Match is full' };
    // Rank split (ranked public lobbies only, off by default): own tier or
    // the allowed tiers above, never down - whichever way the player arrives.
    if (match.lobbyTier && rankSplit.enabled() && rankSplit.isSplitMode(match.mode) && !playerInfo.isAI) {
      const mine = rankSplit.lobbyTierFor(playerInfo.tier || tierForRating(playerInfo.war_rating ?? 1000), playerInfo.id);
      if (!rankSplit.mayJoin(mine, match.lobbyTier, playerInfo.fallbackUp ? 1 : 0)) return { success: false, error: `This ranked lobby is for ${rankSplit.tierLabel(match.lobbyTier)} tier players` };
    }

    if (!match.hostId) match.hostId = playerInfo.id;

    const player = createPlayerState(playerInfo, socketId, false, null, match.config);
    dealForMode(match, player, playerInfo.deck);
    match.players[playerInfo.id] = player;
    match.playerOrder.push(playerInfo.id);

    if (db.isConfigured && match.dbMatchId) {
      db.addMatchPlayer({ matchId: match.dbMatchId, playerId: playerInfo.id }).catch(() => {});
    }

    pushFeed(match, `${player.username} joined the war`);
    emitToAll(match, 'player:joined', { player: publicPlayer(player, false) });
    emitMatchStateToAll(match);
    updatePresence?.(playerInfo.id, { status: 'in_lobby', lobbyId: match.id, matchId: null, mode: match.config.label || match.mode });

    // No mode auto-starts just because it reached idealPlayers anymore - the
    // host presses Start War instead, so a friend invite that's still
    // pending accept doesn't get raced by an instant AI fill. The one
    // exception is a mode with a fixed size reaching it, where there's nothing
    // left to wait for (Tournament War and Async start the instant both/the
    // one seat fills). Unlimited modes never fill up, so the host starts them.
    if (hasCap(match) && isFull(match)) {
      tryStartLobby(match.id, false);
    }
    return { success: true, match };
  }

  // Fills empty match slots with persona accounts, indistinguishable from a
  // real player joining: same 'player:joined' event, same feed text, same
  // lobby:chat mechanism for the occasional "GL HF" greeting. When `stagger`
  // is on (regular matchmaking lobbies, where the lobby is meant to feel
  // like it's filling with real people) each join lands 1-2s apart instead
  // of all at once; Solo Ranked and host-triggered fills stay instant.
  async function fillWithAI(match, count, { stagger = false } = {}) {
    const styles = shuffle(shuffle(PERSONA_STYLES.concat(PERSONA_STYLES).concat(PERSONA_STYLES))).slice(0, count);
    for (let i = 0; i < styles.length; i++) {
      const info = await ensurePersonaPlayer(match.id, styles[i]);
      const ratingField = match.config.ratingKey || 'war_rating';
      const player = createPlayerState(
        { id: info.id, username: info.username, [ratingField]: info[ratingField] ?? info.war_rating ?? 1000 },
        null,
        true,
        info.personality,
        match.config,
        match.instruments
      );
      dealForMode(match, player, null);
      match.players[player.id] = player;
      match.playerOrder.push(player.id);
      if (db.isConfigured && match.dbMatchId) {
        db.addMatchPlayer({ matchId: match.dbMatchId, playerId: player.id }).catch(() => {});
      }
      pushFeed(match, `${player.username} joined the war`);
      emitToAll(match, 'player:joined', { player: publicPlayer(player, false) });
      emitMatchStateToAll(match);

      const chatLine = personas.maybeJoinChatLine();
      if (chatLine) sendChatMessage(match.id, player.id, chatLine);

      if (stagger && i < styles.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 1000));
      }
    }
  }

  function tryStartLobby(matchId, forcedByTimeout) {
    const match = matches.get(matchId);
    if (!match || match.status !== 'waiting') return;

    const currentCount = Object.keys(match.players).length;
    const humanPlayers = Object.values(match.players).filter((p) => !p.isAI);
    const allReady = humanPlayers.length > 0 && humanPlayers.every((p) => p.ready);
    const isFull = currentCount >= match.config.idealPlayers;

    if (!forcedByTimeout && !allReady && !isFull) return;
    if (currentCount < match.config.minPlayers && !forcedByTimeout) return;

    clearTimeout(match.timers.lobbyTimeout);
    match.status = 'countdown'; // lock the lobby immediately so late joins/readies don't race the fill

    // Solo Ranked's "ideal" is 1 (start as soon as the one human is ready), not
    // the table size - it always fills out to 1 human + aiOpponents AI.
    const targetSize =
      match.config.fillMethod === 'ai_only'
        ? 1 + (match.config.aiOpponents || 3)
        : Math.max(match.config.minPlayers, hasCap(match) ? Math.min(match.config.idealPlayers, match.config.maxPlayers) : match.config.idealPlayers);
    const needed = match.config.fillMethod === 'none' ? 0 : Math.max(0, targetSize - currentCount);
    const stagger = match.config.fillMethod === 'ai';

    fillWithAI(match, needed, { stagger }).then(() => {
      emitMatchStateToAll(match);
      beginCountdown(match.id);
    });
  }

  // Explicit "Start War" - the host closes any waiting match once everyone
  // they're expecting has joined, instead of the lobby racing a pending
  // friend invite by auto-filling with AI the moment it's full. Applies
  // uniformly across every mode, including Solo Ranked (the lone human is
  // their own host and clicks it to begin against AI).
  function hostStartMatch(matchId, playerId) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    if (match.status !== 'waiting') return { success: false, error: 'Match already started' };
    if (match.hostId && match.hostId !== playerId) return { success: false, error: 'Only the host can start the match' };
    if (Object.keys(match.players).length < match.config.minPlayers) {
      return { success: false, error: `Need at least ${match.config.minPlayers} players to start` };
    }
    tryStartLobby(matchId, true);
    return { success: true };
  }

  // Marks a player ready. No mode auto-starts off of this anymore (see
  // hostStartMatch) - it's purely the READY/WAITING badge other players see.
  function setReady(matchId, playerId) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    const p = match.players[playerId];
    if (!p) return { success: false, error: 'Player not in match' };
    p.ready = true;
    emitMatchStateToAll(match);
    return { success: true };
  }

  function beginCountdown(matchId) {
    const match = matches.get(matchId);
    if (!match) return;
    for (const p of Object.values(match.players)) {
      if (!p.isAI) notifyPlayer?.(p.id, 'match_starting', `Your ${match.config.label || match.mode} match is starting!`);
    }
    let remaining = match.config.countdownSeconds;
    if (remaining <= 0) {
      activateMatch(matchId);
      return;
    }
    emitToAll(match, 'match:countdown', { secondsRemaining: remaining });
    match.timers.countdownInterval = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        emitToAll(match, 'match:countdown', { secondsRemaining: remaining });
      } else {
        clearInterval(match.timers.countdownInterval);
        activateMatch(match.id);
      }
    }, 1000);
  }

  async function activateMatch(matchId) {
    const match = matches.get(matchId);
    if (!match) return;
    // A match ended or voided during its countdown must never start.
    if (match.status === 'resolving' || match.status === 'finished' || match.status === 'voided' || match.status === 'active') return;
    match.status = 'active';
    match.startedAt = Date.now();

    // Private War's 1-coin hosting fee: charged to the room creator only,
    // only now that the match has actually started - not at room creation,
    // so a host isn't charged if nobody ever joins. /api/match/create
    // already pre-checked the host could afford this before letting them
    // open the room; this re-checks defensively rather than trusting time
    // hasn't passed, but never blocks a match that's already starting for
    // real people over a 1-coin shortfall.
    if (match.mode === 'private' && match.hostId && !match.hostFeeCharged && db.isConfigured) {
      match.hostFeeCharged = true;
      try {
        const host = await db.getPlayerById(match.hostId);
        if (host && host.coins >= PRIVATE_WAR_HOST_FEE) {
          await db.debitCoins(match.hostId, PRIVATE_WAR_HOST_FEE, { type: 'match_entry', matchId: match.dbMatchId, idempotencyKey: `host_fee:${match.id}` });
        } else {
          notifyPlayer?.(match.hostId, 'system', `Could not charge the ${PRIVATE_WAR_HOST_FEE}-coin Private War hosting fee - insufficient coins.`);
        }
      } catch (e) {
        console.error('[activateMatch] private war host fee charge failed:', e.message);
      }
    }

    if (db.isConfigured && match.dbMatchId) {
      db.updateMatch(match.dbMatchId, { status: 'active', start_time: new Date(match.startedAt).toISOString() }).catch(() => {});
    }

    // Spike alerts from the real indexed events in this match's windows, and
    // two quick missions per player.
    const spikeEvents = [];
    for (const symbol of match.instruments) spikeEvents.push(...instruments.getSpikeSchedule(match.id, symbol));
    planModeSchedule(match, spikeEvents);
    loadGhost(match).catch((e) => console.warn('[ghost] could not load:', e.message));
    for (const p of Object.values(match.players)) cardRules.assignMissions(match, p, { hasSpikes: match.spikePlan.length > 0 });

    emitMatchStateToAll(match);
    emitToAll(match, 'match:start', { matchId: match.id, startedAt: match.startedAt, durationSeconds: match.config.durationSeconds });
    for (const p of Object.values(match.players)) {
      if (!p.isAI) updatePresence?.(p.id, { status: 'in_match', matchId: match.id, lobbyId: null, mode: match.config.label || match.mode });
    }

    match.timers.tickInterval = setInterval(() => {
      try {
        tick(match);
      } catch (e) {
        console.error('[gameEngine] tick() threw for match', match.id, e);
      }
    }, 1000);
    match.timers.leaderboardInterval = setInterval(() => {
      try {
        emitLeaderboard(match);
      } catch (e) {
        console.error('[gameEngine] emitLeaderboard() threw for match', match.id, e);
      }
    }, 3000);
  }

  // ---- fire gameplay helpers (cards, missions, Heat) --------------------------

  // Market cards never hit their caster or anyone holding a Shield.
  function marketImmune(match, viewerId, casterId, nowMs) {
    if (viewerId === null || viewerId === undefined) return false;
    if (viewerId === casterId) return true;
    return sabotage.hasShieldCard(match.players[viewerId], nowMs);
  }

  // Slippage Storm: uses one of the target's penalised fills, returns the
  // price penalty (N x the instrument's spread) or 0.
  function takeSlippage(player, symbol, nowMs) {
    const s = player.effects.slippage_storm;
    if (!s || nowMs >= s.until || !(s.fillsLeft > 0)) return 0;
    s.fillsLeft -= 1;
    if (s.fillsLeft <= 0) player.effects.slippage_storm = null;
    return instruments.getSpread(symbol) * s.spreads;
  }

  // Missions only count trades of real size (anti-farm).
  function isMeaningful(symbol, lots, midPrice) {
    return marginRules.positionMargin(symbol, lots, midPrice) >= STARTING_CAPITAL * cardRules.MEANINGFUL_MARGIN_SHARE;
  }

  function logCard(match, entry, elapsedSeconds) {
    match.cardLog.push({ t: elapsedSeconds, at: Date.now(), ...entry });
    if (match.cardLog.length > 2000) match.cardLog.shift();
  }

  function emitCardsUpdate(match, player, extra = {}) {
    if (player.isAI) return;
    emitToPlayer(match, player.id, 'cards:update', {
      cards: player.cards.map((c) => ({ type: c.type, used: c.used, earned: Boolean(c.earned) })),
      streak: player.streak,
      bestStreak: player.bestStreak,
      heat: player.heat,
      heatMultiplier: cardRules.heatMultiplier(player.streak),
      handSize: gameFeel.get().cards.handSize,
      ...extra,
    });
  }

  // Advance a player's missions; pay finished ones in coins through the
  // atomic ledger (idempotency key per match/player/mission), within the
  // per-match and per-day caps.
  function missionProgress(match, player, ev) {
    if (player.isAI || !player.missions || !player.missions.length) return;
    const before = player.missions.map((m) => m.progress).join(',');
    const done = cardRules.missionEvent(player, ev);
    if (!done.length) {
      // Only when a chip actually moved (not on every trade).
      if (player.missions.map((m) => m.progress).join(',') !== before) emitToPlayer(match, player.id, 'missions:update', { missions: player.missions });
      return;
    }
    const m = gameFeel.get().missions;
    for (const mission of done) {
      const paidSoFar = player.missionCoins || 0;
      const coins = Math.max(0, Math.min(m.coinsPerMission, m.perMatchCoinCap - paidSoFar));
      player.missionCoins = paidSoFar + coins;
      player.missionsCompleted = (player.missionsCompleted || 0) + 1;
      mission.coins = coins;
      emitToPlayer(match, player.id, 'missions:complete', { mission, coins });
      if (coins > 0 && db.isConfigured && !player.isAI) {
        (async () => {
          try {
            const today = await db.coinsOfTypeToday(player.id, 'mission_reward');
            const allowed = Math.max(0, Math.min(coins, m.perDayCoinCap - today));
            if (allowed > 0) {
              await db.creditCoins(player.id, allowed, { type: 'mission_reward', matchId: match.dbMatchId, idempotencyKey: `mission:${match.id}:${player.id}:${mission.id}` });
            }
          } catch (e) {
            console.warn('[missions] reward failed:', e.message);
          }
        })();
      }
    }
    emitToPlayer(match, player.id, 'missions:update', { missions: player.missions });
  }

  // Market telemetry (Part 1F): per instrument, what players actually saw -
  // price changes per minute, the longest flat stretch and the range.
  function recordMarketStats(match) {
    const info = instruments.getMarketInfo(match.id) || {};
    const played = getElapsedSeconds(match, Date.now());
    for (const symbol of match.instruments) {
      const series = instruments.getFullLiveSeries(match.id, symbol);
      const speed = (info[symbol] && info[symbol].speed) || 1;
      const mids = [];
      for (let t = 0; t <= played; t++) {
        const i = Math.min(series.length - 1, t * speed);
        if (i >= 0 && series[i]) mids.push(series[i].mid);
      }
      if (mids.length < 2) continue;
      let changes = 0;
      let run = 0;
      let longest = 0;
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = 0; i < mids.length; i++) {
        hi = Math.max(hi, mids[i]);
        lo = Math.min(lo, mids[i]);
        if (i === 0) continue;
        if (mids[i] === mids[i - 1]) longest = Math.max(longest, ++run);
        else {
          run = 0;
          changes++;
        }
      }
      const row = {
        match_id: match.id,
        mode: match.mode,
        symbol,
        curated: Boolean(info[symbol] && info[symbol].curated),
        start_offset: info[symbol] && info[symbol].curated ? info[symbol].start : null,
        replay_speed: speed,
        changes_per_min: Math.round((changes / (mids.length / 60)) * 100) / 100,
        longest_flat_seconds: longest,
        range_bps: Math.round(((hi - lo) / ((hi + lo) / 2)) * 1e4 * 1000) / 1000,
        created_at: new Date().toISOString(),
      };
      MARKET_STATS.push(row);
      while (MARKET_STATS.length && (MARKET_STATS.length > MARKET_STATS_MAX || Date.parse(MARKET_STATS[0].created_at) < Date.now() - 24 * 3600 * 1000)) MARKET_STATS.shift();
      if (db.isConfigured && db.recordMarketStats) db.recordMarketStats(row).catch(() => {});
      if (longest > gameFeel.get().market.flatLimitSeconds) onFlatAlert?.(row);
    }
  }

  // XP for one finished match (server/progression.js), capped per match and
  // per day, paid once per match (idempotency key), floored by the player's
  // real history so nobody loses a level they earned. Returns what the
  // result screen shows: XP gained, level before/after, cards unlocked.
  async function awardMatchXp(match, p, r) {
    const played = getElapsedSeconds(match, Date.now());
    const xp = progression.matchXp({
      durationPlayed: played,
      abandoned: Boolean(p.forfeited),
      finalRank: r.rank,
      qualifyingWins: p.qualifyingWins,
      bestStreak: p.bestStreak,
      missionsCompleted: p.missionsCompleted || 0,
      pnl: r.pnl,
      startingCapital: STARTING_CAPITAL,
      // Self-play: a Private War alone, or a ghost challenge (no live opponent).
      selfPlay: Boolean(match.config.challenge) || (Object.values(match.players).filter((x) => !x.isAI).length === 1 && match.mode === 'private'),
    });
    // Per-mode XP multiplier (modeIdentity xpMultiplier, default 1), then the caps.
    const mult = (match.rules && match.rules.xpMultiplier) || 1;
    if (mult !== 1) xp.total = Math.min(Math.round(xp.total * mult), gameFeel.get().progression.xp.perMatchCap);
    if (!db.isConfigured) return { xpGained: xp.total, parts: xp.parts };
    const row = await db.getPlayerById(p.id);
    const stored = db.getProgress ? await db.getProgress(p.id).catch(() => null) : null;
    const before = progression.standing({ total_matches: (row?.total_matches || 1) - 1, wins: (row?.wins || 0) - (r.rank === 1 && !r.isDraw ? 1 : 0) }, stored);
    const today = stored && stored.xp_day === new Date().toISOString().slice(0, 10) ? stored.xp_today : 0;
    const gained = progression.capForDay(xp.total, today);
    let saved = null;
    if (db.awardXp) saved = await db.awardXp(p.id, { matchId: match.id, amount: gained, key: `xp:${match.id}:${p.id}`, bestStreak: p.bestStreak, bestHeat: p.bestHeat, qualifyingWins: p.qualifyingWins, floorXp: before.xp }).catch(() => null);
    const afterXp = saved ? saved.xp : before.xp + gained;
    const after = progression.standing(row || {}, { xp: afterXp });
    const unlocked = progression.newUnlocks(before, after);
    return {
      xpGained: gained,
      parts: xp.parts,
      capped: gained < xp.total,
      levelBefore: before.level,
      levelAfter: after.level,
      level: progression.levelInfo(after.xp),
      unlocked: unlocked.map((id) => ({ id, name: sabotage.CARDS[id].name, icon: sabotage.CARDS[id].icon, rarity: sabotage.CARDS[id].rarity })),
      persisted: Boolean(saved),
    };
  }

  // ---- trading -------------------------------------------------------------

  function openTrade(matchId, playerId, { symbol, direction, lots, stopLoss, takeProfit, stopLossPips, takeProfitPips }) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    if (match.status !== 'active') return { success: false, error: 'Match is not active' };
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Player not in match' };
    if (!match.instruments.includes(symbol)) return { success: false, error: 'Unknown instrument' };
    if (direction !== 'BUY' && direction !== 'SELL') return { success: false, error: 'Invalid direction' };

    const nowMs = Date.now();
    const elapsedSeconds = getElapsedSeconds(match, nowMs);

    if (player.effects.position_freeze && nowMs < player.effects.position_freeze.until) {
      return { success: false, error: 'Position freeze active - cannot open trades' };
    }
    if (player.eliminated) {
      return { success: false, error: 'You have been eliminated from this match (max loss reached)' };
    }
    if (player.softLocked) {
      return { success: false, error: 'Loss limit reached for this 2-minute window - trading resumes next window' };
    }
    if (player.spectator) {
      return { success: false, error: 'You were knocked out at a cut. You are watching now.' };
    }

    // Damaging card effects on this player (server/sabotage.js).
    const fx = player.effects;
    const on = (e) => Boolean(e && nowMs < e.until);
    if (on(fx.trade_limit) && player.positions.length >= 1) {
      return { success: false, error: 'Trade Limit active - close your open trade before opening another' };
    }
    if (on(fx.one_way) && direction !== fx.one_way.direction) {
      return { success: false, error: `One Way active - you can only ${fx.one_way.direction} right now` };
    }
    if (on(fx.cooldown_jam) && player.lastOpenAt && nowMs - player.lastOpenAt < fx.cooldown_jam.gapSeconds * 1000) {
      return { success: false, error: `Cooldown Jam active - wait ${Math.ceil((player.lastOpenAt + fx.cooldown_jam.gapSeconds * 1000 - nowMs) / 1000)}s before your next trade` };
    }

    const liquidityDrained =
      nowMs < match.marketEffects.liquidityDrainUntil && !marketImmune(match, playerId, match.marketEffects.liquidityDrainCasterId, nowMs);
    const lotLimited = player.effects.lot_limiter && nowMs < player.effects.lot_limiter.until;
    // No lot limit of its own: size is decided by free margin below. Only these
    // two sabotage cards still cap it, for as long as they last.
    const cardLotCap = Math.min(liquidityDrained ? 0.1 : Infinity, lotLimited ? 0.05 : Infinity);
    const numLots = Number(lots);
    // Sizes round to 2 decimals, so anything smaller would be a free 0-lot trade.
    if (!Number.isFinite(numLots) || numLots < 0.01) {
      return { success: false, error: 'Lot size must be at least 0.01' };
    }
    if (numLots > cardLotCap) {
      return { success: false, error: `A sabotage card limits your lot size to ${cardLotCap} right now` };
    }
    if (player.positions.length >= MAX_POSITIONS) {
      return { success: false, error: 'Maximum open positions reached' };
    }

    const price = getEffectivePrice(match, symbol, elapsedSeconds, nowMs, playerId);
    let entryPrice = direction === 'BUY' ? price.ask : price.bid;

    const margin = marginStats(match, player, elapsedSeconds, nowMs);
    const freeMargin = margin.equity - margin.used;
    const required = marginRules.positionMargin(symbol, numLots, marginRules.mid(price));
    if (required > freeMargin) {
      const most = marginRules.maxAffordableLots(symbol, marginRules.mid(price), freeMargin);
      return { success: false, error: most > 0 ? `Not enough free margin. You can open up to ${most} lots of ${symbol} right now` : 'No free margin left. Close a position to open a new one' };
    }
    // Margin Squeeze: only a share of what free margin would allow.
    if (on(fx.margin_squeeze)) {
      const most = Math.floor(marginRules.maxAffordableLots(symbol, marginRules.mid(price), freeMargin) * fx.margin_squeeze.share * 100) / 100;
      if (numLots > most) return { success: false, error: `Margin Squeeze active - you can open up to ${most} lots right now` };
    }
    // Slippage Storm: this fill lands worse by N spreads (uses one charge).
    const slip = takeSlippage(player, symbol, nowMs);
    if (slip) entryPrice = Number((entryPrice + (direction === 'BUY' ? slip : -slip)).toFixed(instruments.getInstrument(symbol).decimals));

    // SL/TP may arrive as an absolute price or as a pip distance from entry
    // (the client can't know the real fill price in advance, so "pips" lets
    // it express risk without racing the server's own price feed).
    const pipSize = instruments.getInstrument(symbol).pipSize;
    let sl = stopLoss !== undefined && stopLoss !== null && stopLoss !== '' ? Number(stopLoss) : null;
    let tp = takeProfit !== undefined && takeProfit !== null && takeProfit !== '' ? Number(takeProfit) : null;
    if (sl === null && stopLossPips) {
      const pips = Number(stopLossPips);
      if (Number.isFinite(pips) && pips > 0) sl = direction === 'BUY' ? entryPrice - pips * pipSize : entryPrice + pips * pipSize;
    }
    if (tp === null && takeProfitPips) {
      const pips = Number(takeProfitPips);
      if (Number.isFinite(pips) && pips > 0) tp = direction === 'BUY' ? entryPrice + pips * pipSize : entryPrice - pips * pipSize;
    }
    if (sl !== null && !Number.isFinite(sl)) sl = null;
    if (tp !== null && !Number.isFinite(tp)) tp = null;
    if (sl !== null && ((direction === 'BUY' && sl >= entryPrice) || (direction === 'SELL' && sl <= entryPrice))) {
      return { success: false, error: `Stop loss must be ${direction === 'BUY' ? 'below' : 'above'} the entry price` };
    }
    if (tp !== null && ((direction === 'BUY' && tp <= entryPrice) || (direction === 'SELL' && tp >= entryPrice))) {
      return { success: false, error: `Take profit must be ${direction === 'BUY' ? 'above' : 'below'} the entry price` };
    }

    const position = {
      id: crypto.randomUUID(),
      symbol,
      direction,
      lots: Math.round(numLots * 100) / 100,
      entryPrice,
      openedAt: nowMs,
      stopLoss: sl,
      takeProfit: tp,
      dbId: null,
    };
    player.positions.push(position);
    player.tradesMade += 1;
    player.lastOpenAt = nowMs;
    missionProgress(match, player, {
      type: 'open',
      meaningful: isMeaningful(symbol, position.lots, marginRules.mid(price)),
      sinceSpikeMs: match.lastSpikeAlertAt ? nowMs - match.lastSpikeAlertAt : null,
    });

    if (db.isConfigured && match.dbMatchId) {
      db.recordTrade({ matchId: match.dbMatchId, playerId: player.id, symbol, direction, lots: position.lots, entryPrice })
        .then((row) => {
          position.dbId = row.id;
        })
        .catch((e) => console.warn('[gameEngine] recordTrade failed:', e.message));
    }

    pushFeed(match, `${player.username} opened ${direction} ${position.lots} ${symbol} @ ${entryPrice}`, {
      type: 'trade_open',
      timestamp: elapsedSeconds,
      playerId: player.id,
      symbol,
      direction: direction.toLowerCase(),
      lots: position.lots,
      price: entryPrice,
      ticket: position.id,
    });
    emitToPlayer(match, player.id, 'trade:executed', { position });
    return { success: true, position };
  }

  function closeTrade(matchId, playerId, positionId, reason = 'manual') {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Player not in match' };
    const idx = player.positions.findIndex((p) => p.id === positionId);
    if (idx === -1) return { success: false, error: 'Position not found' };

    const nowMs = Date.now();
    // reason !== 'manual' covers SL/TP auto-close and this file's own
    // sabotage-triggered closes (margin_call/force_close/stop_snipe) -
    // lockout only blocks the target's own voluntary close attempts.
    if (reason === 'manual' && player.effects.lockout && nowMs < player.effects.lockout.until) {
      return { success: false, error: 'Lockout active - cannot close positions' };
    }
    const elapsedSeconds = getElapsedSeconds(match, nowMs);
    const position = player.positions[idx];
    const price = getEffectivePrice(match, position.symbol, elapsedSeconds, nowMs, playerId);
    let exitPrice = position.direction === 'BUY' ? price.bid : price.ask;
    // Slippage Storm also hits the target's own exits (not card closes).
    if (reason !== 'sabotage' && reason !== 'elimination') {
      const slip = takeSlippage(player, position.symbol, nowMs);
      if (slip) exitPrice = Number((exitPrice + (position.direction === 'BUY' ? -slip : slip)).toFixed(instruments.getInstrument(position.symbol).decimals));
    }
    const pnl = instruments.calculatePnL(position.direction, position.lots, position.entryPrice, exitPrice, position.symbol);

    player.balance = Math.round((player.balance + pnl) * 100) / 100;
    player.positions.splice(idx, 1);
    if (pnl > player.bestTrade) player.bestTrade = pnl;
    if (pnl < player.worstTrade) player.worstTrade = pnl;

    // Profit Tax: the target's next winning close pays a share to whoever
    // played it (capped, and never below the damage floor).
    const tax = player.effects.profit_tax;
    if (pnl > 0 && tax && nowMs < tax.until && match.players[tax.by]) {
      const floor = STARTING_CAPITAL * gameFeel.get().cards.floorPctOfCapital;
      const room = Math.max(0, computeEquity(match, player, elapsedSeconds, nowMs) - floor);
      const amount = Math.min(Math.round(pnl * tax.share * 100) / 100, tax.cap, Math.floor(room * 100) / 100);
      if (amount > 0) {
        const taker = match.players[tax.by];
        player.balance = Math.round((player.balance - amount) * 100) / 100;
        taker.balance = Math.round((taker.balance + amount) * 100) / 100;
        logCard(match, { attacker: taker.id, target: player.id, card: 'profit_tax', phase: 'collected', amount }, elapsedSeconds);
        pushFeed(match, `${taker.username} collected ${amount} Profit Tax from ${player.username}`, { type: 'sabotage_effect', timestamp: elapsedSeconds, playerId: taker.id, targetPlayerId: player.id, cardType: 'profit_tax', amount });
        emitToPlayer(match, player.id, 'sabotage:incoming', { cardType: 'profit_tax', amount, collected: true, cardName: 'Profit Tax' });
      }
      player.effects.profit_tax = null;
    }

    // Streak, earned cards, Heat and missions (server/cards.js).
    const earned = cardRules.onTradeClosed(match, player, { position, pnl, reason, nowMs, startingCapital: STARTING_CAPITAL });
    if (earned.qualifying || earned.reset || earned.granted.length || earned.heat) emitCardsUpdate(match, player, { earned });
    if (earned.qualifying && player.firstWinSeconds === undefined) player.firstWinSeconds = elapsedSeconds;
    missionProgress(match, player, {
      type: 'close',
      nowMs,
      elapsedSeconds,
      qualifying: earned.qualifying,
      reason,
      heldMs: nowMs - position.openedAt,
      meaningful: isMeaningful(position.symbol, position.lots, marginRules.mid(price)),
      streak: player.streak,
    });

    if (db.isConfigured && position.dbId) {
      db.closeTrade(position.dbId, { exitPrice, pnl }).catch((e) => console.warn('[gameEngine] closeTrade failed:', e.message));
    }

    pushFeed(match, `${player.username} closed ${position.symbol} ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`, {
      type: reason === 'stop_loss' ? 'sl_hit' : reason === 'take_profit' ? 'tp_hit' : 'trade_close',
      timestamp: elapsedSeconds,
      playerId: player.id,
      symbol: position.symbol,
      direction: position.direction.toLowerCase(),
      lots: position.lots,
      price: exitPrice,
      pnl,
      ticket: position.id,
    });
    emitToPlayer(match, player.id, 'trade:closed', { positionId, exitPrice, pnl, balance: player.balance, reason });
    return { success: true, pnl, exitPrice };
  }

  function closeTradePartial(matchId, playerId, positionId, percentage) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    if (match.status !== 'active') return { success: false, error: 'Match is not active' };
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Player not in match' };
    const position = player.positions.find((p) => p.id === positionId);
    if (!position) return { success: false, error: 'Position not found' };

    const pct = Number(percentage);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
      return { success: false, error: 'Partial close percentage must be between 0 and 100 (use Close for 100%)' };
    }

    const nowMs = Date.now();
    const elapsedSeconds = getElapsedSeconds(match, nowMs);
    const price = getEffectivePrice(match, position.symbol, elapsedSeconds, nowMs, playerId);
    const exitPrice = position.direction === 'BUY' ? price.bid : price.ask;

    const closedLots = Math.round(position.lots * (pct / 100) * 100) / 100;
    const remainingLots = Math.round((position.lots - closedLots) * 100) / 100;
    if (closedLots <= 0 || remainingLots <= 0) {
      return { success: false, error: 'Resulting lot sizes must be greater than 0' };
    }

    const pnl = instruments.calculatePnL(position.direction, closedLots, position.entryPrice, exitPrice, position.symbol);
    player.balance = Math.round((player.balance + pnl) * 100) / 100;
    position.lots = remainingLots;
    if (pnl > player.bestTrade) player.bestTrade = pnl;
    if (pnl < player.worstTrade) player.worstTrade = pnl;

    if (db.isConfigured && match.dbMatchId) {
      db.recordTrade({
        matchId: match.dbMatchId,
        playerId: player.id,
        symbol: position.symbol,
        direction: position.direction,
        lots: closedLots,
        entryPrice: position.entryPrice,
      })
        .then((row) => db.closeTrade(row.id, { exitPrice, pnl }))
        .catch((e) => console.warn('[gameEngine] partial close record failed:', e.message));
    }

    pushFeed(
      match,
      `${player.username} partially closed ${pct}% of ${position.symbol} ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`
    );
    emitToPlayer(match, player.id, 'trade:executed', { position, modified: true });
    emitToPlayer(match, player.id, 'trade:partial_closed', {
      positionId,
      closedLots,
      remainingLots,
      exitPrice,
      pnl,
      balance: player.balance,
    });
    return { success: true, pnl, exitPrice, closedLots, remainingLots };
  }

  function setStopLossTakeProfit(matchId, playerId, positionId, { stopLoss, takeProfit } = {}) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    if (match.status !== 'active') return { success: false, error: 'Match is not active' };
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Player not in match' };
    const position = player.positions.find((p) => p.id === positionId);
    if (!position) return { success: false, error: 'Position not found' };
    if (player.effects.order_freeze && Date.now() < player.effects.order_freeze.until) {
      return { success: false, error: 'Order Freeze active - you cannot change stop loss or take profit right now' };
    }

    // A field left out of the request (undefined) means "leave it as-is" - the
    // chart's drag-a-line-to-modify sends only the one field being dragged, so
    // treating "omitted" the same as "explicitly cleared" would wipe out the
    // other line (e.g. dragging SL would silently delete the TP) every time.
    // An explicit null (or '') still means "clear this field".
    if (stopLoss !== undefined) {
      const sl = stopLoss === null || stopLoss === '' ? null : Number(stopLoss);
      if (sl !== null && (!Number.isFinite(sl) || sl <= 0)) return { success: false, error: 'Invalid stop loss price' };
      position.stopLoss = sl;
    }
    if (takeProfit !== undefined) {
      const tp = takeProfit === null || takeProfit === '' ? null : Number(takeProfit);
      if (tp !== null && (!Number.isFinite(tp) || tp <= 0)) return { success: false, error: 'Invalid take profit price' };
      position.takeProfit = tp;
    }
    emitToPlayer(match, player.id, 'trade:executed', { position, modified: true });
    return { success: true, position };
  }

  function checkStopLossTakeProfit(match, elapsedSeconds, nowMs) {
    for (const player of Object.values(match.players)) {
      for (const pos of player.positions.slice()) {
        if (!pos.stopLoss && !pos.takeProfit) continue;
        const price = getEffectivePrice(match, pos.symbol, elapsedSeconds, nowMs, player.id);
        const exitPrice = pos.direction === 'BUY' ? price.bid : price.ask;
        // Above 1x one real second spans several data seconds: test the
        // levels against the extremes the path passed through since the last
        // tick too (same half-spread as the quote), not just where it ended.
        let worst = exitPrice;
        let best = exitPrice;
        if ((match.replaySpeed || 1) > 1 && elapsedSeconds > 0) {
          const speed = match.replaySpeed;
          const r = instruments.liveRangeBetween(match.id, pos.symbol, (elapsedSeconds - 1) * speed, elapsedSeconds * speed);
          if (r) {
            const half = (price.ask - price.bid) / 2;
            const lo = r.low + (pos.direction === 'BUY' ? -half : half);
            const hi = r.high + (pos.direction === 'BUY' ? -half : half);
            worst = pos.direction === 'BUY' ? Math.min(exitPrice, lo) : Math.max(exitPrice, hi);
            best = pos.direction === 'BUY' ? Math.max(exitPrice, hi) : Math.min(exitPrice, lo);
          }
        }

        let hitReason = null;
        if (pos.direction === 'BUY') {
          if (pos.stopLoss && worst <= pos.stopLoss) hitReason = 'stop loss';
          else if (pos.takeProfit && best >= pos.takeProfit) hitReason = 'take profit';
        } else {
          if (pos.stopLoss && worst >= pos.stopLoss) hitReason = 'stop loss';
          else if (pos.takeProfit && best <= pos.takeProfit) hitReason = 'take profit';
        }

        if (hitReason) {
          // closeTrade() already pushes a fully-typed sl_hit/tp_hit feed
          // entry (with price/pnl/ticket) - a second plain-text entry here
          // would just duplicate it as an untyped line on the replay feed.
          closeTrade(match.id, player.id, pos.id, hitReason === 'stop loss' ? 'stop_loss' : 'take_profit');
        }
      }
    }
  }

  // ---- sabotage --------------------------------------------------------------

  function playSabotageCard(matchId, playerId, cardType, opts = {}) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    if (match.status !== 'active') return { success: false, error: 'Match is not active' };

    const nowMs = Date.now();
    const caster = match.players[playerId];
    if (!caster) return { success: false, error: 'Caster not in match' };
    const target = opts.targetId ? match.players[opts.targetId] : null;
    // Guards (server/cards.js): locked cards, shields, the hit shield,
    // same-target cooldown, one damaging effect per target, offline targets.
    const blocked = cardRules.checkPlay(match, caster, cardType, target, nowMs);
    if (blocked) return { success: false, error: blocked };
    const elapsedAtPlay = getElapsedSeconds(match, nowMs);
    const targetEquityBefore = target ? computeEquity(match, target, elapsedAtPlay, nowMs) : null;
    const result = sabotage.playCard(match, playerId, cardType, {
      targetId: opts.targetId,
      symbol: opts.symbol,
      targetEquity: targetEquityBefore,
      startingCapital: STARTING_CAPITAL,
      maxPositions: MAX_POSITIONS,
      rand: match.rand,
    }, nowMs);
    if (!result.success) return result;

    if (result.stopYankTarget) {
      // The stop on the target's largest open position moves halfway to the
      // price; with no stop yet, a tight one is placed N spreads away.
      let biggest = null;
      for (const pos of target.positions) if (!biggest || pos.lots > biggest.lots) biggest = pos;
      const px = getEffectivePrice(match, biggest.symbol, elapsedAtPlay, nowMs, target.id);
      const exit = biggest.direction === 'BUY' ? px.bid : px.ask;
      const dec = instruments.getInstrument(biggest.symbol).decimals;
      const before = biggest.stopLoss;
      const dist = before ? Math.abs(exit - before) : instruments.getSpread(biggest.symbol) * sabotage.CARD_AMOUNTS.stopYankNewSpreads / sabotage.CARD_AMOUNTS.stopYankShare;
      const newDist = Math.max(instruments.getSpread(biggest.symbol), dist * sabotage.CARD_AMOUNTS.stopYankShare);
      biggest.stopLoss = Number((biggest.direction === 'BUY' ? exit - newDist : exit + newDist).toFixed(dec));
      result.amounts = { positionId: biggest.id, stopBefore: before, stopAfter: biggest.stopLoss };
      emitToPlayer(match, target.id, 'trade:executed', { position: biggest, modified: true, stopYanked: true });
    }
    if (result.tpSnipTarget) {
      const snipped = [];
      for (const pos of target.positions) {
        if (pos.takeProfit) {
          snipped.push({ positionId: pos.id, takeProfit: pos.takeProfit });
          pos.takeProfit = null;
          emitToPlayer(match, target.id, 'trade:executed', { position: pos, modified: true, tpSnipped: true });
        }
      }
      result.amounts = { snipped };
    }

    if (cardType === 'volatility_surge') {
      const elapsedSeconds = getElapsedSeconds(match, nowMs);
      match.marketEffects.volatilitySurgeBaseline = {};
      for (const symbol of match.instruments) {
        match.marketEffects.volatilitySurgeBaseline[symbol] = instruments.getCurrentPrice(match.id, symbol, elapsedSeconds).mid;
      }
    }

    if (cardType === 'dead_calm') {
      const elapsedSeconds = getElapsedSeconds(match, nowMs);
      match.marketEffects.deadCalmBaseline = {};
      for (const symbol of match.instruments) {
        match.marketEffects.deadCalmBaseline[symbol] = instruments.getCurrentPrice(match.id, symbol, elapsedSeconds).mid;
      }
    }

    if (result.forceCloseTarget) {
      const target = match.players[result.targetId];
      const elapsedSeconds = getElapsedSeconds(match, nowMs);
      let best = null;
      let bestPnl = -Infinity;
      for (const pos of target.positions) {
        const price = getEffectivePrice(match, pos.symbol, elapsedSeconds, nowMs, target.id);
        const exitPrice = pos.direction === 'BUY' ? price.bid : price.ask;
        const pnl = instruments.calculatePnL(pos.direction, pos.lots, pos.entryPrice, exitPrice, pos.symbol);
        if (pnl > bestPnl) {
          bestPnl = pnl;
          best = pos;
        }
      }
      if (best) closeTrade(match.id, target.id, best.id, 'sabotage');
    }

    if (result.mirrorSource) {
      const target = match.players[result.targetId];
      const elapsedSeconds = getElapsedSeconds(match, nowMs);
      const price = getEffectivePrice(match, result.mirrorSource.symbol, elapsedSeconds, nowMs, target.id);
      const entryPrice = result.mirrorSource.direction === 'BUY' ? price.ask : price.bid;
      const position = {
        id: crypto.randomUUID(),
        symbol: result.mirrorSource.symbol,
        direction: result.mirrorSource.direction,
        lots: result.mirrorSource.lots,
        entryPrice,
        openedAt: nowMs,
        stopLoss: null,
        takeProfit: null,
        dbId: null,
      };
      target.positions.push(position);
      if (db.isConfigured && match.dbMatchId) {
        db
          .recordTrade({
            matchId: match.dbMatchId,
            playerId: target.id,
            symbol: position.symbol,
            direction: position.direction,
            lots: position.lots,
            entryPrice,
          })
          .then((row) => {
            position.dbId = row.id;
          })
          .catch(() => {});
      }
      emitToPlayer(match, target.id, 'trade:executed', { position, mirrored: true });
    }

    if (result.forceCloseAllTarget) {
      const target = match.players[result.targetId];
      // 'sabotage' bypasses lockout - a lockout on the target must not
      // protect them from a *different* card force-closing their positions.
      for (const pos of target.positions.slice()) closeTrade(match.id, target.id, pos.id, 'sabotage');
    }

    if (result.ghostTrade) {
      const target = match.players[result.targetId];
      const elapsedSeconds = getElapsedSeconds(match, nowMs);
      const symbol = result.ghostTrade.symbol;
      const price = getEffectivePrice(match, symbol, elapsedSeconds, nowMs, target.id);
      const direction = result.ghostTrade.direction;
      const pipSize = instruments.getInstrument(symbol)?.pipSize || 0.0001;
      // Deliberately fills 3 pips worse than the real market price, in the
      // direction that hurts the target - a real position they now have to
      // manage, already underwater the instant it lands.
      const entryPrice = direction === 'BUY' ? price.ask + 3 * pipSize : price.bid - 3 * pipSize;
      const position = {
        id: crypto.randomUUID(),
        symbol,
        direction,
        lots: 0.05,
        entryPrice,
        openedAt: nowMs,
        stopLoss: null,
        takeProfit: null,
        dbId: null,
      };
      target.positions.push(position);
      if (db.isConfigured && match.dbMatchId) {
        db
          .recordTrade({ matchId: match.dbMatchId, playerId: target.id, symbol, direction, lots: position.lots, entryPrice })
          .then((row) => {
            position.dbId = row.id;
          })
          .catch(() => {});
      }
      emitToPlayer(match, target.id, 'trade:executed', { position, ghostTrade: true });
    }

    if (result.stopSnipeTarget) {
      const target = match.players[result.targetId];
      const elapsedSeconds = getElapsedSeconds(match, nowMs);
      let best = null;
      let bestPnl = -Infinity;
      for (const pos of target.positions) {
        const price = getEffectivePrice(match, pos.symbol, elapsedSeconds, nowMs, target.id);
        const exitPrice = pos.direction === 'BUY' ? price.bid : price.ask;
        const pnl = instruments.calculatePnL(pos.direction, pos.lots, pos.entryPrice, exitPrice, pos.symbol);
        if (pnl > bestPnl) {
          bestPnl = pnl;
          best = pos;
        }
      }
      if (best) {
        best.stopLoss = best.entryPrice;
        emitToPlayer(match, target.id, 'trade:executed', { position: best, stopSniped: true });
      }
    }

    if (db.isConfigured && match.dbMatchId) {
      db
        .recordSabotageEvent({
          matchId: match.dbMatchId,
          playerId,
          targetPlayerId: result.targetId,
          cardType,
          effectDuration: result.card.duration,
        })
        .catch((e) => console.warn('[gameEngine] recordSabotageEvent failed:', e.message));
    }

    // Hit shield + same-target cooldown, the match log entry, Heat for
    // hitting the leader, the "play a card" mission and the caster's hand.
    if (target && result.card.targeted) cardRules.afterHit(match, target, nowMs);
    const targetEquityAfter = target ? computeEquity(match, target, elapsedAtPlay, nowMs) : null;
    logCard(match, {
      attacker: playerId,
      target: result.targetId,
      card: cardType,
      symbol: result.symbol,
      amounts: result.amounts,
      targetEquityBefore: targetEquityBefore === null ? null : Math.round(targetEquityBefore * 100) / 100,
      targetEquityAfter: targetEquityAfter === null ? null : Math.round(targetEquityAfter * 100) / 100,
    }, elapsedAtPlay);
    if (target && match.leaderId === target.id && gameFeel.get().heat.enabled) {
      caster.heat += gameFeel.get().heat.sabotageLeaderBonus;
      caster.bestHeat = Math.max(caster.bestHeat, caster.heat);
    }
    missionProgress(match, caster, { type: 'card' });
    emitCardsUpdate(match, caster);

    pushFeed(match, result.feedText, {
      type: 'sabotage_played',
      timestamp: getElapsedSeconds(match, nowMs),
      playerId,
      targetPlayerId: result.targetId,
      cardType,
    });
    for (const n of result.notify) {
      const payload = { ...n.payload, cardName: sabotage.CARDS[cardType].name };
      if (n.to === 'all') emitToAll(match, n.event, payload);
      else emitToPlayer(match, n.to, n.event, payload);
    }

    // These 4 market-wide cards are now exempt for the caster (see FIX:
    // sabotage cards must not affect the caster) - let the client show a
    // brief "you're immune to your own card" confirmation. reversal_flash
    // isn't included here since it gets its own private warning instead
    // (the price move itself is shared, not something the caster is immune
    // to) - handled via result.delayedNotify below.
    if (
      [
        'volatility_surge',
        'spread_spike',
        'liquidity_drain',
        'smoke_screen',
        'double_spread',
        'time_warp',
        'fog_of_war',
        'dead_calm',
      ].includes(cardType)
    ) {
      emitToPlayer(match, playerId, 'sabotage:immune', {
        cardType,
        message: 'Your card does not affect you',
      });
    }

    if (result.delayedNotify) {
      const { delayMs, exceptPlayerId, event, payload } = result.delayedNotify;
      setTimeout(() => {
        const stillMatch = matches.get(matchId);
        if (!stillMatch || stillMatch.status !== 'active') return;
        for (const p of Object.values(stillMatch.players)) {
          if (p.id === exceptPlayerId || p.isAI) continue;
          emitToPlayer(stillMatch, p.id, event, { ...payload, cardName: sabotage.CARDS[cardType].name });
        }
      }, delayMs);
    }

    emitMatchStateToAll(match);

    return { success: true };
  }

  // ---- AI ------------------------------------------------------------------

  // Reaction speed per style - aggressive personas jump on moves fast,
  // patient personas wait out a real setup, chaos is pure noise.
  function createAIState(personality, matchInstruments = ['EURUSD', 'XAUUSD']) {
    switch (personality) {
      case 'aggressive':
        return {
          entryTime: rand(3, 30),
          entered: false,
          hesitated: false,
          cardTimes: [rand(5, 120), rand(5, 120), rand(5, 120)].sort((a, b) => a - b),
          cardsFired: [false, false, false],
          reopenIntervalSec: rand(20, 40),
          lastActionAt: 0,
        };
      case 'patient':
        return {
          entryTime: rand(120, 180),
          entered: false,
          hesitated: false,
          instrument: matchInstruments[Math.floor(Math.random() * matchInstruments.length)],
          cardTimes: [rand(360, 595), rand(360, 595), rand(360, 595)].sort((a, b) => a - b),
          cardsFired: [false, false, false],
        };
      case 'chaos':
      default:
        return {
          nextEntryAt: rand(5, 60),
          cardTimes: [rand(0, 600), rand(0, 600), rand(0, 600)].sort((a, b) => a - b),
          cardsFired: [false, false, false],
        };
    }
  }

  // Lot size a persona would actually type in - a spread of realistic sizes
  // per style rather than one fixed number every single trade.
  const LOT_POOL = {
    aggressive: [0.5, 1.0, 1.5, 2.0, 2.0, 3.0],
    patient: [0.1, 0.25, 0.5, 0.5, 0.5, 1.0],
  };
  function lotSizeForStyle(style) {
    const pool = LOT_POOL[style];
    if (pool) return pool[Math.floor(Math.random() * pool.length)];
    return Math.round((0.1 + Math.random() * 2.9) * 10) / 10; // chaos: fully random
  }

  // Not every trade carries a stop loss / take profit - humans skip them
  // plenty. Chance and pip-distance both vary by style; a small fraction of
  // stop losses come out unrealistically tight (a human fat-fingering risk),
  // which is what makes these personas actually beatable.
  const SL_TP_PROFILE = {
    aggressive: { slChance: 0.6, tpChance: 0.4, slPips: [15, 35], tpPips: [15, 45] },
    patient: { slChance: 0.85, tpChance: 0.75, slPips: [20, 50], tpPips: [30, 80] },
    chaos: { slChance: 0.3, tpChance: 0.2, slPips: [5, 100], tpPips: [5, 100] },
  };
  function slTpForStyle(style) {
    const profile = SL_TP_PROFILE[style] || SL_TP_PROFILE.chaos;
    const out = {};
    if (Math.random() < profile.slChance) out.stopLossPips = Math.round(rand(profile.slPips[0], profile.slPips[1]));
    if (Math.random() < profile.tpChance) out.takeProfitPips = Math.round(rand(profile.tpPips[0], profile.tpPips[1]));
    if (out.stopLossPips && Math.random() < 0.05) out.stopLossPips = Math.max(2, Math.round(out.stopLossPips * 0.25));
    return out;
  }

  function fireAICard(match, player, cardIndex) {
    const card = player.cards[cardIndex];
    if (!card || card.used) return;
    const cardDef = sabotage.CARDS[card.type];
    const nowMs = Date.now();
    const candidates = Object.values(match.players).filter((p) => p.id !== player.id && !cardRules.checkPlay(match, player, card.type, p, nowMs));
    if (cardDef.targeted && candidates.length === 0) return;
    const target = cardDef.targeted ? candidates[Math.floor(Math.random() * candidates.length)] : null;
    playSabotageCard(match.id, player.id, card.type, { targetId: target ? target.id : undefined });
  }

  function runAI(match, player, elapsedSeconds, nowMs) {
    const st = player.aiState;
    if (!st || player.spectator) return;

    switch (player.aiPersonality) {
      case 'aggressive': {
        if (!st.entered && elapsedSeconds >= st.entryTime) {
          // 20% of the time, hesitate once - like a human who almost pulled
          // the trigger, then waited a few more seconds to be sure.
          if (!st.hesitated && Math.random() < 0.2) {
            st.hesitated = true;
            st.entryTime = elapsedSeconds + rand(5, 15);
          } else {
            st.entered = true;
            for (const symbol of match.instruments) {
              openTrade(match.id, player.id, { symbol, direction: Math.random() < 0.5 ? 'BUY' : 'SELL', lots: lotSizeForStyle('aggressive'), ...slTpForStyle('aggressive') });
            }
            st.lastActionAt = elapsedSeconds;
          }
        }
        if (st.entered && elapsedSeconds - st.lastActionAt >= st.reopenIntervalSec && player.positions.length > 0) {
          const pos = player.positions[0];
          closeTrade(match.id, player.id, pos.id);
          if (player.positions.length < MAX_POSITIONS) {
            const symbol = match.instruments[Math.floor(Math.random() * match.instruments.length)];
            openTrade(match.id, player.id, { symbol, direction: Math.random() < 0.5 ? 'BUY' : 'SELL', lots: lotSizeForStyle('aggressive'), ...slTpForStyle('aggressive') });
          }
          st.lastActionAt = elapsedSeconds;
          st.reopenIntervalSec = rand(20, 40);
        }
        // Mistake: sometimes close a trade that's currently winning well
        // before it needed to be - a human taking profit too early.
        if (Math.random() < 0.05 && player.positions.length > 0) {
          const pos = player.positions[Math.floor(Math.random() * player.positions.length)];
          const price = getEffectivePrice(match, pos.symbol, elapsedSeconds, nowMs, player.id);
          const exitPrice = pos.direction === 'BUY' ? price.bid : price.ask;
          const pnl = instruments.calculatePnL(pos.direction, pos.lots, pos.entryPrice, exitPrice, pos.symbol);
          if (pnl > 0) closeTrade(match.id, player.id, pos.id);
        }
        st.cardTimes.forEach((t, i) => {
          if (!st.cardsFired[i] && elapsedSeconds >= t) {
            st.cardsFired[i] = true;
            fireAICard(match, player, i);
          }
        });
        break;
      }
      case 'patient': {
        if (!st.entered && elapsedSeconds >= st.entryTime) {
          if (!st.hesitated && Math.random() < 0.2) {
            st.hesitated = true;
            st.entryTime = elapsedSeconds + rand(5, 15);
          } else {
            st.entered = true;
            openTrade(match.id, player.id, { symbol: st.instrument, direction: Math.random() < 0.5 ? 'BUY' : 'SELL', lots: lotSizeForStyle('patient'), ...slTpForStyle('patient') });
          }
        }
        st.cardTimes.forEach((t, i) => {
          if (!st.cardsFired[i] && elapsedSeconds >= t) {
            st.cardsFired[i] = true;
            fireAICard(match, player, i);
          }
        });
        break;
      }
      case 'chaos':
      default: {
        if (elapsedSeconds >= st.nextEntryAt && player.positions.length < MAX_POSITIONS) {
          const symbol = match.instruments[Math.floor(Math.random() * match.instruments.length)];
          openTrade(match.id, player.id, { symbol, direction: Math.random() < 0.5 ? 'BUY' : 'SELL', lots: lotSizeForStyle('chaos'), ...slTpForStyle('chaos') });
          st.nextEntryAt = elapsedSeconds + rand(10, 60);
        }
        if (Math.random() < 0.03 && player.positions.length > 0) {
          for (const pos of player.positions.slice()) {
            const price = getEffectivePrice(match, pos.symbol, elapsedSeconds, nowMs, player.id);
            const exitPrice = pos.direction === 'BUY' ? price.bid : price.ask;
            const pnl = instruments.calculatePnL(pos.direction, pos.lots, pos.entryPrice, exitPrice, pos.symbol);
            if (pnl > 0 && Math.random() < 0.5) closeTrade(match.id, player.id, pos.id);
          }
        }
        st.cardTimes.forEach((t, i) => {
          if (!st.cardsFired[i] && elapsedSeconds >= t) {
            st.cardsFired[i] = true;
            fireAICard(match, player, i);
          }
        });
        break;
      }
    }
  }

  // ---- risk limits ---------------------------------------------------------
  //
  // Risk is decided by the margin rules (applyMarginRules / marginRules.js):
  // margin call, then stop-out. One extra brake on top:
  //  - Soft limit: lose SOFT_LOSS_PCT (20%) of starting capital within the
  //    current SOFT_LOSS_WINDOW_SECONDS (2 min) window -> locked out of new
  //    trades until the window rolls over (every 2 minutes, from match start).

  function checkRiskLimits(match, player, elapsedSeconds, nowMs) {
    if (player.eliminated) return;
    const equity = computeEquity(match, player, elapsedSeconds, nowMs);

    const windowIndex = Math.floor(elapsedSeconds / SOFT_LOSS_WINDOW_SECONDS);
    if (player.riskWindowIndex !== windowIndex) {
      player.riskWindowIndex = windowIndex;
      player.riskWindowStartEquity = equity;
      if (player.softLocked) {
        player.softLocked = false;
        pushFeed(match, `${player.username}'s trading lock reset - back in the war`);
        emitToPlayer(match, player.id, 'margin:warning', { level: 'window_reset', equity: Math.round(equity) });
      }
    }

    if (!player.softLocked) {
      const windowLossPct = (player.riskWindowStartEquity - equity) / STARTING_CAPITAL;
      if (windowLossPct >= SOFT_LOSS_PCT) {
        player.softLocked = true;
        pushFeed(match, `${player.username} hit the 2-minute loss limit - trading locked until the next window`, {
          type: 'margin_warning',
          timestamp: elapsedSeconds,
          playerId: player.id,
          pnl: Math.round(equity - STARTING_CAPITAL),
        });
        emitToPlayer(match, player.id, 'margin:warning', { level: 'soft_locked', equity: Math.round(equity) });
      }
    }

    applyMarginRules(match, player, elapsedSeconds, nowMs);
  }

  // ---- tick / leaderboard / end -------------------------------------------

  function tick(match) {
    const nowMs = Date.now();
    const elapsedSeconds = getElapsedSeconds(match, nowMs);

    for (const p of Object.values(match.players)) {
      if (p.isAI) runAI(match, p, elapsedSeconds, nowMs);
    }

    const prices = {};
    for (const symbol of match.instruments) prices[symbol] = getEffectivePrice(match, symbol, elapsedSeconds, nowMs);
    // marketSpeed/dataSeconds: the chart builds candles on market time (so 1m
    // candles stay the real base bars at any replay speed) and shows the
    // honest "MARKET xN" badge when the speed is above 1.
    const marketSpeed = match.replaySpeed || 1;
    const dataSeconds = elapsedSeconds * marketSpeed;
    emitToAll(match, 'price:update', {
      matchId: match.id,
      elapsedSeconds,
      dataSeconds,
      marketSpeed,
      timeRemaining: match.config.durationSeconds - elapsedSeconds,
      prices,
    });

    // Market-wide cards (volatility_surge, spread_spike) exempt whoever cast
    // them - the room-wide broadcast above is the fully-affected price
    // (spectators and everyone else keep seeing that), so an active caster
    // gets an immediate corrective follow-up with what they should actually
    // see instead. Only computed while one of these is actually active, not
    // for the rest of the match once a card has merely been played once.
    const activeExemptIds = new Set();
    if (nowMs < match.marketEffects.volatilitySurgeUntil && match.marketEffects.volatilitySurgeCasterId) {
      activeExemptIds.add(match.marketEffects.volatilitySurgeCasterId);
    }
    if (nowMs < match.marketEffects.doubleSpreadUntil && match.marketEffects.doubleSpreadCasterId) {
      activeExemptIds.add(match.marketEffects.doubleSpreadCasterId);
    }
    if (nowMs < match.marketEffects.timeWarpUntil && match.marketEffects.timeWarpCasterId) {
      activeExemptIds.add(match.marketEffects.timeWarpCasterId);
    }
    if (nowMs < match.marketEffects.fogOfWarUntil && match.marketEffects.fogOfWarCasterId) {
      activeExemptIds.add(match.marketEffects.fogOfWarCasterId);
    }
    if (nowMs < match.marketEffects.deadCalmUntil && match.marketEffects.deadCalmCasterId) {
      activeExemptIds.add(match.marketEffects.deadCalmCasterId);
    }
    for (const symbol of match.instruments) {
      const symbolEffects = match.marketEffects[symbol];
      if (symbolEffects && nowMs < symbolEffects.spreadUntil && symbolEffects.spreadCasterId) {
        activeExemptIds.add(symbolEffects.spreadCasterId);
      }
    }
    // Shield holders (immune to market cards while any is active) and Spread
    // Blowout targets (their own spread widens) also get their own prices.
    const anyMarketEffect = activeExemptIds.size > 0 || nowMs < match.marketEffects.liquidityDrainUntil || match.instruments.some((s) => match.marketEffects[s] && match.marketEffects[s].reversal);
    for (const p of Object.values(match.players)) {
      if (p.effects.spread_blowout && nowMs < p.effects.spread_blowout.until) activeExemptIds.add(p.id);
      else if (anyMarketEffect && sabotage.hasShieldCard(p, nowMs)) activeExemptIds.add(p.id);
    }
    if (activeExemptIds.size > 0) {
      for (const p of Object.values(match.players)) {
        if (p.isAI || !activeExemptIds.has(p.id)) continue;
        const correctedPrices = {};
        for (const symbol of match.instruments) correctedPrices[symbol] = getEffectivePrice(match, symbol, elapsedSeconds, nowMs, p.id);
        emitToPlayer(match, p.id, 'price:update', {
          matchId: match.id,
          elapsedSeconds,
          dataSeconds,
          marketSpeed,
          timeRemaining: match.config.durationSeconds - elapsedSeconds,
          prices: correctedPrices,
        });
      }
    }

    checkStopLossTakeProfit(match, elapsedSeconds, nowMs);
    for (const p of Object.values(match.players)) checkRiskLimits(match, p, elapsedSeconds, nowMs);

    // Spike alerts (real indexed events only) on market time.
    for (const ev of cardRules.spikeTick(match, dataSeconds)) {
      if (ev.event === 'spike:alert') match.lastSpikeAlertAt = nowMs;
      emitToAll(match, ev.event, ev.payload);
      // Grand: once the last scheduled event has landed, the "survive the
      // events" mission checks who is still above their starting equity.
      if (ev.event === 'spike:result' && ev.payload.kind === 'event' && match.spikePlan.filter((x) => x.kind === 'event').every((x) => x.resolved)) {
        for (const p of Object.values(match.players)) missionProgress(match, p, { type: 'events_done', aboveStart: computeEquity(match, p, elapsedSeconds, nowMs) > STARTING_CAPITAL });
      }
    }
    modeTick(match, elapsedSeconds, nowMs);
    // "Hold a trade for 60 seconds" completes while the trade is still open.
    if (elapsedSeconds % 5 === 0) {
      for (const p of Object.values(match.players)) {
        if (p.isAI || !p.missions || !p.missions.some((m) => m.id === 'hold_60' && !m.done)) continue;
        for (const pos of p.positions) {
          const px = instruments.getCurrentPrice(match.id, pos.symbol, elapsedSeconds);
          missionProgress(match, p, { type: 'tick', heldMs: nowMs - pos.openedAt, meaningful: isMeaningful(pos.symbol, pos.lots, px.mid) });
        }
      }
    }

    // One P&L snapshot per player per elapsed second, for the replay's
    // equity curves (FIX 4) - built from the same computeEquity() used for
    // the live leaderboard, just recorded every tick instead of every 3s.
    for (const p of Object.values(match.players)) {
      const list = match.pnlSnapshots[p.id] || (match.pnlSnapshots[p.id] = []);
      if (list.length === 0 || list[list.length - 1].second !== elapsedSeconds) {
        const equity = computeEquity(match, p, elapsedSeconds, nowMs);
        list.push({ second: elapsedSeconds, pnl: Math.round((equity - STARTING_CAPITAL) * 100) / 100 });
      }
    }

    if (elapsedSeconds >= match.config.durationSeconds) {
      endMatch(match).catch((e) => console.error('[gameEngine] endMatch() rejected for match', match.id, e));
    }
  }

  function emitLeaderboard(match) {
    const nowMs = Date.now();
    const elapsedSeconds = getElapsedSeconds(match, nowMs);
    const rows = Object.values(match.players)
      .map((p) => {
        const equity = computeEquity(match, p, elapsedSeconds, nowMs);
        if (p.equityHistory) p.equityHistory.push({ t: elapsedSeconds, equity: Math.round(equity * 100) / 100 });
        return {
          id: p.id,
          username: p.username,
          pnl: Math.round((equity - STARTING_CAPITAL) * 100) / 100,
          equity: Math.round(equity * 100) / 100,
          tradesMade: p.tradesMade,
          eliminated: p.eliminated,
          softLocked: p.softLocked,
          tier: p.tier,
          level: p.level,
          status: cardRules.targetStatus(p, nowMs),
          out: Boolean(p.spectator),
          outRound: p.eliminatedRound || null,
        };
      })
      .sort((a, b) => (a.out !== b.out ? (a.out ? 1 : -1) : a.out ? (b.outRound || 0) - (a.outRound || 0) || b.pnl - a.pnl : b.pnl - a.pnl))
      .map((row, i) => ({ ...row, rank: i + 1 }));
    // Elimination: the bottom zone of the players still in gets a Danger tag.
    if (match.elimination && match.elimination.active && match.elimination.nextIdx < match.elimination.schedule.length) {
      const alive = rows.filter((r) => !r.out);
      const n = cutCountFor(match);
      for (const r of alive.slice(alive.length - n)) r.danger = true;
    }

    // Crown: the leader is marked, and overtaking them earns one card
    // ("Dethrone", once per leader change, with a cooldown).
    const crown = cardRules.updateCrown(match, rows, nowMs);
    if (crown && crown.previous) {
      const king = match.players[crown.leaderId];
      pushFeed(match, `${king.username} took the crown`, { type: 'crown', timestamp: elapsedSeconds, playerId: king.id });
      if (crown.grant && (crown.grant.granted.length || crown.grant.heat)) emitCardsUpdate(match, king, { dethrone: true, earned: { granted: crown.grant.granted, heat: crown.grant.heat } });
    }
    for (const r of rows) r.crown = r.id === match.leaderId;

    const blurred = nowMs < match.marketEffects.smokeScreenUntil;
    emitToAll(match, 'leaderboard:update', { rows, blurred });
    // Smoke Screen exempts whoever cast it - same rows, just not blurred for
    // them (see FIX: sabotage cards must not affect the caster).
    if (blurred && match.marketEffects.smokeScreenCasterId) {
      const casterId = match.marketEffects.smokeScreenCasterId;
      if (match.players[casterId] && !match.players[casterId].isAI) {
        emitToPlayer(match, casterId, 'leaderboard:update', { rows, blurred: false });
      }
    }
    announceLiveTieIfNew(match, rows, elapsedSeconds);
  }

  // Live in-match tie detector for the match feed ticker - fires only when
  // the tied pair (or the amount they're tied at) actually changes, since
  // this runs every 3s alongside the leaderboard and P&L drifts constantly;
  // without the dedupe key this would spam the feed on every tick a tie
  // happens to persist.
  function announceLiveTieIfNew(match, rows, elapsedSeconds) {
    let tiedPair = null;
    for (let i = 0; i < rows.length - 1; i++) {
      if (samePnl(rows[i].pnl, rows[i + 1].pnl)) {
        tiedPair = [rows[i], rows[i + 1]];
        break;
      }
    }
    if (!tiedPair) {
      match._lastLiveTieKey = null;
      return;
    }
    const key = `${[tiedPair[0].id, tiedPair[1].id].sort().join(':')}@${tiedPair[0].pnl}`;
    if (match._lastLiveTieKey === key) return;
    match._lastLiveTieKey = key;
    pushFeed(match, `🤝 DRAW — ${tiedPair[0].username} and ${tiedPair[1].username} are tied at $${tiedPair[0].pnl}`, {
      type: 'draw',
      timestamp: elapsedSeconds,
      playerId: tiedPair[0].id,
      targetPlayerId: tiedPair[1].id,
      pnl: tiedPair[0].pnl,
    });
  }

  // A bye (see tournament.js's checkForBye) advances a player without them
  // ever playing a match, so nothing else bumps their
  // tournament_registrations.current_round the way a real match's
  // advanceTournamentMatch call does. Idempotent - safe to call after every
  // bracket change; re-syncing an already-correct round is a harmless no-op.
  async function syncByeRegistrations(tournamentId, bracketData) {
    for (const roundData of bracketData.rounds) {
      for (const m of roundData.matchups) {
        if (m.status === 'bye' && m.winnerId) {
          try {
            await db.updateTournamentRegistration(tournamentId, m.winnerId, { current_round: roundData.round + 1 });
          } catch (e) {
            console.warn('[gameEngine] failed to sync bye registration round:', e.message);
          }
        }
      }
    }
  }

  // Advances a tournament bracket once one of its matches finishes. Reads
  // tournamentId/round/matchupIndex back off match.config, which endMatch's
  // createMatch call sets via opts.configOverrides (see
  // POST /api/tournament/:id/play in index.js).
  async function advanceTournamentMatch(match, results) {
    if (!db.isConfigured) return;
    const { tournamentId, round, matchupIndex } = match.config;

    const t = await db.getTournament(tournamentId);
    if (!t || !t.bracket_data) return;

    // Tournament matches are always exactly 2 players, so a draw is simply
    // "both results share rank 1" - a normal single-elimination draw
    // eliminates BOTH players (the matchup is void) and refunds their entry
    // fee, since neither of them actually lost a real match.
    const isVoidDraw = results.length === 2 && results[0].rank === results[1].rank;

    if (isVoidDraw) {
      const { bracketData, tournamentComplete, championId } = tournamentLib.voidMatchup(t.bracket_data, round, matchupIndex);

      for (const r of results) {
        await db.updateTournamentRegistration(tournamentId, r.playerId, { eliminated_at: new Date().toISOString() });
        if (t.entry_coins > 0) {
          await db.creditCoins(r.playerId, t.entry_coins, { type: 'tournament_refund', matchId: match.dbMatchId, idempotencyKey: `tournament_refund:${match.id}:${r.playerId}` });
        }
        notifyPlayer?.(
          r.playerId,
          'tournament_draw',
          `Your round ${round} match ended in a draw - both players are eliminated${t.entry_coins > 0 ? ` and refunded ${t.entry_coins} coins` : ''}.`
        );
      }

      if (tournamentComplete) {
        // A cascading double-void can reach the final with no one left to
        // crown - end the tournament without a champion rather than
        // crediting a prize to no one.
        await db.updateTournament(tournamentId, { status: championId ? 'completed' : 'cancelled', bracket_data: bracketData });
        if (championId) {
          await db.updateTournamentRegistration(tournamentId, championId, { final_rank: 1 });
          if (t.prize_pool_coins > 0) {
            await db.creditCoins(championId, t.prize_pool_coins, { type: 'tournament_prize', matchId: match.dbMatchId, idempotencyKey: `tournament_prize:${t.id}` });
          }
          notifyPlayer?.(championId, 'tournament_champion', `You won the tournament! +${t.prize_pool_coins} coins`);
        }
      } else {
        await db.updateTournament(tournamentId, { bracket_data: bracketData });
        await syncByeRegistrations(tournamentId, bracketData);
      }
      return;
    }

    const winner = results.find((r) => r.rank === 1);
    if (!winner) return;

    const { bracketData, tournamentComplete, championId } = tournamentLib.advanceBracket(t.bracket_data, round, matchupIndex, winner.playerId);

    const loser = results.find((r) => r.playerId !== winner.playerId);
    if (loser) {
      await db.updateTournamentRegistration(tournamentId, loser.playerId, { eliminated_at: new Date().toISOString() });
      notifyPlayer?.(loser.playerId, 'tournament_eliminated', `You were eliminated from the tournament in round ${round}.`);
    }
    await db.updateTournamentRegistration(tournamentId, winner.playerId, { current_round: round + 1 });

    if (tournamentComplete) {
      await db.updateTournament(tournamentId, { status: 'completed', bracket_data: bracketData });
      await db.updateTournamentRegistration(tournamentId, championId, { final_rank: 1 });
      if (t.prize_pool_coins > 0) {
        await db.creditCoins(championId, t.prize_pool_coins, { type: 'tournament_prize', matchId: match.dbMatchId, idempotencyKey: `tournament_prize:${t.id}` });
      }
      notifyPlayer?.(championId, 'tournament_champion', `You won the tournament! +${t.prize_pool_coins} coins`);
    } else {
      await db.updateTournament(tournamentId, { bracket_data: bracketData });
      notifyPlayer?.(winner.playerId, 'tournament_advance', `You advanced to round ${round + 1} of the tournament!`);
      await syncByeRegistrations(tournamentId, bracketData);
    }
  }

  // Trading experience is a computed read-only stat (not player-editable -
  // see /api/player/settings), so this is the one place it changes: every
  // time total_matches goes up, whether the match finished normally
  // (endMatch) or the player forfeited by leaving early (leaveMatch).
  async function updateExperienceLevel(playerId, oldTotalMatches, newTotalMatches, isAI) {
    if (isAI) return null;
    const oldLevel = getExperienceLevel(oldTotalMatches);
    const newLevel = getExperienceLevel(newTotalMatches);
    if (newLevel === oldLevel) return newLevel;
    notifyPlayer?.(playerId, 'system', `📈 Experience Level Up! You are now: ${newLevel}`);
    return newLevel;
  }

  async function endMatch(match) {
    if (match.status === 'resolving' || match.status === 'finished') return;
    match.status = 'resolving';
    clearInterval(match.timers.countdownInterval); // force-ended during the countdown
    clearInterval(match.timers.tickInterval);
    clearInterval(match.timers.leaderboardInterval);

    for (const player of Object.values(match.players)) {
      for (const pos of player.positions.slice()) closeTrade(match.id, player.id, pos.id, 'match_end');
    }

    const results = computeMatchResults(Object.values(match.players), match.mode, match.config);

    const ratingField = match.config.ratingKey || 'war_rating';
    for (const r of results) {
      const p = match.players[r.playerId];
      p.warRating = r.newRating;
      if (ratingField === 'war_rating') p.tier = tierForRating(r.newRating);
      if (db.isConfigured) {
        try {
          const existing = await db.getPlayerById(r.playerId);
          // A ghost challenge is played alone: it never counts as a win (no
          // farming wins toward win-gated card unlocks).
          const won = r.rank === 1 && !r.isDraw && !match.config.challenge;
          const oldTotalMatches = existing?.total_matches || 0;
          const newTotalMatches = oldTotalMatches + 1;
          const updateFields = {
            wins: (existing?.wins || 0) + (won ? 1 : 0),
            losses: (existing?.losses || 0) + (!won && !r.isDraw && !match.config.challenge ? 1 : 0),
            draws: (existing?.draws || 0) + (r.isDraw ? 1 : 0),
            total_matches: newTotalMatches,
          };
          if (!r.isAI) {
            updateFields.experience_level = await updateExperienceLevel(r.playerId, oldTotalMatches, newTotalMatches, r.isAI);
          }
          if (match.config.ranked) {
            updateFields[ratingField] = r.newRating;
            if (ratingField === 'war_rating') updateFields.tier = p.tier;
            if (ratingField === 'war_rating' && p.tier !== r.oldTier && r.newRating > r.oldRating && !r.isAI) {
              notifyPlayer?.(r.playerId, 'rank_up', `You are now ${p.tier} tier! (${r.oldRating} → ${r.newRating} rating)`);
              // Rank cosmetics are kept once reached (server/cosmetics.js).
              db.grantCosmetics(cosmetics.rankItemsFor(p.tier).map((it) => ({ player_id: r.playerId, item_id: it.id, source: 'rank' }))).catch(() => {});
            }
          }
          await db.updatePlayer(r.playerId, updateFields);
          if (match.mode === 'async' && !r.isAI) {
            await db.recordAsyncResult({ playerId: r.playerId, pnl: r.pnl, tradesMade: r.tradesMade });
          }
          if (match.dbMatchId) {
            await db.updateMatchPlayer(match.dbMatchId, r.playerId, {
              final_pnl: r.pnl,
              final_rank: r.rank,
              cards_played: r.cardsPlayed,
              trades_made: r.tradesMade,
              rating_change: r.ratingChange,
              is_draw: r.isDraw,
              draw_with: r.drawWith,
              split_count: r.splitCount,
              combined_prize_percentage: r.combinedPrizePercentage,
            });
            // Separate, best-effort: why the match ended (support answers).
            // Never allowed to block results or prize coins below.
            db.updateMatchPlayer(match.dbMatchId, r.playerId, { end_reason: p && p.eliminated ? 'loss_limit' : 'completed' }).catch(() => {});
          }
          if (r.coinsAwarded > 0) {
            await db.creditCoins(r.playerId, r.coinsAwarded, { type: 'prize_won', matchId: match.dbMatchId, idempotencyKey: `prize:${match.id}:${r.playerId}` });
          }
          if (!r.isAI) {
            const season = battlepass.currentSeason();
            const xpGained = 10 + (won ? 20 : 0);
            const before = await db.ensureBattlePassStatus(r.playerId, season);
            const oldTier = battlepass.tierFromXp(before.xp_current);
            const newXp = before.xp_current + xpGained;
            const newTier = battlepass.tierFromXp(newXp);
            await db.addBattlePassXp(r.playerId, season, xpGained, newTier);
            if (newTier > oldTier) {
              const track = battlepass.buildTrack(newTier, before.is_premium);
              let tierCoins = 0;
              for (const entry of track) {
                if (entry.tier <= oldTier || entry.tier > newTier) continue;
                if (entry.freeReward?.coins) tierCoins += entry.freeReward.coins;
                if (entry.premiumReward?.coins) tierCoins += entry.premiumReward.coins;
              }
              if (tierCoins > 0) {
                await db.creditCoins(r.playerId, tierCoins, { type: 'battlepass_tier', matchId: match.dbMatchId, idempotencyKey: `bp_tier:${match.id}:${r.playerId}` });
              }
              notifyPlayer?.(r.playerId, 'battlepass_tier', `Battle Pass tier ${newTier} unlocked!`);
            }
          }
        } catch (e) {
          console.warn('[gameEngine] failed to persist match result for', r.username, e.message);
        }
      }
    }

    // Invite rewards. Separate and best-effort: never allowed to affect results.
    if (db.isConfigured && match.dbMatchId) {
      const everyone = Object.values(match.players);
      for (const p of everyone) {
        if (!referralRules.qualifiesForInviteReward(everyone, p.id)) continue;
        try {
          const paid = await db.payPlayerReferral(p.id, match.dbMatchId, referralRules.INVITE_REWARD_COINS, referralRules.INVITE_MAX_PAID);
          if (paid && paid.paid) {
            notifyPlayer?.(paid.inviter, 'referral_reward', `A friend you invited finished a match. +${referralRules.INVITE_REWARD_COINS} coins!`);
          }
        } catch (e) {
          console.warn('[gameEngine] invite reward failed for', p.username, e.message);
        }
      }
    }

    if (db.isConfigured && match.dbMatchId) {
      try {
        await db.updateMatch(match.dbMatchId, {
          status: 'finished',
          end_time: new Date().toISOString(),
          winner_id: results[0]?.playerId,
        });
      } catch (e) {
        console.warn('[gameEngine] failed to finalize match record:', e.message);
      }
    }

    if (match.config.tournamentId) {
      try {
        await advanceTournamentMatch(match, results);
      } catch (e) {
        console.warn('[gameEngine] failed to advance tournament bracket:', e.message);
      }
    }

    // Fire gameplay summary per player: Heat, streaks, earned cards, missions,
    // XP and new card unlocks (result screen), plus market telemetry for the
    // Fire monitor. None of it feeds back into P&L, rank, prizes or ratings.
    recordMarketStats(match);
    // Mode wrap-up: Elimination's "stay out of the bottom zone" missions, and
    // Grand's Steady Hand badge (smallest drawdown among the top 3; cosmetic,
    // never changes the ranking).
    const el = match.elimination;
    if (el && el.active) for (const p of Object.values(match.players)) missionProgress(match, p, { type: 'cuts_over', cuts: el.rounds.length });
    let steadyId = null;
    if (match.rules && match.rules.steadyHandBadge) {
      const top3 = results.filter((r) => r.rank <= 3).map((r) => match.players[r.playerId]).filter(Boolean);
      steadyId = top3.sort((a, b) => (a.maxDrawdown || 0) - (b.maxDrawdown || 0))[0]?.id || null;
    }
    for (const r of results) {
      const p = match.players[r.playerId];
      if (!p) continue;
      r.mode = {
        key: match.mode,
        displayName: match.config.tournamentId ? 'Tournament round' : match.rules?.identity.displayName,
        highlights: match.rules?.resultHighlights || [],
        fastestWinSeconds: p.firstWinSeconds ?? null,
        roundsSurvived: el && el.active ? (p.eliminatedRound ? p.eliminatedRound - 1 : el.rounds.length) : null,
        survived: el && el.active ? !p.eliminatedRound : null,
        cutRound: p.eliminatedRound || null,
        eventsSurvived: (match.marketEvents || []).filter((e) => e.found).length ? match.marketEvents.filter((e) => e.found).length : null,
        steadyHand: steadyId === p.id,
        maxDrawdown: p.maxDrawdown !== undefined ? Math.round(p.maxDrawdown * 100) / 100 : null,
        ghost: match.ghost && !p.isAI ? { label: match.ghost.label, pnl: match.ghost.pnl, delta: Math.round((r.pnl - match.ghost.pnl) * 100) / 100 } : null,
        personalBest: match.personal && !p.isAI ? Math.max(match.personal.best ?? -Infinity, r.pnl) : null,
        newBest: Boolean(match.personal && !p.isAI && (match.personal.best == null || r.pnl > match.personal.best)),
        yesterdayBest: match.personal && !p.isAI ? match.personal.yesterday : null,
      };
      r.fire = {
        heat: p.heat || 0,
        bestHeat: p.bestHeat || 0,
        bestStreak: p.bestStreak || 0,
        qualifyingWins: p.qualifyingWins || 0,
        cardsEarned: p.cardsEarned || 0,
        missions: (p.missions || []).map((m) => ({ id: m.id, label: m.label, done: m.done, coins: m.coins || 0 })),
      };
      if (r.isAI || !gameFeel.get().progression.enabled) continue;
      try {
        r.fire.progress = await awardMatchXp(match, p, r);
      } catch (e) {
        console.warn('[progression] XP award failed for', r.username, e.message);
      }
    }

    match.status = 'finished';

    const drawRanks = [...new Set(results.filter((r) => r.isDraw).map((r) => r.rank))].sort((a, b) => a - b);
    if (drawRanks.length > 0) {
      const drawGroups = drawRanks.map((rank) => {
        const group = results.filter((r) => r.rank === rank);
        const humanShare = group.find((r) => !r.isAI);
        return {
          rank,
          players: group.map((r) => r.username),
          pnl: group[0].pnl,
          individualPrize: humanShare ? humanShare.coinsAwarded : 0,
          splitFrom: group[0].combinedPrizePercentage,
          splitCount: group[0].splitCount,
        };
      });
      emitToAll(match, 'match:draw_detected', { drawGroups });
    }

    // isAI stays out of the client-facing payload (results itself keeps it -
    // the loops right below and the replay-record write further down still
    // need it) - see the publicPlayer() comment for why.
    const clientResults = results.map(({ isAI, ...r }) => r);
    const challengeTarget = match.config.challenge ? { username: match.config.challenge.username, pnl: match.config.challenge.pnl } : null;
    emitToAll(match, 'match:end', { matchId: match.id, results: clientResults, feed: match.feed, challenge: challengeTarget });
    match.endPayload = { matchId: match.id, results: clientResults, feed: match.feed, challenge: challengeTarget };
    // Anyone browsing the site when the clock ran out didn't see the results
    // screen. Same summary as an early leaver gets, minus the "left early".
    for (const r of results) {
      if (r.isAI || match.players[r.playerId]?.socketId) continue;
      const top = results.find((x) => x.rank === 1);
      notifyPlayer?.(r.playerId, 'match_summary', `Match summary: you finished #${r.rank} in ${match.config.label || match.mode}`, {
        data: {
          matchId: match.id,
          mode: match.config.label || match.mode,
          yourRank: r.rank,
          leftEarly: false,
          yourPnl: r.pnl,
          winner: top?.username || null,
          winnerPnl: top?.pnl ?? null,
          ratingChange: r.ratingChange,
          newRating: r.newRating,
        },
      });
    }
    for (const r of results) {
      if (!r.isAI) updatePresence?.(r.playerId, { status: 'online', matchId: null, lobbyId: null, mode: null });
    }
    for (const winner of results.filter((r) => r.rank === 1 && !r.isAI)) {
      notifyFriendsOfWin?.(winner.playerId, winner.username, match.config.label || match.mode, winner.pnl, match.id);
    }

    // FIX: anyone who used leaveMatch() earlier is long gone from
    // match.players by now, but they still get told how the match they
    // abandoned actually turned out - reuses the same global notification
    // pipe as rank_up/battlepass_tier, so it reaches them even if they're
    // already in a different match by the time this fires.
    if (match.earlyLeavers?.length) {
      const winnerResult = results.find((r) => r.rank === 1);
      for (const leaver of match.earlyLeavers) {
        notifyPlayer?.(
          leaver.playerId,
          'match_summary',
          `Match summary: you finished #${leaver.finalRank} (left early) in ${match.config.label || match.mode}`,
          {
            data: {
              matchId: match.id,
              mode: match.config.label || match.mode,
              yourRank: leaver.finalRank,
              leftEarly: true,
              yourPnl: leaver.finalPnl,
              winner: winnerResult?.username || null,
              winnerPnl: winnerResult?.pnl ?? null,
              ratingChange: leaver.ratingChange,
              newRating: leaver.newRating,
            },
          }
        );
      }
    }

    if (db.isConfigured && match.dbMatchId) {
      try {
        const priceData = {};
        for (const symbol of match.instruments) priceData[symbol] = instruments.getFullLiveSeries(match.id, symbol);
        const players = results.map((r) => ({
          id: r.playerId,
          username: r.username,
          finalPnl: r.pnl,
          finalRank: r.rank,
        }));
        await db.createReplay({
          matchId: match.dbMatchId,
          eventLog: match.feed,
          priceData,
          players,
          pnlSnapshots: match.pnlSnapshots,
        });
      } catch (e) {
        console.warn('[gameEngine] failed to persist replay for match', match.id, e.message);
      }
    }

    instruments.releaseMatchWindows(match.id);
    personas.resetMatchPersonas(match.id);
    // unref: this housekeeping timer alone never keeps the process running
    // (the server's own listener does; tests can exit).
    setTimeout(() => {
      matches.delete(match.id);
      roomCodeIndex.delete(match.roomCode);
    }, 5 * 60 * 1000).unref();
  }

  // ---- socket session binding -----------------------------------------------

  function bindSocket(socket, matchId) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    const playerId = socket.data.player.id;
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Join the match via the API before connecting' };

    const wasDisconnected = clearDisconnectGrace(matchId, playerId);
    player.socketId = socket.id;
    socket.join(roomName(matchId));
    socketSessions.set(socket.id, { matchId, playerId });

    io.to(socket.id).emit('match:state', buildMatchStatePayloadFor(match, playerId));
    // Tapped Continue just as the clock ran out: show the results they missed.
    if (match.endPayload) io.to(socket.id).emit('match:end', match.endPayload);
    if (wasDisconnected) {
      pushFeed(match, `${player.username} reconnected`, { type: 'system' });
      emitToAll(match, 'match:player_reconnected', { playerId, username: player.username });
    }
    return { success: true };
  }

  function getSession(socketId) {
    return socketSessions.get(socketId) || null;
  }

  // Read-only viewing for a match the socket's player never joined - used by
  // the "watch live" featured-match link. Joins the room (so price/leaderboard/
  // feed broadcasts arrive normally) but only ever gets the fully-redacted
  // (viewerId=null) match:state view, never a personal one.
  function bindSpectator(socket, matchId) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    // Private rooms are invite-only: only their own players may watch
    // (audit item 10 - any logged-in user with the id could spectate before).
    const viewerId = socket.data?.player?.id;
    if (match.mode === 'private' && !(viewerId && match.players[viewerId])) {
      return { success: false, error: 'This match is private' };
    }
    socket.join(roomName(matchId));
    io.to(socket.id).emit('match:state', buildMatchStatePayloadFor(match, null));
    return { success: true };
  }

  // activePlayers is deliberately still live/in-memory (it means "in a match
  // right now", which only the live matches Map can answer), but matchesToday
  // now reads the persistent matches table - see db.getMatchesToday for why
  // the in-memory version this used to use quietly reset toward 0 shortly
  // after each match actually finished.
  // Seats per mode in lobbies and live matches right now (lobby mode cards).
  // Computer seats count, same owner decision as the public online number.
  // User-made bracket rounds are not public Elimination games.
  function getModeCounts() {
    const counts = {};
    for (const match of matches.values()) {
      if (!['waiting', 'countdown', 'active'].includes(match.status)) continue;
      if (match.config.tournamentId) continue;
      counts[match.mode] = (counts[match.mode] || 0) + Object.keys(match.players).length;
    }
    return counts;
  }

  async function getHomeStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const activePlayerIds = new Set();
    let inMemoryMatchesToday = 0;
    for (const match of matches.values()) {
      if (match.createdAt >= todayStart.getTime()) inMemoryMatchesToday += 1;
      if (match.status === 'active' || match.status === 'countdown') {
        for (const p of Object.values(match.players)) {
          if (!p.isAI) activePlayerIds.add(p.id);
        }
      }
    }
    let matchesToday = inMemoryMatchesToday;
    if (db.isConfigured) {
      try {
        matchesToday = await db.getMatchesToday();
      } catch (e) {
        console.warn('[gameEngine] getMatchesToday failed, falling back to in-memory count:', e.message);
      }
    }
    return { matchesToday, activePlayers: activePlayerIds.size };
  }

  // Filled seats in matches being played right now. Added to the connected
  // count for the public "players online" number.
  function getFilledSeatsInPlay() {
    let seats = 0;
    for (const match of matches.values()) {
      if (match.status !== 'active' && match.status !== 'countdown') continue;
      seats += Object.values(match.players).filter((p) => p.isAI).length;
    }
    return seats;
  }

  function getFeaturedMatch() {
    const nowMs = Date.now();
    for (const match of matches.values()) {
      if (match.status !== 'active') continue;
      const humanCount = Object.values(match.players).filter((p) => !p.isAI).length;
      if (humanCount === 0) continue;
      const elapsedSeconds = getElapsedSeconds(match, nowMs);
      const remaining = match.config.durationSeconds - elapsedSeconds;
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      return {
        matchId: match.id,
        playerCount: Object.keys(match.players).length,
        timeRemainingLabel: `${m}:${String(s).padStart(2, '0')}`,
      };
    }
    return null;
  }

  function sendChatMessage(matchId, playerId, message) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Player not in match' };
    if (!ALLOWED_CHAT_MESSAGES.includes(message)) return { success: false, error: 'Invalid message' };
    emitToAll(match, 'lobby:chat', { username: player.username, message, ts: Date.now() });
    return { success: true };
  }

  // Lets a player pick their own loadout while waiting in the lobby (Grand
  // War deals 5 cards but lets you choose WHICH 5 - other modes deal a fixed
  // random hand and don't call this). Replaces the auto-dealt hand outright.
  // The hand a player may pick in the lobby: the same rules dealForMode
  // deals by (slot count, starting-hand size and tiers, unlocked and
  // mode-allowed cards only).
  function loadoutRules(match, player) {
    const r = match.rules && match.rules.cards;
    if (!r) return { enabled: true, count: match.config.cardsPerPlayer, allowed: Object.keys(sabotage.CARDS) };
    if (!r.enabled) return { enabled: false, count: 0, allowed: [] };
    let allowed = cardRules.allowedPool(match, player);
    let count = Math.min(r.handSize, match.config.cardsPerPlayer);
    if (r.startingHand) {
      allowed = allowed.filter((id) => r.startingHand.tiers.includes(modeIdentity.cardTier(id, progression.BASIC_DECK, sabotage.CARDS[id].rarity)));
      count = Math.min(r.handSize, r.startingHand.count);
    }
    return { enabled: true, count: Math.min(count, allowed.length), allowed };
  }

  function selectLoadoutCards(matchId, playerId, cardTypes) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    if (match.status !== 'waiting') return { success: false, error: 'Cannot change your setup after the match has started' };
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Player not in match' };

    const lr = loadoutRules(match, player);
    if (!lr.enabled) return { success: false, error: 'Cards are off in this match' };
    const expectedCount = lr.count;
    const pool = lr.allowed;
    if (!Array.isArray(cardTypes) || cardTypes.length !== expectedCount) {
      return { success: false, error: `Select exactly ${expectedCount} cards` };
    }
    const validTypes = new Set(pool);
    if (!cardTypes.every((t) => validTypes.has(t))) return { success: false, error: 'That card is locked or not allowed in this mode' };
    if (new Set(cardTypes).size !== cardTypes.length) return { success: false, error: 'Cannot select duplicate cards' };

    player.cards = cardTypes.map((type) => ({ type, used: false }));
    emitMatchStateToAll(match);
    return { success: true };
  }

  // A human who has left the site mid-match (closed the tab, lost wifi) gets
  // 60s to come back before being treated as a voluntary leave - reuses
  // leaveMatch's force-close-positions/last-place/rating-penalty logic rather
  // than duplicating it. Being anywhere else on the site is not leaving: the
  // timer only runs while the player has no socket at all (noteSiteConnected
  // and noteSiteDisconnected below), so they can open settings or the shop
  // and pick the match back up from the live match card. AI never disconnects,
  // and a waiting/finished match has no clock to lose out on, so only
  // active/countdown matches start a timer.
  function startDisconnectGrace(match, playerId) {
    const key = `${match.id}:${playerId}`;
    if (disconnectTimers.has(key)) return;
    const player = match.players[playerId];
    if (!player) return;

    const entry = { announced: false, announceTimer: null, timer: null };
    // Moving between pages drops the socket for a moment. Only tell the room
    // once it has lasted long enough to be a real connection loss.
    entry.announceTimer = setTimeout(() => {
      entry.announced = true;
      const graceSeconds = (RECONNECT_GRACE_MS - DISCONNECT_NOTICE_DELAY_MS) / 1000;
      pushFeed(match, `${player.username} lost connection - ${graceSeconds}s to reconnect`, { type: 'system' });
      emitToAll(match, 'match:player_disconnected', { playerId, username: player.username, graceSeconds });
    }, DISCONNECT_NOTICE_DELAY_MS);
    entry.timer = setTimeout(() => {
      disconnectTimers.delete(key);
      const stillMatch = matches.get(match.id);
      const stillPlayer = stillMatch?.players[playerId];
      // Only forfeit if they genuinely never came back - clearDisconnectGrace
      // normally cancels this, but check again for a narrow race.
      if (stillPlayer && !stillPlayer.socketId && !isPlayerOnSite?.(playerId)) {
        leaveMatch(match.id, playerId, 'disconnect').catch((e) => console.error('[gameEngine] disconnect forfeit failed:', e.message));
      }
    }, RECONNECT_GRACE_MS);
    disconnectTimers.set(key, entry);
  }

  // Returns true if the room was told this player lost connection - callers
  // use that to decide whether a "player reconnected" notice is warranted.
  function clearDisconnectGrace(matchId, playerId) {
    const key = `${matchId}:${playerId}`;
    const entry = disconnectTimers.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    clearTimeout(entry.announceTimer);
    disconnectTimers.delete(key);
    return entry.announced;
  }

  function liveMatchesFor(playerId) {
    const out = [];
    for (const match of matches.values()) {
      if ((match.status === 'active' || match.status === 'countdown') && match.players[playerId] && !match.players[playerId].isAI) out.push(match);
    }
    return out;
  }

  // The player opened a page anywhere on the site.
  function noteSiteConnected(playerId) {
    for (const match of liveMatchesFor(playerId)) {
      const player = match.players[playerId];
      if (clearDisconnectGrace(match.id, playerId)) {
        pushFeed(match, `${player.username} reconnected`, { type: 'system' });
        emitToAll(match, 'match:player_reconnected', { playerId, username: player.username });
      }
    }
  }

  // The player's last socket anywhere on the site just closed.
  function noteSiteDisconnected(playerId) {
    for (const match of liveMatchesFor(playerId)) {
      if (!match.players[playerId].socketId) startDisconnectGrace(match, playerId);
    }
  }

  // What the live match card shows on every page outside the game screen.
  function getLiveMatchStatus(playerId) {
    const match = liveMatchesFor(playerId)[0];
    if (!match) return null;
    const player = match.players[playerId];
    const nowMs = Date.now();
    const elapsedSeconds = getElapsedSeconds(match, nowMs);
    const round2 = (n) => Math.round(n * 100) / 100;

    const positions = player.positions.map((pos) => {
      const price = getEffectivePrice(match, pos.symbol, elapsedSeconds, nowMs, playerId);
      const exitPrice = pos.direction === 'BUY' ? price.bid : price.ask;
      return {
        id: pos.id,
        symbol: pos.symbol,
        direction: pos.direction,
        lots: pos.lots,
        pnl: round2(instruments.calculatePnL(pos.direction, pos.lots, pos.entryPrice, exitPrice, pos.symbol)),
      };
    });
    const equity = computeEquity(match, player, elapsedSeconds, nowMs);

    // Smoke Screen hides the standings from everyone but its caster, so the
    // card must not reveal them either.
    const hidden = nowMs < match.marketEffects.smokeScreenUntil && match.marketEffects.smokeScreenCasterId !== playerId;
    let rank = null;
    if (!hidden) {
      const ahead = Object.values(match.players).filter((p) => p.id !== playerId && computeEquity(match, p, elapsedSeconds, nowMs) > equity);
      rank = ahead.length + 1;
    }

    return {
      matchId: match.id,
      modeLabel: match.config.label || (match.mode === 'private' ? 'Private War' : match.mode),
      status: match.status,
      remainingSeconds: match.status === 'active' ? Math.max(0, match.config.durationSeconds - elapsedSeconds) : null,
      pnl: round2(equity - STARTING_CAPITAL),
      equity: round2(equity),
      rank,
      playerCount: Object.keys(match.players).length,
      eliminated: Boolean(player.eliminated),
      positions,
    };
  }

  // Forfeit from the live match card. The player may have no socket bound to
  // the match at all, so this is keyed off their account instead of a session.
  async function forfeitLiveMatch(playerId, matchId) {
    const match = liveMatchesFor(playerId).find((m) => m.id === matchId);
    if (!match) return { success: false, error: 'That match has already ended' };
    // A game screen still open in another tab must not sit there frozen.
    emitToPlayer(match, playerId, 'match:kicked', { reason: 'You forfeited this match.' });
    const result = await leaveMatch(match.id, playerId);
    if (result.success) updatePresence?.(playerId, { status: 'online', matchId: null, lobbyId: null, mode: null });
    return result;
  }

  function handleDisconnect(socketId) {
    const session = socketSessions.get(socketId);
    if (!session) return;
    const match = matches.get(session.matchId);
    const player = match?.players[session.playerId];
    // Only the socket currently bound counts: a game screen replaced by a
    // newer tab closing must not mark the player as gone.
    if (player && player.socketId === socketId) {
      player.socketId = null;
      if (!player.isAI && (match.status === 'active' || match.status === 'countdown') && !isPlayerOnSite?.(session.playerId)) {
        startDisconnectGrace(match, session.playerId);
      }
    }
    socketSessions.delete(socketId);
  }

  // ---- admin panel bridge (server/internalAdmin.js) --------------------------
  // Everything below is only ever called from the internal, secret-protected
  // admin routes - never reachable from a player's own socket/HTTP session.

  function listActiveMatches() {
    const out = [];
    for (const match of matches.values()) {
      if (match.status !== 'active' && match.status !== 'countdown' && match.status !== 'waiting') continue;
      const elapsedSeconds = match.startedAt ? getElapsedSeconds(match, Date.now()) : 0;
      const remaining = match.status === 'active' ? Math.max(0, match.config.durationSeconds - elapsedSeconds) : null;
      out.push({
        id: match.id,
        mode: match.mode,
        modeLabel: match.config.label,
        status: match.status,
        roomCode: match.roomCode,
        instruments: match.instruments,
        entryCoins: match.config.entryCoins,
        createdAt: match.createdAt,
        remainingSeconds: remaining,
        players: Object.values(match.players).map((p) => ({
          id: p.id,
          username: p.username,
          isAI: p.isAI,
          pnl: Math.round((p.balance - STARTING_CAPITAL) * 100) / 100,
        })),
      });
    }
    return out;
  }

  async function forceEndMatch(matchId) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    if (match.status !== 'active' && match.status !== 'countdown') {
      return { success: false, error: `Cannot force-end a match in status "${match.status}"` };
    }
    await endMatch(match);
    return { success: true };
  }

  // Cancels a match outright (waiting or active) and refunds every human
  // player's entry coins as an admin_grant transaction - distinct from voiding
  // via a normal endMatch, which computes results/ratings/prizes. Used for
  // matches that need to be scrapped rather than resolved (bug, dispute, abuse).
  async function voidMatch(matchId) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    if (match.status === 'finished' || match.status === 'voided') {
      return { success: false, error: `Match is already ${match.status}` };
    }
    clearInterval(match.timers.tickInterval);
    clearInterval(match.timers.leaderboardInterval);
    clearTimeout(match.timers.lobbyTimeout);

    for (const player of Object.values(match.players)) {
      if (player.isAI) continue;
      if (match.config.entryCoins > 0 && db.isConfigured) {
        try {
          await db.creditCoins(player.id, match.config.entryCoins, { type: 'admin_grant', matchId: match.dbMatchId, idempotencyKey: `void_refund:${match.id}:${player.id}` });
        } catch (e) {
          console.warn('[gameEngine] voidMatch refund failed for', player.username, e.message);
        }
      }
      notifyPlayer?.(player.id, 'match_voided', 'This match was cancelled by an admin. Your entry coins have been refunded.');
    }

    match.status = 'voided';
    personas.resetMatchPersonas(match.id);
    emitToAll(match, 'match:voided', { reason: 'Cancelled by an admin. Entry coins refunded.' });
    if (db.isConfigured && match.dbMatchId) {
      try {
        await db.updateMatch(match.dbMatchId, { status: 'voided', end_time: new Date().toISOString() });
      } catch (e) {
        console.warn('[gameEngine] voidMatch persistence failed:', e.message);
      }
    }
    return { success: true };
  }

  // FIX: eliminated/margin-called players (and anyone who just wants out)
  // can leave immediately instead of being stuck spectating their own
  // match. Always records dead-last and the "last place" rating penalty
  // regardless of current standing - leaving is a real forfeit, not a free
  // way to lock in a better-than-earned result. The match itself keeps
  // running normally for whoever's left; earlyLeavers is consulted in
  // endMatch() to notify the player once real final standings are known.
  // Leaving a match that hasn't started yet (the waiting room). Entry coins
  // were debited when the player queued (/api/match/create, invite accept),
  // so they're refunded here. If the host leaves, the next human becomes host;
  // if no humans are left, the room is closed. Tournament brackets are not
  // leavable from the waiting room - their entry belongs to the bracket.
  async function leaveLobby(match, playerId) {
    if (match.mode === 'tournament') return { success: false, error: 'Tournament rounds cannot be left before they start' };
    const player = match.players[playerId];
    delete match.players[playerId];
    match.playerOrder = match.playerOrder.filter((id) => id !== playerId);
    const humansLeft = match.playerOrder.filter((id) => match.players[id] && !match.players[id].isAI);
    if (match.hostId === playerId) match.hostId = humansLeft[0] || null;

    let refunded = 0;
    // Refund exactly the entry this player paid for this seat (entryPaidKey is
    // set by the server when the entry debit succeeds), keyed off that payment
    // so leaving can never refund more than was paid.
    if (match.config.entryCoins > 0 && db.isConfigured && player?.entryPaidKey) {
      try {
        await db.creditCoins(playerId, match.config.entryCoins, { type: 'match_refund', matchId: match.dbMatchId, idempotencyKey: `refund:${player.entryPaidKey}` });
        refunded = match.config.entryCoins;
      } catch (e) {
        console.warn('[gameEngine] leaveLobby refund failed for', player?.username, e.message);
      }
    }
    updatePresence?.(playerId, { status: 'online', matchId: null, lobbyId: null, mode: null });

    if (!humansLeft.length) {
      clearInterval(match.timers.tickInterval);
      clearInterval(match.timers.leaderboardInterval);
      clearTimeout(match.timers.lobbyTimeout);
      match.status = 'voided';
      if (db.isConfigured && match.dbMatchId) db.updateMatch(match.dbMatchId, { status: 'voided', end_time: new Date().toISOString() }).catch(() => {});
      instruments.releaseMatchWindows(match.id);
      personas.resetMatchPersonas(match.id);
      matches.delete(match.id);
      roomCodeIndex.delete(match.roomCode);
    } else {
      pushFeed(match, `${player?.username || 'A player'} left the lobby`);
      emitMatchStateToAll(match);
    }
    return { success: true, refunded, left: 'lobby' };
  }

  // Closes a waiting room, refunding every seat (leaveLobby keys the refund off
  // what each player actually paid).
  async function closeLobby(match, reason, notifyType = 'lobby_closed') {
    io.to(roomName(match.id)).emit('match:voided', { reason });
    const humans = match.playerOrder.filter((id) => match.players[id] && !match.players[id].isAI);
    if (!humans.length) {
      // Nobody to refund or tell, leaveLobby would never run its clean-up.
      match.status = 'voided';
      if (db.isConfigured && match.dbMatchId) db.updateMatch(match.dbMatchId, { status: 'voided', end_time: new Date().toISOString() }).catch(() => {});
      instruments.releaseMatchWindows(match.id);
      personas.resetMatchPersonas(match.id);
      matches.delete(match.id);
      roomCodeIndex.delete(match.roomCode);
      return true;
    }
    for (const playerId of humans) {
      const result = await leaveMatch(match.id, playerId).catch((e) => ({ success: false, error: e.message }));
      if (result && result.success) notifyPlayer?.(playerId, notifyType, reason);
      else console.warn('[gameEngine] could not close lobby seat', match.id, playerId, result && result.error);
    }
    return true;
  }

  // Waiting rooms never start on their own, so without this one left behind
  // (tab closed, script that never connected) would hold memory and the player's
  // entry coins forever. Tournament rounds belong to their bracket and stay.
  async function sweepIdleLobbies(nowMs = Date.now()) {
    let closed = 0;
    for (const match of Array.from(matches.values())) {
      if (match.status !== 'waiting' || match.mode === 'tournament') continue;
      const humans = match.playerOrder.filter((id) => match.players[id] && !match.players[id].isAI);
      if (humans.some((id) => match.players[id].socketId)) match.lastHumanSeenAt = nowMs;
      const idleFor = nowMs - (match.lastHumanSeenAt || match.createdAt);
      if (idleFor < LOBBY_IDLE_MS && nowMs - match.createdAt < LOBBY_MAX_AGE_MS) continue;
      await closeLobby(match, LOBBY_EXPIRED_MESSAGE);
      closed++;
    }
    return closed;
  }

  // Everything this player is seated in and hasn't left.
  function openMatchesFor(playerId) {
    const out = [];
    for (const match of matches.values()) {
      if (match.status !== 'waiting' && match.status !== 'countdown' && match.status !== 'active') continue;
      const seat = match.players[playerId];
      if (seat && !seat.forfeited) out.push({ id: match.id, mode: match.mode, status: match.status, roomCode: match.roomCode });
    }
    return out;
  }

  function liveMatchCount() {
    return matches.size;
  }

  async function leaveMatch(matchId, playerId, endReason = 'left') {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Player not in this match' };
    if (player.isAI) return { success: false, error: 'Cannot leave as AI' };
    if (match.status === 'waiting') return leaveLobby(match, playerId);
    if (match.status !== 'active' && match.status !== 'countdown') {
      return { success: false, error: `Cannot leave a match in status "${match.status}"` };
    }

    clearDisconnectGrace(matchId, playerId);
    player.forfeited = true;
    for (const pos of player.positions.slice()) closeTrade(matchId, playerId, pos.id, 'left_match');

    const totalPlayers = match.playerOrder.length; // original full roster, doesn't shrink as players leave
    const finalRank = totalPlayers;
    const ratingField = match.config.ratingKey || 'war_rating';
    const oldRating = player.warRating;
    let ratingChange = 0;
    let newRating = oldRating;
    if (match.config.ranked) {
      ratingChange = baseRatingForPosition(totalPlayers, totalPlayers); // the real "finished last" constant (-25)
      newRating = Math.max(0, oldRating + ratingChange);
    }
    const finalPnl = Math.round((player.balance - STARTING_CAPITAL) * 100) / 100;

    if (db.isConfigured) {
      try {
        const existing = await db.getPlayerById(playerId);
        const oldTotalMatches = existing?.total_matches || 0;
        const newTotalMatches = oldTotalMatches + 1;
        const updateFields = {
          losses: (existing?.losses || 0) + 1,
          total_matches: newTotalMatches,
          experience_level: await updateExperienceLevel(playerId, oldTotalMatches, newTotalMatches, false),
        };
        if (match.config.ranked) {
          updateFields[ratingField] = newRating;
          if (ratingField === 'war_rating') updateFields.tier = tierForRating(newRating);
        }
        await db.updatePlayer(playerId, updateFields);
        if (match.dbMatchId) {
          await db.updateMatchPlayer(match.dbMatchId, playerId, {
            final_pnl: finalPnl,
            final_rank: finalRank,
            cards_played: player.cardsPlayed,
            trades_made: player.tradesMade,
            rating_change: ratingChange,
          });
          db.updateMatchPlayer(match.dbMatchId, playerId, { end_reason: endReason }).catch(() => {});
        }
      } catch (e) {
        console.warn('[gameEngine] leaveMatch persistence failed:', e.message);
      }
    }

    match.earlyLeavers = match.earlyLeavers || [];
    match.earlyLeavers.push({ playerId, username: player.username, finalRank, finalPnl, ratingChange, newRating });

    delete match.players[playerId];
    match.playerOrder = match.playerOrder.filter((id) => id !== playerId);
    pushFeed(match, `${player.username} left the match`, { type: 'system' });
    emitMatchStateToAll(match);

    return { success: true, finalRank, ratingChange, newRating, pnl: finalPnl };
  }

  async function kickPlayerFromMatch(matchId, playerId) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Player not in this match' };

    for (const pos of player.positions.slice()) closeTrade(matchId, playerId, pos.id, 'admin_kick');
    emitToPlayer(match, playerId, 'match:kicked', { reason: 'Removed from this match by an admin.' });
    delete match.players[playerId];
    match.playerOrder = match.playerOrder.filter((id) => id !== playerId);
    pushFeed(match, `${player.username} was removed from the match by an admin`, { type: 'system' });
    emitMatchStateToAll(match);
    notifyPlayer?.(playerId, 'match_kicked', 'You were removed from a match by an admin.');
    return { success: true };
  }

  // Merges admin-edited values from the game_config table onto the live
  // MATCH_MODES object in place (not a reassignment) - createMatch() reads
  // MATCH_MODES[mode] fresh on every call, so this takes effect for the very
  // next match created in that mode, no restart needed.
  function applyConfigOverrides(overridesByMode) {
    if (!overridesByMode) return;
    for (const [mode, patch] of Object.entries(overridesByMode)) {
      if (MATCH_MODES[mode] && patch && typeof patch === 'object') {
        Object.assign(MATCH_MODES[mode], patch);
      }
    }
  }

  return {
    getGhost,
    getModeCounts,
    MAX_PLAYERS,
    MIN_PLAYERS,
    MATCH_MODES,
    STARTING_CAPITAL,
    PRIVATE_WAR_HOST_FEE,
    createMatch,
    closeLobby,
    sweepIdleLobbies,
    openMatchesFor,
    liveMatchCount,
    getMatch,
    getMatchByRoomCode,
    getPreMatchHistory,
    listWaitingQuickMatches,
    listWaitingMatchesByMode,
    joinMatch,
    setReady,
    hostStartMatch,
    forceStartLobby: (matchId) => tryStartLobby(matchId, true),
    openTrade,
    closeTrade,
    closeTradePartial,
    setStopLossTakeProfit,
    playSabotageCard,
    sendChatMessage,
    selectLoadoutCards,
    ALLOWED_CHAT_MESSAGES,
    // Lets index.js push a one-off system line into a match's feed (e.g.
    // "Farmer joined via invite") without exposing arbitrary player-authored
    // chat - sendChatMessage stays restricted to ALLOWED_CHAT_MESSAGES.
    pushSystemFeed: (matchId, text) => {
      const match = matches.get(matchId);
      if (match) pushFeed(match, text);
    },
    bindSocket,
    bindSpectator,
    getSession,
    handleDisconnect,
    getHomeStats,
    getFilledSeatsInPlay,
    getFeaturedMatch,
    buildMatchStatePayloadFor,
    tierForRating,
    leaveMatch,
    noteSiteConnected,
    noteSiteDisconnected,
    getLiveMatchStatus,
    forfeitLiveMatch,
    isInLiveMatch,
    // ---- admin panel bridge ----
    listActiveMatches,
    forceEndMatch,
    voidMatch,
    kickPlayerFromMatch,
    applyConfigOverrides,
    isFull,
    // ---- fire gameplay ----
    getMarketStats: () => MARKET_STATS.slice(),
    setFlatAlertHandler: (fn) => {
      onFlatAlert = fn;
    },
    // What a ghost challenge needs to replay this match's exact market.
    getMatchMarket: (matchId) => {
      const match = matches.get(matchId);
      if (!match) return null;
      const info = instruments.getMarketInfo(matchId) || {};
      const starts = {};
      for (const [s, v] of Object.entries(info)) if (v.curated) starts[s] = v.start;
      return { mode: match.mode, instruments: match.instruments.slice(), marketSeed: match.marketSeed, marketStarts: starts, durationSeconds: match.config.durationSeconds, endPayload: match.endPayload || null, playerIds: Object.keys(match.players), humanIds: Object.values(match.players).filter((p) => !p.isAI).map((p) => p.id) };
    },
    getCardLog: (matchId) => {
      const match = matches.get(matchId);
      return match ? match.cardLog.slice() : null;
    },
  };
}

module.exports = { createGameEngine, LIVE_MATCH_BUSY_ERROR, GAME_RULES, MODE_DURATIONS, MATCH_MODES, SOFT_LOSS_PCT, SOFT_LOSS_WINDOW_SECONDS, RECONNECT_GRACE_SECONDS: RECONNECT_GRACE_MS / 1000, MAX_PLAYERS, PRIZE_SHARE_BY_RANK, baseRatingForPosition, tierForRating, TIERS, computeMatchResults, groupByTiedPnl, samePnl, getExperienceLevel, EXPERIENCE_LEVELS, PRIVATE_WAR_HOST_FEE };
