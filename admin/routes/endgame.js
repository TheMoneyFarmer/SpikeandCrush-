'use strict';

// Admin: Balance dashboard, card config (versioned, rollback) and Season Studio.
// Behind requireAdmin; every change is audit logged. Editors only for changes.

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const endgame = require('../../server/endgame');
const sabotage = require('../../server/sabotage');
const cosmetics = require('../../server/cosmetics');

const UUID_RE = /^[0-9a-f-]{36}$/i;
const REWARD_TYPES = ['cosmetic', 'title', 'coins'];

function router() {
  const r = express.Router();
  const who = (req) => req.admin.email || req.admin.username;
  const audit = (req, action, id, details) => logAdminAction({ adminUsername: req.admin.username, actionType: action, targetType: 'endgame', targetId: id, details, ip: clientIp(req) });
  const editor = (req, res, next) => (['super_admin', 'admin'].includes(req.admin.role) || !req.admin.role ? next() : res.status(403).json({ error: 'Read only for your role' }));

  r.use((req, res, next) => (isConfigured ? next() : res.status(503).json({ error: 'Supabase not configured' })));

  // ---- balance -------------------------------------------------------------------------
  r.get('/balance', async (req, res) => {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 28));
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    let q = supabase.from('card_balance_daily').select('*').gte('day', since);
    if (req.query.mode) q = q.eq('mode', String(req.query.mode));
    if (req.query.bracket) q = q.eq('bracket', String(req.query.bracket));
    const { data, error } = await q.limit(100000);
    if (error) return res.status(500).json({ error: /card_balance_daily/.test(error.message) ? 'Run the endgame migration first' : error.message });
    res.json({ days, ...endgame.balanceReport(data || [], { minSample: Number(req.query.minSample) || endgame.MIN_SAMPLE }) });
  });

  r.post('/balance/run', editor, async (req, res) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.day || '') ? req.body.day : undefined;
    const out = await endgame.runBalanceAggregation(supabase, day);
    await audit(req, 'balance_aggregate', null, out);
    res.json(out);
  });

  // ---- card config ---------------------------------------------------------------------
  r.get('/card-config', async (req, res) => {
    const { data } = await supabase.from('card_config_versions').select('id, created_at, created_by, note, params, active').order('id', { ascending: false }).limit(50);
    res.json({
      versions: data || [],
      cards: Object.entries(sabotage.CARDS).map(([id, c]) => ({ id, name: c.name, defaultDuration: endgame.DEFAULT_DURATIONS[id], bounds: endgame.durationBounds(id) })),
    });
  });

  r.post('/card-config', editor, async (req, res) => {
    try {
      const id = await endgame.saveCardConfig(supabase, req.body?.params || {}, { by: who(req), note: req.body?.note });
      await audit(req, 'card_config_save', String(id), { params: req.body?.params, note: req.body?.note });
      res.json({ id, note: 'Applies on the game server within a minute, no deploy needed.' });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  r.post('/card-config/:id/activate', editor, async (req, res) => {
    try {
      const id = await endgame.activateCardConfig(supabase, Number(req.params.id));
      await audit(req, 'card_config_rollback', String(id), {});
      res.json({ id });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ---- Season Studio -------------------------------------------------------------------
  function seasonFields(b, { partial }) {
    const f = {};
    if (!partial || b.name !== undefined) {
      const n = String(b.name || '').trim().slice(0, 80);
      if (!n) return { error: 'Name the season' };
      f.name = n;
    }
    if (b.theme !== undefined) f.theme = String(b.theme || '').slice(0, 200) || null;
    if (!partial || b.startsAt !== undefined) {
      const s = Date.parse(b.startsAt);
      if (!Number.isFinite(s)) return { error: 'Choose a start date' };
      f.starts_at = new Date(s).toISOString();
      const e = b.endsAt ? Date.parse(b.endsAt) : s + endgame.DEFAULT_SEASON_WEEKS * 7 * 86400000;
      if (!Number.isFinite(e) || e <= s) return { error: 'The end must be after the start' };
      f.ends_at = new Date(e).toISOString();
    }
    if (b.featuredCards !== undefined) {
      const list = (Array.isArray(b.featuredCards) ? b.featuredCards : String(b.featuredCards).split(',')).map((x) => String(x).trim()).filter(Boolean);
      if (list.length > 6) return { error: 'At most 6 featured cards' };
      if (list.some((id) => !sabotage.CARDS[id])) return { error: 'Featured cards must be existing card ids' };
      f.featured_cards = list;
    }
    if (b.softResetPct !== undefined) {
      const p = Number(b.softResetPct);
      if (!Number.isInteger(p) || p < 0 || p > 100) return { error: 'Soft reset must be 0 to 100 percent' };
      f.soft_reset_pct = p;
    }
    for (const [k, col] of [['track', 'track'], ['peakRewards', 'peak_rewards']]) {
      if (b[k] === undefined) continue;
      if (!Array.isArray(b[k]) || b[k].length > 60) return { error: `${k} must be a list` };
      for (const row of b[k]) {
        const rw = row && row.reward;
        if (!rw || !REWARD_TYPES.includes(rw.type)) return { error: 'Rewards are cosmetic, title or coins' };
        if (rw.type === 'coins' && !(Number(rw.amount) > 0 && Number(rw.amount) <= 25)) return { error: 'Coin rewards are 1 to 25 coins (the existing caps)' };
        if (rw.type !== 'coins' && !cosmetics.findItem(rw.id)) return { error: `Unknown cosmetic ${rw.id}` };
        if (k === 'track' && !(Number.isInteger(row.level) && row.level >= 1 && row.level <= endgame.SEASON_LEVELS)) return { error: 'Track levels are 1 to 50' };
        if (k === 'peakRewards' && !endgame.BRACKETS.includes(row.tier)) return { error: 'Peak rewards need a rank tier' };
      }
      f[col] = b[k];
    }
    return { f };
  }

  r.get('/seasons', async (req, res) => {
    const { data, error } = await supabase.from('seasons').select('*').order('starts_at', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: /seasons/.test(error.message) ? 'Run the endgame migration first' : error.message });
    res.json({ seasons: (data || []).map((s) => ({ ...s, liveState: endgame.stateAt(s) })), cards: Object.entries(sabotage.CARDS).map(([id, c]) => ({ id, name: c.name })), tiers: endgame.BRACKETS, defaultWeeks: endgame.DEFAULT_SEASON_WEEKS });
  });

  r.post('/seasons', editor, async (req, res) => {
    const { f, error } = seasonFields(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    const { data, error: e2 } = await supabase.from('seasons').insert({ ...f, created_by: who(req) }).select('*').single();
    if (e2) return res.status(500).json({ error: e2.message });
    await audit(req, 'season_create', data.id, { name: data.name, starts_at: data.starts_at, ends_at: data.ends_at });
    res.json({ season: data });
  });

  r.put('/seasons/:id', editor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Season not found' });
    const { data: cur } = await supabase.from('seasons').select('*').eq('id', req.params.id).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'Season not found' });
    if (cur.state === 'archived') return res.status(400).json({ error: 'An archived season cannot be edited' });
    const { f, error } = seasonFields(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    const { data, error: e2 } = await supabase.from('seasons').update(f).eq('id', cur.id).select('*').single();
    if (e2) return res.status(500).json({ error: e2.message });
    await audit(req, 'season_update', cur.id, { fields: Object.keys(f) });
    res.json({ season: data });
  });

  // Ends a season now (normally the hourly job does it when ends_at passes).
  r.post('/seasons/:id/end', editor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Season not found' });
    const { data: s } = await supabase.from('seasons').select('*').eq('id', req.params.id).maybeSingle();
    if (!s) return res.status(404).json({ error: 'Season not found' });
    const out = await endgame.endSeason(supabase, s, { grant: grantFromAdmin(), by: who(req) });
    await audit(req, 'season_end', s.id, out);
    res.json(out);
  });

  return r;
}

// Rewards granted by the admin-side jobs (same rules as the game server).
function grantFromAdmin() {
  const { applyCoins } = require('../lib/coins');
  return async (playerId, reward, key) => {
    if (!reward) return;
    if (reward.type === 'cosmetic' || reward.type === 'title') {
      await supabase.from('earned_cosmetics').upsert({ player_id: playerId, item_id: reward.id, source: 'season' }, { onConflict: 'player_id,item_id', ignoreDuplicates: true });
    } else if (reward.type === 'coins') {
      const amount = Math.max(0, Math.min(25, Math.floor(Number(reward.amount) || 0)));
      if (amount) await applyCoins(playerId, amount, 'season_reward', key).catch(() => {});
    }
  };
}

// Jobs: nightly balance numbers (yesterday, once) and season end when due.
async function runEndgameJobs() {
  const out = {};
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const { count } = await supabase.from('card_balance_daily').select('day', { count: 'exact', head: true }).eq('day', yesterday);
  if (!count) out.balance = await endgame.runBalanceAggregation(supabase, yesterday);
  const { data: seasons } = await supabase.from('seasons').select('*').neq('state', 'archived').limit(50);
  for (const s of seasons || []) {
    const st = endgame.stateAt(s);
    if (st === 'active' && s.state !== 'active') await supabase.from('seasons').update({ state: 'active' }).eq('id', s.id);
    if (st === 'ending') out[`end:${s.id}`] = await endgame.endSeason(supabase, s, { grant: grantFromAdmin() });
  }
  return out;
}

module.exports = router;
module.exports.runEndgameJobs = runEndgameJobs;
module.exports.grantFromAdmin = grantFromAdmin;
