'use strict';

// Admin Leads centre (server/leads.js stores them). Every route sits behind
// requireAdmin (admin/server.js); support agents are blocked by the support
// guard. Every change writes a lead_events row and the admin audit log.

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const { CATEGORIES, CATEGORY_LABEL } = require('../../server/leads');

const STATUSES = ['new', 'contacted', 'qualified', 'in_talks', 'won', 'lost', 'spam'];
const PRIORITIES = ['low', 'normal', 'high'];
const UUID_RE = /^[0-9a-f-]{36}$/i;
const LIST_FIELDS = 'id, created_at, updated_at, source_form, category, name, company, email, country, status, owner, priority, tags, next_followup_at, last_contact_at, read_at, email_status';

function router() {
  const r = express.Router();
  const who = (req) => req.admin.email || req.admin.username;
  const audit = (req, action, id, details) => logAdminAction({ adminUsername: req.admin.username, actionType: action, targetType: 'lead', targetId: id, details, ip: clientIp(req) });
  const event = (id, actor, kind, detail = {}) => supabase.from('lead_events').insert({ lead_id: id, actor, kind, detail });

  r.use((req, res, next) => (isConfigured ? next() : res.status(503).json({ error: 'Supabase not configured' })));

  function applyFilters(q, f) {
    if (f.category && CATEGORIES.includes(f.category)) q = q.eq('category', f.category);
    if (f.status && STATUSES.includes(f.status)) q = q.eq('status', f.status);
    else if (!f.includeSpam) q = q.neq('status', 'spam');
    if (f.priority && PRIORITIES.includes(f.priority)) q = q.eq('priority', f.priority);
    if (f.owner) q = f.owner === 'none' ? q.is('owner', null) : q.eq('owner', String(f.owner === 'me' ? f.me || '' : f.owner).slice(0, 200));
    // The shared admin date range control (preset or custom, admin's zone).
    if (f.preset && f.preset !== 'all') {
      try {
        const rng = require('../../server/dateRange').resolveRange(f);
        q = q.gte('created_at', new Date(rng.start).toISOString()).lt('created_at', new Date(rng.end).toISOString());
      } catch (e) { /* bad range: no date filter */ }
    }
    if (f.q) {
      const s = String(f.q).replace(/[%,()]/g, ' ').trim().slice(0, 80);
      if (s) q = q.or(`name.ilike.%${s}%,company.ilike.%${s}%,email.ilike.%${s}%,message.ilike.%${s}%`);
    }
    return q;
  }

  // Tabs with counts, plus how many are still unread and New.
  r.get('/counts', async (req, res) => {
    try {
      const { data, error } = await supabase.from('leads').select('category, status, read_at').neq('status', 'spam').limit(20000);
      if (error) throw error;
      const counts = Object.fromEntries(CATEGORIES.map((c) => [c, { total: 0, unreadNew: 0 }]));
      for (const l of data) {
        counts[l.category].total++;
        if (l.status === 'new' && !l.read_at) counts[l.category].unreadNew++;
      }
      res.json({ counts, labels: CATEGORY_LABEL, all: { total: data.length, unreadNew: data.filter((l) => l.status === 'new' && !l.read_at).length } });
    } catch (e) {
      res.status(500).json({ error: /leads/.test(e.message) ? 'Leads table missing: run the leads_centre migration' : e.message });
    }
  });

  r.get('/', async (req, res) => {
    try {
      let q = supabase.from('leads').select(LIST_FIELDS);
      q = applyFilters(q, req.query);
      q = req.query.sort === 'followup' ? q.order('next_followup_at', { ascending: true, nullsFirst: false }) : q.order('created_at', { ascending: false });
      const { data, error } = await q.limit(Math.min(500, Number(req.query.limit) || 200));
      if (error) throw error;
      res.json({ leads: data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Pipeline summary: counts per status per category, conversion and speed.
  r.get('/summary', async (req, res) => {
    try {
      const { data: leads, error } = await supabase.from('leads').select('id, category, status, created_at').neq('status', 'spam').limit(20000);
      if (error) throw error;
      const { data: firsts } = await supabase.from('lead_events').select('lead_id, created_at').eq('kind', 'status_changed').limit(50000);
      const firstContact = {};
      for (const ev of firsts || []) if (!firstContact[ev.lead_id] || ev.created_at < firstContact[ev.lead_id]) firstContact[ev.lead_id] = ev.created_at;
      const table = {};
      for (const l of leads) {
        table[l.category] = table[l.category] || Object.fromEntries(STATUSES.map((s) => [s, 0]));
        table[l.category][l.status]++;
      }
      const won = leads.filter((l) => l.status === 'won').length;
      const hours = leads.filter((l) => firstContact[l.id]).map((l) => (new Date(firstContact[l.id]) - new Date(l.created_at)) / 3600000);
      res.json({
        table,
        total: leads.length,
        conversionNewToWonPct: leads.length ? Number(((100 * won) / leads.length).toFixed(1)) : 0,
        avgHoursToFirstContact: hours.length ? Number((hours.reduce((a, b) => a + b, 0) / hours.length).toFixed(1)) : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/export.csv', async (req, res) => {
    try {
      let q = supabase.from('leads').select('created_at, category, source_form, status, priority, owner, name, company, role, email, phone, country, website, tags, next_followup_at, message');
      q = applyFilters(q, req.query).order('created_at', { ascending: false });
      const { data, error } = await q.limit(20000);
      if (error) throw error;
      const cols = ['created_at', 'category', 'source_form', 'status', 'priority', 'owner', 'name', 'company', 'role', 'email', 'phone', 'country', 'website', 'tags', 'next_followup_at', 'message'];
      // Quote every cell and neutralise spreadsheet formulas.
      const cell = (v) => {
        let s = Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v);
        if (/^[=+\-@]/.test(s)) s = `'${s}`;
        return `"${s.replace(/"/g, '""')}"`;
      };
      await audit(req, 'leads_export', null, { rows: data.length, filters: req.query });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send([cols.join(','), ...data.map((row) => cols.map((c) => cell(row[c])).join(','))].join('\n'));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/whoami', (req, res) => res.json({ owner: who(req), role: req.admin.role || null }));

  r.get('/settings', async (req, res) => {
    const { data } = await supabase.from('lead_settings').select('key, value');
    res.json({ settings: Object.fromEntries((data || []).map((x) => [x.key, x.value])), categories: CATEGORIES, labels: CATEGORY_LABEL, defaultRecipients: process.env.LEADS_NOTIFY_EMAILS || 'hello@spikeandcrush.com' });
  });

  r.put('/settings', async (req, res) => {
    const b = req.body || {};
    const rows = [];
    const emailList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    const okEmail = (x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
    if (b.routing && typeof b.routing === 'object') {
      const routing = {};
      for (const c of CATEGORIES) {
        const list = emailList(b.routing[c]);
        if (list.some((x) => !okEmail(x))) return res.status(400).json({ error: `Check the email addresses for ${CATEGORY_LABEL[c]}` });
        if (list.length) routing[c] = list.join(',');
      }
      rows.push({ key: 'routing', value: routing });
    }
    if (b.reply_time !== undefined) rows.push({ key: 'reply_time', value: String(b.reply_time || '').slice(0, 80) });
    if (b.stale_days !== undefined) rows.push({ key: 'stale_days', value: Math.max(1, Math.min(60, Number(b.stale_days) || 3)) });
    if (b.captcha !== undefined) rows.push({ key: 'captcha', value: Boolean(b.captcha) });
    for (const row of rows) await supabase.from('lead_settings').upsert({ ...row, updated_at: new Date().toISOString(), updated_by: who(req) });
    await audit(req, 'leads_settings', null, { keys: rows.map((x) => x.key) });
    res.json({ success: true });
  });

  r.get('/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Lead not found' });
    const [{ data: lead }, { data: notes }, { data: events }] = await Promise.all([
      supabase.from('leads').select('*').eq('id', req.params.id).maybeSingle(),
      supabase.from('lead_notes').select('*').eq('lead_id', req.params.id).order('created_at'),
      supabase.from('lead_events').select('*').eq('lead_id', req.params.id).order('created_at'),
    ]);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.read_at) await supabase.from('leads').update({ read_at: new Date().toISOString() }).eq('id', lead.id);
    res.json({ lead, notes: notes || [], events: events || [], label: CATEGORY_LABEL[lead.category] });
  });

  r.patch('/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Lead not found' });
    const b = req.body || {};
    const { data: before } = await supabase.from('leads').select('*').eq('id', req.params.id).maybeSingle();
    if (!before) return res.status(404).json({ error: 'Lead not found' });
    const patch = { updated_at: new Date().toISOString() };
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status' });
      patch.status = b.status;
      if (['contacted', 'qualified', 'in_talks'].includes(b.status)) patch.last_contact_at = new Date().toISOString();
    }
    if (b.priority !== undefined) {
      if (!PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'Unknown priority' });
      patch.priority = b.priority;
    }
    if (b.owner !== undefined) patch.owner = b.owner ? String(b.owner).slice(0, 200) : null;
    if (b.tags !== undefined) patch.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags).split(',')).map((t) => String(t).trim().slice(0, 30)).filter(Boolean).slice(0, 12);
    if (b.next_followup_at !== undefined) patch.next_followup_at = b.next_followup_at ? new Date(b.next_followup_at).toISOString() : null;
    if (b.lost_reason !== undefined) patch.lost_reason = String(b.lost_reason || '').slice(0, 300) || null;
    if (b.converted_to && typeof b.converted_to === 'object') patch.converted_to = { ...(before.converted_to || {}), ...b.converted_to };
    const { data, error } = await supabase.from('leads').update(patch).eq('id', before.id).select('*').single();
    if (error) return res.status(500).json({ error: error.message });
    for (const k of ['status', 'owner', 'priority', 'next_followup_at', 'tags', 'converted_to']) {
      if (patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(before[k])) await event(before.id, who(req), `${k === 'status' ? 'status' : k}_changed`, { from: before[k], to: patch[k] });
    }
    await audit(req, 'lead_update', before.id, Object.keys(patch).filter((k) => k !== 'updated_at'));
    res.json({ lead: data });
  });

  r.post('/:id/notes', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Lead not found' });
    const note = String(req.body?.note || '').trim().slice(0, 4000);
    if (!note) return res.status(400).json({ error: 'Write a note first' });
    const { data, error } = await supabase.from('lead_notes').insert({ lead_id: req.params.id, author: who(req), note }).select('*').single();
    if (error) return res.status(500).json({ error: error.message });
    await event(req.params.id, who(req), 'note_added');
    await audit(req, 'lead_note', req.params.id, {});
    res.json({ note: data });
  });

  return r;
}

// Daily digest per owner: overdue follow-ups and leads still New after
// lead_settings.stale_days (default 3). Sent once a day (UTC), idempotent.
async function runLeadsDigest({ sendEmail, now = new Date() }) {
  if (!isConfigured) return { sent: 0 };
  const { data: s } = await supabase.from('lead_settings').select('key, value');
  const settings = Object.fromEntries((s || []).map((x) => [x.key, x.value]));
  const staleDays = Number(settings.stale_days) || 3;
  const nowIso = now.toISOString();
  const staleIso = new Date(now - staleDays * 86400000).toISOString();
  const [{ data: overdue }, { data: stale }] = await Promise.all([
    supabase.from('leads').select('id, category, company, name, email, owner, next_followup_at').lt('next_followup_at', nowIso).not('status', 'in', '(won,lost,spam)').limit(500),
    supabase.from('leads').select('id, category, company, name, email, owner, created_at').eq('status', 'new').lt('created_at', staleIso).limit(500),
  ]);
  const byOwner = {};
  const fallback = process.env.LEADS_NOTIFY_EMAILS || 'hello@spikeandcrush.com';
  for (const l of overdue || []) (byOwner[l.owner || fallback] ||= { overdue: [], stale: [] }).overdue.push(l);
  for (const l of stale || []) (byOwner[l.owner || fallback] ||= { overdue: [], stale: [] }).stale.push(l);
  let sent = 0;
  const day = nowIso.slice(0, 10);
  for (const [owner, g] of Object.entries(byOwner)) {
    if (!/@/.test(owner)) continue;
    const line = (l) => `- [${CATEGORY_LABEL[l.category]}] ${l.company || l.name || l.email || l.id}`;
    const text = `${g.overdue.length ? `Follow-ups overdue:\n${g.overdue.map(line).join('\n')}\n\n` : ''}${g.stale.length ? `Still New after ${staleDays} days:\n${g.stale.map(line).join('\n')}\n` : ''}`;
    try {
      await sendEmail({ to: owner, idempotencyKey: `leads-digest:${owner}:${day}`, subject: `Leads to follow up today (${g.overdue.length + g.stale.length})`, text, html: `<pre style="font-family:Inter,Arial,sans-serif">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>` });
      sent++;
    } catch (e) {
      console.warn('[leads digest] send failed:', e.message);
    }
  }
  return { sent, owners: Object.keys(byOwner).length };
}

module.exports = router;
module.exports.runLeadsDigest = runLeadsDigest;
