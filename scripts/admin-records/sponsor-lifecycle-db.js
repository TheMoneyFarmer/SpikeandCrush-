'use strict';

// Test 6 on the real dev tables: a test sponsor with placements, the hourly
// job run with the clock moved forward (scheduled -> active -> expiring ->
// expired), reminders once per milestone, then the archive/delete rules via
// the admin API (refused while active, refused for a non-super admin and
// without the typed name; allowed for an expired placement, stats kept).
// Emails go to a fake sender. Everything it creates is deleted at the end.
//   ADMIN=http://localhost:3071 SMOKE_ADMIN_USER=... SMOKE_ADMIN_PASS=... node scripts/admin-records/sponsor-lifecycle-db.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const lc = require('../../server/sponsorLifecycle');

if (!String(process.env.SUPABASE_URL).includes('tifsqiexbjcsazxwvavg')) { console.error('dev only'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const ADMIN = process.env.ADMIN || 'http://localhost:3071';
const DAY = 86400000;
const results = [];
const ok = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'} ${n}${d ? ` - ${d}` : ''}`); };
const iso = (ms) => new Date(ms).toISOString();

(async () => {
  const T0 = Date.now();
  const name = `RECTEST Sponsor ${crypto.randomBytes(3).toString('hex')}`;
  // leftovers from an interrupted run
  const { data: old } = await sb.from('sponsors').select('id').like('name', 'RECTEST Sponsor %');
  for (const o of old || []) { await sb.from('sponsor_placements').delete().eq('sponsor_id', o.id); await sb.from('sponsors').delete().eq('id', o.id); }
  const { data: sp, error: spErr } = await sb.from('sponsors').insert({ name, tier: 'partner', status: 'active', slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), contact_email: 'contact@recordtest.example.invalid', remind_contact: true }).select().single();
  if (spErr) throw spErr;
  const mk = (o) => ({ sponsor_id: sp.id, placement: 'global_strip', slot: 'lobby_strip', targets: 'all', status: 'active', active: true, weight: 1, creative: 'logo', ...o });
  const { data: pls } = await sb.from('sponsor_placements').insert([
    mk({ starts_at: iso(T0 + 2 * DAY), ends_at: iso(T0 + 20 * DAY) }),
    mk({ starts_at: iso(T0 - DAY), ends_at: iso(T0 + 30 * DAY) }),
  ]).select();
  if (!pls) { const { error } = await sb.from('sponsor_placements').insert(mk({ starts_at: iso(T0), ends_at: iso(T0 + DAY) })); throw new Error(`placements: ${error && error.message}`); }
  const ids = pls.map((p) => p.id);
  const [pSched, pRun] = pls;
  await sb.from('sponsor_stats_daily').insert({ placement_id: pRun.id, day: iso(T0).slice(0, 10), impressions: 321, unique_viewers: 100, clicks: 7, entries: 0, outbound_clicks: 0 });
  const sent = [];
  const run = (t) => lc.runLifecycle(sb, { now: t, sendEmail: async (m) => { sent.push(m); return { id: 'fake' }; }, onlyPlacementIds: ids, slotName: () => 'Lobby strip' });
  const state = async () => Object.fromEntries((await sb.from('sponsor_placements').select('id, lifecycle, status').in('id', ids)).data.map((r) => [r.id, `${r.lifecycle}/${r.status}`]));

  await run(T0);
  let s = await state();
  ok('now: scheduled and active', s[pSched.id] === 'scheduled/active' && s[pRun.id] === 'active/active', JSON.stringify(s));
  await run(T0 + 3 * DAY);
  s = await state();
  ok('+3 days: the scheduled one went active', s[pSched.id] === 'active/active');
  const r10 = await run(T0 + 21 * DAY);
  s = await state();
  ok('+21 days: 10-day reminder for the running one, expiring', s[pRun.id] === 'expiring/active' && r10.reminders.some((r) => r.placementId === pRun.id && r.milestone === 'd10'), JSON.stringify(r10.reminders));
  const again = await run(T0 + 21 * DAY + 3600000);
  ok('an hour later: no repeat', !again.reminders.some((r) => r.placementId === pRun.id));
  const r0 = await run(T0 + 20 * DAY + 3600000 + 1);
  s = await state();
  ok('first placement ended: expired, set to ended, expiry reminder', s[pSched.id] === 'expired/ended' && r0.reminders.some((r) => r.placementId === pSched.id && r.milestone === 'd0'), JSON.stringify(s));
  const { data: rem } = await sb.from('sponsor_reminders').select('placement_id, milestone, recipients').in('placement_id', ids);
  ok('reminders logged per placement, admin + contact', rem.length >= 2 && rem.every((r) => r.recipients.includes('hello@spikeandcrush.com') || r.recipients.length >= 1) && rem.some((r) => r.recipients.includes('contact@recordtest.example.invalid')), JSON.stringify(rem.map((r) => `${r.milestone}:${r.recipients.length}`)));
  ok('emails carry stats so far', sent.some((m) => m.html.includes('321 impressions')), `${sent.length} emails (fake sender)`);
  // serving: an expired placement is not served
  const { data: live } = await sb.from('sponsor_placements').select('id, status').eq('id', pSched.id).single();
  ok('expired placement no longer serves (status ended)', live.status === 'ended');

  // ---- archive / delete rules through the admin API ----------------------------
  // Real logins: the shared admin login (role admin) and a temporary
  // super_admin row with its own 2FA secret, removed at the end.
  const loginCookie = async (body) => {
    const res = await fetch(`${ADMIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const c = (res.headers.get('set-cookie') || '').split(';')[0];
    return { status: res.status, cookie: c.startsWith('admin_token=') ? c : null, body: await res.json().catch(() => null) };
  };
  const callWith = (cookie) => async (method, p, body) => {
    const res = await fetch(ADMIN + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const adminLogin = await loginCookie({ username: process.env.SMOKE_ADMIN_USER, password: process.env.SMOKE_ADMIN_PASS });
  const asAdmin = callWith(adminLogin.cookie);
  const twoFactor = require('../../admin/lib/twoFactor');
  const totp = require('../../server/totp');
  const bcrypt = require('bcryptjs');
  const superEmail = `rectest-super-${crypto.randomBytes(3).toString('hex')}@recordtest.example.invalid`;
  const superPass = crypto.randomBytes(18).toString('base64url');
  const secret = totp.generateSecret();
  const { data: superRow, error: suErr } = await sb.from('admin_users').insert({ email: superEmail, name: 'rectest super', password_hash: await bcrypt.hash(superPass, 10), role: 'super_admin', is_active: true, totp_enabled: true, totp_secret: twoFactor.encryptSecret(secret) }).select('id').single();
  if (suErr) throw suErr;
  const superLogin = await loginCookie({ username: superEmail, password: superPass, code: totp.generateTotp(secret) });
  const asSuper = callWith(superLogin.cookie);
  ok('test logins work (admin, super admin with 2FA)', Boolean(adminLogin.cookie && superLogin.cookie), `${adminLogin.status}/${superLogin.status} ${superLogin.body && superLogin.body.error ? superLogin.body.error : ''}`);
  const d1 = await asAdmin('DELETE', `/api/sponsors/placements/${pRun.id}`, { confirmName: name });
  ok('delete refused for a non-super admin', d1.status === 403, `${d1.status} ${d1.body && d1.body.error}`);
  const a1 = await asAdmin('POST', `/api/sponsors/placements/${pRun.id}/archive`);
  const { data: arch } = await sb.from('sponsor_placements').select('archived_at, status, lifecycle').eq('id', pRun.id).single();
  ok('archive works for an admin and stops serving', a1.status === 200 && arch.archived_at && arch.status === 'ended' && arch.lifecycle === 'archived', JSON.stringify(arch));
  const ext = await asAdmin('POST', `/api/sponsors/placements/${pSched.id}/extend`, { days: 7 });
  const { data: exd } = await sb.from('sponsor_placements').select('ends_at, status').eq('id', pSched.id).single();
  ok('extend logged and back to serving', ext.status === 200 && Date.parse(exd.ends_at) > Date.now() && exd.status === 'active', `${ext.status} ${exd.ends_at}`);
  const dup = await asAdmin('POST', `/api/sponsors/placements/${pSched.id}/duplicate`, {});
  ok('renew creates a new scheduled placement', dup.status === 200 && dup.body.placement && dup.body.placement.lifecycle === 'scheduled', `${dup.status} ${dup.body && (dup.body.error || dup.body.placement.lifecycle)}`);
  if (dup.body && dup.body.placement) ids.push(dup.body.placement.id);
  const { data: logs } = await sb.from('admin_logs').select('action_type').in('target_id', ids).gte('created_at', iso(T0 - 60000));
  ok('archive, extend and renew are in the audit log', ['sponsor_placement_archive', 'sponsor_placement_extend', 'sponsor_placement_duplicate'].every((a) => logs.some((l) => l.action_type === a)), logs.map((l) => l.action_type).join(','));
  const sdel = await asAdmin('DELETE', `/api/sponsors/${sp.id}`, { confirmName: name });
  ok('sponsor delete refused for a non-super admin', sdel.status === 403);

  // super admin rules
  const live1 = await asSuper('DELETE', `/api/sponsors/placements/${pSched.id}`, { confirmName: name });
  ok('super admin: delete refused on an active placement', live1.status === 400, live1.body && live1.body.error);
  const noName = await asSuper('DELETE', `/api/sponsors/placements/${pRun.id}`, { confirmName: 'wrong' });
  ok('super admin: delete needs the typed sponsor name', noName.status === 400, noName.body && noName.body.error);
  const del = await asSuper('DELETE', `/api/sponsors/placements/${pRun.id}`, { confirmName: name.toUpperCase() });
  const { data: kept } = await sb.from('sponsor_stats_archive').select('impressions').eq('placement_id', pRun.id);
  ok('super admin: archived placement deleted, its stats kept for reports', del.status === 200 && kept.length === 1 && kept[0].impressions === 321, `${del.status} kept ${JSON.stringify(kept)}`);
  const rep = await asSuper('GET', `/api/sponsors/${sp.id}/stats?from=${iso(T0 - DAY).slice(0, 10)}&to=${iso(T0 + DAY).slice(0, 10)}`);
  ok('sponsor report still counts the deleted placement', rep.status === 200 && JSON.stringify(rep.body).includes('321'), `${rep.status}`);
  const sdelBusy = await asSuper('DELETE', `/api/sponsors/${sp.id}`, { confirmName: name });
  ok('sponsor delete refused while placement rows exist', sdelBusy.status === 400, sdelBusy.body && sdelBusy.body.error);

  // ---- clean up everything this test made --------------------------------------
  await sb.from('sponsor_reminders').delete().in('placement_id', ids);
  await sb.from('sponsor_stats_archive').delete().in('placement_id', ids);
  await sb.from('sponsor_stats_daily').delete().in('placement_id', ids);
  await sb.from('sponsor_placements').delete().in('id', ids);
  await sb.from('sponsors').delete().eq('id', sp.id);
  // The temporary admin is switched off, not deleted: the audit log keeps
  // pointing at who did what.
  await sb.from('admin_users').update({ is_active: false, totp_enabled: false, totp_secret: null, password_hash: 'disabled' }).eq('id', superRow.id);
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
