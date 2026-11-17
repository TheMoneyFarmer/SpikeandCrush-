'use strict';

// Endgame: what keeps a fully unlocked player playing. Nothing here is sold,
// nothing makes a card stronger, and nothing touches GAME_RULES, money maths,
// the ledger or how match results and rank points are computed.
//
// Stage 1  balance data (nightly per-card numbers) and versioned card config
// Stage 2  seasons: track, featured cards and the Vault, end job with peak
//          rewards and a soft rank reset (one audit row per player)
// Stage 3  card mastery (server-confirmed outcomes only) and prestige
//
// Every function takes a Supabase-like `client` so it can be tested without a
// database.

const sabotage = require('./sabotage');
const progression = require('./progression');

// ---------------------------------------------------------------------------
// Stage 1a: balance data
// ---------------------------------------------------------------------------

const BRACKETS = ['Recruit', 'Trader', 'Broker', 'Analyst', 'Veteran', 'Elite', 'War Lord'];
const MIN_SAMPLE = 50;

// rows: [{ match_id, mode, player_id, rank, bracket, held: [cardId], played: [cardId] }]
// -> per (card, mode, bracket): held, played, played_wins, held_unplayed, ...
function aggregateBalance(rows) {
  const out = {};
  for (const r of rows) {
    const playedSet = new Set(r.played || []);
    const heldSet = new Set([...(r.held || []), ...playedSet]);
    for (const card of heldSet) {
      const k = `${card}|${r.mode}|${r.bracket || 'unknown'}`;
      const a = (out[k] ||= { card_id: card, mode: r.mode, bracket: r.bracket || 'unknown', held: 0, played: 0, played_wins: 0, held_unplayed: 0, held_unplayed_wins: 0, rank_sum_played: 0, rank_sum_unplayed: 0 });
      a.held++;
      if (playedSet.has(card)) {
        a.played++;
        if (r.rank === 1) a.played_wins++;
        a.rank_sum_played += r.rank || 0;
      } else {
        a.held_unplayed++;
        if (r.rank === 1) a.held_unplayed_wins++;
        a.rank_sum_unplayed += r.rank || 0;
      }
    }
  }
  return Object.values(out);
}

// Summed daily rows -> the dashboard table with flags (minimum sample shown).
function balanceReport(dailyRows, { minSample = MIN_SAMPLE } = {}) {
  const by = {};
  for (const d of dailyRows) {
    const a = (by[d.card_id] ||= { card_id: d.card_id, held: 0, played: 0, played_wins: 0, held_unplayed: 0, held_unplayed_wins: 0, rank_sum_played: 0, rank_sum_unplayed: 0 });
    for (const k of ['held', 'played', 'played_wins', 'held_unplayed', 'held_unplayed_wins', 'rank_sum_played', 'rank_sum_unplayed']) a[k] += Number(d[k]) || 0;
  }
  const rows = Object.values(by).map((a) => ({
    card: a.card_id,
    name: (sabotage.CARDS[a.card_id] && sabotage.CARDS[a.card_id].name) || a.card_id,
    held: a.held,
    played: a.played,
    pickRate: a.held ? a.played / a.held : 0,
    winRatePlayed: a.played ? a.played_wins / a.played : null,
    winRateUnplayed: a.held_unplayed ? a.held_unplayed_wins / a.held_unplayed : null,
    // Positive = players who played it finished higher (smaller rank number).
    rankSwing: a.played && a.held_unplayed ? a.rank_sum_unplayed / a.held_unplayed - a.rank_sum_played / a.played : null,
  }));
  const withWin = rows.filter((r) => r.played >= minSample && r.winRatePlayed !== null);
  const avgWin = withWin.length ? withWin.reduce((s, r) => s + r.winRatePlayed, 0) / withWin.length : null;
  for (const r of rows) {
    r.flags = [];
    if (r.played >= minSample && avgWin !== null && r.winRatePlayed > avgWin + 0.1) r.flags.push('too_strong');
    if (r.held >= minSample && r.pickRate < 0.02) r.flags.push('never_picked');
    if (r.played < minSample) r.flags.push('small_sample');
  }
  return { rows: rows.sort((a, b) => b.pickRate - a.pickRate || (b.winRatePlayed || 0) - (a.winRatePlayed || 0)), averageWinRatePlayed: avgWin, minSample };
}

// Builds yesterday's (or `day`'s) rows from the match event log and writes them.
async function runBalanceAggregation(client, day = new Date(Date.now() - 86400000).toISOString().slice(0, 10)) {
  const from = `${day}T00:00:00Z`;
  const to = new Date(Date.parse(from) + 86400000).toISOString();
  const { data: matches } = await client.from('matches').select('id, mode').eq('status', 'finished').gte('end_time', from).lt('end_time', to).limit(20000);
  if (!matches || !matches.length) return { day, rows: 0 };
  const ids = matches.map((m) => m.id);
  const modeOf = Object.fromEntries(matches.map((m) => [m.id, m.mode]));
  const [{ data: mps }, { data: events }] = await Promise.all([
    client.from('match_players').select('match_id, player_id, final_rank, player:players(war_rating)').in('match_id', ids).limit(200000),
    client.from('match_events').select('match_id, player_id, kind, payload').in('match_id', ids).in('kind', ['card', 'cards_held']).limit(500000),
  ]);
  const played = {};
  const held = {};
  for (const e of events || []) {
    const k = `${e.match_id}|${e.player_id}`;
    if (e.kind === 'card' && e.payload && e.payload.card && !e.payload.phase) (played[k] ||= []).push(e.payload.card);
    if (e.kind === 'cards_held' && e.payload && Array.isArray(e.payload.cards)) held[k] = e.payload.cards;
  }
  const tierFor = require('./gameEngine').tierForRating;
  const rows = (mps || []).map((m) => ({ match_id: m.match_id, mode: modeOf[m.match_id], player_id: m.player_id, rank: m.final_rank, bracket: tierFor(Number(m.player && m.player.war_rating) || 1000), held: held[`${m.match_id}|${m.player_id}`] || [], played: played[`${m.match_id}|${m.player_id}`] || [] }));
  const agg = aggregateBalance(rows).map((a) => ({ day, ...a }));
  for (let i = 0; i < agg.length; i += 500) await client.from('card_balance_daily').upsert(agg.slice(i, i + 500));
  return { day, rows: agg.length, matches: matches.length };
}

// ---------------------------------------------------------------------------
// Stage 1b: versioned card config (durations; checked against bounds)
// ---------------------------------------------------------------------------

const DEFAULT_DURATIONS = Object.fromEntries(Object.entries(sabotage.CARDS).map(([id, c]) => [id, c.duration]));
// A card with a duration may be set between half and double its default
// (at least 1 s); a card without one (instant) cannot be given one.
function durationBounds(id) {
  const d = DEFAULT_DURATIONS[id];
  if (!d) return null;
  return { min: Math.max(1, Math.round(d / 2)), max: d * 2 };
}

function validateCardConfig(params) {
  const errors = [];
  const out = { durations: {} };
  const durations = (params && params.durations) || {};
  for (const [id, v] of Object.entries(durations)) {
    if (!(id in DEFAULT_DURATIONS)) { errors.push(`Unknown card ${id}`); continue; }
    const b = durationBounds(id);
    if (!b) { errors.push(`${id} has no duration to change`); continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < b.min || n > b.max) { errors.push(`${id}: duration must be a whole number from ${b.min} to ${b.max} seconds`); continue; }
    out.durations[id] = n;
  }
  for (const k of Object.keys(params || {})) if (k !== 'durations') errors.push(`${k} is not a card setting (only durations; Heat is in Fire Gameplay settings)`);
  return errors.length ? { errors } : { params: out };
}

// Applies (or resets with null) the active config to the live card table.
function applyCardConfig(params) {
  for (const [id, d] of Object.entries(DEFAULT_DURATIONS)) sabotage.CARDS[id].duration = d;
  const ok = params ? validateCardConfig(params) : { params: { durations: {} } };
  if (ok.errors) return { applied: false, errors: ok.errors };
  for (const [id, d] of Object.entries(ok.params.durations)) sabotage.CARDS[id].duration = d;
  return { applied: true, durations: ok.params.durations };
}

async function loadActiveCardConfig(client) {
  const { data } = await client.from('card_config_versions').select('id, params').eq('active', true).maybeSingle();
  applyCardConfig(data ? data.params : null);
  return data ? data.id : null;
}

// Save a new version and make it the active one (rollback = activate an old id).
async function saveCardConfig(client, params, { by, note }) {
  const v = validateCardConfig(params);
  if (v.errors) throw Object.assign(new Error(v.errors.join('; ')), { status: 400 });
  await client.from('card_config_versions').update({ active: false }).eq('active', true);
  const { data, error } = await client.from('card_config_versions').insert({ params: v.params, created_by: by, note: note || null, active: true }).select('id').single();
  if (error) throw error;
  applyCardConfig(v.params);
  return data.id;
}

async function activateCardConfig(client, id) {
  const { data: row } = await client.from('card_config_versions').select('id, params').eq('id', id).maybeSingle();
  if (!row) throw Object.assign(new Error('Version not found'), { status: 404 });
  await client.from('card_config_versions').update({ active: false }).eq('active', true);
  await client.from('card_config_versions').update({ active: true }).eq('id', id);
  applyCardConfig(row.params);
  return row.id;
}

// ---------------------------------------------------------------------------
// Stage 2: seasons
// ---------------------------------------------------------------------------

const SEASON_LEVELS = 50;
const SEASON_XP_PER_LEVEL = 300;
const DEFAULT_SEASON_WEEKS = 8;
const CORE_CARDS = new Set(Object.keys(sabotage.CARDS)); // every card today is core: never rotates

function seasonLevel(xp) {
  return Math.max(1, Math.min(SEASON_LEVELS, 1 + Math.floor((Number(xp) || 0) / SEASON_XP_PER_LEVEL)));
}

function stateAt(season, now = Date.now()) {
  if (season.state === 'archived') return 'archived';
  const s = Date.parse(season.starts_at);
  const e = Date.parse(season.ends_at);
  if (now < s) return 'scheduled';
  if (now < e) return 'active';
  return 'ending';
}

// Ranked pool: core cards plus this season's featured cards. A seasonal card
// that is not featured now is in the Vault: allowed in casual and private.
function rankedCardAllowed(cardId, { ranked, activeSeason, seasonalCards = [] }) {
  if (!ranked) return true;
  if (CORE_CARDS.has(cardId) && !seasonalCards.includes(cardId)) return true;
  return Boolean(activeSeason && (activeSeason.featured_cards || []).includes(cardId));
}

// Season XP from match XP (same server-computed amount, same caps), and track
// rewards for each level reached, once each.
async function addSeasonXp(client, season, playerId, gained, { grant, rating = null, tierFor = null } = {}) {
  if (!season || !gained) return null;
  const { data: cur } = await client.from('season_progress').select('*').eq('season_id', season.id).eq('player_id', playerId).maybeSingle();
  const xp = (cur ? cur.xp : 0) + gained;
  const level = seasonLevel(xp);
  const claimed = new Set((cur && cur.claimed_levels) || []);
  const newRewards = (season.track || []).filter((t) => t.level <= level && !claimed.has(t.level));
  for (const t of newRewards) {
    if (grant) await grant(playerId, t.reward, `season:${season.id}:${playerId}:L${t.level}`);
    claimed.add(t.level);
  }
  const row = { season_id: season.id, player_id: playerId, xp, level, claimed_levels: [...claimed].sort((a, b) => a - b), updated_at: new Date().toISOString() };
  // Peak rank this season (decides the end-of-season reward).
  const peak = Math.max(Number(cur && cur.peak_rating) || 0, Number(rating) || 0);
  if (peak) Object.assign(row, { peak_rating: peak, peak_tier: tierFor ? tierFor(peak) : (cur && cur.peak_tier) || null });
  await client.from('season_progress').upsert(cur ? { ...cur, ...row } : row);
  return { xp, level, rewards: newRewards.map((t) => t.reward) };
}

function softReset(rating, pct, base = 1000) {
  return Math.round(rating - ((rating - base) * pct) / 100);
}

// The end job: peak rewards and the soft reset, once per player (primary keys
// make a second run a no-op), then archive. The normal rank maths is untouched:
// this only moves the starting point of the next season.
async function endSeason(client, season, { grant, by = 'system' } = {}) {
  if (season.state === 'archived') return { skipped: 'archived' };
  await client.from('seasons').update({ state: 'ending' }).eq('id', season.id);
  const { data: progress } = await client.from('season_progress').select('*').eq('season_id', season.id).limit(100000);
  const { data: players } = await client.from('players').select('id, war_rating').limit(200000);
  let rewarded = 0;
  let reset = 0;
  const peakRewards = (season.peak_rewards || []).slice().sort((a, b) => BRACKETS.indexOf(b.tier) - BRACKETS.indexOf(a.tier));
  for (const p of progress || []) {
    if (p.peak_reward_given) continue;
    const reward = peakRewards.find((r) => BRACKETS.indexOf(p.peak_tier || 'Recruit') >= BRACKETS.indexOf(r.tier));
    if (reward && grant) await grant(p.player_id, reward.reward, `season-peak:${season.id}:${p.player_id}`);
    await client.from('season_progress').update({ peak_reward_given: true }).eq('season_id', season.id).eq('player_id', p.player_id);
    if (reward) rewarded++;
  }
  for (const pl of players || []) {
    const before = Number(pl.war_rating) || 1000;
    const after = softReset(before, season.soft_reset_pct ?? 25);
    // The audit row is the once-only guard: a second run inserts nothing.
    const { error } = await client.from('season_resets').insert({ season_id: season.id, player_id: pl.id, rating_before: before, rating_after: after });
    if (error) continue;
    if (after !== before) await client.from('players').update({ war_rating: after }).eq('id', pl.id);
    reset++;
  }
  await client.from('seasons').update({ state: 'archived', ended_at: new Date().toISOString() }).eq('id', season.id);
  return { rewarded, reset, by };
}

async function activeSeason(client, now = Date.now()) {
  const { data } = await client.from('seasons').select('*').neq('state', 'archived').limit(50);
  return (data || []).find((s) => stateAt(s, now) === 'active') || null;
}

// ---------------------------------------------------------------------------
// Stage 3: mastery and prestige
// ---------------------------------------------------------------------------

const MASTERY_THRESHOLDS = [5, 15, 40, 100, 250]; // successful uses for levels 1-5

function masteryLevel(successes) {
  let l = 0;
  for (const t of MASTERY_THRESHOLDS) if (successes >= t) l++;
  return l;
}

// From the server's own match results only: a play is a success when the
// target finished below the caster. results: [{ playerId, rank }];
// cardLog: [{ attacker, target, card, phase }] (the server's log).
function masteryOutcomes(cardLog, results) {
  const rank = Object.fromEntries(results.map((r) => [r.playerId, r.rank]));
  const out = {};
  for (const e of cardLog || []) {
    if (!e.attacker || !e.card || e.phase) continue;
    const k = `${e.attacker}|${e.card}`;
    const a = (out[k] ||= { player_id: e.attacker, card_id: e.card, uses: 0, successes: 0, targets: {} });
    a.uses++;
    if (e.target) {
      a.targets[e.target] = (a.targets[e.target] || 0) + 1;
      if (rank[e.target] && rank[e.attacker] && rank[e.target] > rank[e.attacker]) a.successes++;
    }
  }
  return Object.values(out);
}

async function recordMastery(client, outcomes) {
  const ups = [];
  for (const o of outcomes) {
    const { data: cur } = await client.from('card_mastery').select('*').eq('player_id', o.player_id).eq('card_id', o.card_id).maybeSingle();
    const successes = (cur ? cur.successes : 0) + o.successes;
    const targets = { ...(cur ? cur.targets : {}) };
    for (const [t, n] of Object.entries(o.targets)) targets[t] = (targets[t] || 0) + n;
    const row = { player_id: o.player_id, card_id: o.card_id, uses: (cur ? cur.uses : 0) + o.uses, successes, level: masteryLevel(successes), targets, updated_at: new Date().toISOString() };
    await client.from('card_mastery').upsert(row);
    if (!cur || masteryLevel(cur.successes) < row.level) ups.push({ player_id: o.player_id, card_id: o.card_id, level: row.level });
  }
  return ups;
}

// Prestige: only at max level; the shown level restarts at 1, every unlock and
// cosmetic stays (unlocks are computed from total XP, which is unchanged).
function prestigeState(xp, player = {}) {
  const offset = Number(player.prestige_xp_offset) || 0;
  const shown = progression.levelInfo(Math.max(0, xp - offset));
  return { prestige: Number(player.prestige_level) || 0, shownLevel: shown.level, canPrestige: shown.level >= shown.maxLevel, levelInfo: shown };
}

async function doPrestige(client, player, xp) {
  const st = prestigeState(xp, player);
  if (!st.canPrestige) throw Object.assign(new Error('Reach the top level to prestige'), { status: 400 });
  const next = st.prestige + 1;
  // Conditional update: two quick clicks cannot prestige twice.
  const { data, error } = await client.from('players').update({ prestige_level: next, prestige_xp_offset: xp }).eq('id', player.id).eq('prestige_level', st.prestige).select('id');
  if (error) throw error;
  if (!data || !data.length) throw Object.assign(new Error('Already done'), { status: 409 });
  await client.from('prestige_events').insert({ player_id: player.id, from_prestige: st.prestige, to_prestige: next, xp_at: xp });
  return { prestige: next };
}

// Game-server cache of the active season (refreshed every minute by index.js)
// so match creation and card checks never wait on the database.
const runtime = { active: null, seasonalCards: [], twist: null, at: 0 };
async function refreshRuntime(client) {
  try {
    const { data } = await client.from('seasons').select('id, name, starts_at, ends_at, state, featured_cards, track').neq('state', 'archived').limit(50);
    const rows = data || [];
    runtime.active = rows.find((x) => stateAt(x) === 'active') || null;
    // Every card ever featured by a season is a seasonal card (vaulted when not featured now).
    const { data: all } = await client.from('seasons').select('featured_cards').limit(500);
    runtime.seasonalCards = [...new Set((all || []).flatMap((x) => x.featured_cards || []))];
    const nowIso = new Date().toISOString();
    const { data: tw } = await client.from('twists').select('*').eq('enabled', true).lte('starts_at', nowIso).gt('ends_at', nowIso).limit(1);
    runtime.twist = (tw && tw[0]) || null;
    runtime.at = Date.now();
  } catch (e) { /* table missing: no seasons */ }
  return runtime;
}
const seasonSnapshot = () => ({ active: runtime.active ? { id: runtime.active.id, name: runtime.active.name, featured_cards: runtime.active.featured_cards || [] } : null, seasonalCards: runtime.seasonalCards.slice() });

// Grants one season reward. Cosmetics and titles use the existing earned
// cosmetics; coins are small (<= 25), idempotent per level, and go through the
// ledger like every other credit. Never a card power change.
function makeGrant(db) {
  return async (playerId, reward, key) => {
    if (!reward) return;
    if ((reward.type === 'cosmetic' || reward.type === 'title') && reward.id && db.grantCosmetics) {
      await db.grantCosmetics([{ player_id: playerId, item_id: reward.id, source: 'season' }]);
    } else if (reward.type === 'coins' && db.creditCoins) {
      const amount = Math.max(0, Math.min(25, Math.floor(Number(reward.amount) || 0)));
      if (amount) await db.creditCoins(playerId, amount, { type: 'season_reward', idempotencyKey: key });
    }
  };
}

// ---------------------------------------------------------------------------
// Stage 5: rivalries (head to head from finished matches; read only)
// ---------------------------------------------------------------------------

// rows: match_players rows for both players: [{ match_id, player_id, final_rank }]
function headToHead(rows, me, them) {
  const byMatch = {};
  for (const r of rows) (byMatch[r.match_id] ||= {})[r.player_id] = r.final_rank;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (const m of Object.values(byMatch)) {
    if (m[me] == null || m[them] == null) continue;
    if (m[me] < m[them]) wins++;
    else if (m[me] > m[them]) losses++;
    else draws++;
  }
  return { wins, losses, draws, matches: wins + losses + draws };
}

async function rivalry(client, me, them) {
  const { data: mine } = await client.from('match_players').select('match_id').eq('player_id', me).not('final_rank', 'is', null).order('match_id').limit(5000);
  const ids = (mine || []).map((r) => r.match_id);
  if (!ids.length) return { wins: 0, losses: 0, draws: 0, matches: 0 };
  const rows = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await client.from('match_players').select('match_id, player_id, final_rank').in('match_id', ids.slice(i, i + 500)).in('player_id', [me, them]);
    rows.push(...(data || []));
  }
  return headToHead(rows, me, them);
}

// My most frequent opponents (humans) with my record against each.
async function topRivals(client, me, limit = 5) {
  const { data: mine } = await client.from('match_players').select('match_id').eq('player_id', me).not('final_rank', 'is', null).limit(2000);
  const ids = (mine || []).map((r) => r.match_id);
  if (!ids.length) return [];
  const rows = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await client.from('match_players').select('match_id, player_id, final_rank, player:players(username, is_persona)').in('match_id', ids.slice(i, i + 500));
    rows.push(...(data || []));
  }
  const counts = {};
  const names = {};
  for (const r of rows) {
    if (r.player_id === me || (r.player && r.player.is_persona)) continue;
    counts[r.player_id] = (counts[r.player_id] || 0) + 1;
    names[r.player_id] = r.player && r.player.username;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => ({ id, username: names[id], ...headToHead(rows, me, id) }));
}

module.exports = {
  BRACKETS, MIN_SAMPLE, aggregateBalance, balanceReport, runBalanceAggregation,
  DEFAULT_DURATIONS, durationBounds, validateCardConfig, applyCardConfig, loadActiveCardConfig, saveCardConfig, activateCardConfig,
  SEASON_LEVELS, SEASON_XP_PER_LEVEL, DEFAULT_SEASON_WEEKS, seasonLevel, stateAt, rankedCardAllowed, addSeasonXp, softReset, endSeason, activeSeason,
  runtime, refreshRuntime, seasonSnapshot, makeGrant,
  headToHead, rivalry, topRivals,
  MASTERY_THRESHOLDS, masteryLevel, masteryOutcomes, recordMastery, prestigeState, doPrestige,
};
