'use strict';

// The aggregate sponsor report: impressions, unique viewers, clicks, CTR, by
// day, page and device, for one sponsor and a date range. Built only from
// counts. The output never contains a player id, a visitor hash, an address,
// an email or a session id: rows are reduced to totals before they leave here.
//
// Definitions:
//   impression      placement_impression (at least half visible for 1 s, once
//                   per visit per placement, bots and internal traffic out)
//   unique viewers  distinct visitors per day (signed-in player, or the daily
//                   visitor hash), summed over days
//   click           placement_click or partner_link_click on this sponsor's placements
//   CTR             clicks / impressions

const def = require('./definitions');
const { createPage, buildPdf, PDF_COLORS, PDF_SIZE } = require('../statementPdf');

function emptyTotals() { return { impressions: 0, unique_viewers: 0, clicks: 0, unique_clickers: 0 }; }
const ctr = (t) => (t.impressions ? Math.round((t.clicks / t.impressions) * 10000) / 100 : 0);

// events: analytics_events rows for the sponsor's placements in the range.
function build({ sponsor, placements, events, fromDay, toDay, tz = 'dubai' }) {
  const bySlot = new Map(placements.map((p) => [p.id, p.slot]));
  const totals = emptyTotals();
  const days = new Map(def.dayList(fromDay, toDay).map((d) => [d, emptyTotals()]));
  const pages = new Map();
  const devices = new Map();
  const slots = new Map();
  const seenV = new Set();
  const seenC = new Set();
  const bump = (map, key, f) => { const k = key || 'unknown'; if (!map.has(k)) map.set(k, emptyTotals()); map.get(k)[f] += 1; };
  for (const e of events) {
    if (e.is_internal) continue;
    const d = def.dayOf(e.occurred_at, tz);
    if (!days.has(d)) continue;
    const who = `${d}|${e.user_id ? `u${e.user_id}` : `v${e.visitor_day_hash || e.id}`}`;
    const slot = bySlot.get(e.placement_id) || (e.properties && e.properties.slot) || 'unknown';
    if (e.event_name === 'placement_impression') {
      totals.impressions++; days.get(d).impressions++;
      bump(pages, e.page, 'impressions'); bump(devices, e.device_class, 'impressions'); bump(slots, slot, 'impressions');
      const k = `${who}|${e.placement_id}`;
      if (!seenV.has(who)) { seenV.add(who); totals.unique_viewers++; days.get(d).unique_viewers++; }
      if (!seenV.has(k)) seenV.add(k);
    } else if (e.event_name === 'placement_click' || e.event_name === 'partner_link_click') {
      totals.clicks++; days.get(d).clicks++;
      bump(pages, e.page, 'clicks'); bump(devices, e.device_class, 'clicks'); bump(slots, slot, 'clicks');
      if (!seenC.has(who)) { seenC.add(who); totals.unique_clickers++; days.get(d).unique_clickers++; }
    }
  }
  const rows = (m) => [...m.entries()].map(([key, t]) => ({ key, ...t, ctr: ctr(t) })).sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
  return {
    sponsor: { name: sponsor.name },
    range: { from: fromDay, to: toDay, timezone: def.tzKey(tz) === 'utc' ? 'UTC' : 'Asia/Dubai' },
    totals: { ...totals, ctr: ctr(totals) },
    byDay: [...days.entries()].map(([day, t]) => ({ day, ...t, ctr: ctr(t) })),
    byPage: rows(pages),
    byDevice: rows(devices),
    byPlacement: rows(slots),
    definitions: 'Impression: placement at least half visible for 1 second, counted once per visit, bots and internal traffic excluded. Unique viewers: distinct visitors per day. CTR: clicks divided by impressions. No personal data is included.',
  };
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(r) {
  const lines = [`Sponsor report,${csvCell(r.sponsor.name)},${r.range.from} to ${r.range.to} (${r.range.timezone})`, '', 'section,key,impressions,unique_viewers,clicks,unique_clickers,ctr_percent'];
  lines.push(['total', 'all', r.totals.impressions, r.totals.unique_viewers, r.totals.clicks, r.totals.unique_clickers, r.totals.ctr].map(csvCell).join(','));
  for (const d of r.byDay) lines.push(['day', d.day, d.impressions, d.unique_viewers, d.clicks, d.unique_clickers, d.ctr].map(csvCell).join(','));
  for (const [section, list] of [['page', r.byPage], ['device', r.byDevice], ['placement', r.byPlacement]]) for (const x of list) lines.push([section, x.key, x.impressions, x.unique_viewers, x.clicks, x.unique_clickers, x.ctr].map(csvCell).join(','));
  lines.push('', csvCell(r.definitions));
  return lines.join('\n');
}

function toPdf(r) {
  const { GOLD, INK, MUTED } = PDF_COLORS;
  const { W, H, M } = PDF_SIZE;
  const pages = [];
  let page; let y;
  const newPage = () => {
    page = createPage(); pages.push(page);
    page.rect(0, H - 70, W, 70, INK); page.rect(0, H - 73, W, 3, GOLD);
    page.text(M, H - 34, 'SPIKE & CRUSH', { size: 16, bold: true, color: GOLD });
    page.text(M, H - 52, `Sponsor report: ${r.sponsor.name}`, { size: 10, color: [0.91, 0.93, 0.96] });
    page.textRight(W - M, H - 52, `${r.range.from} to ${r.range.to} (${r.range.timezone})`, { size: 9, color: [0.91, 0.93, 0.96] });
    y = H - 100;
  };
  const need = (h) => { if (y - h < 50) newPage(); };
  newPage();
  const t = r.totals;
  const tiles = [['Impressions', t.impressions], ['Unique viewers', t.unique_viewers], ['Clicks', t.clicks], ['CTR', `${t.ctr}%`]];
  tiles.forEach(([label, v], i) => { const x = M + i * ((W - 2 * M) / 4); page.text(x, y, label, { size: 8, color: MUTED }); page.text(x, y - 18, String(v), { size: 16, bold: true }); });
  y -= 46;
  const table = (title, list, keyLabel) => {
    need(40);
    page.text(M, y, title, { size: 11, bold: true }); y -= 16;
    const cols = [M, M + 230, M + 300, M + 380, M + 450];
    [keyLabel, 'Impressions', 'Unique', 'Clicks', 'CTR'].forEach((h, i) => (i ? page.textRight(cols[i] + 50, y, h, { size: 8, color: MUTED }) : page.text(cols[0], y, h, { size: 8, color: MUTED })));
    y -= 12;
    for (const x of list) {
      need(14);
      page.text(cols[0], y, String(x.key || x.day).slice(0, 44), { size: 8 });
      page.textRight(cols[1] + 50, y, String(x.impressions), { size: 8 });
      page.textRight(cols[2] + 50, y, String(x.unique_viewers), { size: 8 });
      page.textRight(cols[3] + 50, y, String(x.clicks), { size: 8 });
      page.textRight(cols[4] + 50, y, `${x.ctr}%`, { size: 8 });
      y -= 12;
    }
    y -= 10;
  };
  table('By page', r.byPage, 'Page');
  table('By device', r.byDevice, 'Device');
  table('By placement', r.byPlacement, 'Placement');
  table('By day', r.byDay.map((d) => ({ ...d, key: d.day })), 'Day');
  need(40);
  const words = r.definitions.split(' ');
  let line = '';
  for (const w of words) { if ((line + ' ' + w).length > 110) { page.text(M, y, line.trim(), { size: 7, color: MUTED }); y -= 10; line = ''; } line += ` ${w}`; }
  if (line) page.text(M, y, line.trim(), { size: 7, color: MUTED });
  return buildPdf(pages);
}

module.exports = { build, toCsv, toPdf };
