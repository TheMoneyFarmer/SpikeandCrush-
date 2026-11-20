'use strict';

// Writes analytics_events and tech_events. Batched (a timer flushes every
// 2 seconds, at most 500 rows per insert), bounded (oldest dropped past
// 5,000 waiting), and never throws into the caller: tracking must never slow
// or break the game. Nothing here is called per price tick.
//
// Internal traffic is marked, not dropped: at flush the user ids are looked up
// once (players.is_internal / is_persona, cached for 10 minutes) and the row's
// is_internal is set, so the dashboard toggle can include or exclude it.

const { EVENTS, SCHEMA_VERSION } = require('./catalogue');
const ctx = require('./context');

const FLUSH_MS = 2000;
const MAX_QUEUE = 5000;
const BATCH = 500;
const INTERNAL_TTL_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clip = (v, n = 60) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, n));

function cleanProps(name, props = {}) {
  const allowed = new Set(EVENTS[name] ? EVENTS[name].props : []);
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (!allowed.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === 'boolean') out[k] = v;
    else if (v !== null && v !== undefined) out[k] = String(v).slice(0, 40);
  }
  return out;
}

// Path only (no query string, no fragment), at most 120 characters.
function cleanPage(p) {
  if (!p) return null;
  try { return new URL(String(p), 'https://x.invalid').pathname.slice(0, 120); } catch (e) { return null; }
}
// Referrer host only; our own site counts as internal navigation (null).
function cleanReferrer(r, ownHosts = ['spikeandcrush.com', 'www.spikeandcrush.com', 'localhost']) {
  if (!r) return null;
  try {
    const h = new URL(String(r)).hostname.toLowerCase().replace(/^www\./, '');
    return ownHosts.map((x) => x.replace(/^www\./, '')).includes(h) ? null : h.slice(0, 80);
  } catch (e) { return null; }
}

function createWriter({ client, now = () => Date.now(), log = console, flushMs = FLUSH_MS } = {}) {
  let queue = [];
  let techQueue = [];
  let warned = false;
  let flushing = false;
  const internalCache = new Map(); // id -> { v, at }
  const stats = { accepted: 0, written: 0, dropped: 0, failed: 0, lastWriteAt: null };

  function row(name, f = {}) {
    if (!EVENTS[name]) { stats.dropped++; return null; }
    const r = {
      occurred_at: new Date(f.at || now()).toISOString(),
      event_name: name,
      schema_version: SCHEMA_VERSION,
      source: f.source === 'client' ? 'client' : 'server',
      anonymous_id: clip(f.anonymousId, 40),
      visitor_day_hash: clip(f.visitorDayHash, 40),
      user_id: f.userId && UUID.test(String(f.userId)) ? String(f.userId) : null,
      session_id: clip(f.sessionId, 40),
      page: cleanPage(f.page),
      referrer: f.referrerHost !== undefined ? clip(f.referrerHost, 80) : cleanReferrer(f.referrer),
      utm_source: clip(f.utmSource),
      utm_medium: clip(f.utmMedium),
      utm_campaign: clip(f.utmCampaign),
      partner_id: clip(f.partnerId),
      placement_id: f.placementId && UUID.test(String(f.placementId)) ? String(f.placementId) : null,
      device_class: clip(f.deviceClass, 12),
      browser_family: clip(f.browserFamily, 12),
      coarse_country: f.country && /^[A-Z]{2}$/.test(f.country) ? f.country : null,
      mode: clip(f.mode, 20),
      match_id: clip(f.matchId, 40),
      properties: cleanProps(name, f.props),
      is_internal: Boolean(f.internal),
    };
    return r;
  }

  // track('login', { req, userId, props: { method: 'password' } })
  function track(name, f = {}) {
    try {
      if (f.req) {
        const c = ctx.fromReq(f.req);
        f = { deviceClass: c.device_class, browserFamily: c.browser_family, country: c.coarse_country, visitorDayHash: c.visitor_day_hash, ...f };
      }
      const r = row(name, f);
      if (!r) return false;
      queue.push(r);
      stats.accepted++;
      if (queue.length > MAX_QUEUE) { stats.dropped += queue.length - MAX_QUEUE; queue = queue.slice(-MAX_QUEUE); }
      return true;
    } catch (e) {
      stats.dropped++;
      return false;
    }
  }

  // tech('client_freeze', { matchId, mode, playerId, valueMs })
  function tech(kind, f = {}) {
    techQueue.push({ at: new Date(f.at || now()).toISOString(), kind: String(kind).slice(0, 20), match_id: clip(f.matchId, 40), mode: clip(f.mode, 20), player_id: f.playerId && UUID.test(String(f.playerId)) ? f.playerId : null, value_ms: Number.isFinite(f.valueMs) ? Math.round(f.valueMs) : null, properties: f.props || {} });
    if (techQueue.length > MAX_QUEUE) techQueue = techQueue.slice(-MAX_QUEUE);
  }

  async function markInternal(rows) {
    const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))].filter((id) => { const c = internalCache.get(id); return !c || now() - c.at > INTERNAL_TTL_MS; });
    if (ids.length) {
      const { data } = await client().from('players').select('id, is_internal, is_persona').in('id', ids);
      for (const p of data || []) internalCache.set(p.id, { v: Boolean(p.is_internal || p.is_persona), at: now() });
    }
    for (const r of rows) if (r.user_id && internalCache.get(r.user_id)?.v) r.is_internal = true;
  }

  async function flush() {
    if (flushing) return 0;
    flushing = true;
    let n = 0;
    try {
      if (!client || !client()) { queue = []; techQueue = []; return 0; }
      while (queue.length) {
        const batch = queue.splice(0, BATCH);
        try {
          await markInternal(batch).catch(() => {});
          const { error } = await client().from('analytics_events').insert(batch);
          if (error) throw error;
          n += batch.length;
          stats.written += batch.length;
          stats.lastWriteAt = new Date(now()).toISOString();
        } catch (e) {
          stats.failed += batch.length;
          if (!warned) { warned = true; log.warn('[analytics] write failed (run the analytics migration?):', e.message); }
        }
      }
      while (techQueue.length) {
        const batch = techQueue.splice(0, BATCH);
        const { error } = await client().from('tech_events').insert(batch);
        if (error && !warned) { warned = true; log.warn('[analytics] tech write failed:', error.message); }
      }
    } finally {
      flushing = false;
    }
    return n;
  }

  const timer = setInterval(() => { flush().catch(() => {}); }, flushMs);
  if (timer.unref) timer.unref();

  return { track, tech, flush, stats, _queue: () => queue, _techQueue: () => techQueue };
}

let shared = null;
// The game server's writer (database client from server/database.js).
function analytics() {
  if (!shared) {
    const db = require('../database');
    shared = createWriter({ client: () => (db.isConfigured ? db.client() : null) });
  }
  return shared;
}

module.exports = { createWriter, analytics, cleanProps, cleanPage, cleanReferrer };
