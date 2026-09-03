'use strict';

const crypto = require('crypto');
const instruments = require('./instruments');
const sabotage = require('./sabotage');
const db = require('./database');
const battlepass = require('./battlepass');
const tournamentLib = require('./tournament');
const personas = require('./personas');

const MAX_PLAYERS = 8; // raised from 6 so Grand War's 8-player lobbies fit the same player-cap check everywhere
const MIN_PLAYERS = 2;
const STARTING_CAPITAL = 10000;
const MAX_LOTS = 10.0;
const MAX_POSITIONS = 10;
const SOFT_LOSS_WINDOW_SECONDS = 120; // 2 minutes
const SOFT_LOSS_PCT = 0.2; // 20% of starting capital lost within the current window -> locked out until it resets
const HARD_LOSS_PCT = 0.5; // 50% of starting capital lost overall -> eliminated for the rest of the match
const ALLOWED_CHAT_MESSAGES = ['GL HF', "Let's go", 'May the best trader win', 'Ready to war'];

// Per-mode lobby/match rules. `ratingKey` names which field on the player
// record this mode's result affects (war_rating for Quick/Blitz/Private,
// grand_war_rating / solo_rating for their own separate leaderboards, null
// for unranked modes) - createPlayerState reads the right one per match.
const MATCH_MODES = {
  quick: {
    label: 'Quick War', idealPlayers: 4, minPlayers: 2, maxPlayers: 6,
    lobbyTimeoutMs: 45000, countdownSeconds: 10, durationSeconds: 600,
    instrumentCount: 5, cardsPerPlayer: 3, entryCoins: 10, ranked: true, ratingKey: 'war_rating',
    fillMethod: 'ai',
  },
  blitz: {
    label: 'Blitz War', idealPlayers: 4, minPlayers: 2, maxPlayers: 6,
    lobbyTimeoutMs: 20000, countdownSeconds: 10, durationSeconds: 180,
    instrumentCount: 3, cardsPerPlayer: 1, entryCoins: 5, ranked: false, ratingKey: null,
    fillMethod: 'ai',
  },
  grand: {
    label: 'Grand War', idealPlayers: 8, minPlayers: 4, maxPlayers: 8,
    lobbyTimeoutMs: 90000, countdownSeconds: 10, durationSeconds: 1200,
    instrumentCount: 5, cardsPerPlayer: 5, entryCoins: 25, ranked: true, ratingKey: 'grand_war_rating',
    fillMethod: 'ai', deckSelection: true,
  },
  private: {
    label: 'Private War', idealPlayers: 4, minPlayers: 2, maxPlayers: 8,
    lobbyTimeoutMs: 45000, countdownSeconds: 10, durationSeconds: 600,
    instrumentCount: 5, cardsPerPlayer: 3, entryCoins: 0, ranked: false, ratingKey: null,
    fillMethod: 'host',
  },
  solo: {
    label: 'Solo Ranked', idealPlayers: 1, minPlayers: 1, maxPlayers: 4,
    lobbyTimeoutMs: 0, countdownSeconds: 3, durationSeconds: 600,
    instrumentCount: 2, cardsPerPlayer: 3, entryCoins: 0, ranked: true, ratingKey: 'solo_rating',
    fillMethod: 'ai_only', aiOpponents: 3,
  },
  tournament: {
    label: 'Tournament War', idealPlayers: 2, minPlayers: 2, maxPlayers: 2,
    lobbyTimeoutMs: 0, countdownSeconds: 10, durationSeconds: 900,
    instrumentCount: 5, cardsPerPlayer: 4, entryCoins: 0, ranked: false, ratingKey: null,
    fillMethod: 'none',
  },
  async: {
    label: 'Async Daily Challenge', idealPlayers: 1, minPlayers: 1, maxPlayers: 1,
    lobbyTimeoutMs: 0, countdownSeconds: 0, durationSeconds: 600,
    instrumentCount: 3, cardsPerPlayer: 0, entryCoins: 5, ranked: false, ratingKey: null,
    fillMethod: 'none',
  },
};

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
  for (let i = 1; i < sortedEntries.length; i++) {
    if (enableTies && samePnl(sortedEntries[i].pnl, sortedEntries[i - 1].pnl)) {
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
  if (pos === 2) return 10;
  if (pos === 3) return 0;
  return pos === totalPlayers ? -25 : -10;
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
  const ranked = players
    .map((p) => ({ player: p, pnl: Math.round((p.balance - STARTING_CAPITAL) * 100) / 100 }))
    .sort((a, b) => b.pnl - a.pnl);

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

function createGameEngine(io, notifyPlayer, updatePresence, notifyFriendsOfWin) {
  const matches = new Map();
  const roomCodeIndex = new Map(); // roomCode -> matchId
  const socketSessions = new Map(); // socketId -> { matchId, playerId }

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
      cards: p.cards.map((c) => (isSelf ? { type: c.type, used: c.used } : { type: c.used ? c.type : null, used: c.used })),
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
      lobbyTargetSize: match.config.idealPlayers,
      cardsPerPlayer: match.config.cardsPerPlayer,
      entryCoins: match.config.entryCoins,
      cardCatalog: sabotage.getCardCatalog(),
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
    const timeWarpActive = nowMs < match.marketEffects.timeWarpUntil && viewerId !== match.marketEffects.timeWarpCasterId;
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
      viewerId !== match.marketEffects.volatilitySurgeCasterId
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
      viewerId !== match.marketEffects.deadCalmCasterId
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
    if (nowMs < match.marketEffects.fogOfWarUntil && viewerId !== match.marketEffects.fogOfWarCasterId) {
      const pipSize = instruments.getInstrument(symbol)?.pipSize || 0.0001;
      mid += (Math.random() * 2 - 1) * 4 * pipSize;
    }

    const baseSpread = instruments.getSpread(symbol);
    const spreadActive =
      nowMs < match.marketEffects[symbol].spreadUntil && viewerId !== match.marketEffects[symbol].spreadCasterId;
    const doubleSpreadActive =
      nowMs < match.marketEffects.doubleSpreadUntil && viewerId !== match.marketEffects.doubleSpreadCasterId;
    let spread = spreadActive ? baseSpread * match.marketEffects[symbol].spreadMultiplier : baseSpread;
    if (doubleSpreadActive) spread *= 2;

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
    const matchInstruments = opts.instrumentList && opts.instrumentList.length
      ? opts.instrumentList
      : dailySeed
        ? instruments.selectDailyInstruments(dailySeed, modeConfig.instrumentCount)
        : instruments.selectMatchInstruments(modeConfig.instrumentCount);

    for (const symbol of matchInstruments) instruments.assignMatchWindow(matchId, symbol, dailySeed);

    const match = {
      id: matchId,
      mode,
      config: { ...modeConfig, ...opts.configOverrides },
      roomCode,
      status: 'waiting',
      instruments: matchInstruments,
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

    if (match.config.lobbyTimeoutMs > 0) {
      match.timers.lobbyTimeout = setTimeout(() => tryStartLobby(matchId, true), match.config.lobbyTimeoutMs);
    }
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
    if (!match) return null;
    // A finished match releases its price windows immediately (endMatch) but the
    // match record itself lingers in `matches` for a few more minutes before
    // cleanup - in that gap, history is simply no longer available rather than
    // an error worth a 500.
    try {
      const history = {};
      for (const symbol of match.instruments) {
        history[symbol] = instruments.getPreMatchHistory(matchId, symbol);
      }
      return history;
    } catch (e) {
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
    return {
      id: info.id,
      username: info.username,
      country: info.country || null,
      warRating: rating,
      tier: tierForRating(rating),
      isAI,
      aiPersonality: personality,
      aiState: isAI ? createAIState(personality, matchInstruments) : null,
      ready: isAI,
      socketId,
      balance: STARTING_CAPITAL,
      positions: [],
      cards: sabotage.dealCards(modeConfig.cardsPerPlayer),
      cardsPlayed: 0,
      tradesMade: 0,
      effects: sabotage.createPlayerEffects(),
      marginWarned: false,
      eliminated: false,
      softLocked: false,
      riskWindowIndex: 0,
      riskWindowStartEquity: STARTING_CAPITAL,
      bestTrade: 0,
      worstTrade: 0,
      equityHistory: isAI ? null : [{ t: 0, equity: STARTING_CAPITAL }],
    };
  }

  function joinMatch(match, playerInfo, socketId = null) {
    if (match.status !== 'waiting') return { success: false, error: 'Match already started' };
    if (match.players[playerInfo.id]) {
      return { success: true, alreadyJoined: true, match };
    }
    if (Object.keys(match.players).length >= match.config.maxPlayers) return { success: false, error: 'Match is full' };

    const player = createPlayerState(playerInfo, socketId, false, null, match.config);
    match.players[playerInfo.id] = player;
    match.playerOrder.push(playerInfo.id);

    if (db.isConfigured && match.dbMatchId) {
      db.addMatchPlayer({ matchId: match.dbMatchId, playerId: playerInfo.id }).catch(() => {});
    }

    pushFeed(match, `${player.username} joined the war`);
    emitToAll(match, 'player:joined', { player: publicPlayer(player, false) });
    emitMatchStateToAll(match);
    updatePresence?.(playerInfo.id, { status: 'in_lobby', lobbyId: match.id, matchId: null, mode: match.config.label || match.mode });

    if (Object.keys(match.players).length >= match.config.idealPlayers || Object.keys(match.players).length >= match.config.maxPlayers) {
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
        : Math.max(match.config.minPlayers, Math.min(match.config.idealPlayers, match.config.maxPlayers));
    const needed = match.config.fillMethod === 'none' ? 0 : Math.max(0, targetSize - currentCount);
    const stagger = match.config.fillMethod === 'ai';

    fillWithAI(match, needed, { stagger }).then(() => {
      emitMatchStateToAll(match);
      beginCountdown(match.id);
    });
  }

  function setReady(matchId, playerId) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    const p = match.players[playerId];
    if (!p) return { success: false, error: 'Player not in match' };
    p.ready = true;
    emitMatchStateToAll(match);

    const humanPlayers = Object.values(match.players).filter((p2) => !p2.isAI);
    if (humanPlayers.length > 0 && humanPlayers.every((p2) => p2.ready) && Object.keys(match.players).length >= match.config.minPlayers) {
      tryStartLobby(match.id, false);
    }
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
    match.status = 'active';
    match.startedAt = Date.now();

    if (db.isConfigured && match.dbMatchId) {
      db.updateMatch(match.dbMatchId, { status: 'active', start_time: new Date(match.startedAt).toISOString() }).catch(() => {});
    }

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

    const liquidityDrained =
      nowMs < match.marketEffects.liquidityDrainUntil && match.marketEffects.liquidityDrainCasterId !== playerId;
    const lotLimited = player.effects.lot_limiter && nowMs < player.effects.lot_limiter.until;
    const maxLot = Math.min(liquidityDrained ? 0.1 : MAX_LOTS, lotLimited ? 0.05 : MAX_LOTS);
    const numLots = Number(lots);
    if (!Number.isFinite(numLots) || numLots <= 0 || numLots > maxLot) {
      return { success: false, error: `Lot size must be between 0 and ${maxLot}` };
    }
    if (player.positions.length >= MAX_POSITIONS) {
      return { success: false, error: 'Maximum open positions reached' };
    }

    const price = getEffectivePrice(match, symbol, elapsedSeconds, nowMs, playerId);
    const entryPrice = direction === 'BUY' ? price.ask : price.bid;

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
    const exitPrice = position.direction === 'BUY' ? price.bid : price.ask;
    const pnl = instruments.calculatePnL(position.direction, position.lots, position.entryPrice, exitPrice, position.symbol);

    player.balance = Math.round((player.balance + pnl) * 100) / 100;
    player.positions.splice(idx, 1);
    if (pnl > player.bestTrade) player.bestTrade = pnl;
    if (pnl < player.worstTrade) player.worstTrade = pnl;

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

        let hitReason = null;
        if (pos.direction === 'BUY') {
          if (pos.stopLoss && exitPrice <= pos.stopLoss) hitReason = 'stop loss';
          else if (pos.takeProfit && exitPrice >= pos.takeProfit) hitReason = 'take profit';
        } else {
          if (pos.stopLoss && exitPrice >= pos.stopLoss) hitReason = 'stop loss';
          else if (pos.takeProfit && exitPrice <= pos.takeProfit) hitReason = 'take profit';
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
    const result = sabotage.playCard(match, playerId, cardType, opts, nowMs);
    if (!result.success) return result;

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
      const direction = Math.random() < 0.5 ? 'BUY' : 'SELL';
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
    const candidates = Object.values(match.players).filter((p) => p.id !== player.id);
    if (cardDef.targeted && candidates.length === 0) return;
    const target = cardDef.targeted ? candidates[Math.floor(Math.random() * candidates.length)] : null;
    playSabotageCard(match.id, player.id, card.type, { targetId: target ? target.id : undefined });
  }

  function runAI(match, player, elapsedSeconds, nowMs) {
    const st = player.aiState;
    if (!st) return;

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
  // Two-tier risk system:
  //  - Soft limit: lose SOFT_LOSS_PCT (20%) of starting capital within the
  //    current SOFT_LOSS_WINDOW_SECONDS (2 min) window -> locked out of new
  //    trades until the window rolls over (every 2 minutes, from match start).
  //  - Hard limit: lose HARD_LOSS_PCT (50%) of starting capital overall ->
  //    all positions force-closed and the player is permanently eliminated
  //    from trading for the rest of the match.

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

    const overallLossPct = (STARTING_CAPITAL - equity) / STARTING_CAPITAL;
    if (overallLossPct >= HARD_LOSS_PCT) {
      player.eliminated = true;
      for (const pos of player.positions.slice()) closeTrade(match.id, player.id, pos.id, 'eliminated');
      pushFeed(match, `${player.username} hit max loss (-50%) and is eliminated from the match`, {
        type: 'margin_warning',
        timestamp: elapsedSeconds,
        playerId: player.id,
        pnl: Math.round(equity - STARTING_CAPITAL),
      });
      emitToPlayer(match, player.id, 'margin:warning', { level: 'eliminated', equity: Math.round(equity) });
    } else if (overallLossPct >= 0.4) {
      if (!player.marginWarned) {
        player.marginWarned = true;
        emitToPlayer(match, player.id, 'margin:warning', { level: 'warning', equity: Math.round(equity) });
      }
    } else {
      player.marginWarned = false;
    }
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
    emitToAll(match, 'price:update', {
      matchId: match.id,
      elapsedSeconds,
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
    if (activeExemptIds.size > 0) {
      for (const p of Object.values(match.players)) {
        if (p.isAI || !activeExemptIds.has(p.id)) continue;
        const correctedPrices = {};
        for (const symbol of match.instruments) correctedPrices[symbol] = getEffectivePrice(match, symbol, elapsedSeconds, nowMs, p.id);
        emitToPlayer(match, p.id, 'price:update', {
          matchId: match.id,
          elapsedSeconds,
          timeRemaining: match.config.durationSeconds - elapsedSeconds,
          prices: correctedPrices,
        });
      }
    }

    checkStopLossTakeProfit(match, elapsedSeconds, nowMs);
    for (const p of Object.values(match.players)) checkRiskLimits(match, p, elapsedSeconds, nowMs);

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
          tradesMade: p.tradesMade,
          eliminated: p.eliminated,
          softLocked: p.softLocked,
        };
      })
      .sort((a, b) => b.pnl - a.pnl)
      .map((row, i) => ({ ...row, rank: i + 1 }));

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
          await db.creditCoins(r.playerId, t.entry_coins, { type: 'tournament_refund', matchId: match.dbMatchId });
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
            await db.creditCoins(championId, t.prize_pool_coins, { type: 'tournament_prize', matchId: match.dbMatchId });
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
        await db.creditCoins(championId, t.prize_pool_coins, { type: 'tournament_prize', matchId: match.dbMatchId });
      }
      notifyPlayer?.(championId, 'tournament_champion', `You won the tournament! +${t.prize_pool_coins} coins`);
    } else {
      await db.updateTournament(tournamentId, { bracket_data: bracketData });
      notifyPlayer?.(winner.playerId, 'tournament_advance', `You advanced to round ${round + 1} of the tournament!`);
      await syncByeRegistrations(tournamentId, bracketData);
    }
  }

  async function endMatch(match) {
    if (match.status === 'resolving' || match.status === 'finished') return;
    match.status = 'resolving';
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
          const won = r.rank === 1 && !r.isDraw;
          const updateFields = {
            wins: (existing?.wins || 0) + (won ? 1 : 0),
            losses: (existing?.losses || 0) + (!won && !r.isDraw ? 1 : 0),
            draws: (existing?.draws || 0) + (r.isDraw ? 1 : 0),
            total_matches: (existing?.total_matches || 0) + 1,
          };
          if (match.config.ranked) {
            updateFields[ratingField] = r.newRating;
            if (ratingField === 'war_rating') updateFields.tier = p.tier;
            if (ratingField === 'war_rating' && p.tier !== r.oldTier && r.newRating > r.oldRating && !r.isAI) {
              notifyPlayer?.(r.playerId, 'rank_up', `You are now ${p.tier} tier! (${r.oldRating} → ${r.newRating} rating)`);
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
          }
          if (r.coinsAwarded > 0) {
            await db.creditCoins(r.playerId, r.coinsAwarded, { type: 'prize_won', matchId: match.dbMatchId });
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
                await db.creditCoins(r.playerId, tierCoins, { type: 'battlepass_tier', matchId: match.dbMatchId });
              }
              notifyPlayer?.(r.playerId, 'battlepass_tier', `Battle Pass tier ${newTier} unlocked!`);
            }
          }
        } catch (e) {
          console.warn('[gameEngine] failed to persist match result for', r.username, e.message);
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
    emitToAll(match, 'match:end', { matchId: match.id, results: clientResults, feed: match.feed });
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
    setTimeout(() => {
      matches.delete(match.id);
      roomCodeIndex.delete(match.roomCode);
    }, 5 * 60 * 1000);
  }

  // ---- socket session binding -----------------------------------------------

  function bindSocket(socket, matchId) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    const playerId = socket.data.player.id;
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Join the match via the API before connecting' };

    player.socketId = socket.id;
    socket.join(roomName(matchId));
    socketSessions.set(socket.id, { matchId, playerId });

    io.to(socket.id).emit('match:state', buildMatchStatePayloadFor(match, playerId));
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
    socket.join(roomName(matchId));
    io.to(socket.id).emit('match:state', buildMatchStatePayloadFor(match, null));
    return { success: true };
  }

  function getHomeStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    let matchesToday = 0;
    const activePlayerIds = new Set();
    for (const match of matches.values()) {
      if (match.createdAt >= todayStart.getTime()) matchesToday += 1;
      if (match.status === 'active' || match.status === 'countdown') {
        for (const p of Object.values(match.players)) {
          if (!p.isAI) activePlayerIds.add(p.id);
        }
      }
    }
    return { matchesToday, activePlayers: activePlayerIds.size };
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
  function selectLoadoutCards(matchId, playerId, cardTypes) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    if (match.status !== 'waiting') return { success: false, error: 'Cannot change your setup after the match has started' };
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Player not in match' };

    const expectedCount = match.config.cardsPerPlayer;
    if (!Array.isArray(cardTypes) || cardTypes.length !== expectedCount) {
      return { success: false, error: `Select exactly ${expectedCount} cards` };
    }
    const validTypes = new Set(Object.keys(sabotage.CARDS));
    if (!cardTypes.every((t) => validTypes.has(t))) return { success: false, error: 'Invalid card selection' };
    if (new Set(cardTypes).size !== cardTypes.length) return { success: false, error: 'Cannot select duplicate cards' };

    player.cards = cardTypes.map((type) => ({ type, used: false }));
    emitMatchStateToAll(match);
    return { success: true };
  }

  function handleDisconnect(socketId) {
    const session = socketSessions.get(socketId);
    if (!session) return;
    const match = matches.get(session.matchId);
    if (match && match.players[session.playerId]) {
      match.players[session.playerId].socketId = null;
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
          await db.creditCoins(player.id, match.config.entryCoins, { type: 'admin_grant', matchId: match.dbMatchId });
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
  async function leaveMatch(matchId, playerId) {
    const match = matches.get(matchId);
    if (!match) return { success: false, error: 'Match not found' };
    const player = match.players[playerId];
    if (!player) return { success: false, error: 'Player not in this match' };
    if (player.isAI) return { success: false, error: 'Cannot leave as AI' };
    if (match.status !== 'active' && match.status !== 'countdown') {
      return { success: false, error: `Cannot leave a match in status "${match.status}"` };
    }

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
        const updateFields = {
          losses: (existing?.losses || 0) + 1,
          total_matches: (existing?.total_matches || 0) + 1,
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
    MAX_PLAYERS,
    MIN_PLAYERS,
    MATCH_MODES,
    STARTING_CAPITAL,
    createMatch,
    getMatch,
    getMatchByRoomCode,
    getPreMatchHistory,
    listWaitingQuickMatches,
    listWaitingMatchesByMode,
    joinMatch,
    setReady,
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
    getFeaturedMatch,
    buildMatchStatePayloadFor,
    tierForRating,
    leaveMatch,
    // ---- admin panel bridge ----
    listActiveMatches,
    forceEndMatch,
    voidMatch,
    kickPlayerFromMatch,
    applyConfigOverrides,
  };
}

module.exports = { createGameEngine, tierForRating, TIERS, computeMatchResults, groupByTiedPnl, samePnl };
