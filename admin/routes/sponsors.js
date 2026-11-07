'use strict';

// Sponsors: CRUD, logo upload (Supabase Storage bucket `sponsor-logos`),
// placements, per-day analytics + CSV, the sponsor-leads inbox and the
// lobby settings card. super_admin and admin can edit; moderator is
// read-only. Every write is logged to admin_logs and admin_activity_log.

const express = require('express');
const multer = require('multer');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, logAdminActivity, clientIp } = require('../lib/auth');
const { MAX_LOGO_BYTES, validateLogo, isHttpUrl } = require('../lib/logoValidation');

const TIERS = ['platinum', 'gold', 'silver', 'partner'];
const STATUSES = ['draft', 'active', 'paused', 'ended'];
const PLACEMENTS = ['global_strip', 'hero', 'competition', 'mode'];
const LEAD_STATUSES = ['new', 'contacted', 'closed'];
const MODES = ['quick', 'blitz', 'grand', 'solo', 'async', 'private', 'tournament'];
const LOGO_BUCKET = 'sponsor-logos';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES, files: 1 } });

function requireEditor(req, res, next) {
  if (!req.admin || !['super_admin', 'admin'].includes(req.admin.role)) {
    return res.status(403).json({ error: 'Your role is read-only for sponsors' });
  }
  next();
}

async function audit(req, actionType, targetType, targetId, details = {}) {
  const ip = clientIp(req);
  await Promise.all([
    logAdminAction({ adminUsername: req.admin.username, actionType, targetType, targetId, details, ip }),
    logAdminActivity({ adminId: req.admin.id || null, adminEmail: req.admin.email || req.admin.username, action: actionType, targetTable: targetType, targetId, details, ip }),
  ]);
}

// Shared body parsing for create + update. Returns { fields } or { error }.
function sponsorFields(body, { partial }) {
  const b = body || {};
  const fields = {};
  if (!partial || b.name !== undefined) {
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return { error: 'name is required' };
    fields.name = name;
  }
  if (b.linkUrl !== undefined) {
    const link = String(b.linkUrl || '').trim();
    if (link && !isHttpUrl(link)) return { error: 'Link must be an http:// or https:// URL' };
    fields.link_url = link || null;
  }
  if (b.tier !== undefined) {
    if (!TIERS.includes(b.tier)) return { error: `tier must be one of ${TIERS.join(', ')}` };
    fields.tier = b.tier;
  }
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return { error: `status must be one of ${STATUSES.join(', ')}` };
    fields.status = b.status;
  }
  for (const [key, col] of [['startsAt', 'starts_at'], ['endsAt', 'ends_at']]) {
    if (b[key] === undefined) continue;
    if (!b[key]) fields[col] = null;
    else if (Number.isNaN(Date.parse(b[key]))) return { error: `${key} is not a valid date` };
    else fields[col] = new Date(b[key]).toISOString();
  }
  if (fields.starts_at && fields.ends_at && fields.ends_at <= fields.starts_at) return { error: 'End date must be after the start date' };
  if (b.notes !== undefined) fields.notes = String(b.notes || '').slice(0, 2000) || null;
  return { fields };
}

function router() {
  const r = express.Router();

  r.use((req, res, next) => (isConfigured ? next() : res.status(503).json({ error: 'Supabase not configured' })));

  // ---- lobby settings (featured competition, empty-state copy, season) ----------

  r.get('/lobby-settings', async (req, res) => {
    try {
      const keys = ['featured_competition_id', 'lobby_empty_message', 'season_label', 'show_seed_accounts'];
      const [{ data: rows, error }, { data: comps, error: cErr }] = await Promise.all([
        supabase.from('app_settings').select('key, value').in('key', keys),
        supabase
          .from('competitions')
          .select('id, title, frequency, starts_at, ends_at, status')
          .eq('is_test', false)
          .eq('type', 'native')
          .gte('ends_at', new Date().toISOString())
          .order('starts_at', { ascending: true })
          .limit(50),
      ]);
      if (error) throw error;
      if (cErr) throw cErr;
      const settings = Object.fromEntries((rows || []).map((row) => [row.key, row.value]));
      res.json({
        featuredCompetitionId: settings.featured_competition_id || null,
        emptyMessage: settings.lobby_empty_message || '',
        seasonLabel: settings.season_label || '',
        showSeedAccounts: settings.show_seed_accounts === true,
        competitions: comps || [],
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/lobby-settings', requireEditor, async (req, res) => {
    const b = req.body || {};
    const updates = [];
    if (b.featuredCompetitionId !== undefined) {
      if (b.featuredCompetitionId && !UUID_RE.test(b.featuredCompetitionId)) return res.status(400).json({ error: 'Invalid competition id' });
      updates.push({ key: 'featured_competition_id', value: b.featuredCompetitionId || null });
    }
    if (b.emptyMessage !== undefined) updates.push({ key: 'lobby_empty_message', value: String(b.emptyMessage).slice(0, 200) });
    if (b.seasonLabel !== undefined) updates.push({ key: 'season_label', value: String(b.seasonLabel).slice(0, 40) });
    if (b.showSeedAccounts !== undefined) updates.push({ key: 'show_seed_accounts', value: b.showSeedAccounts === true });
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    try {
      const now = new Date().toISOString();
      const { error } = await supabase.from('app_settings').upsert(updates.map((u) => ({ ...u, updated_at: now })), { onConflict: 'key' });
      if (error) throw error;
      await audit(req, 'lobby_settings_update', 'app_settings', null, Object.fromEntries(updates.map((u) => [u.key, u.value])));
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- sponsor leads inbox ---------------------------------------------------------

  r.get('/leads', async (req, res) => {
    try {
      let q = supabase.from('sponsor_leads').select('id, company, contact_name, email, interest, budget_band, message, status, created_at').order('created_at', { ascending: false }).limit(500);
      if (LEAD_STATUSES.includes(req.query.status)) q = q.eq('status', req.query.status);
      const { data, error } = await q;
      if (error) throw error;
      res.json({ leads: data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/leads/:id', requireEditor, async (req, res) => {
    const status = req.body?.status;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Lead not found' });
    if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${LEAD_STATUSES.join(', ')}` });
    try {
      const { data, error } = await supabase.from('sponsor_leads').update({ status }).eq('id', req.params.id).select('id, company, status').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Lead not found' });
      await audit(req, 'sponsor_lead_status', 'sponsor_leads', data.id, { company: data.company, status });
      res.json({ lead: data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- placements ------------------------------------------------------------------

  r.put('/placements/:pid', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.pid)) return res.status(404).json({ error: 'Placement not found' });
    const fields = {};
    if (req.body?.sortOrder !== undefined) fields.sort_order = Math.trunc(Number(req.body.sortOrder) || 0);
    if (req.body?.active !== undefined) fields.active = req.body.active === true;
    try {
      const { data, error } = await supabase.from('sponsor_placements').update(fields).eq('id', req.params.pid).select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Placement not found' });
      await audit(req, 'sponsor_placement_update', 'sponsor_placements', data.id, fields);
      res.json({ placement: data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.delete('/placements/:pid', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.pid)) return res.status(404).json({ error: 'Placement not found' });
    try {
      const { data, error } = await supabase.from('sponsor_placements').delete().eq('id', req.params.pid).select('id, sponsor_id, placement, target_id').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Placement not found' });
      await audit(req, 'sponsor_placement_remove', 'sponsor_placements', data.id, data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- sponsor list + CRUD -----------------------------------------------------------

  // Clicks/impressions/CTR over the optional ?from&to range (all time otherwise).
  r.get('/', async (req, res) => {
    try {
      let q = supabase.from('sponsors').select('*, sponsor_placements(id, placement, target_id, sort_order, active)').order('created_at', { ascending: false });
      if (STATUSES.includes(req.query.status)) q = q.eq('status', req.query.status);
      if (TIERS.includes(req.query.tier)) q = q.eq('tier', req.query.tier);
      const { data: sponsors, error } = await q;
      if (error) throw error;
      const ids = sponsors.map((s) => s.id);
      const from = req.query.from && !Number.isNaN(Date.parse(req.query.from)) ? new Date(req.query.from) : null;
      const to = req.query.to && !Number.isNaN(Date.parse(req.query.to)) ? new Date(req.query.to) : null;
      let clicksQ = supabase.from('sponsor_clicks').select('sponsor_id, created_at').in('sponsor_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
      let imprQ = supabase.from('sponsor_impressions_daily').select('sponsor_id, day, count').in('sponsor_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
      if (from) {
        clicksQ = clicksQ.gte('created_at', from.toISOString());
        imprQ = imprQ.gte('day', from.toISOString().slice(0, 10));
      }
      if (to) {
        clicksQ = clicksQ.lte('created_at', to.toISOString());
        imprQ = imprQ.lte('day', to.toISOString().slice(0, 10));
      }
      const [{ data: clicks, error: e1 }, { data: impr, error: e2 }] = await Promise.all([clicksQ.limit(100000), imprQ.limit(100000)]);
      if (e1) throw e1;
      if (e2) throw e2;
      const clickCount = {};
      (clicks || []).forEach((c) => { clickCount[c.sponsor_id] = (clickCount[c.sponsor_id] || 0) + 1; });
      const imprCount = {};
      (impr || []).forEach((i) => { imprCount[i.sponsor_id] = (imprCount[i.sponsor_id] || 0) + i.count; });
      res.json({
        sponsors: sponsors.map((s) => {
          const clicksN = clickCount[s.id] || 0;
          const imprN = imprCount[s.id] || 0;
          return { ...s, placements: s.sponsor_placements || [], sponsor_placements: undefined, clicks: clicksN, impressions: imprN, ctr: imprN ? Math.round((clicksN / imprN) * 10000) / 100 : 0 };
        }),
        canEdit: ['super_admin', 'admin'].includes(req.admin.role),
        modes: MODES,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/', requireEditor, async (req, res) => {
    const { fields, error: invalid } = sponsorFields(req.body, { partial: false });
    if (invalid) return res.status(400).json({ error: invalid });
    try {
      const { data, error } = await supabase.from('sponsors').insert({ ...fields, created_by: req.admin.email || req.admin.username }).select().single();
      if (error) throw error;
      await audit(req, 'sponsor_create', 'sponsors', data.id, { name: data.name, status: data.status, tier: data.tier });
      res.json({ sponsor: data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/:id', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    const { fields, error: invalid } = sponsorFields(req.body, { partial: true });
    if (invalid) return res.status(400).json({ error: invalid });
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update' });
    try {
      const { data, error } = await supabase.from('sponsors').update(fields).eq('id', req.params.id).select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Sponsor not found' });
      await audit(req, 'sponsor_update', 'sponsors', data.id, { name: data.name, ...fields });
      res.json({ sponsor: data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/logo', requireEditor, (req, res) => {
    upload.single('logo')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Logo must be 1 MB or smaller' : err.message });
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
      const result = validateLogo(req.file?.buffer);
      if (!result.ok) return res.status(400).json({ error: result.error });
      try {
        const { data: sponsor } = await supabase.from('sponsors').select('id, name').eq('id', req.params.id).maybeSingle();
        if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });
        const objectPath = `${sponsor.id}/${Date.now()}.${result.ext}`;
        const { error: upErr } = await supabase.storage.from(LOGO_BUCKET).upload(objectPath, result.buffer, { contentType: result.contentType, upsert: true });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(objectPath);
        const { data, error } = await supabase.from('sponsors').update({ logo_url: pub.publicUrl }).eq('id', sponsor.id).select().single();
        if (error) throw error;
        await audit(req, 'sponsor_logo_upload', 'sponsors', sponsor.id, { name: sponsor.name, type: result.ext, bytes: result.buffer.length, sanitized: !!result.sanitized });
        res.json({ sponsor: data, sanitized: !!result.sanitized });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  r.post('/:id/placements', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    const { placement, targetId, sortOrder } = req.body || {};
    if (!PLACEMENTS.includes(placement)) return res.status(400).json({ error: `placement must be one of ${PLACEMENTS.join(', ')}` });
    if (placement === 'competition' && !UUID_RE.test(String(targetId || ''))) return res.status(400).json({ error: 'Pick a competition for a competition placement' });
    if (placement === 'mode' && !MODES.includes(targetId)) return res.status(400).json({ error: `Pick a mode: ${MODES.join(', ')}` });
    try {
      const row = {
        sponsor_id: req.params.id,
        placement,
        target_id: placement === 'competition' || placement === 'mode' ? String(targetId) : null,
        sort_order: Math.trunc(Number(sortOrder) || 0),
        active: true,
      };
      const { data, error } = await supabase.from('sponsor_placements').insert(row).select().single();
      if (error) throw error;
      // A competition placement also marks the competition as sponsored, so
      // its hero shows "Presented by".
      if (placement === 'competition') await supabase.from('competitions').update({ sponsor_id: req.params.id }).eq('id', row.target_id);
      await audit(req, 'sponsor_placement_add', 'sponsor_placements', data.id, row);
      res.json({ placement: data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Last N days (default 30) of impressions and clicks per day.
  async function analyticsRows(id, days) {
    const since = new Date(Date.now() - (days - 1) * 86400000);
    since.setUTCHours(0, 0, 0, 0);
    const [{ data: impr, error: e1 }, { data: clicks, error: e2 }] = await Promise.all([
      supabase.from('sponsor_impressions_daily').select('day, placement, count').eq('sponsor_id', id).gte('day', since.toISOString().slice(0, 10)),
      supabase.from('sponsor_clicks').select('created_at, placement').eq('sponsor_id', id).gte('created_at', since.toISOString()).limit(100000),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    const byDay = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(since.getTime() + i * 86400000).toISOString().slice(0, 10);
      byDay[d] = { day: d, impressions: 0, clicks: 0 };
    }
    (impr || []).forEach((row) => { if (byDay[row.day]) byDay[row.day].impressions += row.count; });
    (clicks || []).forEach((row) => {
      const d = row.created_at.slice(0, 10);
      if (byDay[d]) byDay[d].clicks += 1;
    });
    return Object.values(byDay).map((row) => ({ ...row, ctr: row.impressions ? Math.round((row.clicks / row.impressions) * 10000) / 100 : 0 }));
  }

  r.get('/:id/analytics', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    try {
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
      res.json({ days: await analyticsRows(req.params.id, days) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/:id/analytics.csv', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    try {
      const rows = await analyticsRows(req.params.id, 30);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="sponsor-${req.params.id}-30d.csv"`);
      res.send(['day,impressions,clicks,ctr_pct', ...rows.map((r2) => `${r2.day},${r2.impressions},${r2.clicks},${r2.ctr}`)].join('\n'));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
