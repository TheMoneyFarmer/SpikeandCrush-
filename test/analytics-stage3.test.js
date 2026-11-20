'use strict';

// Analytics Stage 3: sponsor report from per-click and per-impression rows,
// with no personal data in any output.
const test = require('node:test');
const assert = require('node:assert');
const rep = require('../server/analytics/sponsorReport');

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const HASH = 'f00dfeedf00dfeedf00dfeedf00dfeed';
const ev = (name, at, extra = {}) => ({ id: Math.random(), event_name: name, occurred_at: at, placement_id: P1, page: '/play', device_class: 'phone', visitor_day_hash: HASH, user_id: null, is_internal: false, properties: {}, ...extra });

const events = [
  ev('placement_impression', '2026-11-20T08:00:00Z'),
  ev('placement_impression', '2026-11-20T09:00:00Z', { visitor_day_hash: 'other' }),
  ev('placement_impression', '2026-11-20T09:30:00Z', { user_id: UID, page: '/competitions', device_class: 'desktop', placement_id: P2 }),
  ev('placement_click', '2026-11-20T09:31:00Z', { user_id: UID, page: '/competitions', device_class: 'desktop', placement_id: P2 }),
  ev('partner_link_click', '2026-11-20T21:00:00Z'), // 01:00 next day in Dubai
  ev('placement_impression', '2026-11-20T10:00:00Z', { is_internal: true }),
];

test('sponsor report: totals, uniques, CTR, by page / device / placement / day (Asia/Dubai)', () => {
  const r = rep.build({ sponsor: { name: 'Acme Markets' }, placements: [{ id: P1, slot: 'lobby_strip' }, { id: P2, slot: 'competition_card' }], events, fromDay: '2026-11-20', toDay: '2026-11-21', tz: 'dubai' });
  assert.deepStrictEqual(r.totals, { impressions: 3, unique_viewers: 3, clicks: 2, unique_clickers: 2, ctr: 66.67 });
  assert.strictEqual(r.byDay.find((d) => d.day === '2026-11-21').clicks, 1, '21:00 UTC is the next Dubai day');
  assert.strictEqual(r.byPage.find((p) => p.key === '/play').impressions, 2);
  assert.strictEqual(r.byDevice.find((p) => p.key === 'desktop').clicks, 1);
  assert.strictEqual(r.byPlacement.find((p) => p.key === 'competition_card').ctr, 100);
});

test('sponsor report: JSON, CSV and PDF carry no player id, visitor hash, email or address', () => {
  const r = rep.build({ sponsor: { name: 'Acme Markets' }, placements: [{ id: P1, slot: 'lobby_strip' }], events, fromDay: '2026-11-20', toDay: '2026-11-21' });
  const outputs = { json: JSON.stringify(r), csv: rep.toCsv(r), pdf: rep.toPdf(r).toString('latin1') };
  for (const [kind, text] of Object.entries(outputs)) {
    assert.ok(!text.includes(UID), `${kind}: no player id`);
    assert.ok(!text.includes(HASH), `${kind}: no visitor hash`);
    assert.ok(!/@[a-z0-9-]+\.[a-z]/i.test(text.replace(/@\d/g, '')), `${kind}: no email`);
    assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(text), `${kind}: no IP address`);
  }
  assert.ok(outputs.pdf.startsWith('%PDF-1.4'));
  assert.match(outputs.csv, /^Sponsor report,Acme Markets,2026-11-20 to 2026-11-21/);
});
