'use strict';
// Rank cosmetics and monthly season rewards (Part 2E.5).
process.env.SUPABASE_SERVICE_KEY = '';
const test = require('node:test');
const assert = require('node:assert');
const cosmetics = require('../server/cosmetics');
const shop = require('../server/shop');
const { runSeasonRewards } = require('../server/seasons');

test('rank items: every tier up to the current one, nothing above; never in the shop', () => {
  const trader = cosmetics.entitled('Trader').map((i) => i.id);
  assert.ok(trader.includes('rk_frame_rookie') && trader.includes('rk_title_trader'));
  assert.ok(!trader.includes('rk_title_warlord'));
  assert.strictEqual(cosmetics.entitled('War Lord').length, cosmetics.RANK_ITEMS.length);
  for (const it of cosmetics.RANK_ITEMS) assert.strictEqual(shop.findItem(it.id), null, `${it.id} is buyable`);
  assert.strictEqual(shop.findItem(cosmetics.seasonItemId('2026-11', 'champion_title')), null);
  // A stored season reward stays equippable whatever the tier.
  assert.ok(cosmetics.entitled('Recruit', ['ss_2026_10_top10_title']).some((i) => i.id === 'ss_2026_10_top10_title'));
  assert.strictEqual(cosmetics.findItem('ss_2026_10_not_a_reward'), null);
});

test('season rewards by place and the season rank ladder', () => {
  assert.strictEqual(cosmetics.seasonRewardsFor('2026-10', 1).length, 5);
  assert.strictEqual(cosmetics.seasonRewardsFor('2026-10', 7).length, 3);
  assert.strictEqual(cosmetics.seasonRewardsFor('2026-10', 55).length, 1);
  assert.strictEqual(cosmetics.seasonRewardsFor('2026-10', 101).length, 0);
  assert.strictEqual(cosmetics.seasonRank(0).name, 'Bronze');
  assert.strictEqual(cosmetics.seasonRank(1500).name, 'Gold');
  assert.strictEqual(cosmetics.previousSeason(new Date(Date.UTC(2026, 0, 3))), '2025-12');
  assert.deepStrictEqual(cosmetics.seasonBounds('2026-02'), { from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' });
});

test('season end pays the top finishers once, and nothing when the tables are missing', async () => {
  const store = [];
  const notes = [];
  const db = {
    isConfigured: true,
    seasonAlreadyRewarded: async (s) => store.some((r) => r.season === s),
    seasonTop: async () => Array.from({ length: 12 }, (_, i) => ({ player_id: `p${i + 1}`, xp: 1000 - i })),
    grantCosmetics: async (rows) => {
      const fresh = rows.filter((r) => !store.some((x) => x.player_id === r.player_id && x.item_id === r.item_id));
      store.push(...fresh);
      return fresh;
    },
  };
  const first = await runSeasonRewards(db, (...a) => notes.push(a), '2026-10');
  assert.deepStrictEqual([first.players, first.granted], [12, 5 + 9 * 3 + 2 * 1]);
  const again = await runSeasonRewards(db, () => {}, '2026-10');
  assert.ok(again.skipped);
  assert.strictEqual(store.length, 34);
  assert.strictEqual(notes.length, 12);
  const missing = await runSeasonRewards({ isConfigured: true, seasonAlreadyRewarded: async () => false, seasonTop: async () => null }, () => {}, '2026-10');
  assert.match(missing.skipped, /missing/);
});
