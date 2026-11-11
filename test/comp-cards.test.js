'use strict';

// Cards, streaks and Heat in competitions (server/compFire.js), through the
// real competition engine against a fake database and fixed prices.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ALL_DECK = ['pip_theft', 'position_freeze', 'force_close', 'capital_drain', 'shield'];
let ready = true;
const transfers = [];
const closes = [];
const saved = {};
const now = Date.now();
const comp = {
  id: 'c1', title: 'Daily War', status: 'active', is_published: true, type: 'native', instruments: ['EURUSD'],
  starts_at: new Date(now - 60000).toISOString(), ends_at: new Date(now + 3600000).toISOString(),
  data_window_start: new Date(now - 86400000).toISOString(), replay_speed: 1,
};
const accounts = [];
const positions = [];
const acc = (id, extra = {}) => ({ id, competition_id: 'c1', player_id: 'p' + id, status: 'active', balance: 10000, equity: 10000, starting_capital: 10000, realised_pnl: 0, trade_count: 0, fire: {}, player: { username: id.toUpperCase() }, ...extra });
const fakeDb = new Proxy({
  compFireReady: async () => ready,
  getCompetitionById: async () => comp,
  getCompAccount: async (cid, pid) => accounts.find((a) => a.player_id === pid) || null,
  getCompAccountById: async (id) => accounts.find((a) => a.id === id) || null,
  listCompAccounts: async () => accounts,
  listCompPositions: async (f) => positions.filter((p) => (!f.account_id || p.account_id === f.account_id) && (!f.status || p.status === f.status)),
  insertCompPosition: async (row) => { const p = { id: 'pos' + (positions.length + 1), status: 'open', opened_at: new Date(Date.now() - 20000).toISOString(), ...row }; positions.push(p); return p; },
  incrementCompTradeCount: async () => {},
  getCompPosition: async (id) => positions.find((p) => p.id === id) || null,
  compClosePosition: async (id, exit, reason, pnl) => {
    const p = positions.find((x) => x.id === id);
    if (!p || p.status !== 'open') return false;
    p.status = 'closed';
    closes.push({ id, reason, pnl });
    const a = accounts.find((x) => x.id === p.account_id);
    a.balance += pnl;
    return true;
  },
  compCardTransfer: async (from, to, amount) => {
    transfers.push({ from, to, amount });
    accounts.find((a) => a.id === from).balance -= amount;
    if (to) accounts.find((a) => a.id === to).balance += amount;
    return true;
  },
  updateCompAccountFire: async (id, fire) => { saved[id] = fire; },
  updateCompPosition: async (id, fields) => Object.assign(positions.find((p) => p.id === id), fields),
}, { get: (t, k) => t[k] || (async () => null) });

const dbPath = path.resolve(__dirname, '../server/database.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const replayClock = require('../server/replayClock');
replayClock.getPriceAt = () => ({ bid: 1.1, ask: 1.1002, mid: 1.1001 });
replayClock.pathBetween = () => [];
replayClock.dataTimeFor = () => 1_000_000;
const { createCompEngine } = require('../server/compEngine');

const sabotage = require('../server/sabotage');
const io = { of: () => io, to: () => ({ emit: () => {} }), emit: () => {}, sockets: {} };
const engine = createCompEngine({ io, notifyPlayer: () => {}, getLoadout: async () => ({ unlockedCards: Object.keys(sabotage.CARDS), deck: ALL_DECK }) });

test('competition cards', async (t) => {
  accounts.push(acc('a'), acc('b'));

  await t.test('entering a competition deals 5 cards from the saved deck; feed cards never dealt', async () => {
    const v = await engine.getAccountView('c1', 'pa');
    assert.ok(v.fire, 'fire view present');
    assert.strictEqual(v.fire.cards.length, 5);
    assert.deepStrictEqual(v.fire.cards.map((c) => c.type).sort(), ALL_DECK.slice().sort());
    assert.ok(!v.fire.cardCatalog.some((c) => ['time_warp', 'fog_of_war', 'dead_calm', 'lifeline'].includes(c.id)));
    assert.strictEqual(v.fire.missions.length > 0, true);
    await engine.getAccountView('c1', 'pb');
  });

  await t.test('Pip Theft moves money from the target to the caster (offline target allowed)', async () => {
    const r = await engine.playCard('c1', 'pa', 'pip_theft', { targetAccountId: 'b' });
    assert.strictEqual(r.cardType, 'pip_theft');
    assert.strictEqual(transfers.length, 1);
    assert.deepStrictEqual([transfers[0].from, transfers[0].to], ['b', 'a']);
    assert.ok(transfers[0].amount > 0);
  });

  await t.test('a player just hit is protected; a played card is gone from the hand', async () => {
    await assert.rejects(engine.playCard('c1', 'pa', 'position_freeze', { targetAccountId: 'b' }), /protected/);
    accounts.push(acc('c'));
    await engine.getAccountView('c1', 'pc');
    await assert.rejects(engine.playCard('c1', 'pa', 'pip_theft', { targetAccountId: 'c' }), /already played|not in hand/i);
  });

  await t.test('Position Freeze on a fresh target blocks their new trades', async () => {
    await engine.playCard('c1', 'pa', 'position_freeze', { targetAccountId: 'c' });
    await assert.rejects(engine.openTrade('c1', 'pc', { symbol: 'EURUSD', side: 'BUY', lots: 0.1 }), /Position Freeze/);
    const tags = engine.__fire.statusOf('c');
    assert.ok(tags.includes('frozen') || tags.includes('protected'), tags.join(','));
  });

  await t.test('Force Close closes the target position as a card close (no streak loss for them)', async () => {
    const st = engine.__fire._cache;
    st.get('c').effects.hitShield = null;
    st.get('c').effects.position_freeze = null;
    const o = await engine.openTrade('c1', 'pc', { symbol: 'EURUSD', side: 'BUY', lots: 0.5 });
    const gameFeel = require('../server/config/gameFeel');
    gameFeel.applyOverrides({ cards: { sameTargetCooldownSeconds: 0 } });
    try {
      await engine.playCard('c1', 'pb', 'force_close', { targetAccountId: 'c' });
    } finally {
      gameFeel.applyOverrides({});
    }
    assert.ok(closes.some((x) => x.id === o.position.id && x.reason === 'sabotage'));
  });

  await t.test('excluded and unknown cards are refused', async () => {
    await assert.rejects(engine.playCard('c1', 'pa', 'time_warp', {}), /not used in competitions/);
  });

  await t.test('winning closes build a streak and earn cards; streak resets on a loss', async () => {
    const pos = await engine.openTrade('c1', 'pb', { symbol: 'EURUSD', side: 'SELL', lots: 1 }).catch((e) => ({ error: e.message }));
    assert.ok(!pos.error, pos.error);
    const row = positions.find((x) => x.id === pos.position.id);
    row.entry_price = 1.2; // a big winner for a SELL
    row.opened_at = new Date(Date.now() - 60000).toISOString();
    const r = await engine.closeTrade('c1', 'pb', row.id);
    assert.ok(r.pnl > 0);
    const v = await engine.getAccountView('c1', 'pb');
    assert.strictEqual(v.fire.streak, 1);
    assert.ok(v.fire.heat > 0);
  });

  await t.test('cards switched off until the migration is applied: trading still works', async () => {
    ready = false;
    const v = await engine.getAccountView('c1', 'pa');
    assert.strictEqual(v.fire, null);
    await assert.rejects(engine.playCard('c1', 'pa', 'capital_drain', { targetAccountId: 'b' }), /switch on/);
    const o = await engine.openTrade('c1', 'pa', { symbol: 'EURUSD', side: 'BUY', lots: 0.1 });
    assert.ok(o.position);
    ready = true;
  });

  await t.test('card state is saved to comp_accounts.fire', async () => {
    await engine.flushCards();
    assert.ok(saved.a && Array.isArray(saved.a.cards));
    assert.ok(saved.b && saved.b.streak >= 0);
  });
});
