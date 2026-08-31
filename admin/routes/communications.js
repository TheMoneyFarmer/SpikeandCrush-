'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const internal = require('../lib/internalGameServer');

async function resolveSegment(segment, tier) {
  if (segment === 'all') {
    const { data } = await supabase.from('players').select('id');
    return (data || []).map((p) => p.id);
  }
  if (segment === 'online_now') {
    const freshSince = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const { data } = await supabase.from('player_presence').select('player_id').neq('status', 'offline').gte('updated_at', freshSince);
    return (data || []).map((p) => p.player_id);
  }
  if (segment === 'dormant_7d') {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: recentLogins } = await supabase.from('login_events').select('player_id').gte('created_at', since);
    const recentIds = new Set((recentLogins || []).map((l) => l.player_id));
    const { data: allPlayers } = await supabase.from('players').select('id');
    return (allPlayers || []).map((p) => p.id).filter((id) => !recentIds.has(id));
  }
  if (segment === 'tier' && tier) {
    const { data } = await supabase.from('players').select('id').eq('tier', tier);
    return (data || []).map((p) => p.id);
  }
  if (segment === 'battle_pass_holders') {
    const { data } = await supabase.from('battle_pass_subscriptions').select('player_id').eq('is_premium', true).gt('expires_at', new Date().toISOString());
    return [...new Set((data || []).map((p) => p.player_id))];
  }
  return [];
}

function router() {
  const r = express.Router();

  // ---- announcements -----------------------------------------------------------

  r.get('/announcements', async (req, res) => {
    try {
      const { data, error } = await supabase.from('announcements').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/announcements', async (req, res) => {
    const { title, message, type, displayLocation, showFrom, showUntil, broadcastNow } = req.body || {};
    if (!title || !message) return res.status(400).json({ error: 'title and message are required' });
    try {
      const { data, error } = await supabase.from('announcements').insert({
        title, message, type: type || 'info', display_location: displayLocation || 'both',
        show_from: showFrom ? new Date(showFrom).toISOString() : new Date().toISOString(),
        show_until: showUntil ? new Date(showUntil).toISOString() : null,
        created_by: req.admin.username,
      }).select().single();
      if (error) throw error;
      let delivered = 0;
      if (broadcastNow) {
        const result = await internal.broadcastAnnouncement({ id: data.id, title, message, type: type || 'info' }).catch(() => null);
        delivered = result?.deliveredTo || 0;
      }
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'create_announcement', targetType: 'announcement', targetId: data.id, details: { broadcastNow, delivered }, ip: clientIp(req) });
      res.json({ ...data, deliveredLiveTo: delivered });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.delete('/announcements/:id', async (req, res) => {
    try {
      await supabase.from('announcements').update({ active: false }).eq('id', req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- push / in-app notifications --------------------------------------------

  r.post('/notifications/send', async (req, res) => {
    const { title, body, segment, tier } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body is required' });
    if (String(body).length > 150) return res.status(400).json({ error: 'body must be 150 characters or fewer' });
    if (title && String(title).length > 50) return res.status(400).json({ error: 'title must be 50 characters or fewer' });
    try {
      const playerIds = await resolveSegment(segment, tier);
      if (!playerIds.length) return res.json({ success: true, recipientCount: 0, note: 'No players matched this segment' });
      const rows = playerIds.map((playerId) => ({ player_id: playerId, type: 'admin_broadcast', data: { message: title ? `${title}: ${body}` : body } }));
      // Batch insert - real delivery through the existing notification bell,
      // not a simulated push (this game has no APNs/FCM integration).
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) await supabase.from('notifications').insert(rows.slice(i, i + chunkSize));
      await supabase.from('admin_logs').insert({
        admin_username: req.admin.username, action_type: 'send_notification', details: { title, body, segment, tier, recipientCount: playerIds.length }, ip_address: clientIp(req),
      });
      res.json({ success: true, recipientCount: playerIds.length, deliveryMethod: 'in-app notification bell (no OS push integration exists in this build)' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/notifications/history', async (req, res) => {
    try {
      const { data, error } = await supabase.from('admin_logs').select('*').eq('action_type', 'send_notification').order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- direct in-game messages --------------------------------------------------

  r.post('/messages/direct', async (req, res) => {
    const { username, message } = req.body || {};
    if (!username || !message) return res.status(400).json({ error: 'username and message are required' });
    try {
      const { data: player } = await supabase.from('players').select('id').eq('username', username).maybeSingle();
      if (!player) return res.status(404).json({ error: `No player found with username "${username}"` });
      await supabase.from('notifications').insert({ player_id: player.id, type: 'admin_message', data: { message } });
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'direct_message', targetType: 'player', targetId: player.id, details: { message }, ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/messages/history', async (req, res) => {
    try {
      const { data, error } = await supabase.from('admin_logs').select('*').in('action_type', ['direct_message', 'message']).order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- email campaigns (no provider configured) --------------------------------

  r.get('/email/campaigns', async (req, res) => {
    try {
      const { data, error } = await supabase.from('game_config').select('value').eq('key', 'email_campaigns').maybeSingle();
      if (error) throw error;
      res.json(data?.value || []);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/email/campaigns', async (req, res) => {
    const { subject, fromName, templateId, target } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'subject is required' });
    try {
      const { data: existing } = await supabase.from('game_config').select('value').eq('key', 'email_campaigns').maybeSingle();
      const list = existing?.value || [];
      const campaign = { id: `camp_${Date.now()}`, subject, fromName, templateId, target, status: 'drafted', createdBy: req.admin.username, createdAt: new Date().toISOString() };
      list.unshift(campaign);
      await supabase.from('game_config').upsert({ key: 'email_campaigns', value: list.slice(0, 200), updated_by: req.admin.username, updated_at: new Date().toISOString() });
      res.status(201).json({ ...campaign, sent: false, note: 'Saved as a draft. No outbound email provider is configured in this project, so nothing was actually sent - see Branding > Email Templates for the same limitation.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
