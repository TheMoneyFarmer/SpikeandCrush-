'use strict';
// Competitions page rebuild: schedules, ordering, secrecy helpers, seed rules.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sch = require('../server/compSchedule');
const L = require('../server/listings');

const iso = (w) => [w.startsAt.toISOString(), w.endsAt.toISOString()];

test('Weekend Open: Saturday 00:00 to Sunday 23:59 in the configured timezone, two days', () => {
  assert.deepStrictEqual(iso(sch.nextWeekend(Date.UTC(2026, 10, 11), { timezone: 'UTC' })), ['2026-11-14T00:00:00.000Z', '2026-11-15T23:59:00.000Z']);
  // US clocks go forward Sun 8 Mar 2026: Saturday is EST (-5), Sunday night is EDT (-4)
  assert.deepStrictEqual(iso(sch.nextWeekend(Date.UTC(2026, 2, 5), { timezone: 'America/New_York' })), ['2026-03-07T05:00:00.000Z', '2026-03-09T03:59:00.000Z']);
  // US clocks go back Sun 1 Nov 2026: Saturday EDT (-4), Sunday night EST (-5)
  assert.deepStrictEqual(iso(sch.nextWeekend(Date.UTC(2026, 9, 29), { timezone: 'America/New_York' })), ['2026-10-31T04:00:00.000Z', '2026-11-02T04:59:00.000Z']);
  // UK clocks go forward Sun 29 Mar 2026
  assert.deepStrictEqual(iso(sch.nextWeekend(Date.UTC(2026, 2, 26), { timezone: 'Europe/London' })), ['2026-03-28T00:00:00.000Z', '2026-03-29T22:59:00.000Z']);
  // during a weekend it returns the current one; after it ends, the next
  assert.deepStrictEqual(iso(sch.nextWeekend(Date.UTC(2026, 10, 15, 12), {})), ['2026-11-14T00:00:00.000Z', '2026-11-15T23:59:00.000Z']);
  assert.deepStrictEqual(iso(sch.nextWeekend(Date.UTC(2026, 10, 16), {})), ['2026-11-21T00:00:00.000Z', '2026-11-22T23:59:00.000Z']);
  assert.strictEqual(sch.nextWeekend(Date.UTC(2026, 10, 11), {}).days, 2);
});

test('Daily Open: Monday to Friday, open to close; skips the weekend', () => {
  assert.deepStrictEqual(iso(sch.nextDaily(Date.UTC(2026, 10, 11, 10), {})), ['2026-11-11T00:00:00.000Z', '2026-11-11T22:00:00.000Z']);
  assert.deepStrictEqual(iso(sch.nextDaily(Date.UTC(2026, 10, 13, 23), {})), ['2026-11-16T00:00:00.000Z', '2026-11-16T22:00:00.000Z']);
  assert.strictEqual(sch.nextDaily(Date.UTC(2026, 10, 11), { timezone: 'Not/AZone' }).timezone, 'UTC');
});

test('listing order: pin, then tier (in its dates), then listed first, then name', () => {
  const now = Date.UTC(2026, 10, 12);
  const d = (n) => new Date(now - n * 86400000).toISOString();
  const rows = [
    { id: 'a', type: 'external', title: 'Bravo', tier: 'standard', listed_at: d(30) },
    { id: 'b', type: 'external', title: 'Alpha', tier: 'plus', listed_at: d(2) },
    { id: 'c', type: 'broker', title: 'Charlie', tier: 'featured', listed_at: d(1) },
    { id: 'd', type: 'external', title: 'Delta', tier: 'plus', listed_at: d(10) },
    { id: 'e', type: 'sponsored', title: 'Echo', tier: 'featured', listed_at: d(5), tier_ends_at: d(1) }, // featured expired
    { id: 'f', type: 'sponsored', title: 'Able', tier: 'standard', listed_at: d(30) }, // same day as a: name decides
  ];
  assert.deepStrictEqual(L.sortListings(rows, 'all', now).map((r) => r.id), ['c', 'd', 'b', 'f', 'a', 'e']);
  const pinned = rows.map((r) => (r.id === 'a' ? { ...r, pin_tab: 'all', pin_ends_at: d(-1) } : r));
  assert.strictEqual(L.sortListings(pinned, 'all', now)[0].id, 'a', 'a pin wins');
  const expired = rows.map((r) => (r.id === 'a' ? { ...r, pin_tab: 'all', pin_ends_at: d(1) } : r));
  assert.strictEqual(L.sortListings(expired, 'all', now)[0].id, 'c', 'an expired pin does nothing');
  const order = L.orderFor(rows, now);
  assert.deepStrictEqual(order.prop, ['d', 'b', 'a']);
  assert.deepStrictEqual(order.broker, ['c']);
});

test('public listing never carries an outbound URL, token or codes while Coming soon', () => {
  const row = { id: 'x', slug: 'x-cup', type: 'external', title: 'X Cup', state: 'coming_soon', prize_kind: 'money', prize_pool: 5000, prize_currency: 'USD', public_token: 'TOKEN12345', external_url: 'https://secret.example/?ref=ABC', listing: {}, organizer: { name: 'X' } };
  const p = L.publicListing(row);
  const json = JSON.stringify(p);
  assert.strictEqual(p.outbound, null);
  assert.doesNotMatch(json, /TOKEN12345|secret\.example|ABC/);
  assert.strictEqual(p.prize.amount, '$5,000');
  const live = L.publicListing({ ...row, state: 'open' });
  assert.strictEqual(live.outbound, '/go/l/TOKEN12345');
  assert.doesNotMatch(JSON.stringify(live), /secret\.example|ABC/);
});

test('seed: invented names only, generated logos only, Preview-tagged, tiers as asked', () => {
  const root = path.join(__dirname, '..');
  const seed = JSON.parse(fs.readFileSync(path.join(root, 'data/seed/competition-listings.json'), 'utf8'));
  const blocklist = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/real-firm-names.json'), 'utf8'));
  assert.ok(blocklist.length >= 100, `blocklist has ${blocklist.length} names`);
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const counts = { prop: 0, broker: 0, sponsored: 0 };
  const tiers = { featured: 0, plus: 0, standard: 0 };
  const { MARKER } = require('../server/listingLogos');
  for (const l of seed.listings) {
    counts[l.type] += 1; tiers[l.tier] += 1;
    assert.strictEqual(l.preview, true, `${l.organizer.name} is Preview`);
    // whole-word match, so "games console" is not flagged as "NAGA"
    const words = (x) => ` ${String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
    for (const real of blocklist) {
      const r = words(real);
      if (r.trim().length < 3) continue;
      assert.ok(!words(l.organizer.name).includes(r) && !words(l.title).includes(r) && norm(l.organizer.name) !== norm(real), `"${l.organizer.name}" / "${l.title}" matches real name "${real}"`);
    }
    assert.match(l.organizer.logo, /^\/img\/listings\/[a-z0-9-]+\.svg$/);
    const svg = fs.readFileSync(path.join(root, 'client', l.organizer.logo), 'utf8');
    assert.ok(svg.includes(MARKER), `${l.organizer.logo} comes from our generator`);
    assert.doesNotMatch(svg, /<image|href=|url\(/, 'no outside images inside the logo');
    if (l.prize.kind === 'money') assert.ok(l.prize.amount >= 1000 && l.prize.amount <= 30000 && l.prize.amount % 1000 === 0);
    assert.doesNotMatch(JSON.stringify(l), /https?:\/\//, 'no outbound URL in the seed');
  }
  assert.deepStrictEqual(counts, { prop: 6, broker: 5, sponsored: 6 });
  assert.deepStrictEqual(tiers, { featured: 2, plus: 4, standard: 11 });
  const files = fs.readdirSync(path.join(root, 'client/img/listings'));
  assert.strictEqual(files.length, 17);
});
