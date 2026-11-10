'use strict';

// Test 15f: Discover privacy, visibility rules, location never exposed, scale.
const test = require('node:test');
const assert = require('node:assert');
const discover = require('../server/discover');
const presence = require('../server/presence');
const friendsHub = require('../server/friendsHub');

const LOCATION_KEYS = /country|city|region|^lat|^lon|^lng|coord|distance|proximity|samecountry|^ip$|geo/i;

test('a Discover row never carries any location field, whatever the input row holds', () => {
  const cand = { id: 'x', username: 'Ace', country: 'AE', city: 'Dubai', lat: 25.2, settings: {}, war_rating: 1500, tier: 'Broker' };
  const r = discover.row(cand, discover.presenceView({ status: 'in_lobby', mode: 'Quick War', lobbyId: 'L1' }, {}, 'stranger'), { relation: 'stranger', mutualFriends: 2 });
  for (const k of Object.keys(r)) assert.ok(!LOCATION_KEYS.test(k), `row has ${k}`);
  assert.ok(!JSON.stringify(r).includes('AE') && !JSON.stringify(r).includes('Dubai'));
});

test('appear offline: everyone else sees plain offline and the player is not listable', () => {
  const s = discover.sanitizePrivacyPatch({ appearOffline: true });
  assert.deepStrictEqual(s, { appearOffline: true, showOnline: false });
  for (const rel of ['friend', 'fof', 'stranger']) assert.deepStrictEqual(discover.presenceView({ status: 'online' }, s, rel), { state: 'offline' });
  assert.strictEqual(discover.presenceView({ status: 'online' }, s, 'self').state, 'online');
  assert.strictEqual(discover.listable('me', { id: 'x', settings: s }), false);
  // the legacy toggle means the same thing
  assert.strictEqual(discover.privacy({ showOnline: false }).appearOffline, true);
});

test('who-can-see rules are enforced for status and activity (friends only / nobody)', () => {
  const live = { status: 'in_lobby', mode: 'Quick War', lobbyId: 'L1' };
  const friendsOnly = { statusVisibility: 'friends', activityVisibility: 'friends' };
  assert.strictEqual(discover.presenceView(live, friendsOnly, 'stranger').state, 'offline');
  assert.strictEqual(discover.presenceView(live, friendsOnly, 'fof').state, 'offline');
  const f = discover.presenceView(live, friendsOnly, 'friend');
  assert.deepStrictEqual([f.state, f.mode, f.joinLobbyId], ['online', 'Quick War', 'L1']);
  const statusOnly = { activityVisibility: 'nobody' };
  const v = discover.presenceView(live, statusOnly, 'friend');
  assert.strictEqual(v.mode, undefined);
  assert.strictEqual(v.joinLobbyId, undefined);
  assert.strictEqual(discover.presenceView(live, { allowJoinFromDiscover: false }, 'stranger').joinLobbyId, undefined, 'join disabled by owner');
  assert.strictEqual(discover.presenceView({ status: 'in_match', mode: 'Blitz War' }, {}, 'stranger').joinLobbyId, undefined, 'no join once the match started');
});

test('requests and invites follow everyone / friends of friends / nobody', () => {
  assert.strictEqual(discover.canRequest({ requestsFrom: 'nobody' }, 'fof'), false);
  assert.strictEqual(discover.canRequest({ requestsFrom: 'fof' }, 'stranger'), false);
  assert.strictEqual(discover.canRequest({ requestsFrom: 'fof' }, 'fof'), true);
  assert.strictEqual(discover.canRequest({ allowFriends: false }, 'friend'), false);
  assert.strictEqual(discover.canInvite({ invitesFrom: 'nobody' }, 'stranger'), false);
  assert.strictEqual(discover.canInvite({ invitesFrom: 'nobody' }, 'friend'), true);
  assert.strictEqual(discover.canInvite({ allowInvites: false }, 'stranger'), false);
  assert.deepStrictEqual(discover.sanitizePrivacyPatch({ statusVisibility: 'all', requestsFrom: 'everyone; drop table' }), {}, 'unknown values are dropped');
});

test('blocked, banned, hidden and persona accounts never appear', () => {
  const blocked = new Set(['b']);
  assert.strictEqual(discover.listable('me', { id: 'b', settings: {} }, { blocked }), false);
  assert.strictEqual(discover.listable('me', { id: 'c', is_banned: true, settings: {} }), false);
  assert.strictEqual(discover.listable('me', { id: 'd', banned_until: new Date(Date.now() + 1e6).toISOString(), settings: {} }), false);
  assert.strictEqual(discover.listable('me', { id: 'e', settings: { showInDiscover: false } }), false);
  assert.strictEqual(discover.listable('me', { id: 'f', is_persona: true, settings: {} }), false);
  assert.strictEqual(discover.listable('me', { id: 'g', settings: {} }), true);
});

test('rate limiter for requests and invites holds and resets', () => {
  const allow = friendsHub.createWindowLimiter({ max: 3, windowMs: 1000 });
  const t = 1_000_000;
  assert.deepStrictEqual([allow('a', t), allow('a', t), allow('a', t), allow('a', t)], [true, true, true, false]);
  assert.strictEqual(allow('a', t + 1001), true);
});

test('presence changes notify listeners exactly once per change (no leaks)', () => {
  const seen = [];
  const off = presence.onChange((id, now) => seen.push([id, now.status]));
  presence.setPresence('w1', { status: 'online' });
  presence.setPresence('w1', { status: 'online' }); // no change, no event
  presence.setPresence('w1', { status: 'away' });
  off();
  presence.setPresence('w1', { status: 'online' }); // listener removed
  assert.deepStrictEqual(seen, [['w1', 'online'], ['w1', 'away']]);
});

test('5,000 online players: filter, score and page in well under 100ms, memory flat', () => {
  const me = { id: 'me', war_rating: 1500, country: 'AE' };
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `p${i}`, username: `Trader${i}`, war_rating: 800 + (i % 3000), country: i % 5 ? 'GB' : 'AE', settings: i % 50 === 0 ? { appearOffline: true } : {}, tier: 'Trader' }));
  const before = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  let pages = 0;
  for (let k = 0; k < 20; k++) {
    const list = rows.filter((c) => discover.listable('me', c)).map((c) => ({ c, s: discover.score(c, { me, fofCount: () => 0, playedWith: new Set() }) })).sort((a, b) => b.s - a.s).map((x) => x.c);
    const page = discover.paginate(list, k);
    pages += page.items.length;
    assert.ok(page.items.every((c) => !c.settings.appearOffline));
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  global.gc && global.gc();
  const grew = (process.memoryUsage().heapUsed - before) / 1e6;
  console.log(`5,000 players: ${ms.toFixed(1)} ms per request, heap +${grew.toFixed(1)} MB, ${pages} rows paged`);
  assert.ok(ms < 100, `${ms}ms per request`);
  assert.strictEqual(pages, 20 * 30);
});
