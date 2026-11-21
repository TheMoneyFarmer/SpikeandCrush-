'use strict';

// Leads centre: one place for every message from outside (Partner with us,
// support escalations, feedback, bug reports, waitlist). Every submission is
// stored first; the notification and the auto-reply come after, and an email
// failure is recorded on the lead (shown in Admin), never lost.
//
// Notification routing: LEADS_NOTIFY_EMAILS (comma separated, default
// hello@spikeandcrush.com), overridden per category in Admin > Leads >
// Settings (lead_settings.routing). Reply-time promise only if set there.

const CATEGORIES = ['partner_broker', 'partner_prop_firm', 'sponsor_brand', 'advertiser', 'competition_listing', 'press_media', 'support_escalation', 'player_feedback', 'bug_report', 'business_other', 'waitlist'];
const CATEGORY_LABEL = {
  partner_broker: 'Broker partner',
  partner_prop_firm: 'Prop firm partner',
  sponsor_brand: 'Brand sponsor',
  advertiser: 'Advertiser',
  competition_listing: 'Competition listing',
  press_media: 'Press and media',
  support_escalation: 'Support escalation',
  player_feedback: 'Player feedback',
  bug_report: 'Bug report',
  business_other: 'Business, other',
  waitlist: 'Waitlist',
};
const MERGE_DAYS = 30;
const LIMITS = { name: 120, company: 120, role: 80, email: 200, phone: 40, country: 60, website: 200, message: 4000 };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// Validates and normalises one submission. Returns { lead } or { errors }.
function normalise(input = {}) {
  const errors = {};
  const category = CATEGORIES.includes(input.category) ? input.category : null;
  if (!category) errors.category = 'Unknown category';
  const lead = { category, source_form: clean(input.source_form || 'unknown', 60) };
  for (const [k, max] of Object.entries(LIMITS)) lead[k] = clean(input[k], max) || null;
  if (lead.email) lead.email = lead.email.toLowerCase();
  if (lead.email && !EMAIL_RE.test(lead.email)) errors.email = 'Enter a valid email address';
  if (lead.website && !/^https?:\/\/[^\s/.]+\.[^\s]+$/i.test(lead.website)) errors.website = 'Website must start with http:// or https://';
  if (lead.phone && !/^[+0-9 ()-]{5,40}$/.test(lead.phone)) errors.phone = 'Enter a valid phone or WhatsApp number';
  const extras = input.extras && typeof input.extras === 'object' && !Array.isArray(input.extras) ? input.extras : {};
  lead.extras = Object.fromEntries(Object.entries(extras).slice(0, 20).map(([k, v]) => [clean(k, 40), typeof v === 'number' || typeof v === 'boolean' ? v : clean(v, 300)]));
  lead.player_id = input.player_id || null;
  lead.consent_text = input.consent_text ? clean(input.consent_text, 500) : null;
  lead.consent_at = lead.consent_text ? new Date().toISOString() : null;
  lead.ip_hash = input.ip_hash || null;
  return Object.keys(errors).length ? { errors } : { lead };
}

function createLeadsService({ client, sendEmail, adminBaseUrl = process.env.ADMIN_PUBLIC_URL || process.env.ADMIN_URL || 'https://admin.spikeandcrush.com' }) {
  const sb = () => client();

  async function settings() {
    try {
      const { data } = await sb().from('lead_settings').select('key, value');
      return Object.fromEntries((data || []).map((r) => [r.key, r.value]));
    } catch (e) {
      return {};
    }
  }

  function recipientsFor(category, s) {
    const routing = (s.routing && s.routing[category]) || null;
    const list = String(routing || process.env.LEADS_NOTIFY_EMAILS || 'hello@spikeandcrush.com').split(',').map((x) => x.trim()).filter((x) => EMAIL_RE.test(x));
    return list.length ? list : ['hello@spikeandcrush.com'];
  }

  async function event(leadId, actor, kind, detail = {}) {
    try {
      await sb().from('lead_events').insert({ lead_id: leadId, actor, kind, detail });
    } catch (e) {
      console.warn('[leads] event write failed:', e.message);
    }
  }

  // Store (or merge), then notify. Returns { id, merged }.
  async function submit(input, { notify = true, autoReply = true } = {}) {
    const n = normalise(input);
    if (n.errors) {
      const err = new Error(Object.values(n.errors)[0]);
      err.status = 400;
      err.errors = n.errors;
      throw err;
    }
    const lead = n.lead;
    // Same email and category within 30 days: a note on the existing lead.
    if (lead.email) {
      const since = new Date(Date.now() - MERGE_DAYS * 86400000).toISOString();
      const { data: prev } = await sb().from('leads').select('id').eq('category', lead.category).ilike('email', lead.email).gte('created_at', since).order('created_at', { ascending: false }).limit(1);
      if (prev && prev.length) {
        const id = prev[0].id;
        const body = [lead.message, Object.keys(lead.extras).length ? `Details: ${JSON.stringify(lead.extras)}` : ''].filter(Boolean).join('\n') || '(no message)';
        await sb().from('lead_notes').insert({ lead_id: id, author: 'submission', note: `New submission from ${lead.source_form}:\n${body}` });
        await sb().from('leads').update({ updated_at: new Date().toISOString(), read_at: null }).eq('id', id);
        await event(id, 'system', 'merged_submission', { source_form: lead.source_form });
        if (notify) await notifyTeam(id, lead, true);
        return { id, merged: true };
      }
    }
    const { data, error } = await sb().from('leads').insert(lead).select('id').single();
    if (error) throw error;
    await event(data.id, 'system', 'created', { source_form: lead.source_form, category: lead.category });
    if (notify) await notifyTeam(data.id, lead, false);
    if (autoReply && lead.email && lead.category !== 'waitlist' && lead.category !== 'support_escalation') await replyToSender(data.id, lead);
    return { id: data.id, merged: false };
  }

  async function notifyTeam(id, lead, merged) {
    const s = await settings();
    const to = recipientsFor(lead.category, s);
    const label = CATEGORY_LABEL[lead.category];
    const link = `${adminBaseUrl.replace(/\/$/, '')}/leads.html#${id}`;
    const rows = [['Category', label], ['From', lead.name], ['Company', lead.company], ['Role', lead.role], ['Email', lead.email], ['Phone', lead.phone], ['Country', lead.country], ['Website', lead.website], ['Form', lead.source_form], ...Object.entries(lead.extras || {})].filter(([, v]) => v !== null && v !== undefined && v !== '');
    try {
      const sent = await sendEmail({
        to: to.join(','),
        idempotencyKey: `lead-notify:${id}:${merged ? Date.now() : 'new'}`,
        subject: `${merged ? 'Again: ' : ''}[${label}] ${lead.company || lead.name || lead.email || 'New lead'}`,
        text: `${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${lead.message || ''}\n\nOpen in admin: ${link}`,
        html: `<table>${rows.map(([k, v]) => `<tr><td style="color:#666;padding-right:10px">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table><p>${esc(lead.message || '').replace(/\n/g, '<br>')}</p><p><a href="${esc(link)}">Open in admin</a></p>`,
      });
      const ok = Boolean(sent && sent.id);
      await sb().from('leads').update({ email_status: ok ? 'sent' : 'failed' }).eq('id', id);
      await event(id, 'system', ok ? 'notify_sent' : 'notify_failed', { to: to.length });
    } catch (e) {
      await sb().from('leads').update({ email_status: 'failed' }).eq('id', id);
      await event(id, 'system', 'notify_failed', { error: String(e.message || e).slice(0, 200) });
      console.warn('[leads] notification failed (lead kept):', e.message);
    }
  }

  async function replyToSender(id, lead) {
    const s = await settings();
    const when = s.reply_time && String(s.reply_time).trim() ? ` We usually reply ${String(s.reply_time).trim()}.` : '';
    // Goes to an address the visitor typed, so it repeats nothing they typed.
    const name = 'there';
    try {
      await sendEmail({
        to: lead.email,
        idempotencyKey: `lead-reply:${id}`,
        subject: 'We received your message',
        text: `Hi ${name},\n\nWe received your message. A person will reply.${when}\n\nSpike & Crush\nhello@spikeandcrush.com`,
        html: `<div style="background:#07090F;padding:24px;font-family:Inter,Arial,sans-serif;color:#E8ECF4"><div style="max-width:480px;margin:auto;background:#0E1320;border:1px solid #1D2638;border-radius:12px;padding:24px"><p style="font-family:Rajdhani,Arial,sans-serif;font-size:20px;font-weight:700;margin:0 0 14px"><span style="color:#2EE6A6">Spike</span><span style="color:#9AA4B8">&amp;</span><span style="color:#FF4D5E">Crush</span></p><p>Hi ${esc(name)},</p><p>We received your message. A person will reply.${esc(when)}</p><p style="color:#9AA4B8;font-size:13px">hello@spikeandcrush.com</p></div></div>`,
      });
      await event(id, 'system', 'auto_reply_sent');
    } catch (e) {
      await event(id, 'system', 'auto_reply_failed', { error: String(e.message || e).slice(0, 200) });
    }
  }

  return { submit, settings, recipientsFor, event, CATEGORIES, CATEGORY_LABEL };
}

module.exports = { createLeadsService, normalise, CATEGORIES, CATEGORY_LABEL, MERGE_DAYS };
