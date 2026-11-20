'use strict';

// First-touch attribution: where a player first came from, sent by the browser
// with the sign-up form (client/js/analytics.js firstTouch) and saved once on
// the player record. Short codes only: campaign tags, the referring site's
// host, the landing path. Never a full URL with its query, never free text.

const s60 = (v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/[^\w .:/@+-]/g, '').slice(0, 60) || null : null);

function host(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  try { return new URL(ref).hostname.toLowerCase().replace(/^www\./, '').slice(0, 80); } catch (e) { return null; }
}
function path(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  return p.split(/[?#]/)[0].slice(0, 120);
}

function clean(ft) {
  if (!ft || typeof ft !== 'object') return null;
  const out = { first_source: s60(ft.source), first_medium: s60(ft.medium), first_campaign: s60(ft.campaign), first_referrer: host(ft.referrer), first_partner: s60(ft.partner), first_landing: path(ft.landing) };
  // A visit with no tags from another site: the source is that site.
  if (!out.first_source && out.first_referrer) out.first_source = out.first_referrer;
  if (!out.first_source) out.first_source = 'direct';
  return out;
}

// Saves once (never overwrites an earlier first touch). Never throws.
async function save(db, playerId, ft) {
  const c = clean(ft) || { first_source: 'unknown' };
  try {
    const existing = await db.getPlayerById(playerId);
    if (existing && existing.first_source) return false;
    await db.updatePlayer(playerId, { ...c, first_seen_at: new Date().toISOString() });
    return true;
  } catch (e) {
    return false; // the column may not exist yet (migration not run): sign-up still works
  }
}

// The same fields for the sign-up event row.
function eventFields(ft) {
  const c = clean(ft);
  if (!c) return {};
  return { utmSource: c.first_source, utmMedium: c.first_medium, utmCampaign: c.first_campaign, partnerId: c.first_partner, referrerHost: c.first_referrer, page: c.first_landing };
}

module.exports = { clean, save, eventFields };
