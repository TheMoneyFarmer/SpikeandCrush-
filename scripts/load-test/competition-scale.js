'use strict';

// One big competition on the real dev database, with players who have no login (the
// tick and settlement never need one). Measures a tick, settlement, and that every
// prize was paid exactly once.   node scripts/load-test/competition-scale.js 5000 1000
const crypto = require('crypto');
const { NAME_PREFIX, assertDev, adminClient } = require('./common');

assertDev();
const ENTRANTS = Number(process.argv[2]) || 5000;
const POSITIONS = Number(process.argv[3]) || 1000;
const admin = adminClient();
const db = require('../../server/database');
const { createCompEngine } = require('../../server/compEngine');
const replayClock = require('../../server/replayClock');

let notices = 0;
const io = { of: () => io, to: () => ({ emit: () => {} }), emit: () => {}, sockets: { adapter: { rooms: new Map() } } };
const engine = createCompEngine({ io, notifyPlayer: () => { notices++; } });
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function insertAll(table, rows, select) {
  const out = [];
  for (let i = 0; i < rows.length; i += 500) {
    let q = admin.from(table).insert(rows.slice(i, i + 500));
    if (select) q = q.select(select);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (data) out.push(...data);
  }
  return out;
}

(async () => {
  const run = crypto.randomBytes(3).toString('hex');
  const started = Date.now() - 2 * 3600e3;
  const ends = Date.now() + 600e3;
  const comp = await engine.createCompetition({ title: `TEST scale ${run}`, description: 'load test', frequency: null, startsAt: started, endsAt: ends, replaySpeed: 1, instruments: ['EURUSD', 'XAUUSD'], entryFee: 0, payouts: [{ rank: 1, coins: 1000 }, { rank: 2, coins: 500 }, { rank: 2500, coins: 7 }], isTest: true });
  console.log(`competition ${comp.id}, ${ENTRANTS} entrants, ${POSITIONS} open positions`);

  const t0 = Date.now();
  const players = await insertAll('players', Array.from({ length: ENTRANTS }, (_, i) => ({ username: `${NAME_PREFIX}${run}_${i}`, email: `${run}_${i}@loadtest.example.invalid`, coins: 0 })), 'id');
  const accounts = await insertAll('comp_accounts', players.map((p, i) => ({ competition_id: comp.id, player_id: p.id, starting_capital: 10000, balance: 10000 + (i % 500), equity: 10000 + (i % 500) })), 'id, player_id');
  const dataTime = replayClock.dataTimeFor(comp);
  const px = replayClock.getPriceAt('EURUSD', dataTime);
  await insertAll('comp_positions', accounts.slice(0, POSITIONS).map((a) => ({ account_id: a.id, competition_id: comp.id, player_id: a.player_id, symbol: 'EURUSD', side: 'BUY', lots: 0.01, entry_price: px.mid, opened_at: new Date(Date.now() - 3600e3).toISOString() })));
  console.log(`seeded in ${secs(Date.now() - t0)}`);

  const read = Date.now();
  const all = await db.listCompAccounts(comp.id);
  console.log(`read all accounts: ${all.length} of ${ENTRANTS} in ${secs(Date.now() - read)}`);

  // Directly, not through tickOnce: another dev server may hold the job lock.
  for (let i = 1; i <= 4; i++) {
    const row = await db.getCompetitionById(comp.id);
    const t = Date.now();
    await engine.tickCompetition(row, Date.now());
    console.log(`tick ${i}${i === 1 ? ' (catching up on price history)' : ''}: ${secs(Date.now() - t)} (budget 5s)`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  const v = Date.now();
  const { data: anyAccount } = await admin.from('comp_accounts').select('player_id').eq('competition_id', comp.id).limit(1).single();
  await engine.getLeaderboard(comp.id, anyAccount.player_id);
  console.log(`first leaderboard request (reads and ranks everyone): ${secs(Date.now() - v)}`);
  const v2 = Date.now();
  await engine.getLeaderboard(comp.id, anyAccount.player_id);
  console.log(`next leaderboard request (shared): ${Date.now() - v2}ms`);

  await db.updateCompetition(comp.id, { ends_at: new Date(Date.now() - 1000).toISOString() });
  const s = Date.now();
  const result = await engine.settle(comp.id);
  console.log(`settlement: ${secs(Date.now() - s)}, ${JSON.stringify(result)}, notices ${notices}`);
  const again = Date.now();
  const second = await engine.settle(comp.id);
  console.log(`settling again: ${secs(Date.now() - again)}, ${JSON.stringify(second)}`);

  const finished = await db.listCompAccounts(comp.id);
  const paid = finished.filter((a) => a.prize_paid).length;
  const ranked = finished.filter((a) => a.final_rank).length;
  const coins = finished.reduce((sum, a) => sum + (a.prize_coins || 0), 0);
  const rank2500 = finished.find((a) => a.final_rank === 2500);
  console.log(`${ENTRANTS} entrants: ranked ${ranked}, paid flag ${paid}, prize coins ${coins} (expected 1507), rank 2500 prize ${rank2500?.prize_coins}`);
  const { count: open } = await admin.from('comp_positions').select('*', { count: 'exact', head: true }).eq('competition_id', comp.id).eq('status', 'open');
  console.log(`positions still open: ${open}`);
  console.log(ranked === ENTRANTS && paid === ENTRANTS && coins === 1507 && open === 0 && second.newlyPaid === 0 ? 'PASS' : 'FAIL');
  await admin.from('competitions').delete().eq('id', comp.id);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message || e); process.exit(1); });
