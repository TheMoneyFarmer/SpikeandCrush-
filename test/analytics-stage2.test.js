'use strict';

// Analytics Stage 2: event layer, collector, attribution. Offline (fake client).
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createWriter, cleanReferrer, cleanPage } = require('../server/analytics/events');
const { createCollector } = require('../server/analytics/collector');
const attribution = require('../server/analytics/attribution');
const { EVENTS, CLIENT_EVENTS } = require('../server/analytics/catalogue');
const topics = require('../server/support/topics');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function fakeClient(players = []) {
  const tables = { analytics_events: [], tech_events: [] };
  const c = {
    tables,
    from(t) {
      return {
        insert: async (rows) => { tables[t].push(...rows); return { error: null }; },
        select: () => ({ in: async (_k, ids) => ({ data: players.filter((p) => ids.includes(p.id)) }) }),
      };
    },
  };
  return c;
}

test('catalogue: every required event exists; client events are a closed list', () => {
  const required = ['page_view', 'signup_started', 'signup_submitted', 'email_verified', 'login', 'password_reset_requested', 'password_reset_completed', 'match_started', 'match_ended', 'trade_opened', 'card_played', 'spike_reacted', 'invite_sent', 'invite_accepted', 'discover_join', 'private_room_created', 'private_room_joined', 'competition_viewed', 'competition_entered', 'placement_impression', 'placement_click', 'partner_link_click', 'winner_step', 'support_opened', 'support_escalated', 'a2hs_shown', 'a2hs_accepted', 'a2hs_dismissed', 'app_installed', 'orientation_landscape', 'client_disconnect', 'client_reconnect', 'client_freeze'];
  for (const e of required) assert.ok(EVENTS[e], `${e} in the catalogue`);
  for (const e of ['signup_submitted', 'login', 'match_ended', 'partner_link_click', 'placement_click', 'winner_step']) assert.ok(!CLIENT_EVENTS.has(e), `${e} is server-only (ad blockers cannot drop it, clients cannot fake it)`);
});

test('writer: batches, cleans, marks internal accounts, never stores query strings or raw referrer paths', async () => {
  const client = fakeClient([{ id: '00000000-0000-0000-0000-00000000000a', is_internal: true }]);
  const w = createWriter({ client: () => client, flushMs: 60000 });
  w.track('page_view', { page: '/play?token=secret#x', referrer: 'https://news.example.org/story?id=9', userId: '00000000-0000-0000-0000-00000000000a', props: { evil: 'x' } });
  w.track('not_an_event', {});
  w.track('match_ended', { props: { end_reason: 'completed', rank: 1, email: 'a@b.c' } });
  assert.strictEqual(w.stats.accepted, 2);
  await w.flush();
  const rows = client.tables.analytics_events;
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].page, '/play', 'path only');
  assert.strictEqual(rows[0].referrer, 'news.example.org', 'host only');
  assert.strictEqual(rows[0].is_internal, true, 'internal account marked');
  assert.deepStrictEqual(rows[0].properties, {});
  assert.deepStrictEqual(rows[1].properties, { end_reason: 'completed', rank: 1 }, 'only catalogue properties kept');
  assert.strictEqual(cleanReferrer('https://www.spikeandcrush.com/play'), null, 'own site is not a referrer');
  assert.strictEqual(cleanPage('/competitions/daily-open?utm_source=x'), '/competitions/daily-open');
});

async function collectorApp(viewer = null) {
  const client = fakeClient();
  const writer = createWriter({ client: () => client, flushMs: 60000 });
  const { router } = createCollector({ optionalViewerId: async () => viewer, writer });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/a/collect`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, 'accept-language': 'en', 'x-forwarded-for': '203.0.113.7, 100.64.0.2', ...headers }, body: JSON.stringify(body) });
  return { client, writer, server, post };
}

test('collector: page views counted without consent and without a persistent id; anon id only with consent', async () => {
  const { client, writer, server, post } = await collectorApp();
  const base = { session_id: 'a1b2c3d4e5f60718293a4b5c', utm: { source: 'test', medium: 'cpc', campaign: 'audit' }, referrer: 'https://google.com/search?q=x' };
  assert.strictEqual((await post({ ...base, anon_id: 'ffffffffffffffffffffffff', consent: false, events: [{ name: 'page_view', page: '/' }] })).status, 204);
  await post({ ...base, anon_id: 'eeeeeeeeeeeeeeeeeeeeeeee', consent: true, events: [{ name: 'page_view', page: '/play' }, { name: 'login' }, { name: 'nope' }] });
  await post({ ...base, consent: false, events: [{ name: 'page_view', page: '/' }] }, { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
  await new Promise((r) => setTimeout(r, 50));
  await writer.flush();
  const rows = client.tables.analytics_events;
  assert.strictEqual(rows.length, 2, 'two page views; a client "login" and an unknown name refused; the bot dropped');
  assert.strictEqual(rows[0].anonymous_id, null, 'no consent: no persistent id');
  assert.strictEqual(rows[1].anonymous_id, 'eeeeeeeeeeeeeeeeeeeeeeee', 'consent: first-party id kept');
  assert.ok(rows[0].visitor_day_hash && rows[0].visitor_day_hash === rows[1].visitor_day_hash, 'same visitor today: same daily hash');
  assert.strictEqual(rows[0].utm_source, 'test');
  assert.strictEqual(rows[0].referrer, 'google.com');
  assert.ok(!JSON.stringify(rows).includes('203.0.113.7'), 'never the raw address');
  server.close();
});

test('first touch: cleaned, defaults to the referring site or direct, never a full URL', () => {
  assert.deepStrictEqual(attribution.clean({ source: 'test', medium: 'cpc', campaign: 'audit', referrer: 'https://t.co/abc?x=1', landing: '/?utm_source=test', partner: 'p1' }), { first_source: 'test', first_medium: 'cpc', first_campaign: 'audit', first_referrer: 't.co', first_partner: 'p1', first_landing: '/' });
  assert.strictEqual(attribution.clean({ referrer: 'https://www.reddit.com/r/x' }).first_source, 'reddit.com');
  assert.strictEqual(attribution.clean({}).first_source, 'direct');
});

test('support topics from the player words', () => {
  assert.strictEqual(topics.classify('I forgot my password'), 'account');
  assert.strictEqual(topics.classify('the chart froze in my match'), 'technical');
  assert.strictEqual(topics.classify('when is the weekend open prize paid'), 'competitions');
  assert.strictEqual(topics.classify('hello'), 'other');
});
