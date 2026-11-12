'use strict';

// Sponsors: CRUD, logo upload (Supabase Storage bucket `sponsor-logos`),
// placements, per-day analytics + CSV, the sponsor-leads inbox and the
// lobby settings card. super_admin and admin can edit; moderator is
// read-only. Every write is logged to admin_logs and admin_activity_log.

const express = require('express');
const multer = require('multer');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { audit } = require('../lib/audit');
const { sendEmail } = require('../lib/email');
const lifecycle = require('../../server/sponsorLifecycle');
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

function requireSuper(req, res, next) {
  if (!req.admin || req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Only a super admin can delete' });
  next();
}

// Before the records migration has run there is no remind_contact column:
// save everything else rather than failing the whole edit.
async function withoutMissingRemind(fields, write) {
  const out = await write(fields);
  if (out.error && /remind_contact/.test(out.error.message || '') && 'remind_contact' in fields) {
    const { remind_contact, ...rest } = fields;
    return write(rest);
  }
  return out;
}

// Typed confirmation: the sponsor's exact name (case and outer spaces ignored).
const nameMatches = (typed, name) => String(typed || '').trim().toLowerCase() === String(name || '').trim().toLowerCase() && String(name || '').trim() !== '';

// "Acme Markets!" -> "acme-markets": the slug fixes itself instead of refusing.
function slugify(v) {
  return String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
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
    const slug = slugify(b.slug);
    fields.slug = slug.length >= 2 ? slug : null;
  }
  // a new sponsor with no slug gets one from its name
  if (!partial && !fields.slug && fields.name) {
    const auto = slugify(fields.name);
    if (auto.length >= 2) { fields.slug = auto; fields._autoSlug = true; }
  }
  for (const [key, col] of [['utmSource', 'utm_source'], ['utmMedium', 'utm_medium'], ['utmCampaign', 'utm_campaign']]) {
    if (b[key] === undefined) continue;
    const v = String(b[key] || '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
    fields[col] = v || null;
  }
  if (b.contactName !== undefined) fields.contact_name = String(b.contactName || '').trim().slice(0, 120) || null;
  if (b.contactEmail !== undefined) {
    const e = String(b.contactEmail || '').trim();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { error: 'Contact email is not valid' };
    fields.contact_email = e || null;
  }
  // Also email the sponsor's contact 10 days / 2 days before and on expiry.
  if (b.remindContact !== undefined) fields.remind_contact = b.remindContact === true;
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

// Slugs are unique. A slug made from the name gets -2, -3... if taken; one the
// admin typed is refused with a plain message instead of a database error.
async function settleSlug(fields, excludeId) {
  if (!fields.slug) { delete fields._autoSlug; return null; }
  const auto = fields._autoSlug;
  delete fields._autoSlug;
  const base = fields.slug;
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 37)}-${i}`;
    let q = supabase.from('sponsors').select('id').eq('slug', candidate).limit(1);
    if (excludeId) q = q.neq('id', excludeId);
    const { data, error } = await q;
    if (error) throw error;
    if (!data.length) { fields.slug = candidate; return null; }
    if (!auto) return `The slug "${base}" is already used by another sponsor. Pick a different one.`;
  }
  return 'Could not find a free slug. Type one in the Slug box.';
}

// The hourly lifecycle job (states + reminder emails), also run on demand.
const ADMIN_URL = () => String(process.env.ADMIN_URL || 'https://admin.spikeandcrush.com').replace(/\/$/, '');
function runLifecycleNow(opts = {}) {
  return lifecycle.runLifecycle(supabase, {
    sendEmail,
    slotName: (s) => SLOT_TITLES[s] || (SLOTS[s] && SLOTS[s].label) || s,
    adminUrl: ADMIN_URL(),
    siteUrl: SITE(),
    log: (m) => console.log(m),
    ...opts,
  });
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

  // Includes placements since deleted (their stats live on in the archive).
  function statsFor(sponsorId, fromDay, toDay) {
    return lifecycle.loadSponsorStats(supabase, sponsorId, fromDay, toDay);
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

  // ---- lifecycle: archive, delete, extend, duplicate, reminders -------------------
  // Archive hides a placement from lists and the calendar and stops it
  // serving; stats and audit stay. Delete is super_admin only, for expired or
  // archived placements, with the sponsor's name typed to confirm; its stats
  // are copied to sponsor_stats_archive first so reports keep them.

  async function loadPlacement(pid) {
    const { data, error } = await supabase.from('sponsor_placements').select('*, sponsor:sponsors(id, name)').eq('id', pid).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function archivePlacement(req, p) {
    const now = new Date().toISOString();
    const patch = { archived_at: now, lifecycle: 'archived', status: p.status === 'draft' ? 'draft' : 'ended', active: false, updated_at: now };
    const { error } = await supabase.from('sponsor_placements').update(patch).eq('id', p.id);
    if (error) throw error;
    await audit(req, 'sponsor_placement_archive', 'sponsor_placements', p.id, { sponsor: p.sponsor && p.sponsor.name, slot: p.slot, endsAt: p.ends_at });
  }

  // Returns null when allowed, else the reason.
  function deleteBlock(p, confirmName) {
    const lc = lifecycle.lifecycleFor(p);
    if (!['expired', 'archived'].includes(lc)) return `Only expired or archived placements can be deleted (this one is ${lc}). Archive it or wait for it to end.`;
    if (!nameMatches(confirmName, p.sponsor && p.sponsor.name)) return `Type the sponsor name "${(p.sponsor && p.sponsor.name) || ''}" to confirm`;
    return null;
  }

  async function deletePlacement(req, p) {
    const { data: stats, error: e1 } = await supabase.from('sponsor_stats_daily').select('*').eq('placement_id', p.id);
    if (e1) throw e1;
    if (stats && stats.length) {
      const rows = stats.map((s) => ({ placement_id: p.id, sponsor_id: p.sponsor_id, slot: p.slot, targets: p.targets, day: s.day, impressions: s.impressions || 0, unique_viewers: s.unique_viewers || 0, clicks: s.clicks || 0, entries: s.entries || 0, outbound_clicks: s.outbound_clicks || 0 }));
      const { error: e2 } = await supabase.from('sponsor_stats_archive').upsert(rows, { onConflict: 'placement_id,day' });
      if (e2) throw e2;
    }
    const { error } = await supabase.from('sponsor_placements').delete().eq('id', p.id);
    if (error) throw error;
    await audit(req, 'sponsor_placement_delete', 'sponsor_placements', p.id, { sponsor: p.sponsor && p.sponsor.name, slot: p.slot, startsAt: p.starts_at, endsAt: p.ends_at, statsDaysKept: (stats || []).length });
  }

  r.post('/placements/:pid/archive', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.pid)) return res.status(404).json({ error: 'Placement not found' });
    try {
      const p = await loadPlacement(req.params.pid);
      if (!p) return res.status(404).json({ error: 'Placement not found' });
      if (p.archived_at) return res.json({ success: true, already: true });
      await archivePlacement(req, p);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/placements/:pid/unarchive', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.pid)) return res.status(404).json({ error: 'Placement not found' });
    try {
      const p = await loadPlacement(req.params.pid);
      if (!p) return res.status(404).json({ error: 'Placement not found' });
      const now = new Date().toISOString();
      const { error } = await supabase.from('sponsor_placements').update({ archived_at: null, lifecycle: lifecycle.lifecycleFor({ ...p, archived_at: null }), updated_at: now }).eq('id', p.id);
      if (error) throw error;
      await audit(req, 'sponsor_placement_unarchive', 'sponsor_placements', p.id, {});
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.delete('/placements/:pid', requireSuper, async (req, res) => {
    if (!UUID_RE.test(req.params.pid)) return res.status(404).json({ error: 'Placement not found' });
    try {
      const p = await loadPlacement(req.params.pid);
      if (!p) return res.status(404).json({ error: 'Placement not found' });
      const block = deleteBlock(p, req.body && req.body.confirmName);
      if (block) return res.status(400).json({ error: block });
      await deletePlacement(req, p);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Bulk archive (editors) or delete (super_admin, same rules per row).
  r.post('/placements/bulk', requireEditor, async (req, res) => {
    const { action, ids, confirmName } = req.body || {};
    const list = Array.isArray(ids) ? ids.filter((x) => UUID_RE.test(String(x))).slice(0, 200) : [];
    if (!['archive', 'delete'].includes(action) || !list.length) return res.status(400).json({ error: 'Choose archive or delete and at least one placement' });
    if (action === 'delete' && req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Only a super admin can delete' });
    const done = [];
    const refused = [];
    try {
      for (const id of list) {
        const p = await loadPlacement(id);
        if (!p) { refused.push({ id, reason: 'not found' }); continue; }
        if (action === 'archive') {
          if (!p.archived_at) await archivePlacement(req, p);
          done.push(id);
          continue;
        }
        // One typed name confirms a bulk delete, so every row must belong to it.
        const block = deleteBlock(p, confirmName);
        if (block) { refused.push({ id, reason: block }); continue; }
        await deletePlacement(req, p);
        done.push(id);
      }
      res.json({ done, refused });
    } catch (e) {
      res.status(500).json({ error: e.message, done, refused });
    }
  });

  // Extend the end date in one click (logged).
  r.post('/placements/:pid/extend', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.pid)) return res.status(404).json({ error: 'Placement not found' });
    try {
      const p = await loadPlacement(req.params.pid);
      if (!p) return res.status(404).json({ error: 'Placement not found' });
      const days = Number(req.body && req.body.days);
      const endsAt = req.body && req.body.endsAt ? new Date(req.body.endsAt) : Number.isFinite(days) && days > 0 && days <= 366 ? new Date(Math.max(Date.parse(p.ends_at || Date.now()), Date.now()) + days * 86400000) : null;
      if (!endsAt || Number.isNaN(endsAt.getTime())) return res.status(400).json({ error: 'Give a new end date or a number of days (1-366)' });
      if (p.starts_at && endsAt <= new Date(p.starts_at)) return res.status(400).json({ error: 'The new end must be after the start' });
      const next = { ...p, ends_at: endsAt.toISOString(), archived_at: null };
      const check = await overlapCheck(next, p.id);
      if (check.blocking) return res.status(409).json({ error: check.blocking, overlaps: check.overlaps });
      const lc = lifecycle.lifecycleFor(next);
      const patch = { ends_at: next.ends_at, archived_at: null, lifecycle: lc, updated_at: new Date().toISOString() };
      // An expired placement that is extended goes back to serving.
      if (p.status === 'ended' && lc !== 'expired') { patch.status = 'active'; patch.active = true; }
      const { data, error } = await supabase.from('sponsor_placements').update(patch).eq('id', p.id).select().single();
      if (error) throw error;
      await audit(req, 'sponsor_placement_extend', 'sponsor_placements', p.id, { from: p.ends_at, to: next.ends_at });
      res.json({ placement: data, warnings: check.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Renew as a new scheduled placement (same slot, target and creative).
  r.post('/placements/:pid/duplicate', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.pid)) return res.status(404).json({ error: 'Placement not found' });
    try {
      const p = await loadPlacement(req.params.pid);
      if (!p) return res.status(404).json({ error: 'Placement not found' });
      const length = p.starts_at && p.ends_at ? Date.parse(p.ends_at) - Date.parse(p.starts_at) : 30 * 86400000;
      const startsAt = req.body && req.body.startsAt ? new Date(req.body.startsAt) : new Date(Math.max(Date.now(), Date.parse(p.ends_at || Date.now())));
      const endsAt = req.body && req.body.endsAt ? new Date(req.body.endsAt) : new Date(startsAt.getTime() + length);
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return res.status(400).json({ error: 'Invalid dates' });
      const row = {
        sponsor_id: p.sponsor_id, placement: p.placement, target_id: p.target_id, sort_order: p.sort_order, slot: p.slot, targets: p.targets, weight: p.weight,
        creative: p.creative, tagline: p.tagline, cta_text: p.cta_text, cta_url: p.cta_url, remind_contact: p.remind_contact || false,
        starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), status: 'active', active: true, created_by: req.admin.username,
      };
      row.lifecycle = lifecycle.lifecycleFor(row);
      const check = await overlapCheck(row, p.id);
      if (check.blocking) return res.status(409).json({ error: check.blocking, overlaps: check.overlaps });
      const { data, error } = await supabase.from('sponsor_placements').insert(row).select().single();
      if (error) throw error;
      await audit(req, 'sponsor_placement_duplicate', 'sponsor_placements', data.id, { from: p.id, startsAt: row.starts_at, endsAt: row.ends_at });
      res.json({ placement: data, warnings: check.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/placements/:pid/reminders', async (req, res) => {
    if (!UUID_RE.test(req.params.pid)) return res.status(404).json({ error: 'Placement not found' });
    try {
      const { data, error } = await supabase.from('sponsor_reminders').select('*').eq('placement_id', req.params.pid).order('sent_at');
      if (error) throw error;
      res.json({ reminders: data || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Reminder settings (admin address, digest, contact emails on/off).
  r.get('/reminders/settings', async (req, res) => {
    res.json(await lifecycle.readConfig(supabase));
  });
  r.put('/reminders/settings', requireEditor, async (req, res) => {
    const b = req.body || {};
    const cur = await lifecycle.readConfig(supabase);
    const next = { ...cur };
    if (b.enabled !== undefined) next.enabled = b.enabled === true;
    if (b.digest !== undefined) next.digest = b.digest === true;
    if (b.adminEmail !== undefined) {
      const em = String(b.adminEmail).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: 'Enter a valid email address' });
      next.adminEmail = em;
    }
    if (b.maxEmailsPerRun !== undefined) next.maxEmailsPerRun = Math.min(200, Math.max(1, Math.trunc(Number(b.maxEmailsPerRun) || 40)));
    try {
      const { error } = await supabase.from('app_settings').upsert({ key: 'sponsors.reminders', value: next, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw error;
      await audit(req, 'sponsor_reminder_settings', 'app_settings', 'sponsors.reminders', next);
      res.json(next);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Run the hourly job now (states + reminders). Same idempotency as the timer.
  r.post('/lifecycle/run', requireEditor, async (req, res) => {
    try {
      const report = await runLifecycleNow();
      await audit(req, 'sponsor_lifecycle_run', 'sponsor_placements', null, { moved: report.moved.length, reminders: report.reminders.length });
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dashboard: how many placements need a look.
  r.get('/lifecycle/summary', async (req, res) => {
    try {
      const { data, error } = await supabase.from('sponsor_placements').select('id, starts_at, ends_at, archived_at, status');
      if (error) throw error;
      const counts = { scheduled: 0, active: 0, expiring: 0, expired: 0, archived: 0 };
      for (const p of data || []) counts[lifecycle.lifecycleFor(p)]++;
      res.json(counts);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Sponsor archive: only when nothing is live or scheduled. Delete: super
  // admin, typed name, and no placement rows left at all.
  r.post('/:id/archive', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    try {
      const { data: s, error } = await supabase.from('sponsors').select('id, name, sponsor_placements(id, starts_at, ends_at, archived_at, status)').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!s) return res.status(404).json({ error: 'Sponsor not found' });
      const live = (s.sponsor_placements || []).filter((p) => ['scheduled', 'active', 'expiring'].includes(lifecycle.lifecycleFor(p)) && !['draft', 'paused'].includes(p.status));
      if (live.length) return res.status(400).json({ error: `${s.name} still has ${live.length} live or scheduled placement${live.length === 1 ? '' : 's'}. Archive or end those first.` });
      const now = new Date().toISOString();
      const { error: e2 } = await supabase.from('sponsors').update({ archived_at: now, status: 'ended', updated_at: now }).eq('id', s.id);
      if (e2) throw e2;
      await audit(req, 'sponsor_archive', 'sponsors', s.id, { name: s.name });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/unarchive', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    try {
      const { data, error } = await supabase.from('sponsors').update({ archived_at: null, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('id, name').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Sponsor not found' });
      await audit(req, 'sponsor_unarchive', 'sponsors', data.id, { name: data.name });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.delete('/:id', requireSuper, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Sponsor not found' });
    try {
      const { data: s, error } = await supabase.from('sponsors').select('id, name, logo_url, logo_dark_url').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!s) return res.status(404).json({ error: 'Sponsor not found' });
      if (!nameMatches(req.body && req.body.confirmName, s.name)) return res.status(400).json({ error: `Type the sponsor name "${s.name}" to confirm` });
      const { count, error: e1 } = await supabase.from('sponsor_placements').select('id', { count: 'exact', head: true }).eq('sponsor_id', s.id);
      if (e1) throw e1;
      if (count) return res.status(400).json({ error: `${s.name} still has ${count} placement${count === 1 ? '' : 's'}. Delete or archive those first; a sponsor with placements can't be deleted.` });
      const { count: comps } = await supabase.from('competitions').select('id', { count: 'exact', head: true }).eq('sponsor_id', s.id);
      if (comps) return res.status(400).json({ error: `${s.name} is linked to ${comps} competition${comps === 1 ? '' : 's'}. Archive the sponsor instead so those records stay intact.` });
      // Logos come out of storage (only files in our own bucket).
      const files = [s.logo_url, s.logo_dark_url].filter(Boolean).map((u) => { const m = String(u).match(new RegExp(`/${LOGO_BUCKET}/(.+)$`)); return m ? decodeURIComponent(m[1].split('?')[0]) : null; }).filter(Boolean);
      if (files.length) await supabase.storage.from(LOGO_BUCKET).remove(files).catch(() => {});
      const { error: e2 } = await supabase.from('sponsors').delete().eq('id', s.id);
      if (e2) throw e2;
      await audit(req, 'sponsor_delete', 'sponsors', s.id, { name: s.name, logosRemoved: files.length });
      res.json({ success: true, logosRemoved: files.length });
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
      // Lifecycle per placement (from the dates; the hourly job stores the same
      // value) and the list view: current (default, archived hidden),
      // expired, inactive or archived.
      const cfg = await lifecycle.readConfig(supabase).catch(() => lifecycle.DEFAULTS);
      const now = Date.now();
      const view = ['expired', 'inactive', 'archived', 'all'].includes(req.query.view) ? req.query.view : 'current';
      const LIVE = ['scheduled', 'active', 'expiring'];
      let list = sponsors.map((s) => {
        const clicksN = clickCount[s.id] || 0;
        const imprN = imprCount[s.id] || 0;
        const placements = (s.sponsor_placements || []).map((p) => ({ ...p, lifecycle: lifecycle.lifecycleFor(p, now, cfg) }));
        // Inactive: nothing can serve (sponsor not active, or no live/scheduled placement).
        const inactive = s.status !== 'active' || !placements.some((p) => LIVE.includes(p.lifecycle) && p.status !== 'draft' && p.status !== 'paused');
        return { ...s, placements, sponsor_placements: undefined, inactive, archived: Boolean(s.archived_at), clicks: clicksN, impressions: imprN, ctr: imprN ? Math.round((clicksN / imprN) * 10000) / 100 : 0 };
      });
      if (view === 'current') list = list.filter((s) => !s.archived).map((s) => ({ ...s, placements: s.placements.filter((p) => p.lifecycle !== 'archived') }));
      if (view === 'expired') list = list.map((s) => ({ ...s, placements: s.placements.filter((p) => p.lifecycle === 'expired') })).filter((s) => s.placements.length);
      if (view === 'inactive') list = list.filter((s) => s.inactive && !s.archived);
      if (view === 'archived') list = list.map((s) => ({ ...s, placements: s.archived ? s.placements : s.placements.filter((p) => p.lifecycle === 'archived') })).filter((s) => s.archived || s.placements.length);
      res.json({
        sponsors: list,
        view,
        canEdit: ['super_admin', 'admin'].includes(req.admin.role),
        canDelete: req.admin.role === 'super_admin',
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
      const taken = await settleSlug(fields, null);
      if (taken) return res.status(400).json({ error: taken });
      const { data, error } = await withoutMissingRemind(fields, (f) => supabase.from('sponsors').insert({ ...f, created_by: req.admin.email || req.admin.username }).select().single());
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
      const taken = await settleSlug(fields, req.params.id);
      if (taken) return res.status(400).json({ error: taken });
      const { data, error } = await withoutMissingRemind(fields, (f) => supabase.from('sponsors').update({ ...f, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().maybeSingle());
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
module.exports.slugify = slugify;
module.exports.sponsorFields = sponsorFields;
module.exports.runLifecycleNow = runLifecycleNow;
