'use strict';

// Competition states, the two prize worlds and card wording (server/competitionStates.js).
const test = require('node:test');
const assert = require('node:assert');
const cs = require('../server/competitionStates');
const liveFeed = require('../server/liveFeed');
const { MATCH_MODES } = require('../server/gameEngine');

const money = { prize_kind: 'money', prize_currency: 'USD', entry_fee_coins: 0, prize_pool_coins: 0 };

test('no prize number until a super admin confirms the pool', () => {
  assert.strictEqual(cs.prizeWording({ ...money, prize_pool_amount: 5000, prize_pool_confirmed: false }).label, 'Cash prizes');
  const w = cs.prizeWording({ ...money, prize_pool_amount: 5000, prize_top_amount: 25000, prize_pool_confirmed: true });
  assert.strictEqual(w.label, '$5,000 prize pool');
  assert.strictEqual(w.top, 'Up to $25,000 on featured days');
  assert.strictEqual(w.badge, 'Free entry');
});

test('coin prizes never carry a currency symbol', () => {
  const w = cs.prizeWording({ prize_kind: 'coins', prize_pool_coins: 1500, entry_fee_coins: 10 });
  assert.match(w.label, /coins/);
  assert.doesNotMatch(w.label, /[$€£¥]|USD|EUR/);
});

test('partner prize text is shown exactly as supplied', () => {
  assert.strictEqual(cs.prizeWording({ prize_kind: 'partner', prize_text: '$100,000 funded account' }).label, '$100,000 funded account');
});

test('a money competition can never charge coins or pay coins; a coin event never carries money', () => {
  assert.throws(() => cs.assertSeparation({ ...money, entry_fee_coins: 10 }), /free to enter/);
  assert.throws(() => cs.assertSeparation({ ...money, prize_pool_coins: 100 }), /cannot pay coins/);
  assert.throws(() => cs.assertSeparation({ prize_kind: 'coins', prize_pool: 5000 }), /cannot carry a money prize/);
  assert.ok(cs.assertSeparation({ ...money }));
  assert.ok(cs.assertSeparation({ prize_kind: 'coins', entry_fee_coins: 10, prize_pool_coins: 200, prize_pool: 0 }));
});

test('game modes pay coins only', () => {
  assert.ok(cs.assertGameModesCoinsOnly(MATCH_MODES));
  assert.throws(() => cs.assertGameModesCoinsOnly({ quick: { prizeCurrency: 'USD' } }), /coins only/);
});

test('coming soon, paused and live-without-a-feed cannot be entered', () => {
  assert.strictEqual(cs.enterGate({ ...money, state: 'coming_soon', data_source: 'live' }).ok, false);
  assert.strictEqual(cs.enterGate({ ...money, state: 'paused', data_source: 'replay' }).ok, false);
  assert.strictEqual(cs.enterGate({ ...money, state: 'open', data_source: 'live' }, { liveOk: false }).ok, false);
  assert.strictEqual(cs.enterGate({ ...money, state: 'open', data_source: 'live' }, { liveOk: true }).ok, true);
  assert.strictEqual(cs.enterGate({ ...money, state: 'open', data_source: 'replay', entry_fee_coins: 5 }).ok, false);
  assert.strictEqual(cs.enterGate({ prize_kind: 'coins', state: 'running', data_source: 'replay', entry_fee_coins: 10 }).ok, true);
});

test('a live template cannot be opened while the feed is not ready', () => {
  assert.strictEqual(cs.stateChangeGate({ data_source: 'live' }, 'open', { liveOk: false }).ok, false);
  assert.strictEqual(cs.stateChangeGate({ data_source: 'live' }, 'running', { liveOk: false }).ok, false);
  assert.strictEqual(cs.stateChangeGate({ data_source: 'live' }, 'paused', { liveOk: false }).ok, true);
  assert.strictEqual(cs.stateChangeGate({ data_source: 'replay' }, 'open', { liveOk: false }).ok, true);
});

test('the live feed extension point reports not ready and not healthy', async () => {
  assert.strictEqual(liveFeed.healthy(), false);
  liveFeed.resetCache();
  assert.strictEqual(await liveFeed.canGoLive({ isConfigured: true, getAppSetting: async () => true }), false); // ready but not healthy
  liveFeed.resetCache();
  assert.strictEqual(await liveFeed.isReady({ isConfigured: true, getAppSetting: async () => { throw new Error('no table'); } }), false);
  liveFeed.resetCache();
});

test('card wording rules catch the banned phrases', () => {
  for (const bad of ['Guaranteed $5,000', 'Funded by Acme', 'Prizes provided by Acme', 'Win money today']) assert.ok(cs.cardTextViolations(bad).length, bad);
  assert.deepStrictEqual(cs.cardTextViolations('Trade the real session. Market open to close. Winners every day.'), []);
});
