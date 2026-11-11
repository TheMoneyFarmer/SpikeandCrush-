'use strict';

// Each game mode's identity: how it plays, not just how long it lasts.
// One entry per mode key (the keys and lengths in gameEngine MATCH_MODES /
// MODE_DURATIONS never change here). The game reads the effective rules for a
// mode from rulesFor() and snapshots them onto the match when it is created,
// so an admin edit applies to new matches and never to a running one.
//
// Anything a mode doesn't set falls back to Quick (the full fire game), and
// Quick itself falls back to server/config/gameFeel.js. Modes may differ in
// cards, win condition, events, instrument pool, missions and presentation -
// never in the money maths (P&L, equity, margin, stop-out are in GAME_RULES).
//
// Admin edits are stored in game_config key 'mode_identity' (partial objects
// per mode) and audit-logged by the admin server.

const gameFeel = require('./gameFeel');

// Card tiers for mode rules ("modeAllowed"): basic = the starter cards, mid =
// everything else common or rare, heavy = epic and legendary. Built from the
// deck at first use; admin can override one card with cardTierOverrides.
const TIER_BY_RARITY = { common: 'mid', rare: 'mid', epic: 'heavy', legendary: 'heavy' };

const DEFAULTS = {
  quick: {
    enabled: true,
    displayName: 'Quick War',
    icon: 'swords',
    identity: 'The full game: trade, earn cards on a win streak, sabotage the leader.',
    bestFor: 'Your everyday match',
    winCondition: 'Highest equity wins',
    winShort: 'Highest equity wins',
    winKey: 'equity',
    special: 'All features: 4 cards, Heat, missions, spike alerts, crown',
    cards: { enabled: true, handSize: 4, allowedTiers: ['basic', 'mid', 'heavy'], streakRewards: { 1: 1, 2: 1, 3: 2 }, refillAtStreak: 5, perWinAfterRefill: 1, startingHand: null, sabotage: true },
    instrumentPool: 'all',
    spikeAlerts: { enabled: true, minGapSeconds: 60 },
    events: { minutes: [] },
    checkpointMinute: null,
    elimination: null,
    missions: ['hold_60', 'two_wins', 'play_card', 'spike_entry', 'streak_3', 'tp_hit'],
    missionChain: false,
    resultHighlights: ['bestStreak', 'heat'],
    xpMultiplier: 1,
    preStartBanner: 'Quick War: 10 minutes, up to 4 cards, highest equity wins.',
  },
  blitz: {
    displayName: 'Blitz War',
    icon: 'bolt',
    identity: 'A three-minute sprint on the busiest markets. Two cards, fast refills.',
    bestFor: 'A quick fix between other things',
    winCondition: 'Highest equity after 3 minutes',
    winShort: 'Highest equity wins',
    special: '2 card slots, refills fast, no heavy cards, more spike alerts',
    cards: { handSize: 2, allowedTiers: ['basic', 'mid'], streakRewards: { 1: 1, 2: 2 }, refillAtStreak: 2, perWinAfterRefill: 1 },
    // The top of the activity ranking only (server/curated.js catalog).
    instrumentPool: 'top',
    instrumentPoolSize: 6,
    spikeAlerts: { enabled: true, minGapSeconds: 40 },
    missions: ['fast_two_wins', 'first_win_30', 'play_card'],
    resultHighlights: ['fastestWin', 'bestStreak'],
    preStartBanner: 'Blitz: 3 minutes, 2 cards, highest equity wins.',
  },
  grand: {
    displayName: 'Grand War',
    icon: 'crown',
    identity: 'Twenty minutes of strategy with scheduled market events and a half-time check.',
    bestFor: 'When you have time to plan',
    winCondition: 'Highest equity after 20 minutes',
    winShort: 'Highest equity wins',
    special: 'Start with 2 cards, events at 5, 10 and 15 minutes, Steady Hand badge',
    cards: { startingHand: { count: 2, tiers: ['basic', 'mid'] }, heavyFromStart: true },
    // Scheduled market events: real indexed spikes nearest these data minutes.
    // Biggest real move within the window around each minute: the top 10% of
    // 1-minute ranges first, then the top 25% (measured coverage 96.5%).
    events: { minutes: [5, 10, 15], searchWindowSeconds: 120, topPercent: 10, fallbackTopPercent: 25 },
    checkpointMinute: 10,
    steadyHandBadge: true,
    missions: ['hold_180', 'survive_events', 'two_wins'],
    resultHighlights: ['eventsSurvived', 'steadyHand', 'bestStreak'],
    preStartBanner: 'Grand War: 20 minutes, 2 cards to start, market events at 5, 10 and 15 minutes.',
  },
  tournament: {
    displayName: 'Elimination',
    icon: 'cut',
    identity: 'Survive the cuts. Every 3 minutes the bottom of the table is knocked out.',
    bestFor: 'Big lobbies and nerves of steel',
    winCondition: 'Survive every cut, then highest equity',
    winShort: 'Survive the cuts',
    winKey: 'elimination',
    special: 'Bottom 20% cut every 3 minutes; Lifeline card',
    elimination: {
      enabled: true,
      firstCutMinute: 3,
      everyMinutes: 3,
      cutShare: 0.2, // of the players still in
      minPlayersToStart: 4, // fewer at the start = a normal match, no cuts
      dangerZoneShare: 0.2, // "Danger" tag on the bottom zone
      warnSeconds: 30, // "Cut in 0:30" strip
    },
    cards: { lifeline: true },
    missions: ['never_bottom', 'survive_two_cuts', 'two_wins'],
    resultHighlights: ['roundsSurvived', 'bestStreak'],
    preStartBanner: 'Elimination: 15 minutes, a cut every 3 minutes, survive to win.',
  },
  solo: {
    displayName: 'Solo Ranked',
    icon: 'target',
    identity: 'Free, always open: race the ghost of your own best run and finish a mission chain.',
    bestFor: 'Learning, practice and beating your personal best',
    winCondition: 'Highest equity at the table; your own best run is the ghost to beat',
    winShort: 'Highest equity wins',
    special: 'No sabotage, ghost of your best run, 3-mission chain',
    // Only Shield and Cleanse can be held here (Lifeline needs cuts): 2 slots.
    cards: { handSize: 2, sabotage: false, allowedTiers: ['basic', 'mid'], defenseOnly: true },
    spikeAlerts: { enabled: true, minGapSeconds: 60 },
    missions: ['first_trade', 'two_wins', 'hold_60'],
    missionChain: true,
    resultHighlights: ['ghostDelta', 'personalBest'],
    preStartBanner: 'Solo Ranked: 10 minutes, free, no sabotage, beat your own best run.',
  },
  async: {
    displayName: 'Daily Challenge',
    icon: 'clock',
    identity: 'One market for everyone today. Set the score, then challenge friends.',
    bestFor: 'One go a day and bragging rights',
    winCondition: 'Best result of the day',
    winShort: 'Best of the day',
    special: 'Same market for everyone, no sabotage, share a challenge link',
    cards: { enabled: false, sabotage: false },
    missions: ['two_wins', 'hold_60'],
    resultHighlights: ['ghostDelta'],
    preStartBanner: 'Daily Challenge: 10 minutes, the same market for everyone today.',
  },
  private: {
    displayName: 'Private War',
    icon: 'lock',
    identity: 'Your room, your rules: invite friends with a code and choose how it plays.',
    bestFor: 'Playing with friends',
    winCondition: 'Set by the host',
    winShort: 'Host decides',
    special: 'Host sets cards, deck level, starting hand, cuts and flavor',
    // What the host may choose (validated in hostOptions()).
    hostOptions: {
      cards: [true, false],
      deckLevel: ['basic', 'mid', 'full'],
      startingHand: [0, 1, 2, 3, 4],
      eliminationCuts: [false, true],
      flavor: ['quick', 'blitz'],
    },
    preStartBanner: 'Private War: house rules set by the host.',
  },
};

// Mission definitions used by modes (cards.js keeps the engine).
const MODE_MISSIONS = {
  fast_two_wins: { label: 'Win two trades within 60 seconds', target: 2 },
  first_win_30: { label: 'Close a winning trade in the first 30 seconds', target: 1 },
  hold_180: { label: 'Hold one trade for 3 minutes', target: 1 },
  survive_events: { label: 'Stay above your starting equity through every market event', target: 1 },
  never_bottom: { label: 'Stay out of the bottom zone at every cut', target: 1 },
  survive_two_cuts: { label: 'Survive two cuts', target: 2 },
  first_trade: { label: 'Open your first trade', target: 1 },
};

let overrides = {};
let cardTierOverrides = {};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => {
  if (!isObj(b)) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
};

function applyOverrides(partial) {
  overrides = {};
  cardTierOverrides = {};
  if (!isObj(partial)) return;
  for (const [k, v] of Object.entries(partial)) {
    if (k === 'cardTierOverrides' && isObj(v)) cardTierOverrides = v;
    else if (DEFAULTS[k] && isObj(v)) overrides[k] = v;
  }
}

function getOverrides() {
  return { ...overrides, cardTierOverrides };
}

// Mode entry with Quick as the base, then admin overrides.
function identity(mode) {
  const quick = merge(DEFAULTS.quick, overrides.quick);
  if (mode === 'quick' || !DEFAULTS[mode]) return quick;
  const own = merge(DEFAULTS[mode], overrides[mode]);
  const out = merge(quick, own);
  // Lists replace (never merge) - a mode's mission pool is its own.
  if (own.missions) out.missions = own.missions;
  if (own.resultHighlights) out.resultHighlights = own.resultHighlights;
  return out;
}

function cardTier(cardId, basicDeck, rarity) {
  if (cardTierOverrides[cardId]) return cardTierOverrides[cardId];
  if (basicDeck.includes(cardId)) return 'basic';
  return TIER_BY_RARITY[rarity] || 'mid';
}

// Host options for a Private War, validated against the allowed lists.
function hostOptions(raw = {}) {
  const allowed = identity('private').hostOptions;
  const pick = (k, d) => (allowed[k].includes(raw[k]) ? raw[k] : d);
  return {
    cards: pick('cards', true),
    deckLevel: pick('deckLevel', 'full'),
    startingHand: pick('startingHand', 0),
    eliminationCuts: pick('eliminationCuts', false),
    flavor: pick('flavor', 'quick'),
  };
}

// The effective rules for one new match: the mode identity flattened over the
// fire-gameplay config, so card/mission/spike/crown code can read match.rules
// exactly like it reads gameFeel. `host` = validated Private War options.
function rulesFor(mode, host = null) {
  const f = gameFeel.get();
  let id = identity(mode);
  if (mode === 'private' && host) {
    const flavor = identity(host.flavor === 'blitz' ? 'blitz' : 'quick');
    id = {
      ...id,
      cards: {
        ...flavor.cards,
        enabled: host.cards,
        sabotage: host.cards,
        allowedTiers: host.deckLevel === 'basic' ? ['basic'] : host.deckLevel === 'mid' ? ['basic', 'mid'] : ['basic', 'mid', 'heavy'],
        startingHand: host.startingHand ? { count: host.startingHand, tiers: host.deckLevel === 'basic' ? ['basic'] : ['basic', 'mid'] } : null,
      },
      elimination: host.eliminationCuts ? identity('tournament').elimination : null,
      winKey: host.eliminationCuts ? 'elimination' : 'equity',
      winShort: host.eliminationCuts ? 'Survive the cuts' : 'Highest equity wins',
      missions: flavor.missions,
      spikeAlerts: flavor.spikeAlerts,
      instrumentPool: flavor.instrumentPool,
      instrumentPoolSize: flavor.instrumentPoolSize,
      resultHighlights: host.eliminationCuts ? ['roundsSurvived', 'bestStreak'] : flavor.resultHighlights,
      host,
    };
  }
  const c = id.cards || {};
  return {
    mode,
    identity: { displayName: id.displayName, identity: id.identity, winShort: id.winShort, winKey: id.winKey || 'equity', banner: id.preStartBanner, icon: id.icon },
    cards: {
      ...f.cards,
      earnedCards: c.enabled !== false && f.cards.earnedCards,
      handSize: c.handSize ?? f.cards.handSize,
      streakRewards: c.streakRewards || f.cards.streakRewards,
      refillAtStreak: c.refillAtStreak ?? f.cards.refillAtStreak,
      perWinAfterRefill: c.perWinAfterRefill ?? f.cards.perWinAfterRefill,
      enabled: c.enabled !== false,
      sabotage: c.sabotage !== false,
      defenseOnly: Boolean(c.defenseOnly),
      allowedTiers: c.allowedTiers || ['basic', 'mid', 'heavy'],
      startingHand: c.startingHand || null,
      lifeline: Boolean(c.lifeline),
    },
    heat: f.heat,
    missions: { ...f.missions, pool: id.missions, chain: Boolean(id.missionChain) },
    spikeAlerts: { ...f.spikeAlerts, enabled: f.spikeAlerts.enabled && id.spikeAlerts && id.spikeAlerts.enabled !== false, minGapSeconds: (id.spikeAlerts && id.spikeAlerts.minGapSeconds) || 60 },
    crown: f.crown,
    progression: f.progression,
    instrumentPool: id.instrumentPool || 'all',
    instrumentPoolSize: id.instrumentPoolSize || null,
    events: id.events || { minutes: [] },
    checkpointMinute: id.checkpointMinute ?? null,
    steadyHandBadge: Boolean(id.steadyHandBadge),
    elimination: id.elimination && id.elimination.enabled !== false ? id.elimination : null,
    resultHighlights: id.resultHighlights || [],
    xpMultiplier: Number(id.xpMultiplier) || 1,
  };
}

// What the lobby and Compare sheet show, per mode.
function publicCatalog() {
  return Object.keys(DEFAULTS)
    .map((key) => {
      const id = identity(key);
      return { key, enabled: id.enabled !== false, displayName: id.displayName, icon: id.icon, identity: id.identity, bestFor: id.bestFor, winCondition: id.winCondition, winShort: id.winShort, special: id.special, cardSlots: id.cards && id.cards.enabled === false ? 0 : (id.cards && id.cards.handSize) || 4, sabotage: !(id.cards && id.cards.sabotage === false), startingHand: (id.cards && id.cards.startingHand && id.cards.startingHand.count) || null, cutsEveryMinutes: id.elimination && id.elimination.enabled !== false ? id.elimination.everyMinutes : null, events: id.events ? id.events.minutes : null, hostOptions: id.hostOptions || null, banner: id.preStartBanner };
    });
}

module.exports = { DEFAULTS, MODE_MISSIONS, identity, rulesFor, hostOptions, cardTier, publicCatalog, applyOverrides, getOverrides };
