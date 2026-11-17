'use strict';

// Leads centre (server/leads.js) against a small in-memory stand-in for the
// Supabase client: validation, categories, the 30-day merge, notification and
// auto-reply, email failure kept on the lead, routing, and secrecy of lead data.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createLeadsService, normalise } = require('../server/leads');

function fakeDb(seed = {}) {
  const tables = { leads: [], lead_notes: [], lead_events: [], lead_settings: [], ...seed };
  let n = 0;
  function query(name) {
    let rows = tables[name];
    const filters = [];
    let op = 'select';
    let payload = null;
    let single = false;
    let limit = Infinity;
    const run = () => {
      let out = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'insert') {
        const row = { id: `id-${++n}`, created_at: new Date().toISOString(), ...payload };
        tables[name].push(row);
        return { data: single ? row : [row], error: null };
      }
      if (op === 'update') {
        out.forEach((r) => Object.assign(r, payload));
        return { data: out, error: null };
      }
      out = out.slice(0, limit);
      return { data: single ? out[0] || null : out, error: null };
    };
    const q = {
      select() { return q; },
      insert(p) { op = 'insert'; payload = p; return q; },
      update(p) { op = 'update'; payload = p; return q; },
      eq(k, v) { filters.push((r) => r[k] === v); return q; },
      ilike(k, v) { filters.push((r) => String(r[k] || '').toLowerCase() === String(v).toLowerCase()); return q; },
      gte(k, v) { filters.push((r) => String(r[k]) >= v); return q; },
      order() { return q; },
      limit(x) { limit = x; return q; },
      single() { single = true; return q; },
      maybeSingle() { single = true; return q; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
    };
    return q;
  }
  return { tables, client: () => ({ from: query }) };
}

function makeService({ failEmail = false, seed } = {}) {
  const db = fakeDb(seed);
  const sent = [];
  const sendEmail = async (msg) => {
    sent.push(msg);
    if (failEmail && /^\[/.test(msg.subject)) throw new Error('provider down');
    return { id: `em-${sent.length}` };
  };
  return { db, sent, svc: createLeadsService({ client: db.client, sendEmail, adminBaseUrl: 'https://admin.example.invalid' }) };
}

test('validation: unknown category, bad email, bad website and javascript: links are refused', () => {
  assert.ok(normalise({ category: 'nope' }).errors.category);
  assert.ok(normalise({ category: 'partner_broker', email: 'not-an-email' }).errors.email);
  assert.ok(normalise({ category: 'partner_broker', website: 'javascript:alert(1)' }).errors.website);
  assert.ok(normalise({ category: 'partner_broker', website: 'data:text/html,x' }).errors.website);
  const ok = normalise({ category: 'partner_broker', email: 'A@B.COM', message: 'x'.repeat(9000), website: 'https://b.com' });
  assert.ok(ok.lead);
  assert.strictEqual(ok.lead.email, 'a@b.com');
  assert.strictEqual(ok.lead.message.length, 4000, 'length limit');
});

test('each form creates one lead with the right category, a team notification and an auto-reply', async () => {
  const forms = [['partner_broker', 'partner_with_us'], ['partner_prop_firm', 'partner_with_us'], ['sponsor_brand', 'partner_with_us'], ['business_other', 'partner_with_us'], ['player_feedback', 'help_feedback'], ['bug_report', 'help_bug_report']];
  for (const [category, form] of forms) {
    const { db, sent, svc } = makeService();
    const out = await svc.submit({ category, source_form: form, name: 'Pat Partner', company: 'Acme', email: `pat+${category}@example.com`, message: 'Hello' });
    assert.strictEqual(out.merged, false);
    assert.strictEqual(db.tables.leads.length, 1, category);
    assert.strictEqual(db.tables.leads[0].category, category);
    assert.strictEqual(db.tables.leads[0].email_status, 'sent');
    assert.ok(sent.some((m) => m.subject.startsWith('[')), `${category}: team notified`);
    const reply = sent.find((m) => m.subject === 'We received your message');
    assert.ok(reply, `${category}: auto-reply`);
    assert.match(reply.text, /A person will reply\./);
    assert.ok(!/working days|within/i.test(reply.text), 'no reply-time promise unless set');
  }
});

test('waitlist and support escalations: stored quietly when asked (no email)', async () => {
  const { db, sent, svc } = makeService();
  await svc.submit({ category: 'waitlist', source_form: 'waitlist:daily-open', email: 'w@example.com' }, { notify: false, autoReply: false });
  await svc.submit({ category: 'support_escalation', source_form: 'support_chat', email: 's@example.com', message: 'Summary: cannot log in' }, { notify: false, autoReply: false });
  assert.strictEqual(db.tables.leads.length, 2);
  assert.strictEqual(sent.length, 0);
});

test('same email and category within 30 days merges as a note; older creates a new lead', async () => {
  const old = new Date(Date.now() - 31 * 86400000).toISOString();
  const { db, svc } = makeService({ seed: { leads: [{ id: 'old-1', created_at: old, category: 'partner_broker', email: 'x@broker.com' }], lead_notes: [], lead_events: [], lead_settings: [] } });
  const a = await svc.submit({ category: 'partner_broker', source_form: 'partner_with_us', email: 'x@broker.com', message: 'first' });
  assert.strictEqual(a.merged, false, 'the 31-day-old lead is not merged into');
  const b = await svc.submit({ category: 'partner_broker', source_form: 'partner_with_us', email: 'X@Broker.com', message: 'second' });
  assert.strictEqual(b.merged, true);
  assert.strictEqual(b.id, a.id);
  assert.strictEqual(db.tables.leads.length, 2);
  assert.ok(db.tables.lead_notes.some((n) => /second/.test(n.note)));
  const c = await svc.submit({ category: 'sponsor_brand', source_form: 'partner_with_us', email: 'x@broker.com', message: 'other category' });
  assert.strictEqual(c.merged, false, 'another category is a new lead');
});

test('a failed notification email keeps the lead and marks it failed', async () => {
  const { db, svc } = makeService({ failEmail: true });
  const out = await svc.submit({ category: 'partner_broker', source_form: 'partner_with_us', email: 'f@example.com', message: 'hi' });
  assert.ok(out.id);
  assert.strictEqual(db.tables.leads[0].email_status, 'failed');
  assert.ok(db.tables.lead_events.some((e) => e.kind === 'notify_failed'));
});

test('routing per category from admin settings, falling back to the default list', async () => {
  const { svc } = makeService();
  assert.deepStrictEqual(svc.recipientsFor('bug_report', { routing: { bug_report: 'dev@example.com, qa@example.com' } }), ['dev@example.com', 'qa@example.com']);
  assert.deepStrictEqual(svc.recipientsFor('partner_broker', { routing: { bug_report: 'dev@example.com' } }), [(process.env.LEADS_NOTIFY_EMAILS || 'hello@spikeandcrush.com')]);
});

test('lead data stays server side: no client file reads the leads tables or admin leads API', () => {
  const root = path.join(__dirname, '..', 'client');
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(js|html)$/.test(e.name) && files.push(path.join(d, e.name))));
  walk(root);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/from\(['"]leads|lead_notes|lead_events|\/api\/leads/.test(src), `client file touches leads: ${path.basename(f)}`);
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20261116140000_leads_centre.sql'), 'utf8');
  for (const t of ['leads', 'lead_notes', 'lead_events', 'lead_settings']) assert.match(sql, new RegExp(`alter table public.${t} enable row level security`));
  assert.ok(!/create policy/i.test(sql), 'no client policies');
});
