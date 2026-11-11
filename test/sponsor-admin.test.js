'use strict';
// Sponsors admin rules: placement validation, banned wording, preview links,
// and reports that carry counts only.
const test = require('node:test');
const assert = require('node:assert');
const sponsorsRoute = require('../admin/routes/sponsors');
const { createSponsorSlots, signPreview, SLOT_NAMES } = require('../server/sponsorSlots');
const { renderReport } = require('../server/sponsorReport');

const pf = (b) => sponsorsRoute.placementFields(b, { partial: false });

test('placement: every slot is accepted, an unknown slot is refused', () => {
  for (const slot of SLOT_NAMES) assert.ok(pf({ slot }).fields, slot);
  assert.match(pf({ slot: 'chart_overlay' }).error, /slot must be one of/);
  assert.match(pf({ slot: 'order_ticket' }).error, /slot must be one of/);
});

test('placement: targets are validated and new placements start as drafts', () => {
  const ok = pf({ slot: 'competition_card', targets: 'competition:daily, mode:quick' }).fields;
  assert.strictEqual(ok.targets, 'competition:daily,mode:quick');
  assert.strictEqual(ok.status, 'draft');
  assert.match(pf({ slot: 'lobby_strip', targets: 'javascript:alert(1)' }).error, /not valid/);
});

test('placement: banned prize wording is refused in taglines and buttons', () => {
  assert.match(pf({ slot: 'event_banner', tagline: 'Win money every day' }).error, /not allowed/);
  assert.match(pf({ slot: 'event_banner', ctaText: 'Guaranteed payout' }).error, /not allowed/);
  assert.ok(pf({ slot: 'event_banner', tagline: 'Tight spreads, fast fills' }).fields);
});

test('placement: a button needs text and an http(s) link; dates must be in order', () => {
  assert.match(pf({ slot: 'result_screen', creative: 'logo_tagline_cta', ctaText: 'Visit' }).error, /needs both/);
  assert.match(pf({ slot: 'result_screen', ctaUrl: 'javascript:x' }).error, /http/);
  assert.match(pf({ slot: 'lobby_strip', startsAt: '2026-12-02', endsAt: '2026-12-01' }).error, /after the start/);
  assert.match(pf({ slot: 'lobby_strip', weight: 0 }).error, /Weight/);
});

test('placement: text-only slots never carry a logo creative', () => {
  assert.strictEqual(pf({ slot: 'spike_strip_tag', creative: 'logo' }).fields.creative, 'logo_tagline');
  assert.strictEqual(pf({ slot: 'email_footer', creative: 'logo_tagline_cta' }).fields.creative, 'logo_tagline');
});

test('preview link: signed by admin with the shared secret, refused with any other', () => {
  const id = '22222222-2222-2222-2222-222222222222';
  const tok = signPreview('shared-secret', id);
  assert.strictEqual(createSponsorSlots({ db: { isConfigured: false }, secret: 'shared-secret' }).verifyPreview(tok), id);
  assert.strictEqual(createSponsorSlots({ db: { isConfigured: false }, secret: 'other' }).verifyPreview(tok), null);
  assert.strictEqual(sponsorsRoute.previewPath({ slot: 'competition_card', targets: 'competition:weekly' }), '/competitions/weekly');
  assert.strictEqual(sponsorsRoute.previewPath({ slot: 'event_banner', targets: 'discover' }), '/discover');
});

test('report: counts only, no player handles, emails or ids', () => {
  const pid = '33333333-3333-3333-3333-333333333333';
  const html = renderReport({
    sponsor: { id: 's1', name: 'Acme Markets', contact_email: 'deals@acme.test' },
    fromDay: '2026-11-01', toDay: '2026-11-10',
    stats: { placements: [{ id: pid, slot: 'lobby_strip', targets: 'all' }], days: [{ placement_id: pid, day: '2026-11-02', impressions: 120, unique_viewers: 80, clicks: 6, entries: 2, outbound_clicks: 3 }] },
    waiting: [{ title: 'Daily', count: 41 }],
  });
  assert.match(html, /Acme Markets/);
  assert.match(html, />120</);
  assert.doesNotMatch(html, /@/, 'no email addresses');
  assert.doesNotMatch(html, new RegExp(pid), 'no internal ids');
  assert.doesNotMatch(html, /user_id|username|handle/i);
  assert.doesNotMatch(html, /\$/, 'no currency symbol');
});
