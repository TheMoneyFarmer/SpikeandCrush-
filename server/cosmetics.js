'use strict';

// Earned cosmetics (fire gameplay, Part 2E.5): rank cosmetics and monthly
// season rewards. They plug into the existing cosmetics system - the same
// equip slots (avatar_frame, background, nameplate) plus a new 'title' slot,
// the same equipped_cosmetics table and /api/shop/equip - but they are never
// for sale: shop.findItem() doesn't know them, so the purchase route refuses
// them. Cosmetics never touch P&L, equity, rank, prizes or ratings.

const TIER_ORDER = ['Recruit', 'Trader', 'Broker', 'Analyst', 'Veteran', 'Elite', 'War Lord'];

const RANK_ITEMS = [
  { id: 'rk_frame_rookie', type: 'avatar_frame', name: 'Rookie Frame', tier: 'Recruit' },
  { id: 'rk_title_trader', type: 'title', name: 'Trader', tier: 'Trader' },
  { id: 'rk_name_green', type: 'nameplate', name: 'Trader Green', tier: 'Trader' },
  { id: 'rk_title_broker', type: 'title', name: 'Broker', tier: 'Broker' },
  { id: 'rk_bg_night_desk', type: 'profile_background', name: 'Night Desk', tier: 'Broker' },
  { id: 'rk_title_analyst', type: 'title', name: 'Analyst', tier: 'Analyst' },
  { id: 'rk_frame_signal', type: 'avatar_frame', name: 'Signal Frame', tier: 'Analyst' },
  { id: 'rk_title_veteran', type: 'title', name: 'Veteran', tier: 'Veteran' },
  { id: 'rk_frame_veteran', type: 'avatar_frame', name: 'Veteran Frame', tier: 'Veteran' },
  { id: 'rk_title_elite', type: 'title', name: 'Elite', tier: 'Elite' },
  { id: 'rk_frame_elite_crown', type: 'avatar_frame', name: 'Elite Crown Frame', tier: 'Elite' },
  { id: 'rk_title_warlord', type: 'title', name: 'Warlord', tier: 'War Lord' },
  { id: 'rk_name_warlord_gold', type: 'nameplate', name: 'Warlord Gold', tier: 'War Lord' },
  { id: 'rk_bg_warlord', type: 'profile_background', name: 'Warlord Banner', tier: 'War Lord' },
];

// Season rewards by finishing place (season XP), per month.
const SEASON_REWARDS = [
  { kind: 'champion_title', type: 'title', label: (s) => `Season ${s} Champion`, maxPlace: 1 },
  { kind: 'champion_frame', type: 'avatar_frame', label: (s) => `Season ${s} Champion Frame`, maxPlace: 1 },
  { kind: 'top10_title', type: 'title', label: (s) => `Season ${s} Top 10`, maxPlace: 10 },
  { kind: 'top10_name', type: 'nameplate', label: (s) => `Season ${s} Top 10 Nameplate`, maxPlace: 10 },
  { kind: 'top100_frame', type: 'avatar_frame', label: (s) => `Season ${s} Top 100 Frame`, maxPlace: 100 },
];
const SEASON_TOP = 100;

// Season rank: the monthly ladder by season XP (resets each month; the
// lifetime level never resets).
const SEASON_RANKS = [
  { name: 'Bronze', min: 0 },
  { name: 'Silver', min: 500 },
  { name: 'Gold', min: 1500 },
  { name: 'Platinum', min: 3500 },
  { name: 'Diamond', min: 7000 },
];

const SLOT_BY_TYPE = { avatar_frame: 'avatar_frame', profile_background: 'background', nameplate: 'nameplate', title: 'title' };

function seasonItemId(season, kind) {
  return `ss_${season.replace('-', '_')}_${kind}`;
}

function findItem(itemId) {
  const rank = RANK_ITEMS.find((i) => i.id === itemId);
  if (rank) return { ...rank, earned: true, source: 'rank' };
  const m = /^ss_(\d{4})_(\d{2})_([a-z0-9_]+)$/.exec(String(itemId || ''));
  if (m) {
    const season = `${m[1]}-${m[2]}`;
    const r = SEASON_REWARDS.find((x) => x.kind === m[3]);
    if (r) return { id: itemId, type: r.type, name: r.label(season), earned: true, source: 'season', season };
  }
  return null;
}

function tierIndex(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? 0 : i;
}

// Rank items for every tier up to and including the player's current one.
function rankItemsFor(tier) {
  const top = tierIndex(tier);
  return RANK_ITEMS.filter((i) => tierIndex(i.tier) <= top).map((i) => ({ ...i, earned: true, source: 'rank' }));
}

// Everything this player may equip from earned cosmetics: rank items by tier
// plus stored grants (season rewards, rank items reached earlier).
function entitled(tier, storedIds = []) {
  const out = new Map(rankItemsFor(tier).map((i) => [i.id, i]));
  for (const id of storedIds) {
    const it = findItem(id);
    if (it) out.set(id, it);
  }
  return [...out.values()];
}

// Rewards for one finishing place in a season.
function seasonRewardsFor(season, place) {
  return SEASON_REWARDS.filter((r) => place <= r.maxPlace).map((r) => findItem(seasonItemId(season, r.kind)));
}

function seasonRank(seasonXp) {
  let r = SEASON_RANKS[0];
  for (const x of SEASON_RANKS) if (seasonXp >= x.min) r = x;
  const next = SEASON_RANKS[SEASON_RANKS.indexOf(r) + 1] || null;
  return { name: r.name, min: r.min, next: next ? { name: next.name, min: next.min } : null };
}

function previousSeason(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function seasonBounds(season) {
  const [y, m] = season.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 1)).toISOString() };
}

module.exports = { RANK_ITEMS, SEASON_REWARDS, SEASON_RANKS, SEASON_TOP, SLOT_BY_TYPE, findItem, rankItemsFor, entitled, seasonRewardsFor, seasonItemId, seasonRank, previousSeason, seasonBounds, TIER_ORDER };
