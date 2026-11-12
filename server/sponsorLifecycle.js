'use strict';

// Sponsor placement lifecycle: where a placement's dates put it, the hourly
// job that keeps that current, and the end-of-placement reminder emails.
//
// `status` stays the admin's own setting (draft / active / paused / ended).
// `lifecycle` is derived from the dates:
//   scheduled  starts in the future
//   active     running now
//   expiring   running, ends within `expiringDays` (default 10)
//   expired    end date passed (status is set to 'ended' at the same time)
//   archived   hidden from lists and the calendar; stats and audit kept
// Serving never depends on this job: the slot code checks status and dates
// itself, so an expired placement stops serving the minute it ends.

const DAY = 86400000;
const DEFAULTS = Object.freeze({
  enabled: true,
  adminEmail: 'hello@spikeandcrush.com',
  expiringDays: 10,
  digest: false,
  maxEmailsPerRun: 40,
});
const MILESTONES = [
  { key: 'd10', days: 10, label: '10 days' },
  { key: 'd2', days: 2, label: '2 days' },
  { key: 'd0', days: 0, label: 'today' },
];

function lifecycleFor(p, now = Date.now(), { expiringDays = DEFAULTS.expiringDays } = {}) {
  if (p.archived_at) return 'archived';
  const start = p.starts_at ? Date.parse(p.starts_at) : -Infinity;
  const end = p.ends_at ? Date.parse(p.ends_at) : Infinity;
  if (end <= now) return 'expired';
  if (start > now) return 'scheduled';
  if (end - now <= expiringDays * DAY) return 'expiring';
  return 'active';
}

// Which reminder milestones are due now and not yet sent. d0 is "expired
// today" (sent once it has ended, within a day); d10 and d2 fire once the
// end is that close, but never for a placement that has already ended, and
// only the nearest due milestone is sent (a placement created 1 day before
// its end gets the 2-day notice, not the 10-day one as well).
function milestonesDue(p, sentKeys, now = Date.now()) {
  if (!p.ends_at || p.archived_at || p.status === 'draft') return [];
  const end = Date.parse(p.ends_at);
  const left = end - now;
  const sent = new Set(sentKeys || []);
  if (left <= 0) return left > -DAY && !sent.has('d0') ? ['d0'] : [];
  const due = MILESTONES.filter((m) => m.days > 0 && left <= m.days * DAY);
  if (!due.length) return [];
  const nearest = due[due.length - 1];
  return sent.has(nearest.key) ? [] : [nearest.key];
}

function milestoneLabel(key) {
  return (MILESTONES.find((m) => m.key === key) || {}).label || key;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmtDate = (iso) => (iso ? new Date(iso).toUTCString().replace(':00 GMT', ' UTC') : 'open');

// One reminder block: placement, slot, dates, stats so far, link to extend.
function reminderBlock(r, adminUrl) {
  return `<tr><td style="padding:14px 0;border-bottom:1px solid #1D2638">
    <div style="font:600 15px Inter,Arial,sans-serif;color:#E8ECF4">${escapeHtml(r.sponsorName)} · ${escapeHtml(r.slotName)}${r.targets && r.targets !== 'all' ? ` (${escapeHtml(r.targets)})` : ''}</div>
    <div style="font:13px Inter,Arial,sans-serif;color:#9AA4B8;margin-top:4px">${r.milestone === 'd0' ? 'Ended' : `Ends in ${escapeHtml(milestoneLabel(r.milestone))}`}: ${escapeHtml(fmtDate(r.endsAt))}. Started ${escapeHtml(fmtDate(r.startsAt))}.</div>
    <div style="font:13px Inter,Arial,sans-serif;color:#9AA4B8;margin-top:4px">So far: ${r.stats.impressions} impressions, ${r.stats.clicks} clicks${r.stats.impressions ? ` (${((r.stats.clicks / r.stats.impressions) * 100).toFixed(2)}% CTR)` : ''}.</div>
    <div style="margin-top:8px"><a href="${escapeHtml(adminUrl)}/sponsors.html?placement=${encodeURIComponent(r.placementId)}" style="color:#F5B83D;font:600 13px Inter,Arial,sans-serif">Extend or renew</a></div>
  </td></tr>`;
}

function wrapEmail(title, inner) {
  return `<div style="background:#07090F;padding:24px"><table role="presentation" style="max-width:560px;margin:0 auto;background:#0E1320;border-radius:14px;padding:24px;width:100%">
    <tr><td style="font:700 20px Rajdhani,Inter,Arial,sans-serif;color:#F5B83D;padding-bottom:6px">SPIKE &amp; CRUSH</td></tr>
    <tr><td style="font:600 16px Inter,Arial,sans-serif;color:#E8ECF4;padding-bottom:8px">${escapeHtml(title)}</td></tr>
    ${inner}
  </table></div>`;
}

function reminderEmail(r, adminUrl) {
  const title = r.milestone === 'd0' ? `Sponsor placement ended: ${r.sponsorName}` : `Sponsor placement ends in ${milestoneLabel(r.milestone)}: ${r.sponsorName}`;
  return { subject: title, html: wrapEmail(title, reminderBlock(r, adminUrl)) };
}

function digestEmail(rows, adminUrl) {
  const title = `${rows.length} sponsor placement${rows.length === 1 ? '' : 's'} ending or ended`;
  return { subject: title, html: wrapEmail(title, rows.map((r) => reminderBlock(r, adminUrl)).join('')) };
}

// Contact-facing version: no admin link, plain wording.
function contactEmail(r, siteUrl) {
  const title = r.milestone === 'd0' ? `Your Spike & Crush placement has ended` : `Your Spike & Crush placement ends in ${milestoneLabel(r.milestone)}`;
  const inner = `<tr><td style="font:14px Inter,Arial,sans-serif;color:#C8D0DE;line-height:1.5">${escapeHtml(r.slotName)} for ${escapeHtml(r.sponsorName)} ${r.milestone === 'd0' ? 'ended' : 'ends'} on ${escapeHtml(fmtDate(r.endsAt))}. So far it has had ${r.stats.impressions} impressions and ${r.stats.clicks} clicks. Reply to this email to extend or renew.</td></tr>
    <tr><td style="padding-top:12px"><a href="${escapeHtml(siteUrl)}" style="color:#F5B83D;font:600 13px Inter,Arial,sans-serif">spikeandcrush.com</a></td></tr>`;
  return { subject: title, html: wrapEmail(title, inner) };
}

async function must(q) {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

async function readConfig(sb) {
  const { data } = await sb.from('app_settings').select('value').eq('key', 'sponsors.reminders').maybeSingle();
  return { ...DEFAULTS, ...((data && data.value) || {}) };
}

// Stats for a sponsor's placements, including placements since deleted (their
// rows were copied to sponsor_stats_archive first).
async function loadSponsorStats(sb, sponsorId, fromDay, toDay) {
  const placements = await must(sb.from('sponsor_placements').select('id, slot, targets, status, starts_at, ends_at').eq('sponsor_id', sponsorId));
  const ids = (placements || []).map((p) => p.id);
  const days = ids.length
    ? await must(sb.from('sponsor_stats_daily').select('placement_id, day, impressions, unique_viewers, clicks, entries, outbound_clicks').in('placement_id', ids).gte('day', fromDay).lte('day', toDay).order('day'))
    : [];
  let archived = [];
  const arch = await sb.from('sponsor_stats_archive').select('placement_id, slot, targets, day, impressions, unique_viewers, clicks, entries, outbound_clicks').eq('sponsor_id', sponsorId).gte('day', fromDay).lte('day', toDay).order('day');
  if (!arch.error) archived = arch.data || [];
  const gone = new Map();
  for (const a of archived) if (!gone.has(a.placement_id)) gone.set(a.placement_id, { id: a.placement_id, slot: a.slot, targets: a.targets, status: 'deleted', starts_at: null, ends_at: null });
  return {
    placements: [...(placements || []), ...gone.values()],
    days: [...(days || []), ...archived.map(({ slot, targets, ...d }) => d)].sort((x, y) => String(x.day).localeCompare(String(y.day))),
  };
}

async function totalsFor(sb, placementIds) {
  if (!placementIds.length) return new Map();
  const rows = await must(sb.from('sponsor_stats_daily').select('placement_id, impressions, clicks').in('placement_id', placementIds));
  const out = new Map();
  for (const r of rows || []) {
    const t = out.get(r.placement_id) || { impressions: 0, clicks: 0 };
    t.impressions += r.impressions || 0;
    t.clicks += r.clicks || 0;
    out.set(r.placement_id, t);
  }
  return out;
}

// The hourly job. Returns what it did (also used by the tests and the admin
// "run now" button). sendEmail({to, subject, html, idempotencyKey}).
async function runLifecycle(sb, { now = Date.now(), sendEmail, slotName = (s) => s, adminUrl = '', siteUrl = 'https://www.spikeandcrush.com', log = () => {} } = {}) {
  const cfg = await readConfig(sb);
  const report = { moved: [], expired: [], reminders: [], skipped: 0, digest: false };
  const rows = await must(sb.from('sponsor_placements').select('id, sponsor_id, slot, targets, status, starts_at, ends_at, lifecycle, archived_at, remind_contact, sponsor:sponsors(name, contact_email, remind_contact, status)'));

  // 1. lifecycle column (and status 'ended' once expired)
  for (const p of rows || []) {
    const next = lifecycleFor(p, now, cfg);
    const patch = {};
    if (p.lifecycle !== next) patch.lifecycle = next;
    if (next === 'expired' && p.status !== 'ended' && p.status !== 'draft') patch.status = 'ended';
    if (patch.status) patch.active = false;
    if (Object.keys(patch).length) {
      patch.updated_at = new Date(now).toISOString();
      await must(sb.from('sponsor_placements').update(patch).eq('id', p.id));
      report.moved.push({ id: p.id, from: p.lifecycle || null, to: next });
      if (patch.status === 'ended') report.expired.push(p.id);
      p.lifecycle = next;
      if (patch.status) p.status = patch.status;
    }
  }
  if (!cfg.enabled) return report;

  // 2. reminders: one per placement per milestone, claimed in the table first
  const ids = (rows || []).map((p) => p.id);
  const sentRows = ids.length ? await must(sb.from('sponsor_reminders').select('placement_id, milestone').in('placement_id', ids)) : [];
  const sentBy = new Map();
  for (const s of sentRows || []) {
    if (!sentBy.has(s.placement_id)) sentBy.set(s.placement_id, []);
    sentBy.get(s.placement_id).push(s.milestone);
  }
  const due = [];
  for (const p of rows || []) {
    for (const m of milestonesDue(p, sentBy.get(p.id), now)) due.push({ p, milestone: m });
  }
  if (!due.length) return report;
  const totals = await totalsFor(sb, [...new Set(due.map((d) => d.p.id))]);
  const items = due.map(({ p, milestone }) => ({
    placementId: p.id, milestone, sponsorName: (p.sponsor && p.sponsor.name) || 'Sponsor', slotName: slotName(p.slot), targets: p.targets,
    startsAt: p.starts_at, endsAt: p.ends_at, stats: totals.get(p.id) || { impressions: 0, clicks: 0 },
    contact: (p.remind_contact || (p.sponsor && p.sponsor.remind_contact)) && p.sponsor && p.sponsor.contact_email ? p.sponsor.contact_email : null,
  }));

  let sent = 0;
  const claimed = [];
  for (const it of items) {
    if (sent >= cfg.maxEmailsPerRun) { report.skipped++; continue; }
    // The primary key makes this the one-time claim; a second run (or a
    // second server) finds the row and sends nothing.
    const recipients = [cfg.adminEmail, it.contact].filter(Boolean);
    const { error } = await sb.from('sponsor_reminders').insert({ placement_id: it.placementId, milestone: it.milestone, recipients, digest: Boolean(cfg.digest), sent_at: new Date(now).toISOString() });
    if (error) {
      if (/duplicate key|23505/.test(error.message + (error.code || ''))) continue;
      throw error;
    }
    claimed.push(it);
    if (!cfg.digest) {
      const mail = reminderEmail(it, adminUrl);
      await sendEmail({ to: cfg.adminEmail, ...mail, idempotencyKey: `sponsor-reminder:${it.placementId}:${it.milestone}` });
      sent++;
    }
    if (it.contact) {
      const mail = contactEmail(it, siteUrl);
      await sendEmail({ to: it.contact, ...mail, idempotencyKey: `sponsor-reminder-contact:${it.placementId}:${it.milestone}` });
      sent++;
    }
    report.reminders.push({ placementId: it.placementId, milestone: it.milestone, recipients });
  }
  if (cfg.digest && claimed.length) {
    const mail = digestEmail(claimed, adminUrl);
    const day = new Date(now).toISOString().slice(0, 13);
    await sendEmail({ to: cfg.adminEmail, ...mail, idempotencyKey: `sponsor-reminder-digest:${day}:${claimed.map((c) => `${c.placementId.slice(0, 8)}${c.milestone}`).join(',').slice(0, 180)}` });
    report.digest = true;
  }
  log(`[sponsors] lifecycle: ${report.moved.length} moved, ${report.expired.length} expired, ${report.reminders.length} reminders${report.digest ? ' (digest)' : ''}${report.skipped ? `, ${report.skipped} held for next run` : ''}`);
  return report;
}

module.exports = { DEFAULTS, MILESTONES, lifecycleFor, milestonesDue, readConfig, runLifecycle, loadSponsorStats, reminderEmail, digestEmail, contactEmail };
