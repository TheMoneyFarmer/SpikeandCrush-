'use strict';

const test = require('node:test');
const assert = require('node:assert');
const lc = require('../server/sponsorLifecycle');

const DAY = 86400000;
const T0 = Date.parse('2026-11-12T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// A tiny in-memory stand-in for the supabase-js query builder (only what the
// lifecycle job uses). Primary keys enforce one reminder per milestone.
function fakeDb(tables) {
  const pk = { sponsor_reminders: ['placement_id', 'milestone'] };
  function builder(name) {
    let rows = () => tables[name] || [];
    const filters = [];
    let op = 'select';
    let payload = null;
    let single = false;
    const api = {
      select() { return api; },
      eq(k, v) { filters.push((r) => r[k] === v); return api; },
      in(k, vs) { filters.push((r) => vs.includes(r[k])); return api; },
      gte(k, v) { filters.push((r) => r[k] >= v); return api; },
      lte(k, v) { filters.push((r) => r[k] <= v); return api; },
      order() { return api; },
      maybeSingle() { single = true; return api; },
      update(p) { op = 'update'; payload = p; return api; },
      insert(p) { op = 'insert'; payload = p; return api; },
      then(res, rej) {
        try {
          const list = (tables[name] = tables[name] || []);
          if (op === 'insert') {
            const keys = pk[name];
            if (keys && list.some((r) => keys.every((k) => r[k] === payload[k]))) return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }).then(res, rej);
            list.push({ ...payload });
            return Promise.resolve({ data: payload, error: null }).then(res, rej);
          }
          const hit = list.filter((r) => filters.every((f) => f(r)));
          if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); return Promise.resolve({ data: hit, error: null }).then(res, rej); }
          let data = hit.map((r) => (name === 'sponsor_placements' ? { ...r, sponsor: (tables.sponsors || []).find((s) => s.id === r.sponsor_id) } : { ...r }));
          if (single) data = data[0] || null;
          return Promise.resolve({ data, error: null }).then(res, rej);
        } catch (e) { return Promise.reject(e); }
      },
    };
    void rows;
    return api;
  }
  return { from: builder, tables };
}

function setup(extra = {}) {
  return fakeDb({
    app_settings: extra.settings ? [{ key: 'sponsors.reminders', value: extra.settings }] : [],
    sponsors: [{ id: 's1', name: 'Acme', contact_email: 'acme@example.invalid', remind_contact: false, status: 'active' }],
    sponsor_placements: [
      { id: 'p-sched', sponsor_id: 's1', slot: 'hero', targets: 'all', status: 'active', starts_at: iso(T0 + 5 * DAY), ends_at: iso(T0 + 40 * DAY) },
      { id: 'p-run', sponsor_id: 's1', slot: 'global_strip', targets: 'all', status: 'active', starts_at: iso(T0 - 5 * DAY), ends_at: iso(T0 + 20 * DAY), remind_contact: true },
      { id: 'p-draft', sponsor_id: 's1', slot: 'hero', targets: 'all', status: 'draft', starts_at: iso(T0 - DAY), ends_at: iso(T0 + DAY) },
    ],
    sponsor_reminders: [],
    sponsor_stats_daily: [{ placement_id: 'p-run', day: '2026-11-10', impressions: 1200, clicks: 18 }],
  });
}

test('lifecycle state follows the dates', () => {
  const p = { starts_at: iso(T0 - DAY), ends_at: iso(T0 + 30 * DAY) };
  assert.strictEqual(lc.lifecycleFor({ ...p, starts_at: iso(T0 + DAY) }, T0), 'scheduled');
  assert.strictEqual(lc.lifecycleFor(p, T0), 'active');
  assert.strictEqual(lc.lifecycleFor(p, T0 + 21 * DAY), 'expiring');
  assert.strictEqual(lc.lifecycleFor(p, T0 + 30 * DAY), 'expired');
  assert.strictEqual(lc.lifecycleFor({ ...p, archived_at: iso(T0) }, T0), 'archived');
  assert.strictEqual(lc.lifecycleFor({ starts_at: null, ends_at: null }, T0), 'active');
});

test('time travel: scheduled -> active -> expiring -> expired, reminders once per milestone', async () => {
  const db = setup();
  const sent = [];
  const sendEmail = async (m) => { sent.push(m); return { id: 'x' }; };
  const run = (t) => lc.runLifecycle(db, { now: t, sendEmail, adminUrl: 'https://admin.test' });
  const run0 = await run(T0);
  const P = (id) => db.tables.sponsor_placements.find((p) => p.id === id);
  assert.strictEqual(P('p-sched').lifecycle, 'scheduled');
  assert.strictEqual(P('p-run').lifecycle, 'active');
  assert.strictEqual(run0.reminders.length, 0, 'nothing due 20 days out');

  await run(T0 + 5 * DAY + 1000);
  assert.strictEqual(P('p-sched').lifecycle, 'active');

  // 10 days before p-run ends
  const r10 = await run(T0 + 10 * DAY + 60000);
  assert.strictEqual(P('p-run').lifecycle, 'expiring');
  assert.deepStrictEqual(r10.reminders.map((r) => `${r.placementId}:${r.milestone}`), ['p-run:d10']);
  // admin + contact (remind_contact on the placement)
  assert.strictEqual(sent.length, 2);
  assert.ok(sent[0].subject.includes('ends in 10 days'));
  assert.ok(sent[0].html.includes('1200 impressions'));
  assert.ok(sent[0].html.includes('Extend or renew'));
  assert.ok(!sent[1].html.includes('admin.test'), 'the sponsor contact never gets the admin link');
  // the same hour again: nothing new
  const again = await run(T0 + 10 * DAY + 120000);
  assert.strictEqual(again.reminders.length, 0);
  assert.strictEqual(sent.length, 2);

  const r2 = await run(T0 + 18 * DAY + 60000);
  assert.deepStrictEqual(r2.reminders.map((r) => r.milestone), ['d2']);

  const r0 = await run(T0 + 20 * DAY + 60000);
  assert.strictEqual(P('p-run').lifecycle, 'expired');
  assert.strictEqual(P('p-run').status, 'ended', 'expired placements are set to ended (stop serving)');
  assert.deepStrictEqual(r0.reminders.map((r) => r.milestone), ['d0']);
  assert.ok(r0.expired.includes('p-run'));

  const later = await run(T0 + 25 * DAY);
  assert.strictEqual(later.reminders.length, 0, 'no repeat after expiry');
  assert.deepStrictEqual(db.tables.sponsor_reminders.filter((r) => r.placement_id === 'p-run').map((r) => r.milestone).sort(), ['d0', 'd10', 'd2']);
  // drafts never get reminders or a forced status
  assert.strictEqual(P('p-draft').status, 'draft');
  assert.ok(!db.tables.sponsor_reminders.some((r) => r.placement_id === 'p-draft'));
});

test('a placement created close to its end gets only the nearest notice', () => {
  const p = { status: 'active', ends_at: iso(T0 + DAY) };
  assert.deepStrictEqual(lc.milestonesDue(p, [], T0), ['d2']);
  assert.deepStrictEqual(lc.milestonesDue(p, ['d2'], T0), []);
  assert.deepStrictEqual(lc.milestonesDue({ ...p, ends_at: iso(T0 - 3 * DAY) }, [], T0), [], 'no "expired today" for something long gone');
});

test('throttle holds the overflow for the next run; digest groups into one email', async () => {
  const db = setup({ settings: { maxEmailsPerRun: 1 } });
  db.tables.sponsor_placements.forEach((p) => { p.ends_at = iso(T0 + 5 * DAY); p.starts_at = iso(T0 - DAY); p.status = 'active'; p.remind_contact = false; });
  const sent = [];
  const first = await lc.runLifecycle(db, { now: T0, sendEmail: async (m) => sent.push(m) });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(first.skipped, 2);
  const second = await lc.runLifecycle(db, { now: T0 + 3600000, sendEmail: async (m) => sent.push(m) });
  assert.strictEqual(second.reminders.length, 1);

  const db2 = setup({ settings: { digest: true } });
  db2.tables.sponsor_placements.forEach((p) => { p.ends_at = iso(T0 + 5 * DAY); p.starts_at = iso(T0 - DAY); p.status = 'active'; p.remind_contact = false; });
  const sent2 = [];
  const d = await lc.runLifecycle(db2, { now: T0, sendEmail: async (m) => sent2.push(m) });
  assert.strictEqual(d.digest, true);
  assert.strictEqual(sent2.length, 1, 'one digest email');
  assert.ok(sent2[0].subject.startsWith('3 sponsor placements'));
});

test('reminders can be switched off without stopping the state moves', async () => {
  const db = setup({ settings: { enabled: false } });
  const sent = [];
  const r = await lc.runLifecycle(db, { now: T0 + 19 * DAY, sendEmail: async (m) => sent.push(m) });
  assert.strictEqual(sent.length, 0);
  assert.ok(r.moved.length > 0);
});
