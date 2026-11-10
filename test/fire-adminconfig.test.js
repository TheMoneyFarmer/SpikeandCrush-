'use strict';
// The admin Match Settings reload: only known fields, as whole numbers.
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeMatchSettings } = require('../server/internalAdmin');

test('saved match settings are cleaned before they reach the engine', () => {
  const out = sanitizeMatchSettings({ quick: { entryCoins: 15, durationSeconds: '600', maxPlayers: -1, hack: 1, cardsPerPlayer: 2.5 }, blitz: 'nope', grand: { maxPlayers: 10 } });
  assert.deepStrictEqual(out, { quick: { entryCoins: 15, durationSeconds: 600 }, grand: { maxPlayers: 10 } });
  assert.strictEqual(sanitizeMatchSettings(null), null);
});
