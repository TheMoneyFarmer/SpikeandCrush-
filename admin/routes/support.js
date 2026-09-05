'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const internal = require('../lib/internalGameServer');

function router() {
  const r = express.Router();

  r.get('/tickets', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      let query = supabase
        .from('support_tickets')
        .select('*, player:players(username, email)')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (req.query.status) query = query.eq('status', req.query.status);
      const { data, error } = await query;
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/tickets/:id/respond', async (req, res) => {
    const { response, resolve } = req.body || {};
    if (!response) return res.status(400).json({ error: 'response is required' });
    try {
      const { data: ticket, error: findErr } = await supabase.from('support_tickets').select('player_id, subject').eq('id', req.params.id).maybeSingle();
      if (findErr) throw findErr;
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

      const patch = {
        admin_response: response,
        responded_by: req.admin.email || req.admin.username,
        status: resolve ? 'resolved' : 'in_progress',
      };
      if (resolve) patch.resolved_at = new Date().toISOString();

      const { data, error } = await supabase.from('support_tickets').update(patch).eq('id', req.params.id).select().single();
      if (error) throw error;

      if (ticket.player_id) {
        internal.notifyPlayer(ticket.player_id, 'support_response', `Support replied to your ticket "${ticket.subject}"`).catch(() => {});
      }
      await logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType: 'respond_support_ticket', targetType: 'support_ticket', targetId: req.params.id, details: { resolve: Boolean(resolve) }, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/tickets/:id/resolve', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('support_tickets')
        .update({ status: 'resolved', resolved_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) throw error;
      await logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType: 'resolve_support_ticket', targetType: 'support_ticket', targetId: req.params.id, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
