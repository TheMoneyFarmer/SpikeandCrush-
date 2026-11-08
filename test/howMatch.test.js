'use strict';

// The landing page's example match: rules, and balance bots playing the real
// rules faster than real time. Bounds are ranges over many seeds, not exact runs.
const test = require('node:test');
const assert = require('node:assert');
const M = require('../client/js/how-match.js');

const STEP = 0.05;
function run(seed, bot) {
  const m = M.create(seed); M.start(m);
  const mem = {};
  while (!m.ended) { bot(m, mem); M.step(m, STEP); M.drain(m); }
  return m;
}
const rivalLeader = (m) => M.standings(m).filter((s) => s.i !== 0)[0].i;

// Plays well: trades with the trend, banks profit, leaves on sharp drops, uses cards.
function skilled(m, mem) {
  const you = m.players[0], slope = m.price - m.slow;
  if (you.pos) {
    const live = M.live(m, you);
    mem.peak = Math.max(mem.peak || 0, live);
    if (live >= 110 || (mem.peak > 25 && live < mem.peak * 0.55) || live < -70) { M.close(m, 0); mem.peak = 0; mem.wait = m.t + 1; }
  } else if (m.t > (mem.wait || 1) && Math.abs(slope) > 0.35) M.open(m, 0, slope > 0 ? 1 : -1, 1);
  if (m.t > 16 && you.hand.length === 3) M.play(m, 0, 'pip-theft', rivalLeader(m));
  const target = M.standings(m).filter((s) => s.i !== 0 && m.players[s.i].pos && M.live(m, m.players[s.i]) > 60)[0];
  if (target && you.hand.includes('force-close')) M.play(m, 0, 'force-close', target.i);
  if (m.t > 48 && you.hand.includes('chart-ghost')) M.play(m, 0, 'chart-ghost', rivalLeader(m));
}
// Average: buys, holds a while, closes on a timer; one card late on.
function average(m, mem) {
  const you = m.players[0];
  if (you.pos) { if (m.t > mem.until) M.close(m, 0); } else if (m.t > (mem.next || 3)) { M.open(m, 0, m.rand() < 0.6 ? 1 : -1, 1); mem.until = m.t + 9; mem.next = m.t + 12; }
  if (m.t > 40 && you.hand.length === 3) M.play(m, 0, 'pip-theft', rivalLeader(m));
}
// Careless: biggest size, always Buy, never closes.
function careless(m) { if (!m.players[0].pos && m.t > 2) M.open(m, 0, 1, 2); }
const idle = () => {};

function survey(bot, seeds = 400) {
  const ranks = { 1: 0, 2: 0, 3: 0, 4: 0 }; let coins = 0; const lines = new Set();
  for (let s = 1; s <= seeds; s++) { const m = run(s * 7919, bot); ranks[m.result.rank]++; coins += m.result.coins; lines.add(m.result.story.line); }
  const pct = (k) => ranks[k] / seeds;
  return { first: pct(1), last: pct(4), ranks, coins: coins / seeds, lines };
}

test('same seed and same play gives the same round', () => {
  const a = run(42, average), b = run(42, average);
  assert.deepStrictEqual(a.result.order, b.result.order);
});

test('a trade banks exactly its profit when closed', () => {
  const m = M.create(5); M.start(m);
  M.open(m, 0, 1, 1); const entry = m.players[0].pos.entry;
  for (let i = 0; i < 60; i++) M.step(m, STEP);
  if (m.players[0].pos) {
    const expected = Math.round((m.price - entry) * M.RULES.pnlPerPoint);
    assert.strictEqual(M.close(m, 0), expected);
    assert.strictEqual(m.players[0].bank, expected);
    assert.strictEqual(m.players[0].pos, null);
  }
});

test('one trade at a time, and Sell profits when price falls', () => {
  const m = M.create(9); M.start(m);
  assert.ok(M.open(m, 0, -1, 2));
  assert.strictEqual(M.open(m, 0, 1, 1), false);
  m.price = m.players[0].pos.entry - 5;
  assert.strictEqual(M.live(m, m.players[0]), 5 * M.RULES.pnlPerPoint * 2);
});

test('a big loser is stopped out', () => {
  const m = M.create(11); M.start(m);
  M.open(m, 0, 1, 2);
  m.price = m.players[0].pos.entry - 100;
  M.step(m, STEP);
  assert.strictEqual(m.players[0].pos, null);
  assert.strictEqual(m.players[0].stats.stopOuts, 1);
  assert.ok(m.players[0].bank < 0);
});

test('an open trade closes itself at the bell', () => {
  const m = M.create(13); M.start(m); M.open(m, 0, 1, 1);
  M.finish(m);
  assert.strictEqual(m.players[0].pos, null);
  assert.strictEqual(m.result.stats.trades, 1);
});

test('cards do what the real game does, and are used up', () => {
  const m = M.create(17); M.start(m);
  M.open(m, 1, 1, 1); m.price += 3;
  assert.ok(M.play(m, 0, 'force-close', 1));
  assert.strictEqual(m.players[1].pos, null, 'Force Close shuts the trade');
  assert.ok(m.players[1].bank > 0, 'at its current profit');
  assert.strictEqual(M.play(m, 0, 'force-close', 2), false, 'each card plays once');
  const before = [m.players[0].bank, m.players[2].bank];
  M.play(m, 0, 'pip-theft', 2);
  assert.strictEqual(m.players[0].bank, before[0] + 150);
  assert.strictEqual(m.players[2].bank, before[1] - 150);
  M.play(m, 0, 'chart-ghost', 3);
  assert.strictEqual(m.players[3].frozen, M.RULES.freeze);
});

test('Force Close on someone with no trade is refused and keeps the card', () => {
  const m = M.create(19); M.start(m);
  assert.strictEqual(M.play(m, 0, 'force-close', 2), false);
  assert.ok(m.players[0].hand.includes('force-close'));
  assert.strictEqual(m.players[0].stats.played, 0);
});

test('a frozen rival cannot react', () => {
  const m = M.create(23); M.start(m);
  M.open(m, 1, 1, 1); m.players[1].peakSeen = m.price;
  m.players[1].frozen = 10;
  const pos = m.players[1].pos;
  m.price -= 50;
  for (let i = 0; i < 40 && m.players[1].frozen > 0.1; i++) { m.price = pos.entry - 1; M.step(m, STEP); }
  assert.strictEqual(m.players[1].pos, pos);
});

test('prizes follow the finish: first takes most, last gets nothing', () => {
  assert.deepStrictEqual(M.PRIZES, { 1: 17, 2: 9, 3: 5, 4: 0 });
  for (let s = 1; s < 60; s++) {
    const r = run(s * 101, careless).result;
    assert.strictEqual(r.coins, M.PRIZES[r.rank]);
    if (r.rank === 4) assert.strictEqual(r.coins, 0);
    assert.ok(r.story.line && r.story.tip, 'every finish explains itself');
  }
});

test('reaching the bell early leaves only the final seconds', () => {
  const m = M.create(29); M.start(m);
  for (let i = 0; i < 100; i++) M.step(m, STEP);
  M.hurry(m);
  assert.ok(Math.abs(m.duration - (m.t + M.RULES.finalSeconds)) < 1e-6);
});

test('balance: skill wins often, and no one wins every time', () => {
  const s = survey(skilled), a = survey(average), c = survey(careless), i = survey(idle);
  const fmt = (x) => `1st ${(x.first * 100).toFixed(0)}% last ${(x.last * 100).toFixed(0)}% coins ${x.coins.toFixed(1)}`;
  console.log(`skilled  ${fmt(s)}\naverage  ${fmt(a)}\ncareless ${fmt(c)}\nidle     ${fmt(i)}`);
  // A good player should usually be paid but must still be beatable.
  assert.ok(s.first >= 0.4 && s.first <= 0.9, `skilled first ${s.first}`);
  assert.ok(s.last <= 0.15, `skilled last ${s.last}`);
  // Careless play is where last place comes from.
  assert.ok(c.last >= 0.3, `careless last ${c.last}`);
  assert.ok(c.first <= 0.3, `careless first ${c.first}`);
  // Doing nothing must not be a good plan, nor a guaranteed last.
  assert.ok(i.first <= 0.2, `idle first ${i.first}`);
  assert.ok(s.coins > a.coins && a.coins > c.coins - 1, 'better play earns more');
  // The different endings are all reachable.
  assert.ok(new Set([...s.lines, ...a.lines, ...c.lines, ...i.lines]).size >= 6);
});
