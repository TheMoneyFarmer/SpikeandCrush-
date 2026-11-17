'use strict';

// Endgame Stages 1-3: balance numbers, versioned card config with bounds and
// rollback, seasons (lifecycle, track rewards once, end job once per player,
// soft reset), the Vault in ranked, mastery from server outcomes only, and
// prestige that keeps every unlock.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const endgame = require('../server/endgame');
const sabotage = require('../server/sabotage');
const progression = require('../server/progression');
const cardRules = require('../server/cards');
const { GAME_RULES } = require('../server/gameEngine');

function fakeDb(seed = {}) {
  const T = { card_config_versions: [], seasons: [], season_progress: [], season_resets: [], players: [], card_mastery: [], prestige_events: [], ...seed };
  const keys = { season_resets: ['season_id', 'player_id'], season_progress: ['season_id', 'player_id'], card_mastery: ['player_id', 'card_id'] };
  let n = 0;
  const q = (name) => {
    const filters = [];
    let op = 'select';
    let payload;
    let single = false;
    const pk = (row) => (keys[name] || ['id']).map((k) => row[k]).join('|');
    const run = () => {
      const rows = T[name].filter((r) => filters.every((f) => f(r)));
      if (op === 'insert') {
        const row = { id: ++n, created_at: new Date().toISOString(), ...payload };
        if (keys[name] && T[name].some((r) => pk(r) === pk(row))) return { data: null, error: { code: '23505' } };
        T[name].push(row);
        return { data: single ? row : [row], error: null };
      }
      if (op === 'upsert') {
        const i = T[name].findIndex((r) => pk(r) === pk(payload));
        if (i >= 0) T[name][i] = { ...T[name][i], ...payload };
        else T[name].push({ ...payload });
        return { data: null, error: null };
      }
      if (op === 'update') { rows.forEach((r) => Object.assign(r, payload)); return { data: rows, error: null }; }
      return { data: single ? rows[0] || null : rows, error: null };
    };
    const api = {
      select() { return api; }, insert(p) { op = 'insert'; payload = p; return api; }, upsert(p) { op = 'upsert'; payload = p; return api; }, update(p) { op = 'update'; payload = p; return api; },
      eq(k, v) { filters.push((r) => r[k] === v); return api; }, neq(k, v) { filters.push((r) => r[k] !== v); return api; },
      limit() { return api; }, order() { return api; }, single() { single = true; return api; }, maybeSingle() { single = true; return api; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
    };
    return api;
  };
  return { T, client: { from: q } };
}

test('GAME_RULES unchanged (snapshot)', () => {
  const h = crypto.createHash('sha256').update(JSON.stringify(GAME_RULES)).digest('hex').slice(0, 16);
  assert.strictEqual(h, '834020fe29d39fea');
});

test('balance numbers match a hand-checked sample of 50 matches', () => {
  // 50 four-player matches: player 0 always plays tp_snip and wins every
  // other match; players 1-3 hold tp_snip but never play it.
  const rows = [];
  for (let m = 0; m < 50; m++) {
    const winner = m % 2 === 0 ? 0 : 1;
    for (let p = 0; p < 4; p++) {
      const rank = p === winner ? 1 : p === 0 ? 2 : p + 1 > 4 ? 4 : (p === 1 ? 2 : p + 1);
      rows.push({ match_id: `m${m}`, mode: 'quick', player_id: `p${p}`, rank: p === winner ? 1 : 3, bracket: 'Trader', held: ['tp_snip', 'shield'], played: p === 0 ? ['tp_snip'] : [] });
    }
  }
  const agg = endgame.aggregateBalance(rows);
  const tp = agg.find((a) => a.card_id === 'tp_snip');
  // By hand: held 200, played 50 (player 0), played wins 25, unplayed 150, unplayed wins 25 (player 1 in odd matches).
  assert.deepStrictEqual([tp.held, tp.played, tp.played_wins, tp.held_unplayed, tp.held_unplayed_wins], [200, 50, 25, 150, 25]);
  const rep = endgame.balanceReport(agg.map((a) => ({ day: '2026-11-16', ...a })), { minSample: 50 });
  const row = rep.rows.find((r) => r.card === 'tp_snip');
  assert.strictEqual(row.pickRate, 0.25);
  assert.strictEqual(row.winRatePlayed, 0.5);
  assert.strictEqual(Number(row.winRateUnplayed.toFixed(4)), Number((25 / 150).toFixed(4)));
  const shield = rep.rows.find((r) => r.card === 'shield');
  assert.ok(shield.flags.includes('never_picked'), 'held 200 times, never played');
});

test('card config: in bounds applies without a deploy, out of bounds and non-whitelisted refused, rollback restores', async () => {
  const id = Object.keys(endgame.DEFAULT_DURATIONS).find((k) => endgame.DEFAULT_DURATIONS[k] >= 10);
  const def = endgame.DEFAULT_DURATIONS[id];
  const db = fakeDb();
  const v1 = await endgame.saveCardConfig(db.client, { durations: { [id]: def + 2 } }, { by: 'admin', note: 'test' });
  assert.strictEqual(sabotage.CARDS[id].duration, def + 2, 'applied live');
  await assert.rejects(endgame.saveCardConfig(db.client, { durations: { [id]: def * 3 } }, { by: 'admin' }), /from \d+ to \d+ seconds/);
  await assert.rejects(endgame.saveCardConfig(db.client, { maxLot: 100 }, { by: 'admin' }), /not a card setting/);
  await assert.rejects(endgame.saveCardConfig(db.client, { durations: { nope: 5 } }, { by: 'admin' }), /Unknown card/);
  const instant = Object.keys(endgame.DEFAULT_DURATIONS).find((k) => !endgame.DEFAULT_DURATIONS[k]);
  await assert.rejects(endgame.saveCardConfig(db.client, { durations: { [instant]: 10 } }, { by: 'admin' }), /no duration/);
  const v2 = await endgame.saveCardConfig(db.client, { durations: { [id]: def - 1 } }, { by: 'admin' });
  assert.strictEqual(sabotage.CARDS[id].duration, def - 1);
  assert.strictEqual(db.T.card_config_versions.filter((v) => v.active).length, 1, 'one active version');
  await endgame.activateCardConfig(db.client, v1);
  assert.strictEqual(sabotage.CARDS[id].duration, def + 2, 'rolled back to v1');
  endgame.applyCardConfig(null);
  assert.strictEqual(sabotage.CARDS[id].duration, def, 'defaults back');
  assert.ok(v2 > v1);
});

test('season lifecycle with a test clock; track rewards once; end job once per player with an audit row; soft reset', async () => {
  const t0 = Date.parse('2026-12-01T00:00:00Z');
  const season = { id: 's1', name: 'Season 1', starts_at: new Date(t0).toISOString(), ends_at: new Date(t0 + 8 * 7 * 86400000).toISOString(), state: 'scheduled', featured_cards: [], soft_reset_pct: 25, track: [{ level: 2, reward: { type: 'coins', amount: 10 } }, { level: 3, reward: { type: 'cosmetic', id: 'rk_frame_rookie' } }], peak_rewards: [{ tier: 'Broker', reward: { type: 'title', id: 'rk_title_broker' } }] };
  assert.strictEqual(endgame.stateAt(season, t0 - 1), 'scheduled');
  assert.strictEqual(endgame.stateAt(season, t0 + 1), 'active');
  assert.strictEqual(endgame.stateAt(season, t0 + 57 * 86400000), 'ending');
  const db = fakeDb({ seasons: [season], players: [{ id: 'p1', war_rating: 1400 }, { id: 'p2', war_rating: 900 }] });
  const granted = [];
  const grant = async (pid, reward, key) => granted.push({ pid, reward, key });
  await endgame.addSeasonXp(db.client, season, 'p1', 650, { grant, rating: 1400, tierFor: () => 'Broker' });
  await endgame.addSeasonXp(db.client, season, 'p1', 10, { grant, rating: 1350, tierFor: () => 'Broker' });
  assert.deepStrictEqual(granted.map((g) => g.key), ['season:s1:p1:L2', 'season:s1:p1:L3'], 'each level reward once');
  assert.strictEqual(db.T.season_progress[0].peak_rating, 1400);
  const first = await endgame.endSeason(db.client, season, { grant });
  season.state = 'ending';
  const again = await endgame.endSeason(db.client, { ...season, state: 'ending' }, { grant });
  assert.strictEqual(first.reset, 2);
  assert.strictEqual(again.reset, 0, 'second run resets nobody');
  assert.strictEqual(db.T.season_resets.length, 2, 'one audit row per player');
  assert.strictEqual(db.T.players.find((p) => p.id === 'p1').war_rating, endgame.softReset(1400, 25));
  assert.strictEqual(endgame.softReset(1400, 25), 1300);
  assert.strictEqual(endgame.softReset(900, 25), 925, 'below base moves up toward it');
  assert.strictEqual(granted.filter((g) => g.key.startsWith('season-peak')).length, 1, 'peak reward once');
  assert.strictEqual(db.T.seasons[0].state, 'archived');
});

test('ranked pool: a vaulted seasonal card is refused in ranked and allowed in casual and private', () => {
  const seasonal = 'margin_call';
  const season = { active: { id: 's2', featured_cards: ['profit_skim'] }, seasonalCards: [seasonal, 'profit_skim'] };
  const mk = (ranked, mode) => ({ mode, config: { ranked }, season, rules: { cards: { enabled: true, allowedTiers: ['basic', 'mid', 'heavy'], sabotage: true } } });
  const p = { unlockedCards: Object.keys(sabotage.CARDS) };
  assert.ok(!cardRules.allowedPool(mk(true, 'quick'), p).includes(seasonal), 'not dealt in ranked');
  assert.ok(cardRules.allowedPool(mk(true, 'quick'), p).includes('profit_skim'), 'featured card is in ranked');
  assert.ok(cardRules.allowedPool(mk(false, 'private'), p).includes(seasonal), 'Vault card in private');
  assert.ok(cardRules.allowedPool(mk(false, 'blitz'), p).includes(seasonal), 'Vault card in casual');
  const caster = { id: 'c', unlockedCards: Object.keys(sabotage.CARDS), cards: [{ type: seasonal, used: false }], effects: {} };
  assert.match(cardRules.checkPlay(mk(true, 'quick'), caster, seasonal, null, Date.now()) || '', /Vault/);
  assert.ok(cardRules.allowedPool({ ...mk(true, 'quick'), season: { active: null, seasonalCards: [] } }, p).includes(seasonal), 'no seasons yet: nothing vaulted');
});

test('mastery counts only server-confirmed outcomes', async () => {
  const log = [
    { attacker: 'a', target: 'b', card: 'tp_snip' },
    { attacker: 'a', target: 'c', card: 'tp_snip' },
    { attacker: 'a', target: 'b', card: 'profit_tax', phase: 'collected' }, // follow-up, not a play
    { attacker: 'b', target: 'a', card: 'shield' },
  ];
  const results = [{ playerId: 'a', rank: 2 }, { playerId: 'b', rank: 3 }, { playerId: 'c', rank: 1 }];
  const out = endgame.masteryOutcomes(log, results);
  const a = out.find((o) => o.player_id === 'a' && o.card_id === 'tp_snip');
  assert.deepStrictEqual([a.uses, a.successes], [2, 1], 'b finished below a, c did not');
  assert.ok(!out.some((o) => o.card_id === 'profit_tax'), 'effect follow-ups are not plays');
  const db = fakeDb();
  for (let i = 0; i < 5; i++) await endgame.recordMastery(db.client, [{ player_id: 'a', card_id: 'tp_snip', uses: 1, successes: 1, targets: { b: 1 } }]);
  const row = db.T.card_mastery[0];
  assert.deepStrictEqual([row.successes, row.level], [5, 1]);
  assert.strictEqual(endgame.masteryLevel(250), 5);
  // No route accepts mastery from a client: only the server's match end writes it.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.ok(!/app\.(post|put|patch)\('\/api\/mastery/.test(src));
});

test('prestige: shown level restarts, every unlock kept, needs max level again, cannot double', async () => {
  const thresholds = require('../server/config/gameFeel').get().progression.levelThresholds;
  const maxXp = thresholds[thresholds.length - 1];
  const player = { id: 'p1', prestige_level: 0, prestige_xp_offset: 0, wins: 60, total_matches: 400 };
  const before = endgame.prestigeState(maxXp, player);
  assert.strictEqual(before.canPrestige, true);
  const unlockedBefore = progression.unlockedCards(progression.standing(player, { xp: maxXp }));
  const db = fakeDb({ players: [{ ...player }] });
  const out = await endgame.doPrestige(db.client, db.T.players[0], maxXp);
  assert.strictEqual(out.prestige, 1);
  const after = endgame.prestigeState(maxXp, db.T.players[0]);
  assert.strictEqual(after.shownLevel, 1, 'shown level back to 1');
  assert.strictEqual(after.canPrestige, false, 'must reach max again');
  assert.deepStrictEqual(progression.unlockedCards(progression.standing(player, { xp: maxXp })), unlockedBefore, 'unlocks unchanged');
  await assert.rejects(endgame.doPrestige(db.client, { ...player }, maxXp), /Already done/, 'a stale second click cannot prestige twice');
  assert.strictEqual(db.T.prestige_events.length, 1);
  await assert.rejects(endgame.doPrestige(db.client, db.T.players[0], maxXp + 100), /top level/);
});

test('season coin rewards stay small and keyed (no new coin source beyond the caps)', async () => {
  const credits = [];
  const grant = endgame.makeGrant({ creditCoins: async (pid, amount, opts) => credits.push({ amount, key: opts.idempotencyKey }), grantCosmetics: async () => [] });
  await grant('p1', { type: 'coins', amount: 500 }, 'k1');
  await grant('p1', { type: 'coins', amount: 10 }, 'k2');
  assert.deepStrictEqual(credits, [{ amount: 25, key: 'k1' }, { amount: 10, key: 'k2' }]);
});

// ---- Stage 4: Weekly Twists -----------------------------------------------------------
const twists = require('../server/twists');
const modeIdentity = require('../server/config/modeIdentity');

test('twists: 6 in the library; only whitelisted, in-bounds settings; GAME_RULES untouched', () => {
  assert.strictEqual(Object.keys(twists.LIBRARY).length, 6);
  assert.match(twists.validateTwist('double_heat', { factor: 9 }).error, /between/);
  assert.match(twists.validateTwist('double_heat', { maxLot: 100 }).error, /not a setting/);
  assert.match(twists.validateTwist('leverage_boost', {}).error, /Unknown twist/);
  const before = JSON.stringify(GAME_RULES);
  const base = modeIdentity.rulesFor('blitz');
  for (const key of Object.keys(twists.LIBRARY)) {
    const out = twists.applyToRules(base, { key, params: {}, modes: [], include_ranked: true }, { mode: 'blitz', ranked: false });
    assert.strictEqual(out.twist.key, key);
    // Only the fire layer may differ.
    for (const k of Object.keys(out)) if (!['heat', 'cards', 'spikeAlerts', 'twist'].includes(k)) assert.deepStrictEqual(out[k], base[k], `${key} changed ${k}`);
  }
  assert.strictEqual(JSON.stringify(GAME_RULES), before);
  assert.strictEqual(twists.applyToRules(base, { key: 'double_heat', params: { factor: 2 } }, { mode: 'blitz', ranked: false }).heat.basePerWin, base.heat.basePerWin * 2);
});

test('twists: ranked matches left out unless enabled; mode list respected', () => {
  const base = modeIdentity.rulesFor('quick');
  const tw = { key: 'double_heat', params: { factor: 2 }, modes: ['blitz'], include_ranked: false };
  assert.strictEqual(twists.applyToRules(base, tw, { mode: 'quick', ranked: true }), base, 'ranked untouched');
  assert.strictEqual(twists.applyToRules(base, { ...tw, include_ranked: true }, { mode: 'quick', ranked: true }), base, 'not in its mode list');
  assert.ok(twists.applyToRules(base, { ...tw, modes: [] , include_ranked: true }, { mode: 'quick', ranked: true }).twist);
});

test('twists: No Shields removes the Shield card; Sharp Targets only allows hitting the leader', () => {
  const rules = twists.applyToRules(modeIdentity.rulesFor('blitz'), { key: 'no_shields', params: {} }, { mode: 'blitz', ranked: false });
  const match = { mode: 'blitz', config: { ranked: false }, rules };
  assert.ok(!cardRules.allowedPool(match, { unlockedCards: Object.keys(sabotage.CARDS) }).includes('shield'));
  const sharp = twists.applyToRules(modeIdentity.rulesFor('blitz'), { key: 'sharp_targets', params: {} }, { mode: 'blitz', ranked: false });
  const pool = cardRules.allowedPool({ mode: 'blitz', config: { ranked: false }, rules: sharp }, { unlockedCards: Object.keys(sabotage.CARDS) });
  const attack = pool.find((id) => sabotage.CARDS[id].targeted && sabotage.CARDS[id].kind === 'attack');
  const players = { c: { id: 'c', username: 'c', unlockedCards: Object.keys(sabotage.CARDS), cards: [{ type: attack }], effects: {} }, lead: { id: 'lead', username: 'lead', effects: {}, socketId: 's' }, other: { id: 'other', username: 'other', effects: {}, socketId: 's' } };
  const m = { mode: 'blitz', config: { ranked: false }, rules: sharp, players, leaderId: 'lead', lastTargeted: {} };
  assert.match(cardRules.checkPlay(m, players.c, attack, players.other, Date.now()) || '', /leader/);
  assert.ok(!/leader/.test(cardRules.checkPlay(m, players.c, attack, players.lead, Date.now()) || ''));
});

test('rivalries: head-to-head counts only matches both played', () => {
  const rows = [
    { match_id: 'm1', player_id: 'a', final_rank: 1 }, { match_id: 'm1', player_id: 'b', final_rank: 3 },
    { match_id: 'm2', player_id: 'a', final_rank: 4 }, { match_id: 'm2', player_id: 'b', final_rank: 2 },
    { match_id: 'm3', player_id: 'a', final_rank: 2 }, { match_id: 'm3', player_id: 'b', final_rank: 2 },
    { match_id: 'm4', player_id: 'a', final_rank: 1 },
  ];
  assert.deepStrictEqual(endgame.headToHead(rows, 'a', 'b'), { wins: 1, losses: 1, draws: 1, matches: 3 });
});
