'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');

// The live brand values as they actually exist in client/css/main.css today -
// shown as the starting point / "reset to current" baseline in the colour
// picker. Editing here does NOT write to that file (see PUT /colour-theme).
const CURRENT_THEME = {
  backgroundBase: '#080810', surfaceOne: '#0f1018',
  accentTeal: '#00c896', accentRed: '#ff4444', accentGold: '#ffd700',
};

function router() {
  const r = express.Router();

  r.get('/colour-theme', async (req, res) => {
    try {
      const { data } = isConfigured ? await supabase.from('game_config').select('value, updated_by, updated_at').eq('key', 'colour_theme').maybeSingle() : { data: null };
      res.json({ current: CURRENT_THEME, saved: data?.value || null, updatedBy: data?.updated_by, updatedAt: data?.updated_at });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Saves the proposed palette for reference/preview and history - does NOT
  // rewrite client/css/main.css. Applying a colour change to the live site is
  // a file edit, which this panel deliberately doesn't do unattended; use the
  // "Download theme.css" export and hand it to whoever's editing the game's
  // CSS, or ask an engineer session to apply it.
  r.put('/colour-theme', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      await supabase.from('game_config').upsert({ key: 'colour_theme', value: req.body, updated_by: req.admin.username, updated_at: new Date().toISOString() });
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'update_colour_theme', targetType: 'game_config', details: req.body, ip: clientIp(req) });
      res.json({ success: true, live: false, note: 'Saved for preview/export. Not written to client/css/main.css - use the CSS export to apply it by hand.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/ui-text', async (req, res) => {
    try {
      const { data } = isConfigured ? await supabase.from('game_config').select('value').eq('key', 'ui_text').maybeSingle() : { data: null };
      res.json(data?.value || {});
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/ui-text', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const { data: existing } = await supabase.from('game_config').select('value').eq('key', 'ui_text').maybeSingle();
      const history = existing?.value?.__history || [];
      if (existing?.value) history.push({ value: { ...existing.value, __history: undefined }, savedAt: new Date().toISOString(), savedBy: existing.updated_by });
      await supabase.from('game_config').upsert({
        key: 'ui_text', value: { ...req.body, __history: history.slice(-10) }, updated_by: req.admin.username, updated_at: new Date().toISOString(),
      });
      res.json({ success: true, live: false, note: 'Saved to game_config - the game client reads its UI strings from the HTML/JS files directly, not from this table yet.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/email-templates', async (req, res) => {
    try {
      const { data, error } = isConfigured ? await supabase.from('message_templates').select('*').order('name') : { data: [] };
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/email-templates/:id', async (req, res) => {
    const { id } = req.params;
    const { name, subject, bodyHtml } = req.body || {};
    if (!bodyHtml) return res.status(400).json({ error: 'bodyHtml is required' });
    try {
      await supabase.from('message_templates').upsert({ id, name: name || id, subject, body_html: bodyHtml, updated_by: req.admin.username, updated_at: new Date().toISOString() });
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'update_email_template', targetType: 'message_template', targetId: id, ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // No outbound email provider is configured in this project (no SendGrid/
  // Resend/SMTP dependency, no API key in .env - Supabase Auth only sends its
  // own built-in auth emails like password reset). Honest response instead of
  // a fake "sent!" toast.
  r.post('/email-templates/:id/test-send', (req, res) => {
    res.status(501).json({ error: 'No outbound email provider is configured for this project - template preview/storage works, but nothing can actually send yet. Add SENDGRID_API_KEY (or similar) and wire a sender to enable this.' });
  });

  return r;
}

module.exports = router;
