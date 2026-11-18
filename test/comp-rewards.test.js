'use strict';

// Competition data engine and winner flow: market calendar pools, the data
// source label and stub, prize table, winners for review with flags, approval
// email (disclosure, single-use link), claim with and without consent,
// ineligible country, expired/used/tampered links, the /go/ redirect with the
// IB code added server side, prize request only with consent, prop-firm
// template, no-partner manual queue, and that no secret reaches the client.

process.env.LISTING_SECRETS_KEY = 'a'.repeat(64);
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const calendar = require('../server/marketCalendar');
const secrets = require('../server/listingSecrets');
const { createCompRewards, prizeTable, DISCLOSURE, sha256 } = require('../server/compRewards');

const REG = { EURUSD: { category: 'forex' }, XAUUSD: { category: 'metals' }, NAS100: { category: 'indices' }, USOIL: { category: 'commodities' }, BTCUSD: { category: 'crypto' }, AAPL: { category: 'stocks' }, ES: { category: 'futures' } };
const ny = (iso) => new Date(iso).getTime(); // ISO strings below carry their offset

test('calendar: a weekday US cash session has every class; Saturday only crypto; a stock never on Saturday', () => {
  // Wednesday 2026-11-18, 09:30-16:00 New York (EST, -05:00).
  const wk = calendar.poolFor(ny('2026-11-18T09:30:00-05:00'), ny('2026-11-18T16:00:00-05:00'), REG);
  assert.deepStrictEqual(wk.classes.sort(), ['commodities', 'crypto', 'forex', 'futures', 'indices', 'metals', 'stocks']);
  // Saturday 2026-11-21 00:00 to Sunday 23:59 New York.
  const we = calendar.poolFor(ny('2026-11-21T00:00:00-05:00'), ny('2026-11-22T23:59:00-05:00'), REG);
  assert.deepStrictEqual(we.classes, ['crypto']);
  assert.ok(!we.symbols.includes('AAPL'));
  for (let h = 0; h < 48; h++) assert.strictEqual(calendar.openAt('stocks', ny('2026-11-21T00:00:00-05:00') + h * 3600000), false, `stocks open on the weekend at +${h}h`);
  // A Daily Open crossing the 17:00 break loses the Globex classes but keeps crypto.
  const late = calendar.poolFor(ny('2026-11-18T16:30:00-05:00'), ny('2026-11-18T17:30:00-05:00'), REG);
  assert.ok(!late.classes.includes('futures') && !late.classes.includes('stocks') && late.classes.includes('crypto'));
  // Thanksgiving 2026-11-26: no stocks.
  assert.strictEqual(calendar.openAt('stocks', ny('2026-11-26T11:00:00-05:00')), false);
  // DST: 09:30 New York in summer is 13:30 UTC.
  assert.strictEqual(calendar.openAt('stocks', Date.parse('2026-07-15T13:30:00Z')), true);
  assert.strictEqual(calendar.openAt('stocks', Date.parse('2026-07-15T13:29:00Z')), false);
});

test('data source: chosen per competition; replay is "Demo market data"; live is not healthy until the feed runs', () => {
  const ds = require('../server/marketDataSource');
  assert.strictEqual(ds.current({}).name, 'historical', 'default is the replay');
  assert.strictEqual(ds.forComp({ data_source: 'live' }).name, 'live');
  assert.strictEqual(ds.label({}), 'Demo market data');
  assert.strictEqual(ds.LiveFeed.getPriceAt('BTCUSD', 0), null, 'no live data in tests');
  assert.strictEqual(ds.LiveFeed.healthy(), false, 'feed not started, so canGoLive stays false and competitions stay Coming soon');
  assert.ok(!/\blive\b/i.test(ds.HistoricalReplay.label));
});

test('prize table from the breakdown: 1st 50%, 2nd 25%, 3rd 15%, 4th to 10th share 10%', () => {
  const t = prizeTable(5000, [{ places: '1st', share: 50 }, { places: '2nd', share: 25 }, { places: '3rd', share: 15 }, { places: '4th to 10th', share: 10 }]);
  assert.deepStrictEqual(t.slice(0, 4).map((x) => x.amount), [2500, 1250, 750, 71]);
  assert.strictEqual(t.length, 10);
});

// ---- in-memory database stand-in --------------------------------------------------------
function fakeDb(seed) {
  const T = { comp_winners: [], comp_winner_events: [], comp_partners: [], competitions: [], players: [], sessions: [], competition_listing_secrets: [], ...seed };
  let n = 0;
  const q = (name) => {
    const filters = [];
    let op = 'select';
    let payload;
    let single = false;
    const run = () => {
      const rows = T[name].filter((r) => filters.every((f) => f(r)));
      if (op === 'insert') {
        if (name === 'comp_winners' && T[name].some((r) => r.competition_id === payload.competition_id && r.rank === payload.rank)) return { data: null, error: { code: '23505' } };
        const row = { id: `w${++n}`, created_at: new Date().toISOString(), ...payload };
        T[name].push(row);
        return { data: single ? row : [row], error: null };
      }
      if (op === 'update') { rows.forEach((r) => Object.assign(r, payload)); return { data: rows, error: null }; }
      return { data: single ? rows[0] || null : rows, error: null };
    };
    const api = {
      select() { return api; }, insert(p) { op = 'insert'; payload = p; return api; }, update(p) { op = 'update'; payload = p; return api; },
      eq(k, v) { filters.push((r) => r[k] === v); return api; }, in(k, v) { filters.push((r) => v.includes(r[k])); return api; },
      order() { return api; }, limit() { return api; }, single() { single = true; return api; }, maybeSingle() { single = true; return api; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
    };
    return api;
  };
  return { T, client: () => ({ from: q }) };
}

const IB_URL = 'https://broker.example.invalid/open';
const IB_CODE = 'IBSECRET-7781';
function setup({ partnerType = 'broker', withPartner = true, allowed = [], restricted = ['US'] } = {}) {
  const db = fakeDb({
    competitions: [{ id: 'c1', title: 'Daily Open', prize_kind: 'money', prize_currency: 'USD', starts_at: '2026-11-18T14:30:00Z', partner_id: withPartner ? 'p1' : null }, { id: 'L1', slug: 'acme-broker' }],
    players: [{ id: 'pl1', username: 'alpha', email: 'alpha@example.com', created_at: '2026-01-01T00:00:00Z' }, { id: 'pl2', username: 'beta', email: 'beta@example.com', created_at: '2026-11-18T10:00:00Z' }],
    sessions: [{ player_id: 'pl1', ip: '1.1.1.1' }, { player_id: 'pl2', ip: '1.1.1.1' }],
    comp_partners: withPartner ? [{ id: 'p1', name: 'Acme Broker', partner_type: partnerType, listing_id: 'L1', allowed_countries: allowed, restricted_countries: restricted, name_in_terms: false, contact_enc: secrets.encrypt(JSON.stringify({ email: 'ib.manager@broker.example.invalid', whatsapp: '+971500000000' })), reminder_days: 5 }] : [],
    competition_listing_secrets: [{ competition_id: 'L1', outbound_enc: secrets.encrypt(IB_URL), ib_param: 'ib', ib_code_enc: secrets.encrypt(IB_CODE) }],
  });
  const sent = [];
  const rewards = createCompRewards({ client: db.client, sendEmail: async (m) => { sent.push(m); return { id: `e${sent.length}` }; }, siteUrl: () => 'https://www.spikeandcrush.com' });
  return { db, sent, rewards };
}
const template = { prize_pool_amount: 5000, prize_currency: 'USD', prize_breakdown: [{ places: '1st', share: 50 }, { places: '2nd', share: 25 }] };
const ranked = [{ id: 'a1', player_id: 'pl1', trade_count: 12, status: 'finished' }, { id: 'a2', player_id: 'pl2', trade_count: 2, status: 'finished' }];

async function approvedToken(s) {
  await s.rewards.recordWinners(s.db.T.competitions[0], template, ranked);
  await s.rewards.approve([s.db.T.comp_winners[0].id], 'admin@test');
  const mail = s.sent.find((m) => /You won/.test(m.subject));
  return { mail, token: (mail.text.match(/\/claim\/([A-Za-z0-9_-]+)/) || [])[1] };
}

test('winners are recorded for review with flags; nothing is emailed until approval; recording twice adds nothing', async () => {
  const s = setup();
  const a = await s.rewards.recordWinners(s.db.T.competitions[0], template, ranked);
  assert.strictEqual(a.created, 2);
  assert.ok(s.db.T.comp_winners.every((w) => w.status === 'pending_review'));
  assert.strictEqual(s.sent.length, 0, 'no email before approval');
  const flags = s.db.T.comp_winners[1].flags.map((f) => f.kind).sort();
  assert.deepStrictEqual(flags, ['few_trades', 'new_account', 'shared_ip']);
  const b = await s.rewards.recordWinners(s.db.T.competitions[0], template, ranked);
  assert.strictEqual(b.created, 0, 'idempotent');
});

test('approval sends the claim email with the disclosure and a single-use link; only the hash is stored', async () => {
  const s = setup();
  const { mail, token } = await approvedToken(s);
  assert.ok(token && token.length >= 40);
  assert.ok(mail.text.includes(DISCLOSURE) && mail.html.includes('This is a partner link'));
  assert.ok(!mail.html.includes('Acme Broker'), 'partner not named unless the terms name them');
  const w = s.db.T.comp_winners[0];
  assert.strictEqual(w.status, 'email_sent');
  assert.strictEqual(w.claim_token_hash, sha256(token));
  assert.ok(!JSON.stringify(s.db.T).includes(token), 'the raw token is never stored');
});

test('claim without consent: nothing shared, claim stays open; with consent: /go/ adds the IB code server side and logs the click', async () => {
  const s = setup();
  const { token } = await approvedToken(s);
  const noConsent = await s.rewards.submitClaim(token, { over18: true, country: 'AE', consent: false });
  assert.strictEqual(noConsent.go, null);
  assert.ok(!s.db.T.comp_winners[0].consent_at);
  await assert.rejects(s.rewards.prizeRequest(s.db.T.comp_winners[0].id, 'email', 'admin'), /not consented/);
  const view = await s.rewards.claimView(token);
  assert.ok(!JSON.stringify(view).includes(IB_URL) && !JSON.stringify(view).includes(IB_CODE), 'claim page data has no partner URL or code');
  const yes = await s.rewards.submitClaim(token, { over18: true, country: 'AE', consent: true });
  assert.strictEqual(yes.go, `/go/c/${token}`);
  assert.ok(s.db.T.comp_winners[0].consent_text.startsWith('claim-consent-v1'));
  const go = await s.rewards.goTarget(token, { ipHash: 'h1' });
  assert.ok(go.url.startsWith(IB_URL) && go.url.includes(`ib=${IB_CODE}`));
  assert.strictEqual(s.db.T.comp_winners[0].status, 'link_clicked');
  assert.strictEqual(s.db.T.comp_winners[0].click_ip_hash, 'h1');
  const req = await s.rewards.prizeRequest(s.db.T.comp_winners[0].id, 'email', 'admin');
  assert.strictEqual(req.sent, true);
  assert.strictEqual(s.db.T.comp_winners[0].status, 'prize_requested');
  const ibMail = s.sent.find((m) => /Prize request/.test(m.subject));
  assert.strictEqual(ibMail.to, 'ib.manager@broker.example.invalid');
  const wa = await s.rewards.prizeRequest(s.db.T.comp_winners[0].id, 'whatsapp', 'admin');
  assert.ok(wa.open.startsWith('https://wa.me/971500000000?text='), 'WhatsApp is a prepared message, not sent');
  assert.ok(s.db.T.comp_winner_events.some((e) => e.kind === 'prize_request_sent'));
});

test('ineligible country blocks the claim with a clear message', async () => {
  const s = setup({ restricted: ['US'] });
  const { token } = await approvedToken(s);
  const out = await s.rewards.submitClaim(token, { over18: true, country: 'US', consent: true });
  assert.strictEqual(out.error, 'ineligible');
  assert.match(out.message, /cannot open accounts in your country/);
  assert.strictEqual(s.db.T.comp_winners[0].status, 'ineligible');
  const under = setup();
  const t2 = (await approvedToken(under)).token;
  assert.strictEqual((await under.rewards.submitClaim(t2, { over18: false, country: 'AE', consent: true })).error, 'age');
});

test('expired, reused and tampered claim links are refused', async () => {
  const s = setup();
  const { token } = await approvedToken(s);
  assert.strictEqual((await s.rewards.claimView(`${token.slice(0, -3)}xyz`)).error, 'invalid', 'tampered');
  assert.strictEqual((await s.rewards.claimView('short')).error, 'invalid');
  await s.rewards.submitClaim(token, { over18: true, country: 'AE', consent: true });
  await s.rewards.setStatus(s.db.T.comp_winners[0].id, 'registered', 'admin');
  assert.strictEqual((await s.rewards.claimView(token)).error, 'used', 'reused after the claim moved on');
  const e = setup();
  const t2 = (await approvedToken(e)).token;
  e.db.T.comp_winners[0].claim_expires_at = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual((await e.rewards.claimView(t2)).error, 'expired');
  assert.strictEqual(e.db.T.comp_winners[0].status, 'expired');
});

test('prop-firm partner: "Claim your challenge"; no partner: manual payout queue, no broker email', async () => {
  const p = setup({ partnerType: 'prop_firm' });
  const { mail, token } = await approvedToken(p);
  assert.match(mail.text, /Claim your challenge/);
  assert.strictEqual((await p.rewards.claimView(token)).claim.button, 'Claim your challenge');
  const m = setup({ withPartner: false });
  await m.rewards.recordWinners(m.db.T.competitions[0], template, ranked);
  await m.rewards.approve([m.db.T.comp_winners[0].id], 'admin');
  assert.strictEqual(m.db.T.comp_winners[0].status, 'manual_payout');
  const email = m.sent.find((x) => /You won/.test(x.subject));
  assert.ok(!email.text.includes(DISCLOSURE) && !/prize account/i.test(email.text), 'promises nothing beyond the terms');
  await assert.rejects(m.rewards.prizeRequest(m.db.T.comp_winners[0].id, 'email', 'admin'), /consented|manual/);
});

test('secrecy: no client file, claim page or email contains a partner URL or code; only /go/ links leave the site', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['client/claim.html', 'client/js/claim.js', 'server/claimRoutes.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/outbound_enc|ib_code|ref_code|discount_code/.test(src) || f === 'server/claimRoutes.js', `${f} touches partner secrets`);
  }
  const claimJs = fs.readFileSync(path.join(root, 'client/js/claim.js'), 'utf8');
  assert.match(claimJs, /\/go\/c\//);
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261117100000_competition_rewards.sql'), 'utf8');
  for (const t of ['comp_partners', 'comp_winners', 'comp_winner_events']) assert.match(sql, new RegExp(`alter table public.${t} enable row level security`));
  assert.ok(!/create policy/i.test(sql));
});
