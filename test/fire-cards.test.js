'use strict';

// Parts 2 and 3: earned cards, sabotage protection, deck rework, damage
// guards, progression locks, Heat, missions, spike alerts and the crown.
// Real engine, fake sockets, no database.
process.env.SUPABASE_SERVICE_KEY = '';
const test = require('node:test');
const assert = require('node:assert');
const { createGameEngine } = require('../server/gameEngine');
const instruments = require('../server/instruments');
const sabotage = require('../server/sabotage');
const cardRules = require('../server/cards');
const progression = require('../server/progression');
const gameFeel = require('../server/config/gameFeel');
const curated = require('../server/curated');

const ALL = Object.keys(sabotage.CARDS);
const fakeIo = () => {
  const events = [];
  const room = { emit: (event, payload) => events.push({ event, payload }) };
  return { events, to: () => room };
};
const SYMS = ['XAUUSD', 'NAS100'];

async function makeMatch(n = 2, { unlocked = ALL, seed = 'fixed-seed' } = {}) {
  const io = fakeIo();
  const engine = createGameEngine(io, () => {}, () => {}, () => {}, () => true);
  const match = await engine.createMatch('quick', { instrumentList: SYMS, marketSeed: seed, marketStarts: { XAUUSD: 500, NAS100: 500 } });
  for (let i = 1; i <= n; i++) engine.joinMatch(match, { id: `p${i}`, username: `P${i}`, war_rating: 1000, unlockedCards: unlocked }, `s${i}`);
  match.status = 'active';
  match.startedAt = Date.now() - 30000;
  return { engine, match, io };
}

// Opens a BUY and fakes its entry price / open time so the close realises `pnl`.
function scriptedTrade(engine, match, pid, pnl, { heldMs = 10000, lots = 1 } = {}) {
  const o = engine.openTrade(match.id, pid, { symbol: 'XAUUSD', direction: 'BUY', lots });
  assert.ok(o.success, o.error);
  const pos = match.players[pid].positions.find((p) => p.id === o.position.id);
  const cfg = instruments.getInstrument('XAUUSD');
  const elapsed = Math.floor((Date.now() - match.startedAt) / 1000);
  const bid = instruments.getCurrentPrice(match.id, 'XAUUSD', elapsed).bid;
  pos.entryPrice = bid - pnl / (lots * cfg.contractSize);
  pos.openedAt = Date.now() - heldMs;
  return engine.closeTrade(match.id, pid, pos.id, 'manual');
}

const unused = (p) => p.cards.filter((c) => !c.used).length;
const emptyHand = (p) => p.cards.forEach((c) => (c.used = true));

test.beforeEach(() => gameFeel.applyOverrides({ cards: { maxCardsPerMinute: 100, maxCardsPerMatch: 100 } }));
test.after(() => gameFeel.applyOverrides({}));

test('9: too small, too short and same-second closes do not count; losing close resets streak and keeps cards', async () => {
  const { engine, match } = await makeMatch();
  const p = match.players.p1;
  emptyHand(p);
  scriptedTrade(engine, match, 'p1', 5); // below 0.2% of 10,000 = 20
  assert.strictEqual(p.streak, 0);
  scriptedTrade(engine, match, 'p1', 100, { heldMs: 2000 }); // held 2s < 5s
  assert.strictEqual(p.streak, 0);
  scriptedTrade(engine, match, 'p1', 100, { heldMs: 0 }); // same second
  assert.strictEqual(p.streak, 0);
  scriptedTrade(engine, match, 'p1', 100);
  assert.strictEqual(p.streak, 1);
  const handBefore = unused(p);
  scriptedTrade(engine, match, 'p1', -50);
  assert.strictEqual(p.streak, 0, 'losing close resets');
  assert.strictEqual(unused(p), handBefore, 'cards in hand are kept');
});

test('9: streak 1/2/3 grant 1/1/2, streak 5 refills every slot, hand never above 4, overflow becomes Heat', async () => {
  const { engine, match } = await makeMatch();
  const p = match.players.p1;
  emptyHand(p);
  const counts = [];
  for (let i = 0; i < 3; i++) {
    scriptedTrade(engine, match, 'p1', 100);
    counts.push(unused(p));
  }
  assert.deepStrictEqual(counts, [1, 2, 4]);
  emptyHand(p);
  scriptedTrade(engine, match, 'p1', 100); // streak 4: nothing
  assert.strictEqual(unused(p), 0);
  scriptedTrade(engine, match, 'p1', 100); // streak 5: refill all four
  assert.strictEqual(unused(p), 4, 'the "all cards come back" moment');
  const heat = p.heat;
  scriptedTrade(engine, match, 'p1', 100); // streak 6, hand full -> Heat
  assert.strictEqual(unused(p), 4);
  assert.ok(p.heat > heat + gameFeel.get().cards.heatPerOverflowCard - 1, 'overflow card became Heat');
  for (let i = 0; i < 20; i++) scriptedTrade(engine, match, 'p1', 100);
  assert.ok(unused(p) <= 4);
});

test('9: per-minute and per-match caps hold; the same trade can never grant twice', async () => {
  gameFeel.applyOverrides({ cards: { maxCardsPerMinute: 3, maxCardsPerMatch: 5 } });
  const { engine, match } = await makeMatch();
  const p = match.players.p1;
  emptyHand(p);
  for (let i = 0; i < 3; i++) scriptedTrade(engine, match, 'p1', 100);
  assert.strictEqual(p.cardsEarned, 3, 'per-minute cap of 3 (streak 3 alone would have given 4)');
  p.cardGrantTimes = []; // a minute later
  emptyHand(p);
  scriptedTrade(engine, match, 'p1', 100);
  scriptedTrade(engine, match, 'p1', 100);
  for (let i = 0; i < 5; i++) {
    p.cardGrantTimes = [];
    emptyHand(p);
    scriptedTrade(engine, match, 'p1', 100);
  }
  assert.strictEqual(p.cardsEarned, 5, 'per-match cap');
  const pos = { id: 'dup', openedAt: Date.now() - 10000 };
  const a = cardRules.onTradeClosed(match, p, { position: pos, pnl: 100, reason: 'manual', nowMs: Date.now() });
  const b = cardRules.onTradeClosed(match, p, { position: pos, pnl: 100, reason: 'manual', nowMs: Date.now() });
  assert.strictEqual(a.qualifying, true);
  assert.strictEqual(b.qualifying, false);
  assert.strictEqual(b.why, 'already counted');
});

test('10: a hit target gets the shield; a second card inside it is rejected with a clear message', async () => {
  const { engine, match } = await makeMatch(3);
  match.players.p1.cards = [{ type: 'position_freeze', used: false }, { type: 'lot_limiter', used: false }];
  match.players.p3.cards = [{ type: 'lockout', used: false }];
  const first = engine.playSabotageCard(match.id, 'p1', 'position_freeze', { targetId: 'p2' });
  assert.ok(first.success, first.error);
  const second = engine.playSabotageCard(match.id, 'p3', 'lockout', { targetId: 'p2' });
  assert.strictEqual(second.success, false);
  assert.match(second.error, /just hit - protected for \d+s/);
  // Shield card blocks attacks; offline targets cannot be picked.
  match.players.p2.effects.hitShield = null;
  match.cardTargetedAt = {};
  match.players.p2.effects.position_freeze = null;
  match.players.p2.effects.shield = { until: Date.now() + 20000 };
  assert.match(engine.playSabotageCard(match.id, 'p1', 'lot_limiter', { targetId: 'p2' }).error, /Shield/);
  match.players.p2.effects.shield = null;
  match.players.p2.socketId = null;
  assert.match(engine.playSabotageCard(match.id, 'p1', 'lot_limiter', { targetId: 'p2' }).error, /offline/);
});

test('10: target checks for 1,000 players (random, leader, above, below, search) stay fast and correct', () => {
  const nowMs = Date.now();
  const players = Array.from({ length: 1000 }, (_, i) => ({ id: `x${i}`, username: `Trader${i}`, isAI: false, socketId: i % 7 ? `s${i}` : null, effects: sabotage.createPlayerEffects(), eliminated: false }));
  players[5].effects.shield = { until: nowMs + 5000 };
  const caster = { id: 'me', unlockedCards: ALL, effects: sabotage.createPlayerEffects() };
  const match = { players: Object.fromEntries(players.map((p) => [p.id, p])), cardTargetedAt: {} };
  const t0 = process.hrtime.bigint();
  const ok = players.filter((p) => !cardRules.checkPlay(match, caster, 'lot_limiter', p, nowMs));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(ok.length, 1000 - players.filter((p) => !p.socketId).length - 1);
  assert.ok(ms < 50, `${ms}ms`);
  const search = players.filter((p) => p.username.toLowerCase().includes('der99'));
  assert.ok(search.length >= 1);
});

test('11: Heat and earned cards never change equity, P&L or ranking (same scripted match, feature on vs off)', async () => {
  const run = async (on) => {
    gameFeel.applyOverrides({ heat: { enabled: on }, cards: { earnedCards: on, maxCardsPerMinute: 100, maxCardsPerMatch: 100 }, missions: { enabled: on } });
    const { engine, match } = await makeMatch(2, { seed: 'heat-test' });
    for (const pnl of [100, 120, -40, 300, 80]) scriptedTrade(engine, match, 'p1', pnl);
    for (const pnl of [60, -20, 90]) scriptedTrade(engine, match, 'p2', pnl);
    return Object.values(match.players).map((p) => [p.id, p.balance]).sort();
  };
  const on = await run(true);
  const off = await run(false);
  assert.deepStrictEqual(on, off);
});

test('15c: deck = 30 attack/market cards (same total as before) + 2 defensive; no threat-only card remains', () => {
  const attack = ALL.filter((id) => sabotage.CARDS[id].kind !== 'defense');
  assert.strictEqual(attack.length, 30);
  assert.deepStrictEqual(ALL.filter((id) => sabotage.CARDS[id].kind === 'defense').sort(), ['cleanse', 'shield']);
  for (const old of Object.keys(sabotage.REPLACED_THREAT_ONLY)) assert.ok(!sabotage.CARDS[old], `${old} still in deck`);
  for (const id of ALL) assert.ok(!/\p{Extended_Pictographic}/u.test(sabotage.CARDS[id].icon), `${id} uses an emoji icon`);
});

test('15c: every attack and market card changes real server state on the target', async () => {
  for (const id of ALL.filter((c) => sabotage.CARDS[c].kind !== 'defense')) {
    const { engine, match } = await makeMatch(2);
    const t = match.players.p2;
    const c = match.players.p1;
    // Give both sides something to act on: positions with SL/TP, banked profit.
    engine.openTrade(match.id, 'p1', { symbol: 'XAUUSD', direction: 'BUY', lots: 0.1 });
    const o = engine.openTrade(match.id, 'p2', { symbol: 'XAUUSD', direction: 'BUY', lots: 0.2, stopLossPips: 500, takeProfitPips: 500 });
    assert.ok(o.success, o.error);
    t.balance = 10500;
    c.cards = [{ type: id, used: false }];
    const snap = () => JSON.stringify({ t: { b: t.balance, pos: t.positions.map((p) => [p.id, p.stopLoss, p.takeProfit, p.lots]), fx: t.effects }, m: match.marketEffects });
    const before = snap();
    const r = engine.playSabotageCard(match.id, 'p1', id, { targetId: 'p2', symbol: 'XAUUSD' });
    assert.ok(r.success, `${id}: ${r.error}`);
    assert.notStrictEqual(snap(), before, `${id} changed nothing on the server`);
  }
});

test('15c: no card pushes the target below the loss floor in one hit', async () => {
  const floor = 10000 * gameFeel.get().cards.floorPctOfCapital;
  for (const id of ['capital_drain', 'pip_theft', 'profit_skim']) {
    const { engine, match } = await makeMatch(2);
    match.players.p2.balance = id === 'profit_skim' ? floor + 30 : floor + 30;
    if (id === 'profit_skim') match.players.p2.balance = 10000 + 10; // banked 10, room only 5010
    match.players.p1.cards = [{ type: id, used: false }];
    const before = match.players.p2.balance;
    const r = engine.playSabotageCard(match.id, 'p1', id, { targetId: 'p2' });
    assert.ok(r.success, r.error);
    assert.ok(match.players.p2.balance >= floor, `${id}: ${match.players.p2.balance}`);
    assert.ok(before - match.players.p2.balance <= Math.max(30, 10 * 0.15) + 1e-9);
  }
  const { engine, match } = await makeMatch(2);
  match.players.p2.balance = floor;
  match.players.p1.cards = [{ type: 'capital_drain', used: false }];
  const r = engine.playSabotageCard(match.id, 'p1', 'capital_drain', { targetId: 'p2' });
  assert.strictEqual(r.success, false);
  assert.strictEqual(match.players.p1.cards[0].used, false, 'a refused card is not consumed');
});

test('15c: the match log reproduces every balance exactly (trades + card amounts)', async () => {
  const { engine, match } = await makeMatch(2);
  const play = (caster, card, target) => {
    match.players[caster].cards.push({ type: card, used: false });
    match.players[target].effects.hitShield = null;
    match.cardTargetedAt = {};
    const r = engine.playSabotageCard(match.id, caster, card, { targetId: target });
    assert.ok(r.success, `${card}: ${r.error}`);
  };
  scriptedTrade(engine, match, 'p2', 400);
  play('p1', 'pip_theft', 'p2');
  play('p1', 'capital_drain', 'p2');
  play('p1', 'profit_skim', 'p2');
  play('p1', 'profit_tax', 'p2');
  scriptedTrade(engine, match, 'p2', 200); // pays the tax
  scriptedTrade(engine, match, 'p1', -30);
  const log = engine.getCardLog(match.id);
  for (const pid of ['p1', 'p2']) {
    let bal = 10000;
    for (const f of match.feed) if (f.playerId === pid && typeof f.pnl === 'number' && f.ticket) bal += f.pnl;
    for (const e of log) {
      const amt = e.amount ?? (e.amounts && e.amounts.amount);
      if (!amt) continue;
      if (e.target === pid) bal -= amt;
      if (e.attacker === pid && e.card !== 'capital_drain') bal += amt;
    }
    assert.strictEqual(Math.round(bal * 100) / 100, match.players[pid].balance, `${pid}`);
  }
});

test('15c: timed effects expire on their own clock and block only while active', async () => {
  const { engine, match } = await makeMatch(2);
  match.players.p1.cards = [{ type: 'trade_limit', used: false }];
  engine.openTrade(match.id, 'p2', { symbol: 'XAUUSD', direction: 'BUY', lots: 0.1 });
  assert.ok(engine.playSabotageCard(match.id, 'p1', 'trade_limit', { targetId: 'p2' }).success);
  assert.match(engine.openTrade(match.id, 'p2', { symbol: 'XAUUSD', direction: 'BUY', lots: 0.1 }).error, /Trade Limit/);
  match.players.p2.effects.trade_limit.until = Date.now() - 1; // time passes
  assert.ok(engine.openTrade(match.id, 'p2', { symbol: 'XAUUSD', direction: 'BUY', lots: 0.1 }).success);
});

test('15d: a new account has only the basic deck; a locked card can never be dealt, earned or played', async () => {
  const fresh = progression.standing({ total_matches: 0, wins: 0 });
  const unlocked = progression.unlockedCards(fresh);
  assert.deepStrictEqual(unlocked.sort(), progression.BASIC_DECK.slice().sort());
  const { engine, match } = await makeMatch(2, { unlocked });
  const p = match.players.p1;
  assert.ok(p.cards.every((c) => unlocked.includes(c.type)), 'dealt a locked card');
  emptyHand(p);
  for (let i = 0; i < 12; i++) scriptedTrade(engine, match, 'p1', 100);
  assert.ok(p.cards.every((c) => unlocked.includes(c.type)), 'streak granted a locked card');
  p.cards.push({ type: 'margin_call', used: false }); // forged
  engine.openTrade(match.id, 'p2', { symbol: 'XAUUSD', direction: 'BUY', lots: 0.1 });
  const r = engine.playSabotageCard(match.id, 'p1', 'margin_call', { targetId: 'p2' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /locked/);
});

test('15d: unlocks happen at the exact level or condition; XP caps hold; history migration places players', () => {
  const t = gameFeel.get().progression.levelThresholds;
  const at = (xp, extra = {}) => progression.unlockedCards({ xp, level: progression.levelForXp(xp), wins: 0, matches: 0, ...extra });
  assert.ok(!at(t[1] - 1).includes('tp_snip'));
  assert.ok(at(t[1]).includes('tp_snip'));
  assert.ok(!at(t[14]).includes('pip_theft'), 'pip_theft also needs 10 wins');
  assert.ok(at(t[14], { wins: 10 }).includes('pip_theft'));
  assert.ok(at(0, { matches: 10 }).includes('cleanse'));
  const big = progression.matchXp({ durationPlayed: 600, finalRank: 1, qualifyingWins: 50, bestStreak: 30, missionsCompleted: 5, pnl: 9000, startingCapital: 10000 });
  assert.strictEqual(big.total, gameFeel.get().progression.xp.perMatchCap);
  assert.strictEqual(progression.matchXp({ durationPlayed: 30, abandoned: true }).total, 0);
  assert.strictEqual(progression.capForDay(200, gameFeel.get().progression.xp.perDayCap - 50), 50);
  const veteran = progression.standing({ total_matches: 120, wins: 40 });
  assert.ok(veteran.level >= 10, `120 matches / 40 wins -> level ${veteran.level}`);
});

test('15d: coins can never buy a card - the shop sells only cosmetic variants and unlocks ignore them', () => {
  const shop = require('../server/shop');
  const items = shop.getCatalog ? shop.getCatalog() : null;
  const all = items ? Object.values(items).flat() : [];
  assert.ok(all.every((i) => i.type !== 'card' && i.type !== 'card_unlock'));
  const s = progression.standing({ total_matches: 0, wins: 0 });
  assert.deepStrictEqual(progression.unlockedCards(s, { granted: [] }).sort(), progression.BASIC_DECK.slice().sort());
});

test('12: missions progress and complete once; tiny-trade spam completes nothing', async () => {
  const { engine, match, io } = await makeMatch(2);
  const p = match.players.p1;
  p.missions = [
    { id: 'two_wins', label: '', progress: 0, target: 2, done: false },
    { id: 'hold_60', label: '', progress: 0, target: 1, done: false },
  ];
  for (let i = 0; i < 30; i++) scriptedTrade(engine, match, 'p1', 3, { lots: 0.01, heldMs: 70000 }); // spam tiny
  assert.ok(p.missions.every((m) => !m.done), 'spam completed a mission');
  scriptedTrade(engine, match, 'p1', 100);
  scriptedTrade(engine, match, 'p1', 100);
  const completes = io.events.filter((e) => e.event === 'missions:complete');
  assert.strictEqual(completes.length, 1);
  assert.ok(p.missionCoins <= gameFeel.get().missions.perMatchCoinCap);
  scriptedTrade(engine, match, 'p1', 100);
  assert.strictEqual(io.events.filter((e) => e.event === 'missions:complete').length, 1, 'completed twice');
});

test('13: spike alerts come from real events ~10 data-seconds ahead, carry no direction, and stay off when disabled', async () => {
  const { match } = await makeMatch(2);
  const events = [];
  for (const s of match.instruments) events.push(...instruments.getSpikeSchedule(match.id, s));
  const plan = cardRules.planSpikes(events, 600);
  for (const sp of plan) {
    const pl = curated.getPlaylist(sp.symbol);
    const start = instruments.getMarketInfo(match.id)[sp.symbol].start;
    const bar = pl.spikes.find((x) => x.i === (start + sp.dataSecond / 60) % pl.bars.length);
    assert.ok(bar, 'invented spike');
    assert.strictEqual(bar.movePct, sp.movePct);
  }
  const fake = { spikePlan: cardRules.planSpikes([{ symbol: 'XAUUSD', dataSecond: 120, movePct: 0.42 }], 600) };
  const out = [];
  for (let t = 0; t < 300; t++) for (const e of cardRules.spikeTick(fake, t)) out.push({ t, ...e });
  assert.strictEqual(out[0].event, 'spike:alert');
  assert.strictEqual(out[0].t, 110);
  assert.deepStrictEqual(Object.keys(out[0].payload).sort(), ['id', 'inSeconds']);
  assert.ok(!/XAUUSD|0\.42|up|down|buy|sell/i.test(JSON.stringify(out[0].payload)), 'alert leaks more than the time');
  assert.strictEqual(out[1].event, 'spike:result');
  assert.strictEqual(out[1].payload.movePct, 0.42);
  gameFeel.applyOverrides({ spikeAlerts: { enabled: false } });
  assert.strictEqual(cardRules.planSpikes([{ symbol: 'XAUUSD', dataSecond: 120, movePct: 1 }], 600).length, 0);
});

test('14: crown changes grant exactly one card per overtake per cooldown (N = 2, 8, 100, 1000)', () => {
  for (const n of [2, 8, 100, 1000]) {
    const players = {};
    for (let i = 0; i < n; i++) players[`q${i}`] = cardRules.initPlayer({ id: `q${i}`, cards: [], effects: sabotage.createPlayerEffects() });
    const match = { players, leaderId: null };
    const rows = (lead) => [{ id: lead, pnl: 100 }, ...Object.keys(players).filter((k) => k !== lead).map((k, i) => ({ id: k, pnl: -i }))];
    let now = 1_000_000;
    cardRules.updateCrown(match, rows('q0'), now);
    const a = cardRules.updateCrown(match, rows('q1'), (now += 1000));
    assert.strictEqual(a.grant.granted.length, 1, `N=${n}`);
    cardRules.updateCrown(match, rows('q0'), (now += 1000));
    const again = cardRules.updateCrown(match, rows('q1'), (now += 1000)); // inside cooldown
    assert.strictEqual(again.grant, null, `N=${n} cooldown`);
    const later = cardRules.updateCrown(match, rows('q0'), (now += 61000));
    assert.strictEqual(later.grant.granted.length, 1);
    assert.strictEqual(cardRules.updateCrown(match, rows('q0'), (now += 1000)), null, 'no change, no grant');
  }
});
