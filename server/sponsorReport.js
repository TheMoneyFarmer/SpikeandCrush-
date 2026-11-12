'use strict';

// The sponsor report: one HTML renderer used by the admin export and by the
// read-only tokenised link (/sponsor-report/:token). Aggregate numbers only:
// impressions, unique viewers, clicks, entries, outbound clicks and players
// waiting, all as counts. Nothing here can name a player.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { visitorIp } = require('./originLock'); // the real visitor, not Cloudflare's edge address

const SLOT_LABELS = {
  lobby_strip: 'Lobby strip', competition_card: 'Competition card', prematch: 'Before the match', match_header_chip: 'Match header',
  spike_strip_tag: 'Spike alert strip', result_screen: 'Result screen', leaderboard_header: 'Leaderboard', event_banner: 'Event banner',
  email_footer: 'Email footer', cosmetic: 'Cosmetic item',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v || 0).toLocaleString('en-US');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// days: [{placement_id, day, impressions, unique_viewers, clicks, entries, outbound_clicks}]
function summarise({ placements, days }) {
  const byPlacement = new Map(placements.map((p) => [p.id, { ...p, impressions: 0, unique: 0, clicks: 0, entries: 0, outbound: 0 }]));
  const byDay = new Map();
  for (const d of days) {
    const p = byPlacement.get(d.placement_id);
    if (p) { p.impressions += d.impressions; p.unique += d.unique_viewers; p.clicks += d.clicks; p.entries += d.entries; p.outbound += d.outbound_clicks; }
    const t = byDay.get(d.day) || { impressions: 0, clicks: 0 };
    t.impressions += d.impressions; t.clicks += d.clicks + d.outbound_clicks;
    byDay.set(d.day, t);
  }
  const rows = [...byPlacement.values()];
  const total = rows.reduce((a, r) => ({ impressions: a.impressions + r.impressions, unique: a.unique + r.unique, clicks: a.clicks + r.clicks, entries: a.entries + r.entries, outbound: a.outbound + r.outbound }), { impressions: 0, unique: 0, clicks: 0, entries: 0, outbound: 0 });
  return { rows, total, byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)) };
}

function renderReport({ sponsor, fromDay, toDay, stats, waiting = [] }) {
  const { rows, total, byDay } = summarise(stats);
  const ctr = total.impressions ? `${((total.clicks + total.outbound) / total.impressions * 100).toFixed(2)}%` : '–';
  const max = Math.max(1, ...byDay.map(([, v]) => v.impressions));
  const W = 720, H = 160, bw = byDay.length ? Math.max(2, Math.floor(W / byDay.length) - 2) : 0;
  const bars = byDay.map(([day, v], i) => `<rect x="${i * (bw + 2)}" y="${(H - (v.impressions / max) * H).toFixed(1)}" width="${bw}" height="${((v.impressions / max) * H).toFixed(1)}" rx="3" fill="#3987e5"><title>${esc(day)}: ${n(v.impressions)} impressions</title></rect>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(sponsor.name)} report | Spike &amp; Crush</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#14213d;color:#f2f5fa;font:15px/1.5 Inter,system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px 48px}h1{font-weight:300;font-size:32px;margin:4px 0 0}
.k{font-size:12px;color:rgba(200,212,232,.72)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}
.t{background:#182746;border-radius:12px;padding:14px}.t b{display:block;font:600 24px 'JetBrains Mono',ui-monospace,monospace}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}th{text-align:left;font-weight:500;color:rgba(200,212,232,.72);font-size:12px;padding:8px;border-bottom:1px solid rgba(160,182,222,.2)}
td{padding:8px;border-bottom:1px solid rgba(160,182,222,.08)}td.m{font-family:'JetBrains Mono',ui-monospace,monospace;text-align:right}th.m{text-align:right}
.card{background:#182746;border-radius:12px;padding:16px;margin-top:16px;overflow-x:auto}.note{font-size:12px;color:rgba(200,212,232,.72);margin-top:24px}
.brand{font-weight:800}.s{color:#1fd38a}.c{color:#ff4d6a}
</style></head><body><main>
<div class="brand"><span class="s">Spike</span>&amp;<span class="c">Crush</span> <span class="k">Sponsor report</span></div>
<h1>${esc(sponsor.name)}</h1>
<div class="k">${esc(fromDay)} to ${esc(toDay)}</div>
<div class="tiles">
<div class="t"><span class="k">Impressions</span><b>${n(total.impressions)}</b></div>
<div class="t"><span class="k">Unique viewers (summed by day)</span><b>${n(total.unique)}</b></div>
<div class="t"><span class="k">Clicks</span><b>${n(total.clicks)}</b></div>
<div class="t"><span class="k">Outbound clicks</span><b>${n(total.outbound)}</b></div>
<div class="t"><span class="k">Competition entries</span><b>${n(total.entries)}</b></div>
<div class="t"><span class="k">Click-through rate</span><b>${ctr}</b></div>
</div>
<div class="card"><div class="k">Impressions per day</div>${byDay.length ? `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Impressions per day">${bars}</svg>` : '<p class="k">No impressions in this period.</p>'}</div>
<div class="card"><div class="k">By placement</div><table><thead><tr><th>Placement</th><th>Shown on</th><th class="m">Impressions</th><th class="m">Unique</th><th class="m">Clicks</th><th class="m">Outbound</th><th class="m">Entries</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(SLOT_LABELS[r.slot] || r.slot || '')}</td><td>${esc(r.targets || 'all')}</td><td class="m">${n(r.impressions)}</td><td class="m">${n(r.unique)}</td><td class="m">${n(r.clicks)}</td><td class="m">${n(r.outbound)}</td><td class="m">${n(r.entries)}</td></tr>`).join('') || '<tr><td colspan="7" class="k">No placements yet.</td></tr>'}
</tbody></table></div>
${waiting.length ? `<div class="card"><div class="k">Players waiting for a competition you present</div><table><tbody>${waiting.map((w) => `<tr><td>${esc(w.title)}</td><td class="m">${n(w.count)}</td></tr>`).join('')}</tbody></table></div>` : ''}
<p class="note">These counts come from Spike &amp; Crush's own measurement. An impression is counted when a placement is at least half on screen for at least one second, once per viewer per placement per minute; known bots are left out. Unique viewers are counted per day and summed across days. The report contains aggregate numbers only and never identifies a player.</p>
</main></body></html>`;
}

function createSponsorReportRouter({ db }) {
  const r = express.Router();
  const limiter = rateLimit({ keyGenerator: (req) => visitorIp(req), windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
  r.get('/sponsor-report/:token', limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    const gone = (msg) => res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"><title>Report unavailable</title><body style="background:#14213d;color:#f2f5fa;font:16px Inter,system-ui,sans-serif;padding:40px"><p>${esc(msg)}</p></body>`);
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(req.params.token) || !db.isConfigured) return gone('This report link is not valid.');
    try {
      const tok = await db.getSponsorReportToken(hashToken(req.params.token));
      if (!tok || tok.revoked_at) return gone('This report link has been turned off.');
      if (new Date(tok.expires_at).getTime() < Date.now()) return gone('This report link has expired.');
      const sponsor = await db.getSponsorById(tok.sponsor_id);
      if (!sponsor) return gone('This report link is not valid.');
      const toDay = new Date().toISOString().slice(0, 10);
      const fromDay = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const stats = await db.sponsorStats(sponsor.id, fromDay, toDay);
      const waiting = await waitingFor(db, stats.placements);
      res.type('html').send(renderReport({ sponsor, fromDay, toDay, stats, waiting }));
    } catch (e) {
      console.error('[sponsor report]', e.message);
      gone('This report is not available right now.');
    }
  });
  return r;
}

// "Players waiting" for each competition template the sponsor presents.
async function waitingFor(db, placements) {
  const keys = [...new Set((placements || []).flatMap((p) => String(p.targets || '').split(',')).map((t) => t.trim()).filter((t) => t.startsWith('competition:')).map((t) => t.slice(12)))];
  if (!keys.length) return [];
  const counts = await db.waitlistCounts().catch(() => ({}));
  const templates = await db.listCompTemplates().catch(() => []);
  return keys.map((k) => ({ title: (templates.find((t) => t.key === k) || {}).title || k, count: counts[k] || 0 }));
}

module.exports = { renderReport, summarise, createSponsorReportRouter, hashToken, waitingFor, SLOT_LABELS };
