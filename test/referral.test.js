'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { qualifiesForInviteReward: ok, INVITE_REWARD_COINS, INVITE_MAX_PAID } = require('../server/referralRules');

const human = (id, extra = {}) => ({ id, isAI: false, tradesMade: 3, ...extra });
const bot = (id) => ({ id, isAI: true, tradesMade: 5 });

test('the agreed reward numbers', () => {
  assert.strictEqual(INVITE_REWARD_COINS, 100);
  assert.strictEqual(INVITE_MAX_PAID, 50);
});

test('invite reward: who qualifies', () => {
  assert.ok(ok([human('f'), human('o')], 'f'), 'friend and another real player');
  assert.ok(ok([human('f'), human('o'), bot('b')], 'f'), 'bots present is fine if another real player is too');
  assert.ok(!ok([human('f'), bot('b'), bot('c')], 'f'), 'only bots does not count');
  assert.ok(!ok([human('f')], 'f'), 'alone does not count');
  assert.ok(!ok([human('f', { forfeited: true }), human('o')], 'f'), 'friend left early');
  assert.ok(!ok([human('f'), human('o', { forfeited: true })], 'f'), 'the other real player left early');
  assert.ok(!ok([human('f', { tradesMade: 0 }), human('o')], 'f'), 'friend made no trade');
  assert.ok(!ok([human('f'), bot('b')], 'b'), 'a bot never qualifies');
});
