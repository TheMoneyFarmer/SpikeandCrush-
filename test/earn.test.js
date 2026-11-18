'use strict';

// Earn coins (server/earn.js): eligibility from server data, each reward paid
// once by idempotency key, nothing for computer players.
const test = require('node:test');
const assert = require('node:assert');
const { createEarn, nextStreak, weeklyWinners, REWARDS, weekStart } = require('../server/earn');

function harness({ player = {}, history = [], progress = null, now = Date.parse('2026-11-18T12:00:00Z') } = {}) {
  const ledger = []; // { player_id, type, amount, idempotency_key, created_at }
  const notes = [];
  let row = { id: 'p1', wins: 0, total_matches: 0, settings: {}, prestige_level: 0, tutorial_completed: false, ...player };
  const chain = (rows) => {
    const q = { _rows: rows, select() { return q; }, eq(k, v) { q._rows = q._rows.filter((r) => r[k] === v); return q; }, like(k, p) { q._rows = q._rows.filter((r) => String(r[k]).startsWith(p.replace('%', ''))); return q; }, order() { return q; }, limit() { return Promise.resolve({ data: q._rows, error: null }); } };
    return q;
  };
  const db = {
    isConfigured: true,
    client: () => ({ from: (t) => (t === 'coin_transactions' ? chain(ledger) : chain(history.map((h) => ({ player_id: 'p1', final_rank: h.rank, is_draw: false, matches: { mode: h.mode, end_time: h.end, status: 'finished' } })))) }),
    async creditCoins(id, amount, { type, idempotencyKey }) {
      if (ledger.some((l) => l.idempotency_key === idempotencyKey)) return { coins: 0, duplicate: true };
      ledger.push({ player_id: id, type, amount, idempotency_key: idempotencyKey, created_at: new Date(now).toISOString() });
      return { coins: ledger.reduce((a, l) => a + l.amount, 0), duplicate: false };
    },
    getProgress: async () => progress,
    getPlayerById: async () => row,
    updatePlayer: async (id, patch) => { row = { ...row, ...patch }; },
  };
  const earn = createEarn({ db, notify: (...a) => notes.push(a), now: () => now, log: { warn() {} } });
  return { earn, ledger, notes, row: () => row, setNow: (t) => { now = t; } };
}

test('daily streak: 1..7 on consecutive days, resets after a missed day, once a day', async () => {
  assert.deepStrictEqual(nextStreak(null, '2026-11-18'), { day: 1, already: false });
  assert.deepStrictEqual(nextStreak({ day: 3, last: '2026-11-17' }, '2026-11-18'), { day: 4, already: false });
  assert.deepStrictEqual(nextStreak({ day: 7, last: '2026-11-17' }, '2026-11-18'), { day: 1, already: false }, 'after day 7 a new week');
  assert.deepStrictEqual(nextStreak({ day: 5, last: '2026-11-15' }, '2026-11-18'), { day: 1, already: false }, 'missed a day');
  assert.strictEqual(nextStreak({ day: 2, last: '2026-11-18' }, '2026-11-18').already, true);

  const h = harness();
  const r1 = await h.earn.claim(h.row(), null, 'streak');
  assert.strictEqual(r1.coins, REWARDS.streak[0]);
  const again = await h.earn.claim(h.row(), null, 'streak');
  assert.match(again.error, /Already collected/);
  h.setNow(Date.parse('2026-11-19T08:00:00Z'));
  assert.strictEqual((await h.earn.claim(h.row(), null, 'streak')).coins, REWARDS.streak[1]);
  assert.strictEqual(h.ledger.length, 2);
});

test('starter tasks and achievements: only when done, only once, checked on the server', async () => {
  const h = harness({ player: { wins: 1, total_matches: 3, tutorial_completed: true }, history: [{ mode: 'quick', rank: 1, end: '2026-11-10T00:00:00Z' }, { mode: 'blitz', rank: 2, end: '2026-11-11T00:00:00Z' }] });
  assert.match((await h.earn.claim(h.row(), null, 'starter', 'three_modes')).error, /Not done/, 'only 2 modes');
  assert.match((await h.earn.claim(h.row(), null, 'starter', 'verify_email')).error, /Not done/);
  assert.strictEqual((await h.earn.claim(h.row(), { email_confirmed_at: '2026-11-01' }, 'starter', 'verify_email')).coins, 20);
  assert.strictEqual((await h.earn.claim(h.row(), null, 'starter', 'tutorial')).coins, 20);
  assert.strictEqual((await h.earn.claim(h.row(), null, 'achievement', 'first_win')).coins, 25);
  assert.match((await h.earn.claim(h.row(), null, 'achievement', 'first_win')).error, /Already/);
  assert.match((await h.earn.claim(h.row(), null, 'achievement', 'wins_10')).error, /Not done/);
  assert.match((await h.earn.claim(h.row(), null, 'achievement', 'made_up')).error, /Unknown/);
  const s = await h.earn.status(h.row(), null);
  assert.strictEqual(s.achievements.find((a) => a.id === 'first_win').claimed, true);
  assert.deepStrictEqual(s.achievements.find((a) => a.id === 'wins_10').progress, [1, 10]);
});

test('install task: set by the installed app, then claimable once', async () => {
  const h = harness();
  assert.match((await h.earn.claim(h.row(), null, 'starter', 'install_app')).error, /Not done/);
  await h.earn.markInstalled(h.row());
  assert.strictEqual((await h.earn.claim(h.row(), null, 'starter', 'install_app')).coins, 20);
});

test('welcome back: eligible after 14+ days away, once per 30 days; never for someone who has not played', async () => {
  const away = harness({ history: [{ mode: 'quick', rank: 2, end: '2026-10-30T00:00:00Z' }] });
  assert.strictEqual((await away.earn.claim(away.row(), null, 'welcome_back')).coins, 50);
  assert.match((await away.earn.claim(away.row(), null, 'welcome_back')).error, /Not available/);
  const recent = harness({ history: [{ mode: 'quick', rank: 2, end: '2026-11-15T00:00:00Z' }] });
  assert.match((await recent.earn.claim(recent.row(), null, 'welcome_back')).error, /Not available/);
  const fresh = harness();
  assert.match((await fresh.earn.claim(fresh.row(), null, 'welcome_back')).error, /Not available/);
});

test('match end: first win once a day, Daily Challenge once a day, every level crossed, never for computer players or solo private play', async () => {
  const h = harness();
  const match = (mode, players = { p1: { id: 'p1' }, b: { id: 'b', isAI: true } }) => ({ mode, players, config: {} });
  let out = await h.earn.onMatchEnd(match('quick'), { id: 'p1' }, { rank: 1 }, { levelBefore: 3, levelAfter: 5 });
  assert.deepStrictEqual(out.map((x) => x.coins), [REWARDS.firstWin, REWARDS.level(4), REWARDS.level(5)]);
  out = await h.earn.onMatchEnd(match('blitz'), { id: 'p1' }, { rank: 1 }, { levelBefore: 5, levelAfter: 5 });
  assert.deepStrictEqual(out, [], 'second win today pays nothing extra');
  out = await h.earn.onMatchEnd(match('async'), { id: 'p1' }, { rank: 3 }, null);
  assert.deepStrictEqual(out.map((x) => x.coins), [REWARDS.dailyChallenge]);
  assert.deepStrictEqual(await h.earn.onMatchEnd(match('quick'), { id: 'b', isAI: true }, { rank: 1, isAI: true }, null), []);
  const solo = harness();
  assert.deepStrictEqual(await solo.earn.onMatchEnd(match('private', { p1: { id: 'p1' } }), { id: 'p1' }, { rank: 1 }, null), [], 'alone in a Private War');
  assert.deepStrictEqual(await solo.earn.onMatchEnd(match('quick'), { id: 'p1' }, { rank: 1, isDraw: true }, null), [], 'a shared first place is not a win');
});

test('prestige pays once per prestige level', async () => {
  const h = harness();
  assert.strictEqual((await h.earn.onPrestige('p1', 1)).coins, REWARDS.prestige);
  assert.strictEqual(await h.earn.onPrestige('p1', 1), null);
  assert.strictEqual((await h.earn.onPrestige('p1', 2)).coins, REWARDS.prestige);
});

test('weekly leaderboard: top 3 per tier by wins, at least 5 matches, ties by fewer matches', () => {
  const rows = [];
  const add = (pid, tier, wins, matches) => { for (let i = 0; i < matches; i++) rows.push({ player_id: pid, tier, final_rank: i < wins ? 1 : 3, is_draw: false }); };
  add('a', 'Gold', 6, 10); add('b', 'Gold', 6, 8); add('c', 'Gold', 3, 5); add('d', 'Gold', 2, 9); add('e', 'Gold', 9, 4);
  add('x', 'Bronze', 1, 5);
  const w = weeklyWinners(rows);
  assert.deepStrictEqual(w.filter((x) => x.tier === 'Gold').map((x) => [x.playerId, x.coins]), [['b', 60], ['a', 35], ['c', 20]], 'e has only 4 matches');
  assert.deepStrictEqual(w.filter((x) => x.tier === 'Bronze').map((x) => x.playerId), ['x']);
  assert.strictEqual(new Date(weekStart(Date.parse('2026-11-18T12:00:00Z'))).toISOString(), '2026-11-16T00:00:00.000Z', 'weeks start Monday');
});
