'use strict';

// Test 15: ghost challenge links and identical markets.
process.env.SUPABASE_SERVICE_KEY = '';
const test = require('node:test');
const assert = require('node:assert');
const challenge = require('../server/challenge');
const instruments = require('../server/instruments');
const { createGameEngine } = require('../server/gameEngine');

const fakeIo = () => ({ to: () => ({ emit() {} }) });

test('a link round-trips the market and result; tampering and expiry are refused', () => {
  const now = Date.UTC(2026, 10, 10);
  const code = challenge.create({ creatorId: 'u1', username: 'Ace', mode: 'quick', instruments: ['XAUUSD'], marketSeed: 'seed-1', marketStarts: { XAUUSD: 812 }, durationSeconds: 600, pnl: 431.5, rank: 1, sourceMatchId: 'm1' }, now);
  const r = challenge.read(code, now + 1000);
  assert.ok(r.ok);
  assert.deepStrictEqual([r.challenge.username, r.challenge.pnl, r.challenge.marketStarts.XAUUSD, r.challenge.marketSeed], ['Ace', 431.5, 812, 'seed-1']);
  // Edit the result to beat inside the payload: the signature no longer matches.
  const [data, sig] = code.split('.');
  const body = JSON.parse(Buffer.from(data, 'base64url').toString());
  body.p = -999;
  const forged = `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${sig}`;
  assert.strictEqual(challenge.read(forged, now).ok, false);
  assert.strictEqual(challenge.read('nonsense', now).ok, false);
  const late = challenge.read(code, now + 7 * 86400000 + 1);
  assert.strictEqual(late.ok, false);
  assert.strictEqual(late.expired, true);
  assert.ok(challenge.read(code, now + 7 * 86400000 - 1).ok, 'valid for the full 7 days');
});

test('the friend plays byte-identical prices from the same seed and offsets', async () => {
  const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
  const original = await engine.createMatch('quick', { instrumentList: ['XAUUSD', 'NAS100'] });
  const market = engine.getMatchMarket(original.id);
  const ghost = await engine.createMatch('solo', {
    instrumentList: market.instruments,
    marketSeed: market.marketSeed,
    marketStarts: market.marketStarts,
    configOverrides: { durationSeconds: market.durationSeconds, ranked: false, ratingKey: null, fillMethod: 'none', challenge: { username: 'Ace', pnl: 10 } },
  });
  for (const s of market.instruments) {
    assert.strictEqual(JSON.stringify(instruments.getFullLiveSeries(ghost.id, s)), JSON.stringify(instruments.getFullLiveSeries(original.id, s)), s);
    assert.strictEqual(JSON.stringify(instruments.getPreMatchHistory(ghost.id, s)), JSON.stringify(instruments.getPreMatchHistory(original.id, s)), `${s} history`);
  }
  assert.deepStrictEqual(engine.buildMatchStatePayloadFor(ghost, null).challenge, { username: 'Ace', pnl: 10 });
});
