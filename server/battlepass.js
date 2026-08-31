'use strict';

// 30-day season, XP-driven tier track. Free track rewards every 3 tiers,
// premium (paid) track rewards every tier. XP: 10 per match played, +20 for a
// win, plus whatever a completed challenge grants.
const XP_PER_TIER = 500;
const SEASON_DAYS = 30;

function currentSeason() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function seasonExpiry() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + SEASON_DAYS);
  return d.toISOString();
}

const FREE_REWARDS = {
  3: { coins: 50 },
  6: { coins: 50 },
  9: { coins: 100 },
  12: { unlock: 'Silver card variant' },
  15: { coins: 150 },
  18: { coins: 100 },
  21: { unlock: 'Avatar frame - Basic' },
  24: { coins: 200 },
  27: { coins: 100 },
  30: { coins: 300, unlock: 'Season completion badge' },
};

const PREMIUM_REWARDS = {
  1: { coins: 100 },
  2: { unlock: 'Card animation - Silver News Bomb' },
  3: { coins: 150, unlock: 'Avatar frame - Animated' },
  5: { coins: 200 },
  7: { unlock: 'Card animation - Silver Force Close' },
  10: { unlock: 'Profile background - Season theme' },
  12: { coins: 300 },
  15: { unlock: 'Gold card variant unlock' },
  18: { unlock: 'Nameplate effect - Flame' },
  20: { coins: 400 },
  25: { unlock: 'Exclusive avatar - Season character' },
  30: { coins: 500, unlock: 'War Lord border + Season trophy badge' },
};

// challenge id -> { type: 'daily'|'weekly', label, coins, check(stats) }
// `stats` is a small per-match/per-period summary the caller assembles from
// match results (see index.js's battle-pass challenge check after each match).
const DAILY_CHALLENGES = [
  { id: 'win_2_quick', label: 'Win 2 Quick War matches', coins: 50 },
  { id: 'news_bomb_success', label: 'Use a News Bomb card successfully', coins: 25 },
  { id: 'trade_xauusd', label: 'Trade XAUUSD in any match', coins: 20 },
  { id: 'positive_all_day', label: 'Achieve positive P&L in all matches today', coins: 100 },
  { id: 'complete_3_matches', label: 'Complete 3 matches in any mode', coins: 30 },
];

const WEEKLY_CHALLENGES = [
  { id: 'win_5_week', label: 'Win 5 matches this week', coins: 200 },
  { id: 'top2_grand', label: 'Finish top 2 in a Grand War', coins: 300 },
  { id: 'async_5x', label: 'Complete Async Daily Challenge 5 times', coins: 150 },
  { id: 'every_card_type', label: 'Use every card type at least once', coins: 250 },
  { id: 'win_no_cards', label: 'Win a match without using any cards', coins: 200 },
];

const ALL_CARD_TYPES = [
  'news_bomb', 'force_close', 'margin_call', 'spread_widen', 'flash_crash', 'freeze_chart',
  'fake_signal', 'slippage', 'liquidity_drain', 'rate_shock', 'stop_hunt', 'blackout',
];

// Each checker consumes the aggregate stats bundle from
// db.getBattlePassChallengeStats(playerId, sinceIso) and returns true/false.
const CHALLENGE_CHECKS = {
  win_2_quick: (s) => s.matches.filter((m) => m.mode === 'quick' && m.finalRank === 1).length >= 2,
  news_bomb_success: (s) => s.cardPlays.some((c) => c.card_type === 'news_bomb'),
  trade_xauusd: (s) => s.trades.some((t) => t.symbol === 'XAUUSD'),
  positive_all_day: (s) => s.matches.length > 0 && s.matches.every((m) => m.finalPnl >= 0),
  complete_3_matches: (s) => s.matches.length >= 3,
  win_5_week: (s) => s.matches.filter((m) => m.finalRank === 1).length >= 5,
  top2_grand: (s) => s.matches.some((m) => m.mode === 'grand' && m.finalRank <= 2),
  async_5x: (s) => s.matches.filter((m) => m.mode === 'async').length >= 5,
  every_card_type: (s) => {
    const played = new Set(s.cardPlays.map((c) => c.card_type));
    return ALL_CARD_TYPES.every((t) => played.has(t));
  },
  win_no_cards: (s) => s.matches.some((m) => m.finalRank === 1 && m.cardsPlayed === 0),
};

function evaluateChallenges(stats, alreadyCompletedIds) {
  const completedSet = new Set(alreadyCompletedIds);
  const evaluate = (list) => list.map((c) => ({
    ...c,
    completed: completedSet.has(c.id),
    // newly earnable this call - completed by stats but not yet recorded
    earnable: !completedSet.has(c.id) && !!CHALLENGE_CHECKS[c.id]?.(stats),
  }));
  return { daily: evaluate(DAILY_CHALLENGES), weekly: evaluate(WEEKLY_CHALLENGES) };
}

function tierFromXp(xp) {
  return Math.min(30, Math.floor(xp / XP_PER_TIER));
}

function buildTrack(tierCurrent, isPremium) {
  const track = [];
  for (let tier = 1; tier <= 30; tier++) {
    const freeReward = FREE_REWARDS[tier] || null;
    const premiumReward = PREMIUM_REWARDS[tier] || null;
    track.push({
      tier,
      freeReward,
      premiumReward: isPremium ? premiumReward : null,
      premiumLocked: !isPremium && !!premiumReward,
      claimed: tier <= tierCurrent,
    });
  }
  return track;
}

module.exports = {
  XP_PER_TIER,
  currentSeason,
  seasonExpiry,
  tierFromXp,
  buildTrack,
  DAILY_CHALLENGES,
  WEEKLY_CHALLENGES,
  CHALLENGE_CHECKS,
  evaluateChallenges,
};
