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
const crypto = require('crypto');
const { SLOTS, SLOT_NAMES, signPreview } = require('../../server/sponsorSlots');
const { renderReport, summarise, hashToken, waitingFor } = require('../../server/sponsorReport');
const compStates = require('../../server/competitionStates');

const TIERS = ['platinum', 'gold', 'silver', 'partner'];
const STATUSES = ['draft', 'active', 'paused', 'ended'];
const PLACEMENTS = ['global_strip', 'hero', 'competition', 'mode'];
const LEAD_STATUSES = ['new', 'contacted', 'closed'];
const MODES = ['quick', 'blitz', 'grand', 'solo', 'async', 'private', 'tournament'];
const LOGO_BUCKET = 'sponsor-logos';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEMENT_STATUSES = ['draft', 'active', 'paused', 'ended'];
const CREATIVES = ['logo', 'logo_tagline', 'logo_tagline_cta'];
// A target is 'all' or one exact thing a slot can be about.
const TARGET_RE = /^(all|leaderboard|lobby|discover|mode:[a-z_]{2,20}|competition:[A-Za-z0-9_-]{2,40}|partner:[0-9a-f-]{36}|cosmetic:[A-Za-z0-9_-]{1,60})$/;
const SITE = () => String(process.env.SITE_URL || 'https://www.spikeandcrush.com').replace(/\/$/, '');
const dayStr = (d) => d.toISOString().slice(0, 10);

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
  if (b.tagline !== undefined) {
    const t = String(b.tagline || '').trim();
    if (t.length > 60) return { error: 'Tagline must be 60 characters or fewer' };
    const bad = compStates.cardTextViolations(t);
    if (bad.length) return { error: `Tagline uses wording that is not allowed (${bad.join(', ')})` };
    fields.tagline = t || null;
  }
  if (b.slug !== undefined) {
    const slug = String(b.slug || '').trim().toLowerCase();
    if (slug && !/^[a-z0-9-]{2,40}$/.test(slug)) return { error: 'Slug: 2-40 lowercase letters, numbers and dashes' };
    fields.slug = slug || null;
  }
  for (const [key, col] of [['utmSource', 'utm_source'], ['utmMedium', 'utm_medium'], ['utmCampaign', 'utm_campaign']]) {
    if (b[key] === undefined) continue;
    const v = String(b[key] || '').trim();
    if (v && !/^[A-Za-z0-9_.-]{1,60}$/.test(v)) return { error: `${key}: letters, numbers, dot, dash and underscore only` };
    fields[col] = v || null;
  }
  if (b.contactName !== undefined) fields.contact_name = String(b.contactName || '').trim().slice(0, 120) || null;
  if (b.contactEmail !== undefined) {
    const e = String(b.contactEmail || '').trim();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { error: 'Contact email is not valid' };
    fields.contact_email = e || null;
  }
  return { fields };
}

const SLOT_TITLES = {
  lobby_strip: 'Lobby strip', competition_card: 'Competition card', prematch: 'Match countdown',
  match_header_chip: 'Match header chip', spike_strip_tag: 'Spike strip tag', result_screen: 'Result screen',
  leaderboard_header: 'Leaderboard header', event_banner: 'Event banner', email_footer: 'Email footer', cosmetic: 'Cosmetic item',
};
const LEGACY_FOR = { lobby_strip: 'global_strip', competition_card: 'competition', match_header_chip: 'mode' };

function range(q) {
  const to = q.to && !Number.isNaN(Date.parse(q.to)) ? new Date(q.to) : new Date();
  const from = q.from && !Number.isNaN(Date.parse(q.from)) ? new Date(q.from) : new Date(to.getTime() - 29 * 86400000);
  if (from > to) return { fromDay: dayStr(to), toDay: dayStr(from) };
  return { fromDay: dayStr(from), toDay: dayStr(to) };
}

// Where the preview link opens for each slot.
function previewPath(p) {
  const t = String(p.targets || 'all').split(',')[0].trim();
  const comp = t.startsWith('competition:') ? t.slice(12) : null;
  switch (p.slot) {
    case 'competition_card': return /^(daily|weekly|weekend|monthly)$/.test(comp || '') ? `/competitions/${comp}` : '/competitions';
    case 'leaderboard_header': return '/leaderboard';
    case 'event_banner': return t === 'discover' ? '/discover' : '/play';
    case 'cosmetic': return '/shop';
    default: return '/play';
  }
}

// Shared parsing for placement create + update. Returns { fields } or { error }.
function placementFields(b = {}, { partial }) {
  const fields = {};
  if (!partial || b.slot !== undefined) {
    if (!SLOT_NAMES.includes(b.slot)) return { error: `slot must be one of ${SLOT_NAMES.join(', ')}` };
    fields.slot = b.slot;
  }
  if (!partial || b.targets !== undefined) {
    const list = String(b.targets || 'all').split(',').map((t) => t.trim()).filter(Boolean);
    if (!list.length) list.push('all');
    const bad = list.find((t) => !TARGET_RE.test(t));
    if (bad) return { error: `Target "${bad}" is not valid. Use all, mode:quick, competition:daily, partner:<id>, leaderboard, cosmetic:<id>` };
    fields.targets = [...new Set(list)].join(',');
  }
  if (b.weight !== undefined) {
    const w = Math.trunc(Number(b.weight));
    if (!(w >= 1 && w <= 100)) return { error: 'Weight must be 1 to 100' };
    fields.weight = w;
  }
  if (b.status !== undefined) {
    if (!PLACEMENT_STATUSES.includes(b.status)) return { error: `status must be one of ${PLACEMENT_STATUSES.join(', ')}` };
    fields.status = b.status;
    fields.active = b.status === 'active';
  } else if (!partial) { fields.status = 'draft'; fields.active = false; }
  for (const [key, col] of [['startsAt', 'starts_at'], ['endsAt', 'ends_at']]) {
    if (b[key] === undefined) continue;
    if (!b[key]) fields[col] = null;
    else if (Number.isNaN(Date.parse(b[key]))) return { error: `${key} is not a valid date` };
    else fields[col] = new Date(b[key]).toISOString();
  }
  if (fields.starts_at && fields.ends_at && fields.ends_at <= fields.starts_at) return { error: 'End date must be after the start date' };
  if (b.creative !== undefined) {
    if (!CREATIVES.includes(b.creative)) return { error: `creative must be one of ${CREATIVES.join(', ')}` };
    fields.creative = b.creative;
  }
  const slot = fields.slot || b.slot;
  if (slot && SLOTS[slot] && SLOTS[slot].creative === 'text' && fields.creative) fields.creative = 'logo_tagline'; // text-only slots show the name and tagline, never a logo
  if (b.tagline !== undefined) {
    const t = String(b.tagline || '').trim();
    if (t.length > 60) return { error: 'Tagline must be 60 characters or fewer' };
    const bad = compStates.cardTextViolations(t);
    if (bad.length) return { error: `Tagline uses wording that is not allowed (${bad.join(', ')})` };
    fields.tagline = t || null;
  }
  if (b.ctaText !== undefined) {
    const t = String(b.ctaText || '').trim();
    if (t.length > 24) return { error: 'Button text must be 24 characters or fewer' };
    const bad = compStates.cardTextViolations(t);
    if (bad.length) return { error: `Button text uses wording that is not allowed (${bad.join(', ')})` };
    fields.cta_text = t || null;
  }
  if (b.ctaUrl !== undefined) {
    const u = String(b.ctaUrl || '').trim();
    if (u && !isHttpUrl(u)) return { error: 'Button link must be an http:// or https:// URL' };
    fields.cta_url = u || null;
  }
  if ((fields.creative === 'logo_tagline_cta') && !partial && (!fields.cta_text || !fields.cta_url)) return { error: 'A button needs both its text and its link' };
  return { fields };
}

function router() {
  const r = express.Router();

  r.use((req, res, next) => (isConfigured ? next() : res.status(503).json({ error: 'Supabase not configured' })));

  // The report helpers expect the game server's db; this is the slice they use.
  const reportDb = {
    async waitlistCounts() {
      const { data } = await supabase.from('competition_waitlist').select('template_key').limit(100000);
      const out = {};
      (data || []).forEach((w) => { out[w.template_key] = (out[w.template_key] || 0) + 1; });
      return out;
    },
    async listCompTemplates() {
      const { data } = await supabase.from('competition_templates').select('key, title');
      return data || [];
    },
  };

  async function statsFor(sponsorId, fromDay, toDay) {
    const { data: placements, error } = await supabase.from('sponsor_placements').select('id, slot, targets, status, starts_at, ends_at').eq('sponsor_id', sponsorId);
    if (error) throw error;
    const ids = (placements || []).map((p) => p.id);
    if (!ids.length) return { placements: [], days: [] };
    const { data: days, error: e2 } = await supabase.from('sponsor_stats_daily').select('placement_id, day, impressions, unique_viewers, clicks, entries, outbound_clicks').in('placement_id', ids).gte('day', fromDay).lte('day', toDay).order('day');
    if (e2) throw e2;
    return { placements, days: days || [] };
  }

  // Overlap rules: one presenting sponsor per competition at a time (blocking);
  // anything else sharing a slot and target in the same window is a warning.
  async function overlapCheck(p, excludeId) {
    let q = supabase.from('sponsor_placements').select('id, sponsor_id, slot, targets, starts_at, ends_at, status, weight, sponsors(name)').eq('slot', p.slot).in('status', ['active', 'draft']);
    if (excludeId) q = q.neq('id', excludeId);
    const { data, error } = await q;
    if (error) throw error;
    const mine = String(p.targets || 'all').split(',').map((t) => t.trim());
    const s1 = p.starts_at ? Date.parse(p.starts_at) : -Infinity;
    const e1 = p.ends_at ? Date.parse(p.ends_at) : Infinity;
    const overlaps = (data || []).filter((o) => {
      const s2 = o.starts_at ? Date.parse(o.starts_at) : -Infinity;
      const e2 = o.ends_at ? Date.parse(o.ends_at) : Infinity;
      if (!(s1 < e2 && s2 < e1)) return false;
      const theirs = String(o.targets || 'all').split(',').map((t) => t.trim());
      return mine.some((t) => theirs.includes(t)) || mine.includes('all') || theirs.includes('all');
    }).map((o) => ({ id: o.id, sponsor: o.sponsors?.name || '', sponsorId: o.sponsor_id, targets: o.targets, startsAt: o.starts_at, endsAt: o.ends_at, status: o.status, weight: o.weight }));
    const warnings = overlaps.length ? [`${overlaps.length} other placement${overlaps.length === 1 ? '' : 's'} share this slot and dates. They rotate by weight.`] : [];
    let blocking = null;
    if (['competition_card', 'prematch'].includes(p.slot)) {
      const comp = mine.filter((t) => t.startsWith('competition:') || t.startsWith('partner:'));
      const clash = overlaps.find((o) => o.sponsorId !== p.sponsor_id && String(o.targets).split(',').map((t) => t.trim()).some((t) => comp.includes(t)));
      if (clash) blocking = `${clash.sponsor || 'Another sponsor'} already presents this competition in those dates. A competition has one presenting sponsor at a time.`;
    }
    return { overlaps, warnings, blocking };
  }


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
    try {
      const { data: cur, error: e0 } = await supabase.from('sponsor_placements').select('*').eq('id', req.params.pid).maybeSingle();
      if (e0) throw e0;
      if (!cur) return res.status(404).json({ error: 'Placement not found' });
      const { fields, error: invalid } = placementFields(req.body, { partial: true });
      if (invalid) return res.status(400).json({ error: invalid });
      if (req.body?.sortOrder !== undefined) fields.sort_order = Math.trunc(Number(req.body.sortOrder) || 0);
      if (req.body?.active !== undefined) { fields.active = req.body.active === true; fields.status = fields.active ? 'active' : 'paused'; }
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update' });
      const next = { ...cur, ...fields };
      const check = await overlapCheck(next, cur.id);
      if (check.blocking) return res.status(409).json({ error: check.blocking, overlaps: check.overlaps });
      fields.updated_at = new Date().toISOString();
      const { data, error } = await supabase.from('sponsor_placements').update(fields).eq('id', cur.id).select().single();
      if (error) throw error;
      await audit(req, 'sponsor_placement_update', 'sponsor_placements', data.id, fields);
      res.json({ placement: data, warnings: check.warnings, overlaps: check.overlaps });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Overlap check before saving (the editor calls this as the admin types).
  r.post('/placements/check', async (req, res) => {
    const { fields, error: invalid } = placementFields(req.body, { partial: false });
    if (invalid) return res.status(400).json({ error: invalid });
    try {
      const check = await overlapCheck({ ...fields, sponsor_id: req.body?.sponsorId }, UUID_RE.test(String(req.body?.excludeId || '')) ? req.body.excludeId : null);
      res.json(check);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // A link that shows one placement on the real page, even before it goes live.
  r.get('/placements/:pid/preview', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.pid)) return res.status(404).json({ error: 'Placement not found' });
    try {
      const { data: p, error } = await supabase.from('sponsor_placements').select('id, slot, targets').eq('id', req.params.pid).maybeSingle();
      if (error) throw error;
      if (!p) return res.status(404).json({ error: 'Placement not found' });
      const secret = process.env.INTERNAL_ADMIN_SECRET || process.env.ADMIN_SECRET;
      if (!secret) return res.status(503).json({ error: 'Preview links need INTERNAL_ADMIN_SECRET set on both servers' });
      const token = signPreview(secret, p.id);
      res.json({ url: `${SITE()}${previewPath(p)}${previewPath(p).includes('?') ? '&' : '?'}sp_preview=${encodeURIComponent(token)}`, expiresInMinutes: 30 });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- global switch ----------------------------------------------------------------
  r.get('/settings', async (req, res) => {
    try {
      const { data, error } = await supabase.from('app_settings').select('key, value').in('key', ['sponsors.enabled', 'lobbyStrip.maxTiles']);
      if (error) throw error;
      const m = Object.fromEntries((data || []).map((x) => [x.key, x.value]));
      res.json({ enabled: m['sponsors.enabled'] !== false, maxTiles: Number(m['lobbyStrip.maxTiles']) || 6, slots: SLOT_NAMES.map((k) => ({ key: k, label: SLOTS[k].label, name: SLOT_TITLES[k] || k, textOnly: SLOTS[k].creative === 'text', defaultCreative: SLOTS[k].creative })), canEdit: ['super_admin', 'admin'].includes(req.admin.role) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/settings', requireEditor, async (req, res) => {
    const rows = [];
    if (req.body?.enabled !== undefined) rows.push({ key: 'sponsors.enabled', value: req.body.enabled === true });
    if (req.body?.maxTiles !== undefined) rows.push({ key: 'lobbyStrip.maxTiles', value: Math.min(12, Math.max(1, Math.trunc(Number(req.body.maxTiles) || 6))) });
    if (!rows.length) return res.status(400).json({ error: 'Nothing to update' });
    try {
      const now = new Date().toISOString();
      const { error } = await supabase.from('app_settings').upsert(rows.map((x) => ({ ...x, updated_at: now })), { onConflict: 'key' });
      if (error) throw error;
      await audit(req, 'sponsors_settings', 'app_settings', null, Object.fromEntries(rows.map((x) => [x.key, x.value])));
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- report tokens -------------------------------------------------------------------
  r.delete('/report-tokens/:tid', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.tid)) return res.status(404).json({ error: 'Link not found' });
    try {
      const { data, error } = await supabase.from('sponsor_report_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', req.params.tid).is('revoked_at', null).select('id, sponsor_id').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Link not found or already off' });
      await audit(req, 'sponsor_report_link_revoke', 'sponsor_report_tokens', data.id, { sponsor_id: data.sponsor_id });
      res.json({ success: true });
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
      let q = supabase.from('sponsors').select('*, sponsor_placements(*)').order('created_at', { ascending: false });
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
      const { data, error } = await supabase.from('sponsors').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().maybeSingle();
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
        const col = req.query.variant === 'dark' ? 'logo_dark_url' : 'logo_url';
        const { data, error } = await supabase.from('sponsors').update({ [col]: pub.publicUrl, updated_at: new Date().toISOString() }).eq('id', sponsor.id).select().single();
        if (error) throw error;
        await audit(req, 'sponsor_logo_upload', 'sponsors', sponsor.id, { name: sponsor.name, variant: req.query.variant === 'dark' ? 'dark' : 'light', type: result.ext, bytes: result.buffer.length, sanitized: !!result.sanitized });
        res.json({ sponsor: data, sanitized: !!result.sanitized });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  r.post('/:id/placements', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    const body = { ...(req.body || {}) };
    // the old form (placement + targetId) maps onto slots
    if (!body.slot && body.placement) {
      const legacy = { global_strip: 'lobby_strip', hero: 'lobby_strip', competition: 'competition_card', mode: 'match_header_chip' }[body.placement];
      if (!legacy) return res.status(400).json({ error: `placement must be one of ${PLACEMENTS.join(', ')}` });
      body.slot = legacy;
      if (body.placement === 'mode' && !MODES.includes(body.targetId)) return res.status(400).json({ error: `Pick a mode: ${MODES.join(', ')}` });
      body.targets = body.placement === 'mode' ? `mode:${body.targetId}` : body.placement === 'competition' ? `competition:${body.targetId}` : 'all';
    }
    const { fields, error: invalid } = placementFields(body, { partial: false });
    if (invalid) return res.status(400).json({ error: invalid });
    try {
      const row = { ...fields, sponsor_id: req.params.id, placement: LEGACY_FOR[fields.slot] || 'global_strip', target_id: null, sort_order: Math.trunc(Number(body.sortOrder) || 0), active: fields.status === 'active', created_by: req.admin.email || req.admin.username };
      const check = await overlapCheck(row, null);
      if (check.blocking) return res.status(409).json({ error: check.blocking, overlaps: check.overlaps });
      const { data, error } = await supabase.from('sponsor_placements').insert(row).select().single();
      if (error) throw error;
      await audit(req, 'sponsor_placement_add', 'sponsor_placements', data.id, { slot: row.slot, targets: row.targets, starts_at: row.starts_at, ends_at: row.ends_at, status: row.status });
      res.json({ placement: data, warnings: check.warnings, overlaps: check.overlaps });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Stats per placement for a date range (aggregate counts only).
  r.get('/:id/stats', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    try {
      const { fromDay, toDay } = range(req.query);
      const stats = await statsFor(req.params.id, fromDay, toDay);
      res.json({ fromDay, toDay, ...stats, summary: summarise(stats) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // The sponsor report as a page (download from admin; same page the token link shows).
  r.get('/:id/report', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    try {
      const { data: sponsor, error } = await supabase.from('sponsors').select('*').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });
      const { fromDay, toDay } = range(req.query);
      const stats = await statsFor(sponsor.id, fromDay, toDay);
      const waiting = await waitingFor(reportDb, stats.placements);
      if (req.query.download === '1') res.set('Content-Disposition', `attachment; filename="sponsor-report-${(sponsor.slug || sponsor.id)}-${fromDay}-to-${toDay}.html"`);
      res.type('html').send(renderReport({ sponsor, fromDay, toDay, stats, waiting }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/:id/report-tokens', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    try {
      const { data, error } = await supabase.from('sponsor_report_tokens').select('id, expires_at, revoked_at, created_by, created_at').eq('sponsor_id', req.params.id).order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      res.json({ tokens: data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // A new read-only link. The token is shown once; only its hash is stored.
  r.post('/:id/report-tokens', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    const days = Math.min(365, Math.max(1, Math.trunc(Number(req.body?.days) || 90)));
    try {
      const token = crypto.randomBytes(32).toString('base64url');
      const row = { sponsor_id: req.params.id, token_hash: hashToken(token), expires_at: new Date(Date.now() + days * 86400000).toISOString(), created_by: req.admin.email || req.admin.username };
      const { data, error } = await supabase.from('sponsor_report_tokens').insert(row).select('id, expires_at').single();
      if (error) throw error;
      await audit(req, 'sponsor_report_link_create', 'sponsor_report_tokens', data.id, { sponsor_id: req.params.id, days });
      res.json({ id: data.id, url: `${SITE()}/sponsor-report/${token}`, expiresAt: data.expires_at });
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
module.exports.placementFields = placementFields;
module.exports.previewPath = previewPath;
