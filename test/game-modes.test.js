'use strict';

// Game modes with their own identity + the walkthrough. Engine-level checks
// (no database, no browser): Elimination cuts, Blitz/Grand/Solo/Private card
// rules, mode catalog, money maths unchanged, and every tour anchor present.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const instruments = require('../server/instruments');
const { createGameEngine, GAME_RULES, MODE_DURATIONS, PRIZE_SHARE_BY_RANK } = require('../server/gameEngine');
const modeIdentity = require('../server/config/modeIdentity');
const tours = require('../server/config/tours');
const sabotage = require('../server/sabotage');

const fakeIo = () => ({ to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } });
const p = (id, extra = {}) => ({ id, username: id.toUpperCase(), war_rating: 1000, unlockedCards: Object.keys(sabotage.CARDS), ...extra });
const engineWith = (events) => createGameEngine({ to: () => ({ emit: (ev, payload) => events && events.push([ev, payload]) }), emit() {}, sockets: { sockets: new Map() } }, () => {}, () => {}, () => {}, () => true);

test('money maths and match lengths are the same as before the modes work', () => {
  // Hashes of the frozen tables: a change here means GAME_RULES or
  // MODE_DURATIONS were edited, which this work must never do.
  const h = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
  assert.deepStrictEqual(MODE_DURATIONS, { quick: 600, blitz: 180, grand: 1200, private: 600, solo: 600, tournament: 900, async: 600 });
  assert.deepStrictEqual(PRIZE_SHARE_BY_RANK, { 1: 0.5, 2: 0.25, 3: 0.15, 4: 0.1 });
  // Hashes taken from main (the live code) before this branch.
  assert.strictEqual(h(GAME_RULES), '834020fe29d39fea');
  assert.strictEqual(h(MODE_DURATIONS), '94932b0a9bd7a4fe');
});

test('mode catalog: every mode has identity, best for, how you win and card slots', () => {
  const cat = modeIdentity.publicCatalog();
  assert.deepStrictEqual(cat.map((m) => m.key).sort(), ['async', 'blitz', 'grand', 'private', 'quick', 'solo', 'tournament']);
  for (const m of cat) {
    for (const k of ['displayName', 'identity', 'bestFor', 'winShort', 'special', 'banner']) assert.ok(m[k], `${m.key}.${k}`);
    assert.ok(Number.isInteger(m.cardSlots), m.key);
  }
  const by = Object.fromEntries(cat.map((m) => [m.key, m]));
  assert.strictEqual(by.blitz.cardSlots, 2);
  assert.strictEqual(by.grand.startingHand, 2);
  assert.strictEqual(by.tournament.displayName, 'Elimination');
  assert.strictEqual(by.solo.displayName, 'Solo Ranked');
  assert.strictEqual(by.solo.sabotage, false);
  assert.strictEqual(by.async.cardSlots, 0);
});

test('Blitz: 2 slots, no heavy cards; Grand: 2 basic/mid to start; Solo: defense only; Daily: none', async () => {
  await instruments.preloadAll?.();
  const engine = engineWith();
  const heavy = (id) => ['epic', 'legendary'].includes(sabotage.CARDS[id].rarity) && !require('../server/progression').BASIC_DECK.includes(id);
  const blitz = await engine.createMatch('blitz');
  engine.joinMatch(blitz, p('b1'));
  assert.strictEqual(blitz.players.b1.cards.length, 2);
  assert.ok(blitz.players.b1.cards.every((c) => !heavy(c.type)), 'heavy card in Blitz');
  const grand = await engine.createMatch('grand');
  engine.joinMatch(grand, p('g1'));
  assert.strictEqual(grand.players.g1.cards.length, 2);
  assert.ok(grand.players.g1.cards.every((c) => !heavy(c.type)));
  const solo = await engine.createMatch('solo');
  engine.joinMatch(solo, p('s1'));
  assert.ok(solo.players.s1.cards.length > 0 && solo.players.s1.cards.every((c) => sabotage.CARDS[c.type].kind === 'defense' && c.type !== 'lifeline'));
  const daily = await engine.createMatch('async');
  engine.joinMatch(daily, p('d1'));
  assert.strictEqual(daily.players.d1.cards.length, 0);
  for (const m of [blitz, grand, solo, daily]) await engine.forceEndMatch(m.id).catch(() => {});
});

test('Private host options are validated and become the match rules', async () => {
  const bad = modeIdentity.hostOptions({ cards: 'yes', deckLevel: 'mega', startingHand: 9, eliminationCuts: 1, flavor: 'grand' });
  assert.deepStrictEqual(bad, { cards: true, deckLevel: 'full', startingHand: 0, eliminationCuts: false, flavor: 'quick' });
  const off = modeIdentity.rulesFor('private', modeIdentity.hostOptions({ cards: false }));
  assert.strictEqual(off.cards.enabled, false);
  const cuts = modeIdentity.rulesFor('private', modeIdentity.hostOptions({ eliminationCuts: true, flavor: 'blitz', deckLevel: 'basic' }));
  assert.ok(cuts.elimination);
  assert.strictEqual(cuts.cards.handSize, 2);
  assert.deepStrictEqual(cuts.cards.allowedTiers, ['basic']);
});

test('Elimination: cuts at 3/6/9/12 min, bottom 20% (min 1), only with 4+ players, Lifeline skips once', async () => {
  await instruments.preloadAll?.();
  const events = [];
  const engine = engineWith(events);
  const match = await engine.createMatch('tournament');
  for (let i = 0; i < 10; i++) engine.joinMatch(match, p(`e${i}`));
  // Start it by hand (no countdown timers in a unit test).
  engine.forceStartLobby(match.id);
  await new Promise((r) => setTimeout(r, (match.config.countdownSeconds + 1) * 1000));
  assert.strictEqual(match.status, 'active');
  assert.ok(match.elimination.active, match.elimination.reason);
  assert.deepStrictEqual(match.elimination.schedule, [180, 360, 540, 720]);
  // Give everyone a distinct balance so the order is known: e0 lowest.
  Object.values(match.players).forEach((pl, i) => { pl.balance = 10000 + i * 100; pl.positions = []; });
  // e1 holds a Lifeline effect: the next cut passes over them.
  match.players.e1.effects = { ...(match.players.e1.effects || {}), lifeline: { charges: 1 } };
  match.startedAt = Date.now() - 181 * 1000;
  await new Promise((r) => setTimeout(r, 2500));
  const out = Object.values(match.players).filter((pl) => pl.spectator);
  assert.strictEqual(out.length, 2, 'bottom 20% of 10 = 2');
  assert.ok(match.players.e0.spectator, 'lowest is out');
  assert.ok(!match.players.e1.spectator, 'Lifeline saved e1');
  assert.ok(match.players.e2.spectator, 'next lowest goes instead');
  assert.ok(events.some(([ev]) => ev === 'elim:cut'));
  // A cut player cannot trade.
  const t = engine.openTrade(match.id, 'e0', { symbol: match.instruments[0], direction: 'BUY', lots: 0.1 });
  assert.strictEqual(t.success, false);
  await engine.forceEndMatch(match.id).catch(() => {});
  // Fewer than 4 at the start: no cuts at all.
  const small = await engine.createMatch('tournament', { configOverrides: { fillMethod: 'none', idealPlayers: 3 } });
  for (let i = 0; i < 3; i++) engine.joinMatch(small, p(`s${i}`));
  engine.forceStartLobby(small.id);
  await new Promise((r) => setTimeout(r, (small.config.countdownSeconds + 1) * 1000));
  assert.strictEqual(small.elimination.active, false);
  await engine.forceEndMatch(small.id).catch(() => {});
});

test('Elimination results: survivors first, then later cuts above earlier ones', async () => {
  const { computeMatchResults } = require('../server/gameEngine');
  const players = [
    { id: 'a', username: 'A', balance: 9000, positions: [], eliminatedRound: null },
    { id: 'b', username: 'B', balance: 15000, positions: [], eliminatedRound: 1 },
    { id: 'c', username: 'C', balance: 12000, positions: [], eliminatedRound: 2 },
    { id: 'd', username: 'D', balance: 9500, positions: [], eliminatedRound: null },
  ];
  const { MATCH_MODES } = require('../server/gameEngine');
  const results = computeMatchResults(players, 'tournament', MATCH_MODES.tournament);
  const order = results.slice().sort((x, y) => x.rank - y.rank).map((r) => r.playerId || (r.player && r.player.id) || r.id);
  assert.deepStrictEqual(order, ['d', 'a', 'c', 'b']);
});

test('walkthrough: every tour anchor exists in the page sources; overrides edit text only', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'client', f), 'utf8');
  const sources = {
    lobby: read('index.html') + read('js/mode-lobby.js'),
    game: read('game.html'),
    results: read('js/game.js'),
  };
  const cfg = tours.get();
  assert.strictEqual(cfg.enabled, true);
  for (const [id, t] of Object.entries(cfg.tours)) {
    assert.ok(Number.isInteger(t.version) && t.version > 0, id);
    assert.ok(t.steps.length > 0, id);
    for (const s of t.steps) {
      assert.ok(s.title && s.body, `${id}: empty step`);
      assert.ok(!/\p{Extended_Pictographic}/u.test(s.title + s.body), `${id}: emoji in "${s.title}"`);
      if (s.anchor) assert.ok(sources[t.page].includes(`data-tour="${s.anchor}"`) || sources[t.page].includes(`'data-tour', '${s.anchor}'`), `${id}: anchor ${s.anchor} missing on ${t.page}`);
    }
  }
  tours.applyOverrides({ enabled: false, tours: { lobby: { version: 9, steps: [{ title: 'Hi', body: 'There' }] }, postMatch: { enabled: false } } });
  const o = tours.get();
  assert.strictEqual(o.enabled, false);
  assert.strictEqual(o.tours.lobby.version, 9);
  assert.strictEqual(o.tours.lobby.steps[0].title, 'Hi');
  assert.strictEqual(o.tours.lobby.steps[0].anchor, null, 'anchors are not editable');
  assert.strictEqual(o.tours.lobby.steps[1].title, tours.DEFAULTS.tours.lobby.steps[1].title);
  assert.strictEqual(o.tours.postMatch.enabled, false);
  tours.applyOverrides({});
});

test('mode overrides: admin edits reach new matches only, and a switched-off mode reports it', async () => {
  modeIdentity.applyOverrides({ blitz: { cards: { handSize: 3 } }, grand: { enabled: false } });
  try {
    assert.strictEqual(modeIdentity.rulesFor('blitz').cards.handSize, 3);
    assert.strictEqual(modeIdentity.identity('grand').enabled, false);
    assert.strictEqual(modeIdentity.publicCatalog().find((m) => m.key === 'grand').enabled, false);
  } finally {
    modeIdentity.applyOverrides({});
  }
  assert.strictEqual(modeIdentity.rulesFor('blitz').cards.handSize, 2);
});
