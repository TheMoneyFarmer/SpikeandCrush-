'use strict';

// Admin API for fire gameplay: market curation + Fire monitor, every tunable
// in server/config/gameFeel.js, card unlock grants/revokes and reports.
// Same pattern as routes/gameConfig.js: the value is stored in game_config
// (key 'game_feel'), the game server is told to reload it over the secret
// bridge, and every change is written to the admin audit log.

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp, requireSuperAdmin } = require('../lib/auth');
const internal = require('../lib/internalGameServer');

const SECTIONS = ['market', 'cards', 'progression', 'rankSplit', 'heat', 'missions', 'spikeAlerts', 'crown', 'ghostChallenge', 'discover'];

async function stored() {
  if (!isConfigured) return {};
  const { data } = await supabase.from('game_config').select('value').eq('key', 'game_feel').maybeSingle();
  return (data && data.value) || {};
}

function router() {
  const r = express.Router();

  r.get('/state', async (req, res) => {
    try {
      res.json(await internal.fire('/state'));
    } catch (e) {
      res.status(502).json({ error: `Game server unreachable: ${e.message}` });
    }
  });

  // Replace one section's overrides (partial object merged over the defaults
  // on the game server). Admin and super_admin; super_admin only for the
  // market and rank-split switches.
  r.put('/config/:section', async (req, res) => {
    const { section } = req.params;
    if (!SECTIONS.includes(section)) return res.status(400).json({ error: 'Unknown section' });
    if (!['admin', 'super_admin'].includes(req.admin.role)) return res.status(403).json({ error: 'Admins only' });
    if (['market', 'rankSplit'].includes(section) && req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Super admins only for this section' });
    const value = req.body && req.body.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return res.status(400).json({ error: 'value must be an object' });
    try {
      const all = await stored();
      const before = all[section] || null;
      all[section] = value;
      await supabase.from('game_config').upsert({ key: 'game_feel', value: all, updated_by: req.admin.username, updated_at: new Date().toISOString() });
      const live = await internal.fire('/reload', {});
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'update_game_feel', targetType: 'game_config', targetId: section, details: { section, before, after: value }, ip: clientIp(req) });
      res.json({ success: true, live: true, config: live.config });
    } catch (e) {
      res.status(502).json({ error: `Could not apply: ${e.message}` });
    }
  });

  // One game mode's identity overrides (server/config/modeIdentity.js),
  // stored in game_config key 'mode_identity' as { mode: partial }. New
  // matches pick them up; running matches keep the rules they started with.
  // GAME_RULES and MODE_DURATIONS are not editable here.
  const MODES = ['quick', 'blitz', 'grand', 'tournament', 'solo', 'async', 'private'];
  const BLOCKED = ['durationSeconds', 'entryCoins', 'leverage', 'maxPositions', 'stopOutLevel', 'marginCallLevel', 'prizeShare'];
  r.put('/modes/:mode', async (req, res) => {
    const { mode } = req.params;
    if (!MODES.includes(mode)) return res.status(400).json({ error: 'Unknown mode' });
    if (!['admin', 'super_admin'].includes(req.admin.role)) return res.status(403).json({ error: 'Admins only' });
    const value = req.body && req.body.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return res.status(400).json({ error: 'value must be an object' });
    const bad = BLOCKED.filter((k) => JSON.stringify(value).includes(`"${k}"`));
    if (bad.length) return res.status(400).json({ error: `Game rules are not edited here: ${bad.join(', ')}` });
    try {
      const { data } = await supabase.from('game_config').select('value').eq('key', 'mode_identity').maybeSingle();
      const all = (data && data.value) || {};
      const before = all[mode] || null;
      if (Object.keys(value).length) all[mode] = value;
      else delete all[mode];
      await supabase.from('game_config').upsert({ key: 'mode_identity', value: all, updated_by: req.admin.username, updated_at: new Date().toISOString() });
      await internal.fire('/reload', {});
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'update_mode_identity', targetType: 'game_config', targetId: mode, details: { mode, before, after: value }, ip: clientIp(req) });
      res.json({ success: true, live: true });
    } catch (e) {
      res.status(502).json({ error: `Could not apply: ${e.message}` });
    }
  });

  // Walkthrough (server/config/tours.js): switch, per-tour on/off, version
  // and step text. Stored in game_config key 'tours'; audit-logged.
  r.put('/tours', async (req, res) => {
    if (!['admin', 'super_admin'].includes(req.admin.role)) return res.status(403).json({ error: 'Admins only' });
    const value = req.body && req.body.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return res.status(400).json({ error: 'value must be an object' });
    try {
      const { data } = await supabase.from('game_config').select('value').eq('key', 'tours').maybeSingle();
      const before = (data && data.value) || null;
      await supabase.from('game_config').upsert({ key: 'tours', value, updated_by: req.admin.username, updated_at: new Date().toISOString() });
      await internal.fire('/reload', {});
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'update_walkthrough', targetType: 'game_config', targetId: 'tours', details: { before, after: value }, ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(502).json({ error: `Could not apply: ${e.message}` });
    }
  });

  // Completion and skip counts per tour from players.settings.tours, plus the
  // step people skip at. Counts are per account (latest outcome only).
  r.get('/tour-stats', async (req, res) => {
    if (!isConfigured) return res.json({ tours: {} });
    const ids = String(req.query.ids || '').split(',').filter((x) => /^[a-zA-Z_]{1,40}$/.test(x)).slice(0, 20);
    try {
      const out = {};
      for (const id of ids) {
        const count = async (outcome) => {
          const { count: n, error } = await supabase.from('players').select('id', { count: 'exact', head: true }).eq(`settings->tours->${id}->>outcome`, outcome);
          if (error) throw error;
          return n || 0;
        };
        const [completed, skipped] = await Promise.all([count('completed'), count('skipped')]);
        const { data: rows } = await supabase.from('players').select(`step:settings->tours->${id}->step`).eq(`settings->tours->${id}->>outcome`, 'skipped').limit(5000);
        const skipSteps = {};
        for (const r2 of rows || []) if (r2.step !== null && r2.step !== undefined) skipSteps[r2.step + 1] = (skipSteps[r2.step + 1] || 0) + 1;
        out[id] = { completed, skipped, completionRate: completed + skipped ? Math.round((completed / (completed + skipped)) * 1000) / 10 : null, skipSteps };
      }
      res.json({ tours: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Rebuild playlists (super_admin): runs the curation in the background on
  // the game server, validates, swaps only if the guarantee holds.
  r.post('/rebuild', requireSuperAdmin, async (req, res) => {
    try {
      const out = await internal.fire('/rebuild', {});
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'rebuild_playlists', targetType: 'market', details: out, ip: clientIp(req) });
      res.json(out);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
  r.get('/rebuild', async (req, res) => {
    try {
      res.json(await internal.fire('/rebuild'));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Grant or revoke one card for one player, with a reason (logged).
  r.post('/card-grant', requireSuperAdmin, async (req, res) => {
    try {
      const out = await internal.fire('/card-grant', req.body || {});
      await logAdminAction({ adminUsername: req.admin.username, actionType: req.body && req.body.revoke ? 'revoke_card_unlock' : 'grant_card_unlock', targetType: 'player', targetId: req.body && req.body.playerId, details: req.body, ip: clientIp(req) });
      res.json(out);
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  // Move one player's ranked lobby tier by hand (super_admin, reason
  // required, logged). tierId null clears it back to their rating tier.
  r.post('/tier-override', requireSuperAdmin, async (req, res) => {
    const { playerId, tierId, reason } = req.body || {};
    if (!playerId || !/^[0-9a-f-]{36}$/i.test(playerId)) return res.status(400).json({ error: 'playerId (uuid) is required' });
    if (!reason || String(reason).trim().length < 3) return res.status(400).json({ error: 'A reason is required' });
    try {
      const all = await stored();
      const rs = { ...(all.rankSplit || {}) };
      const overrides = { ...(rs.playerOverrides || {}) };
      const before = overrides[playerId] || null;
      if (tierId) overrides[playerId] = String(tierId);
      else delete overrides[playerId];
      rs.playerOverrides = overrides;
      all.rankSplit = rs;
      await supabase.from('game_config').upsert({ key: 'game_feel', value: all, updated_by: req.admin.username, updated_at: new Date().toISOString() });
      await internal.fire('/reload', {});
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'move_player_lobby_tier', targetType: 'player', targetId: playerId, details: { before, after: tierId || null, reason }, ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  r.get('/unlock-report', async (req, res) => {
    try {
      res.json(await internal.fire('/unlock-report'));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
