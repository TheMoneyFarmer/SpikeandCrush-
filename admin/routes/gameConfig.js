'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const internal = require('../lib/internalGameServer');

async function getStoredOverrides(key) {
  if (!isConfigured) return null;
  const { data } = await supabase.from('game_config').select('value').eq('key', key).maybeSingle();
  return data?.value || null;
}

async function saveOverrides(key, value, admin) {
  await supabase.from('game_config').upsert({ key, value, updated_by: admin, updated_at: new Date().toISOString() });
}

function router() {
  const r = express.Router();

  // Live current values (post any already-applied overrides) straight from
  // the running game server, plus whichever config domains are only
  // persisted-but-not-yet-live-wired (see note per field below).
  r.get('/', async (req, res) => {
    try {
      const live = await internal.getConfig();
      const [instrumentOverrides, sabotageOverrides, ratingOverrides, dailyChallenges, asyncConfig] = await Promise.all([
        getStoredOverrides('instruments'),
        getStoredOverrides('sabotage_cards'),
        getStoredOverrides('war_rating'),
        isConfigured ? supabase.from('game_config').select('value').eq('key', 'daily_challenges').maybeSingle() : null,
        getStoredOverrides('async_daily'),
      ]);
      res.json({
        matchModes: live.matchModes,
        instruments: live.instruments,
        instrumentOverrides: instrumentOverrides || {},
        sabotageCards: live.sabotageCards,
        sabotageOverrides: sabotageOverrides || {},
        tiers: live.tiers,
        ratingOverrides: ratingOverrides || {},
        dailyChallenges: dailyChallenges?.data?.value || [],
        asyncConfig: asyncConfig || { autoSelect: true },
      });
    } catch (e) {
      res.status(502).json({ error: `Game server unreachable: ${e.message}` });
    }
  });

  // The only config domain wired all the way through to the live running
  // match engine (see gameEngine.js applyConfigOverrides) - takes effect on
  // the next match created in that mode, no restart needed.
  r.put('/match-settings', async (req, res) => {
    const { overrides } = req.body || {}; // { quick: { entryCoins: 15, durationSeconds: 600 }, ... }
    if (!overrides || typeof overrides !== 'object') return res.status(400).json({ error: 'overrides object is required' });
    try {
      await saveOverrides('match_settings', overrides, req.admin.username);
      const result = await internal.reloadConfig();
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'update_match_settings', targetType: 'game_config', details: overrides, ip: clientIp(req) });
      res.json({ success: true, live: true, matchModes: result.matchModes });
    } catch (e) {
      res.status(502).json({ error: `Saved, but game server did not accept the live reload: ${e.message}` });
    }
  });

  // These four persist for real (durable in game_config, versioned by
  // updated_by/updated_at, fully editable/readable from this API) but the
  // running instruments.js/sabotage.js/tierForRating logic doesn't read them
  // back yet - only match-settings has that live wiring so far. Flagged
  // honestly as `live: false` rather than claiming an effect that isn't real.
  r.put('/instruments', async (req, res) => {
    try {
      await saveOverrides('instruments', req.body?.overrides || {}, req.admin.username);
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'update_instrument_config', targetType: 'game_config', details: req.body, ip: clientIp(req) });
      res.json({ success: true, live: false, note: 'Saved to game_config. Not yet read by the running instrument-selection logic - needs a small instruments.js change to respect these overrides.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/sabotage-cards', async (req, res) => {
    try {
      await saveOverrides('sabotage_cards', req.body?.overrides || {}, req.admin.username);
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'update_sabotage_config', targetType: 'game_config', details: req.body, ip: clientIp(req) });
      res.json({ success: true, live: false, note: 'Saved to game_config. Card enable/disable and duration edits are not yet read by sabotage.js.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/war-rating', async (req, res) => {
    try {
      await saveOverrides('war_rating', req.body?.overrides || {}, req.admin.username);
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'update_war_rating_config', targetType: 'game_config', details: req.body, ip: clientIp(req) });
      res.json({ success: true, live: false, note: 'Saved to game_config. Rating-curve edits are not yet read by tierForRating/computeMatchResults.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/challenges', async (req, res) => {
    const { title, description, requirementType, requirementValue, rewardCoins, availableFrom, expiresAt } = req.body || {};
    if (!title || !requirementType) return res.status(400).json({ error: 'title and requirementType are required' });
    try {
      const { data: existing } = await supabase.from('game_config').select('value').eq('key', 'daily_challenges').maybeSingle();
      const list = existing?.value || [];
      const challenge = { id: `custom_${Date.now()}`, title, description, requirementType, requirementValue, rewardCoins: Number(rewardCoins || 0), availableFrom, expiresAt, enabled: true };
      list.push(challenge);
      await supabase.from('game_config').upsert({ key: 'daily_challenges', value: list, updated_by: req.admin.username, updated_at: new Date().toISOString() });
      res.json({ success: true, challenge, live: false, note: 'Saved to game_config - the async daily challenge picker in server/index.js does not read this list yet.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/async-daily', async (req, res) => {
    try {
      await saveOverrides('async_daily', req.body || {}, req.admin.username);
      res.json({ success: true, live: false, note: 'Saved to game_config. server/instruments.js selectDailyInstruments() still auto-selects deterministically from today\'s UTC date - manual override isn\'t wired in yet.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
