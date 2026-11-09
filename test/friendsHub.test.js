'use strict';

const test = require('node:test');
const assert = require('node:assert');
const hub = require('../server/friendsHub');

test('a hidden player looks offline, with no match or lobby to find', () => {
  const live = { status: 'in_lobby', matchId: 'm', lobbyId: 'l', mode: 'Quick War', lastSeen: 5 };
  assert.strictEqual(hub.visiblePresence({}, live), live);
  assert.strictEqual(hub.visiblePresence(null, live), live);
  assert.deepStrictEqual(hub.visiblePresence({ showOnline: false }, live), {
    status: 'offline', matchId: null, lobbyId: null, mode: null, lastSeen: null,
  });
});

test('relations read correctly from either side', () => {
  const rows = [
    { id: 'r1', requester_id: 'me', addressee_id: 'a', status: 'pending' },
    { id: 'r2', requester_id: 'b', addressee_id: 'me', status: 'pending' },
    { id: 'r3', requester_id: 'c', addressee_id: 'me', status: 'accepted' },
    { id: 'r4', requester_id: 'd', addressee_id: 'me', status: 'blocked' },
  ];
  assert.deepStrictEqual(hub.relationFor('me', 'a', rows), { relation: 'sent', requestId: 'r1' });
  assert.deepStrictEqual(hub.relationFor('me', 'b', rows), { relation: 'received', requestId: 'r2' });
  assert.deepStrictEqual(hub.relationFor('me', 'c', rows), { relation: 'friend', requestId: null });
  assert.deepStrictEqual(hub.relationFor('me', 'd', rows), { relation: 'none', requestId: null });
  assert.deepStrictEqual(hub.relationFor('me', 'z', rows), { relation: 'none', requestId: null });
});

test('players around you: same country first, then closest rating', () => {
  const me = { country: 'AE', war_rating: 1000 };
  const names = hub
    .rankOnlinePlayers(
      [
        { username: 'far_home', country: 'AE', war_rating: 1500 },
        { username: 'near_away', country: 'GB', war_rating: 1010 },
        { username: 'near_home', country: 'AE', war_rating: 990 },
        { username: 'mid_away', war_rating: 1100 },
      ],
      me
    )
    .map((p) => p.username);
  assert.deepStrictEqual(names, ['near_home', 'far_home', 'near_away', 'mid_away']);
});

test('without a chosen country nobody counts as nearby', () => {
  const names = hub
    .rankOnlinePlayers([{ username: 'a', war_rating: 1300 }, { username: 'b', war_rating: 1100 }], { war_rating: 1000 })
    .map((p) => p.username);
  assert.deepStrictEqual(names, ['b', 'a']);
});

test('invite rules', () => {
  const open = { isFriend: false, blocked: false, connected: true, presenceStatus: 'online', settings: {}, alreadyInvited: false };
  assert.strictEqual(hub.inviteBlockReason(open), null, 'a stranger can invite by default');
  assert.strictEqual(hub.inviteBlockReason({ ...open, blocked: true }), 'offline', 'a block looks like being offline');
  assert.strictEqual(hub.inviteBlockReason({ ...open, connected: false }), 'offline');
  assert.strictEqual(hub.inviteBlockReason({ ...open, presenceStatus: 'in_match' }), 'busy', 'never interrupt a match');
  assert.strictEqual(hub.inviteBlockReason({ ...open, alreadyInvited: true }), 'already_invited');
  assert.strictEqual(hub.inviteBlockReason({ ...open, settings: { allowInvites: false } }), 'not_accepting');
  assert.strictEqual(hub.inviteBlockReason({ ...open, settings: { showOnline: false } }), 'offline', 'hidden from strangers');
  const friend = { ...open, isFriend: true };
  assert.strictEqual(hub.inviteBlockReason({ ...friend, settings: { allowInvites: false } }), null, 'friends still can');
  assert.strictEqual(hub.inviteBlockReason({ ...friend, settings: { showOnline: false } }), null);
  assert.strictEqual(hub.inviteBlockReason({ ...friend, blocked: true }), 'offline', 'a block beats friendship');
});

test('search wildcards are treated as plain characters', () => {
  assert.strictEqual(hub.escapeLikePattern('a_b%c\\'), 'a\\_b\\%c\\\\');
  assert.strictEqual(hub.escapeLikePattern('plain'), 'plain');
});

test('search puts the exact username first, then names starting with it', () => {
  const names = hub
    .rankSearchResults([{ username: 'xspike' }, { username: 'SPIKE2' }, { username: 'spike' }, { username: 'spike1' }], 'Spike')
    .map((p) => p.username);
  assert.deepStrictEqual(names, ['spike', 'spike1', 'SPIKE2', 'xspike']);
});

test('the limiter caps a player inside the window and clears afterwards', () => {
  const allow = hub.createWindowLimiter({ max: 2, windowMs: 1000 });
  assert.strictEqual(allow('a', 0), true);
  assert.strictEqual(allow('a', 10), true);
  assert.strictEqual(allow('a', 20), false);
  assert.strictEqual(allow('b', 20), true, 'players are separate');
  assert.strictEqual(allow('a', 1011), true);
});
