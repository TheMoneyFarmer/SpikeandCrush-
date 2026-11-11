'use strict';

// Sponsor slots: the only places a sponsor can appear. The server decides
// which placement shows where (one resolver, cached); the client only renders
// what it is given. Every placement carries "Presented by" or "Sponsored".
//
// Tracking keeps counts only (sponsor_stats_daily): no player id, handle or
// email is ever stored against sponsor data. Unique viewers are counted with
// a keyed hash of (day, viewer, placement) held in memory for the day, never
// written to the database and not reversible.
//
// Not slots, and refused here: anything over the chart, price scale, order
// ticket, Modify panel, card tray, target picker, support chat, sign-up or
// payment flows, or the legal pages.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const SLOTS = {
  lobby_strip: { label: 'Sponsored', creative: 'logo_tagline', multi: true },
  competition_card: { label: 'Presented by', creative: 'logo_tagline_cta' },
  prematch: { label: 'Presented by', creative: 'logo_tagline', lead: 'This match is presented by' },
  match_header_chip: { label: 'Presented by', creative: 'logo' },
  spike_strip_tag: { label: 'Presented by', creative: 'text' },
  result_screen: { label: 'Sponsored', creative: 'logo_tagline_cta' },
  leaderboard_header: { label: 'Presented by', creative: 'logo' },
  event_banner: { label: 'Presented by', creative: 'logo_tagline_cta' },
  email_footer: { label: 'Presented by', creative: 'text' },
  cosmetic: { label: 'Sponsored', creative: 'logo' },
};
const SLOT_NAMES = Object.keys(SLOTS);
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|embedly|quora link preview|whatsapp|telegrambot|discordbot|preview|curl|wget|python-requests|headless/i;
const CACHE_MS = 30000;
const FLUSH_MS = 5000;
const DEDUPE_MS = 60000; // one impression per viewer per placement per minute
const MAX_IMPRESSIONS_PER_MIN = 60; // per viewer, beyond this they're ignored

function isHttpsUrl(u) {
  try { return new URL(u).protocol === 'https:'; } catch (e) { return false; }
}

// The signing key comes from the env secret. With no secret (local runs) each
// process makes a random one, so preview links only work on that process.
const RANDOM_KEY = crypto.randomBytes(32);
function keyFor(secret) {
  return secret ? crypto.createHash('sha256').update(`sponsor-slots|${secret}`).digest() : RANDOM_KEY;
}
// Admin preview link token: the admin process signs with the same env secret.
function signPreview(secret, placementId, ttlMs = 30 * 60 * 1000) {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', keyFor(secret)).update(`preview|${placementId}|${exp}`).digest('hex').slice(0, 32);
  return `${placementId}.${exp}.${sig}`;
}

function createSponsorSlots({ db, logoHosts = [], secret, optionalViewerId, siteOrigin }) {
  const hmacKey = keyFor(secret);
  let placementCache = new Map(); // slot -> { at, rows }
  let enabledCache = { at: 0, value: true };

  // ---- resolution ----------------------------------------------------------------------
  async function enabled() {
    if (Date.now() - enabledCache.at < 10000) return enabledCache.value;
    let value = true;
    try { value = (await db.getAppSetting('sponsors.enabled')) !== false; } catch (e) { value = true; }
    enabledCache = { at: Date.now(), value };
    return value;
  }

  // How many lobby strip tiles show at once (admin: Sponsors page). 1 to 12.
  let tilesCache = { at: 0, value: 6 };
  async function maxTiles() {
    if (Date.now() - tilesCache.at < 10000) return tilesCache.value;
    let value = 6;
    try { const v = Number(await db.getAppSetting('lobbyStrip.maxTiles')); if (Number.isFinite(v) && v >= 1) value = Math.min(12, Math.trunc(v)); } catch (e) { value = 6; }
    tilesCache = { at: Date.now(), value };
    return value;
  }

  async function rowsFor(slot) {
    const c = placementCache.get(slot);
    if (c && Date.now() - c.at < CACHE_MS) return c.rows;
    let rows = [];
    try { rows = await db.listLivePlacements(slot); } catch (e) { rows = []; }
    placementCache.set(slot, { at: Date.now(), rows });
    return rows;
  }

  function inWindow(start, end, now) {
    return (!start || new Date(start).getTime() <= now) && (!end || new Date(end).getTime() > now);
  }

  // A cosmetic is only "Sponsored" when its own item id is targeted: 'all'
  // would mark every item in the shop.
  function targetMatches(targets, target, slot) {
    const list = String(targets || 'all').split(',').map((s) => s.trim()).filter(Boolean);
    if (list.includes('all')) return slot !== 'cosmetic';
    return Boolean(target) && list.includes(target);
  }

  // Logos only from our own storage, never hot-linked from a sponsor's site.
  function safeLogo(url) {
    if (!url) return null;
    try {
      const u = new URL(url, siteOrigin || 'https://www.spikeandcrush.com');
      if (u.protocol !== 'https:' && u.hostname !== 'localhost') return null;
      if (url.startsWith('/')) return url;
      return logoHosts.includes(u.hostname) ? u.toString() : null;
    } catch (e) {
      return null;
    }
  }

  function live(row, now) {
    const s = row.sponsor;
    return row.status === 'active' && inWindow(row.starts_at, row.ends_at, now) && s && s.status === 'active' && inWindow(s.starts_at, s.ends_at, now);
  }

  function publicPayload(row) {
    const def = SLOTS[row.slot];
    const s = row.sponsor;
    const creative = def.creative === 'text' ? 'text' : row.creative || def.creative;
    return {
      placementId: row.id,
      slot: row.slot,
      label: def.label,
      lead: def.lead || null,
      sponsor: {
        name: s.name,
        logoUrl: creative === 'text' ? null : safeLogo(s.logo_url),
        logoDarkUrl: creative === 'text' ? null : safeLogo(s.logo_dark_url),
        tagline: creative === 'logo' || creative === 'text' ? null : row.tagline || s.tagline || null,
      },
      cta: creative === 'logo_tagline_cta' && row.cta_text ? { text: String(row.cta_text).slice(0, 24) } : null,
      href: `/go/${row.id}`,
    };
  }

  function weightedPick(rows) {
    const total = rows.reduce((a, r) => a + Math.max(1, r.weight || 1), 0);
    let x = Math.random() * total;
    for (const r of rows) { x -= Math.max(1, r.weight || 1); if (x < 0) return r; }
    return rows[rows.length - 1];
  }

  // Weighted order without replacement (lobby strip shows several).
  function weightedOrder(rows) {
    const pool = rows.slice();
    const out = [];
    while (pool.length) { const r = weightedPick(pool); out.push(r); pool.splice(pool.indexOf(r), 1); }
    return out;
  }

  async function resolve(slot, target, { now = Date.now(), previewId = null, max = null } = {}) {
    if (!SLOTS[slot]) return [];
    if (previewId) {
      const row = await db.getPlacementWithSponsor(previewId).catch(() => null);
      return row && row.slot === slot ? [publicPayload(row)] : [];
    }
    if (!(await enabled())) return [];
    const rows = (await rowsFor(slot)).filter((r) => live(r, now) && targetMatches(r.targets, target, slot));
    if (!rows.length) return [];
    if (SLOTS[slot].multi) return weightedOrder(rows).slice(0, max || (await maxTiles())).map(publicPayload);
    // One presenting sponsor per competition / target: a specific target beats "all".
    const specific = rows.filter((r) => String(r.targets || '') !== 'all');
    return [publicPayload(weightedPick(specific.length ? specific : rows))];
  }

  async function sponsorNameFor(slot, target) {
    const [p] = await resolve(slot, target);
    return p ? p.sponsor.name : null;
  }

  // ---- admin preview tokens -------------------------------------------------------------
  function previewToken(placementId, ttlMs) {
    return signPreview(secret, placementId, ttlMs);
  }
  function verifyPreview(token) {
    const [id, exp, sig] = String(token || '').split('.');
    if (!id || !exp || !sig || Number(exp) < Date.now()) return null;
    const want = crypto.createHmac('sha256', hmacKey).update(`preview|${id}|${exp}`).digest('hex').slice(0, 32);
    if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
    return id;
  }

  // ---- counting (aggregate only) ------------------------------------------------------
  const pending = new Map(); // `${placementId}|${day}` -> { impressions, unique, clicks, entries, outbound }
  const lastSeen = new Map(); // `${viewer}|${placementId}` -> ms
  const perViewerMinute = new Map(); // viewer -> { minute, n }
  let uniqueDay = null;
  let uniqueKeys = new Set();

  const today = () => new Date().toISOString().slice(0, 10);
  function bump(placementId, field, n = 1) {
    const key = `${placementId}|${today()}`;
    const cur = pending.get(key) || { impressions: 0, unique: 0, clicks: 0, entries: 0, outbound: 0 };
    cur[field] += n;
    pending.set(key, cur);
  }

  function viewerKey(viewerId, req) {
    if (viewerId) return `u:${viewerId}`;
    const ip = req.ip || req.socket?.remoteAddress || '';
    return `ip:${crypto.createHmac('sha256', hmacKey).update(ip).digest('hex').slice(0, 16)}`;
  }

  function isBot(req) {
    return BOT_UA.test(String(req.get('user-agent') || ''));
  }

  // Returns how many impressions were counted.
  function countImpressions(ids, viewer, now = Date.now()) {
    const minute = Math.floor(now / 60000);
    const pm = perViewerMinute.get(viewer);
    const used = pm && pm.minute === minute ? pm.n : 0;
    let counted = 0;
    const day = today();
    if (uniqueDay !== day) { uniqueDay = day; uniqueKeys = new Set(); }
    for (const id of ids) {
      if (used + counted >= MAX_IMPRESSIONS_PER_MIN) break;
      const k = `${viewer}|${id}`;
      if (now - (lastSeen.get(k) || 0) < DEDUPE_MS) continue;
      lastSeen.set(k, now);
      bump(id, 'impressions');
      const uk = crypto.createHmac('sha256', hmacKey).update(`${day}|${viewer}|${id}`).digest('hex');
      if (!uniqueKeys.has(uk)) { uniqueKeys.add(uk); bump(id, 'unique'); }
      counted += 1;
    }
    perViewerMinute.set(viewer, { minute, n: used + counted });
    return counted;
  }

  async function flush() {
    const items = [...pending.entries()];
    pending.clear();
    for (const [key, v] of items) {
      const [placementId, day] = key.split('|');
      try {
        await db.bumpSponsorStats({ placementId, day, impressions: v.impressions, unique: v.unique, clicks: v.clicks, entries: v.entries, outbound: v.outbound });
      } catch (e) {
        console.warn('[sponsor stats] flush failed:', e.message);
      }
    }
    // keep the dedupe maps small
    const cutoff = Date.now() - DEDUPE_MS * 2;
    for (const [k, t] of lastSeen) if (t < cutoff) lastSeen.delete(k);
    return items.length;
  }
  const flushTimer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();

  async function recordEntry(target) {
    for (const p of await resolve('competition_card', target)) bump(p.placementId, 'entries');
  }

  function outboundUrl(row) {
    const s = row.sponsor;
    const base = row.cta_url || s.link_url;
    if (!isHttpsUrl(base)) return null;
    const u = new URL(base);
    const partner = String(row.targets || '').startsWith('partner:');
    const set = (k, v) => { if (v && !u.searchParams.has(k)) u.searchParams.set(k, v); };
    set('utm_source', s.utm_source || 'spikeandcrush');
    set('utm_medium', partner ? 'partner_competition' : s.utm_medium || 'sponsorship');
    set('utm_campaign', s.utm_campaign || s.slug || 'spikeandcrush');
    set('utm_content', row.slot);
    // A non-personal reference so the partner can match sign-ups back to us.
    set('sc_ref', String(row.id).replace(/-/g, '').slice(0, 12));
    return u.toString();
  }

  // ---- routes ---------------------------------------------------------------------------
  function router() {
    const r = express.Router();
    const readLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false });
    const seenLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
    const goLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

    // GET /api/slots?want=slot:target,slot:target[&preview=token]
    r.get('/api/slots', readLimiter, async (req, res) => {
      const wants = String(req.query.want || '').split(',').slice(0, 12).map((w) => w.split(':'));
      const previewId = req.query.preview ? verifyPreview(req.query.preview) : null;
      const out = {};
      for (const [slot, ...rest] of wants) {
        if (!SLOTS[slot]) continue;
        const target = rest.join(':') || null;
        out[`${slot}:${target || ''}`] = await resolve(slot, target, { previewId });
      }
      res.set('Cache-Control', 'no-store');
      res.json({ slots: out, enabled: await enabled() });
    });

    // Batched impressions: { ids: [placementId, ...] } (slot was at least half visible for a second)
    r.post('/api/slots/seen', seenLimiter, async (req, res) => {
      if (isBot(req)) return res.json({ counted: 0 });
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => /^[0-9a-f-]{36}$/i.test(String(x))).slice(0, 20);
      const viewerId = await optionalViewerId(req).catch(() => null);
      res.json({ counted: countImpressions([...new Set(ids)], viewerKey(viewerId, req)) });
    });

    // Every sponsor click: count, then redirect with UTM tags. No player data in the URL.
    r.get('/go/:id', goLimiter, async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.redirect(302, '/');
      const row = await db.getPlacementWithSponsor(req.params.id).catch(() => null);
      const url = row && live(row, Date.now()) ? outboundUrl(row) : null;
      if (!url) return res.redirect(302, '/');
      if (!isBot(req)) bump(row.id, String(row.targets || '').startsWith('partner:') ? 'outbound' : 'clicks');
      res.set('Referrer-Policy', 'no-referrer');
      res.redirect(302, url);
    });

    return r;
  }

  return { SLOTS, SLOT_NAMES, resolve, sponsorNameFor, previewToken, verifyPreview, countImpressions, flush, recordEntry, outboundUrl, isBot, router, _bump: bump, _pending: pending, _clearCache: () => { placementCache = new Map(); enabledCache = { at: 0, value: true }; tilesCache = { at: 0, value: 6 }; } };
}

module.exports = { createSponsorSlots, signPreview, SLOTS, SLOT_NAMES, BOT_UA };
