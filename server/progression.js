'use strict';

// Levels, XP and card unlocks. Pure rules (no database, no sockets) so they are
// testable directly; server/index.js and gameEngine.js do the I/O.
//
// Ladders that already existed and are extended, not duplicated:
//   - rank = the rating tier (gameEngine TIERS: Recruit, Trader, Broker,
//     Analyst, Veteran, Elite, War Lord) - status and rank benefits
//   - battle pass tiers (battlepass.js) - the monthly season track
//   - experience label by matches played (gameEngine EXPERIENCE_LEVELS)
// New here: a lifetime XP level (1-20) that unlocks cards. A level is never
// bought: XP comes only from playing (gameFeel.progression.xp).

const gameFeel = require('./config/gameFeel');
const sabotage = require('./sabotage');

// New players start with these: the simplest, least harmful cards, plus one
// defensive card so a beginner is never defenceless.
const BASIC_DECK = ['position_freeze', 'lot_limiter', 'spread_spike', 'shield'];

// What unlocks each other card. Heavy damage (biggest steals, force-close,
// full margin call) sits in the highest tiers. Admin can override per card
// via gameFeel.progression.unlockOverrides { cardId: { level } | { wins } }.
const UNLOCKS = {
  tp_snip: { level: 2 },
  liquidity_drain: { level: 2 },
  order_freeze: { level: 3 },
  double_spread: { level: 3 },
  cooldown_jam: { level: 4 },
  lockout: { level: 4 },
  trade_limit: { level: 5 },
  margin_squeeze: { level: 5 },
  cleanse: { matches: 10 },
  spread_blowout: { level: 6 },
  volatility_surge: { level: 6 },
  slippage_storm: { level: 7 },
  one_way: { level: 7 },
  time_warp: { level: 8 },
  dead_calm: { level: 8 },
  fog_of_war: { level: 9 },
  reversal_flash: { level: 9 },
  stop_snipe: { level: 10 },
  mirror_trade: { level: 10 },
  ghost_trade: { level: 11 },
  panic_wave: { level: 12 },
  stop_yank: { level: 12 },
  profit_tax: { level: 13 },
  capital_drain: { level: 14 },
  force_close: { level: 15 },
  pip_theft: { wins: 10, level: 15 },
  profit_skim: { wins: 25, level: 17 },
  margin_call: { wins: 50, level: 18 },
};

function unlockRule(cardId) {
  const over = (gameFeel.get().progression.unlockOverrides || {})[cardId];
  return over || UNLOCKS[cardId] || null;
}

function describeUnlock(rule) {
  if (!rule) return 'Unlocked from the start';
  const parts = [];
  if (rule.level) parts.push(`Reach Level ${rule.level}`);
  if (rule.wins) parts.push(`Win ${rule.wins} matches`);
  if (rule.matches) parts.push(`Play ${rule.matches} matches`);
  return parts.join(' and ');
}

function thresholds() {
  return gameFeel.get().progression.levelThresholds;
}

function levelForXp(xp) {
  const t = thresholds();
  let level = 1;
  for (let i = 0; i < t.length; i++) if (xp >= t[i]) level = i + 1;
  return level;
}

function levelInfo(xp) {
  const t = thresholds();
  const level = levelForXp(xp);
  const floor = t[level - 1];
  const next = t[level] ?? null;
  return { level, xp, levelFloor: floor, nextLevelXp: next, maxLevel: t.length, progress: next === null ? 1 : (xp - floor) / (next - floor) };
}

// XP a player has already earned by their real history (matches and wins on
// the players row). Used to place existing players on the ladder (the
// migration) and as the floor whenever stored progress is missing.
function historyXp({ total_matches: matches = 0, wins = 0 } = {}) {
  const x = gameFeel.get().progression.xp;
  return Math.max(0, Math.round((Number(matches) || 0) * x.matchCompleted + (Number(wins) || 0) * x.win));
}

// Everything that decides unlocks, from the players row + stored progress.
function standing(playerRow = {}, stored = null) {
  const xp = Math.max(historyXp(playerRow), Number(stored && stored.xp) || 0);
  return { xp, level: levelForXp(xp), wins: Number(playerRow.wins) || 0, matches: Number(playerRow.total_matches) || 0 };
}

function meets(rule, s) {
  if (!rule) return true;
  if (rule.level && s.level < rule.level) return false;
  if (rule.wins && s.wins < rule.wins) return false;
  if (rule.matches && s.matches < rule.matches) return false;
  return true;
}

// The cards this player may hold, be dealt, earn or play. `granted` = admin
// grants (card ids), `revoked` = admin revokes (card ids, override everything).
function unlockedCards(s, { granted = [], revoked = [] } = {}) {
  const all = Object.keys(sabotage.CARDS);
  const out = all.filter((id) => (BASIC_DECK.includes(id) || meets(unlockRule(id), s) || granted.includes(id)) && !revoked.includes(id));
  return out;
}

function collection(s, opts = {}) {
  const unlocked = new Set(unlockedCards(s, opts));
  return sabotage.getCardCatalog().map((c) => ({
    ...c,
    unlocked: unlocked.has(c.id),
    basic: BASIC_DECK.includes(c.id),
    unlockText: BASIC_DECK.includes(c.id) ? 'Starter card' : describeUnlock(unlockRule(c.id)),
    unlockRule: unlockRule(c.id),
  }));
}

// Cards newly unlocked when moving from standing a to standing b.
function newUnlocks(a, b, opts = {}) {
  const before = new Set(unlockedCards(a, opts));
  return unlockedCards(b, opts).filter((id) => !before.has(id));
}

// XP for one finished match. `m` = { durationPlayed, finalRank, qualifyingWins,
// bestStreak, missionsCompleted, pnl, startingCapital, abandoned, selfPlay }.
function matchXp(m) {
  const x = gameFeel.get().progression.xp;
  if (m.abandoned && (m.durationPlayed || 0) < x.minMatchSecondsForXp) return { total: 0, parts: { abandoned: 0 } };
  if (m.selfPlay) return { total: 0, parts: { selfPlay: 0 } };
  const parts = { match: x.matchCompleted };
  if (m.finalRank === 1) parts.win = x.win;
  else if (m.finalRank === 2 || m.finalRank === 3) parts.podium = x.podium;
  if (m.qualifyingWins) parts.qualifyingWins = m.qualifyingWins * x.qualifyingWin;
  if (m.bestStreak) parts.streak = m.bestStreak * x.bestStreakPerStep;
  if (m.missionsCompleted) parts.missions = m.missionsCompleted * x.missionCompleted;
  const pct = m.pnl > 0 ? (m.pnl / (m.startingCapital || 10000)) * 100 : 0;
  if (pct > 0) parts.profit = Math.min(x.profitXpCapPerMatch, Math.floor(pct * x.profitPctPerPoint));
  const raw = Object.values(parts).reduce((s, v) => s + v, 0);
  return { total: Math.min(raw, x.perMatchCap), parts };
}

// Apply today's cap. `today` = XP already earned today (UTC).
function capForDay(amount, today) {
  const cap = gameFeel.get().progression.xp.perDayCap;
  return Math.max(0, Math.min(amount, cap - (Number(today) || 0)));
}

// Rank benefits: extra cards in hand at match start by rating tier.
function startingBonusCards(tier) {
  const t = gameFeel.get().progression.startingCardsByTier || {};
  return Math.max(0, Math.min(2, Number(t[tier]) || 0));
}

// Rank benefit table for the profile screen and rules page.
function rankBenefits() {
  const t = gameFeel.get().progression.startingCardsByTier || {};
  return Object.entries(t).map(([tier, n]) => ({
    tier,
    extraStartingCards: n,
    cosmetics: {
      Recruit: 'Rookie frame',
      Trader: 'Trader title + green nameplate',
      Broker: 'Broker title + chart theme "Night desk"',
      Analyst: 'Analyst title + candle colours "Signal"',
      Veteran: 'Veteran frame + trade sound pack "Bell"',
      Elite: 'Elite crown skin + victory animation',
      'War Lord': 'War Lord gold nameplate + leaderboard flair + result banner',
    }[tier] || '',
  }));
}

function season(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  BASIC_DECK,
  UNLOCKS,
  unlockRule,
  describeUnlock,
  levelForXp,
  levelInfo,
  historyXp,
  standing,
  unlockedCards,
  collection,
  newUnlocks,
  matchXp,
  capForDay,
  startingBonusCards,
  rankBenefits,
  season,
};
