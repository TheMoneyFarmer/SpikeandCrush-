'use strict';

// Action Engine and freeze fix: the price loop (rate, server clock, no
// queueing after a stall), sub-second prices that keep every whole second
// identical to the old series, fairness (same seed = same prices), and no
// repeated window back to back.

process.env.SUPABASE_URL = '';
const test = require('node:test');
const assert = require('node:assert');
const instruments = require('../server/instruments');
const { createGameEngine } = require('../server/gameEngine');
const sabotage = require('../server/sabotage');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = Object.keys(sabotage.CARDS);

function makeEngine(onEmit) {
  const io = { to: (room) => ({ emit: (ev, payload) => onEmit(room, ev, payload) }), emit() {}, sockets: { sockets: new Map() } };
  return createGameEngine(io, () => {}, () => {}, () => {}, () => true);
}

// Ends a test match the normal way: move its clock past the end and let the
// engine's own tick finish it (stops every timer).
async function finish(match) {
  match.startedAt = Date.now() - (match.config.durationSeconds + 2) * 1000;
  for (let i = 0; i < 40 && match.status !== 'finished'; i++) await wait(250);
}

async function startMatch(engine, mode, tag) {
  const match = await engine.createMatch(mode, {});
  for (let i = 0; i < 2; i++) engine.joinMatch(match, { id: `${tag}${i}`, username: `${tag}${i}`, war_rating: 1000, unlockedCards: ALL }, `${tag}sock${i}`);
  engine.forceStartLobby(match.id);
  for (let i = 0; i < 40 && match.status !== 'active'; i++) await wait(250);
  return match;
}

test('price loop: 4 messages a second, each with seq, serverTime and endsAt', async () => {
  instruments.preloadAll();
  const got = [];
  const engine = makeEngine((room, ev, p) => { if (ev === 'price:update') got.push({ at: Date.now(), p }); });
  const match = await startMatch(engine, 'quick', 'pl');
  assert.strictEqual(match.status, 'active');
  got.length = 0;
  await wait(3000);
  const mine = got.filter((g) => g.p.matchId === match.id);
  assert.ok(mine.length >= 11 && mine.length <= 13, `about 12 messages in 3 s, got ${mine.length}`);
  for (let i = 1; i < mine.length; i++) assert.ok(mine[i].p.seq > mine[i - 1].p.seq, 'seq increases');
  for (const g of mine) {
    assert.ok(Number.isFinite(g.p.serverTime) && Number.isFinite(g.p.endsAt));
    assert.strictEqual(g.p.endsAt, match.startedAt + match.config.durationSeconds * 1000);
  }
  // The chart's market time is fractional (several steps a second).
  assert.ok(mine.some((g) => !Number.isInteger(g.p.dataSeconds)));
  await finish(match);
  assert.strictEqual(match.status, 'finished', 'ends by its own clock with nobody connected');
});

test('a 500 ms stall in one match does not make another match queue up prices', async () => {
  const gaps = {};
  const last = {};
  let stalls = 0;
  let stallId = null;
  const engine = makeEngine((room, ev, p) => {
    if (ev !== 'price:update') return;
    const now = Date.now();
    if (last[p.matchId]) (gaps[p.matchId] = gaps[p.matchId] || []).push(now - last[p.matchId]);
    last[p.matchId] = now;
    // Match A blocks the process for 500 ms on its 6th message, once.
    if (p.matchId === stallId && p.seq === 6 && stalls === 0) {
      stalls++;
      const until = Date.now() + 500;
      while (Date.now() < until) { /* stall */ }
    }
  });
  const a = await startMatch(engine, 'quick', 'sa');
  stallId = a.id;
  const b = await startMatch(engine, 'quick', 'sb');
  for (const k of Object.keys(gaps)) gaps[k].length = 0;
  await wait(4000);
  const g = gaps[b.id] || [];
  assert.ok(stalls === 1, 'the stall happened');
  assert.ok(g.length >= 12, `match B kept sending (${g.length} gaps)`);
  // After the stall B skips ahead: no burst of back-to-back catch-up messages.
  const bursts = g.filter((x) => x < 60).length;
  assert.ok(bursts <= 1, `no queued catch-up burst (back-to-back messages: ${bursts})`);
  assert.ok(Math.max(...g) < 800, `worst gap ${Math.max(...g)} ms`);
  await finish(a);
  await finish(b);
});

test('sub-second prices: every whole second is exactly the old per-second price', () => {
  for (const sym of ['USDJPY', 'XAUUSD', 'BTCUSD', 'NAS100']) {
    const id = `sub-${sym}`;
    instruments.assignMatchWindow(id, sym, id, 3, { speed: 2 });
    for (let s = 0; s < 120; s++) {
      assert.strictEqual(instruments.getPriceAt(id, sym, s).mid, instruments.getCurrentPrice(id, sym, s).mid);
    }
    // Inside a second the price moves at every step.
    let changes = 0;
    let prev = instruments.getPriceAt(id, sym, 10).mid;
    for (let k = 1; k <= 8; k++) {
      const p = instruments.getPriceAt(id, sym, 10 + k / 4).mid;
      if (p !== prev) changes++;
      prev = p;
    }
    assert.strictEqual(changes, 8, `${sym}: every quarter second is a new price`);
    instruments.releaseMatchWindows(id);
  }
});

test('fairness: the same seed gives every player the same series; back-to-back matches never share a window', () => {
  const sym = 'USDJPY';
  instruments.assignMatchWindow('fair-1', sym, 'seed-x', 10, {});
  const a = instruments.getMarketInfo('fair-1')[sym];
  const s1 = Array.from({ length: 40 }, (_, k) => instruments.getPriceAt('fair-1', sym, k / 4).mid);
  instruments.releaseMatchWindows('fair-1');
  const starts = [a.start];
  for (let i = 0; i < 6; i++) {
    instruments.assignMatchWindow(`fair-n${i}`, sym, `seed-n${i}`, 10, {});
    starts.push(instruments.getMarketInfo(`fair-n${i}`)[sym].start);
    instruments.releaseMatchWindows(`fair-n${i}`);
  }
  for (let i = 1; i < starts.length; i++) assert.notStrictEqual(starts[i], starts[i - 1], 'never the same window twice in a row');
  // A replay (ghost, challenge) of the same seed and start rebuilds the same prices.
  instruments.assignMatchWindow('fair-2', sym, 'seed-x', 10, { startIndex: a.start });
  const s2 = Array.from({ length: 40 }, (_, k) => instruments.getPriceAt('fair-2', sym, k / 4).mid);
  instruments.releaseMatchWindows('fair-2');
  assert.deepStrictEqual(s2, s1);
});
