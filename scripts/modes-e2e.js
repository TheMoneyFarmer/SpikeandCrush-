'use strict';
// Every mode end to end with scripted players, offline (no database): each
// match is created, filled, started, fast-forwarded through its real clock
// (the engine's own 1s tick, with the start time moved back), traded by
// scripted players, and ended by the timer. Prints what each mode did.
//   node scripts/modes-e2e.js
process.env.SUPABASE_URL = '';
const instruments = require('../server/instruments');
const { createGameEngine } = require('../server/gameEngine');
const modeIdentity = require('../server/config/modeIdentity');
const sabotage = require('../server/sabotage');

const emitted = [];
const io = { to: (room) => ({ emit: (ev, payload) => emitted.push({ room, ev, payload }) }), emit() {}, sockets: { sockets: new Map() } };
const engine = createGameEngine(io, () => {}, () => {}, () => {}, () => true);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = Object.keys(sabotage.CARDS);
let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures += 1; };

async function startNow(match) {
  engine.forceStartLobby(match.id);
  for (let i = 0; i < 20 && match.status !== 'active'; i++) await wait(500);
}

// Moves the match clock to `sec` elapsed and lets the engine tick on it.
async function clockTo(match, sec) {
  match.startedAt = Date.now() - sec * 1000;
  await wait(1300);
}

// Scripted trading: each human opens a trade, and every few checkpoints some close.
function trade(match, round) {
  for (const p of Object.values(match.players)) {
    if (p.isAI || p.spectator) continue;
    const sym = match.instruments[(round + p.id.length) % match.instruments.length];
    const open = p.positions.find((x) => x.symbol === sym);
    if (open && round % 2) engine.closeTrade(match.id, p.id, open.id, 'manual');
    else engine.openTrade(match.id, p.id, { symbol: sym, direction: (round + p.id.charCodeAt(1)) % 2 ? 'BUY' : 'SELL', lots: 0.2 + (p.id.charCodeAt(1) % 5) / 10 });
  }
}

async function runMode(mode, { players = 4, opts = {}, checkpoints = [], extra } = {}) {
  emitted.length = 0;
  const match = await engine.createMatch(mode, opts);
  for (let i = 0; i < players; i++) engine.joinMatch(match, { id: `${mode.slice(0, 2)}${i}`, username: `${mode}${i}`, war_rating: 1000 + i * 10, unlockedCards: ALL }, `sock${i}`);
  console.log(`\n${match.rules.identity.displayName} (${mode}): ${Object.keys(match.players).length} seats, ${match.config.durationSeconds}s, instruments ${match.instruments.join(' ')}`);
  const hands = Object.values(match.players).map((p) => p.cards.length);
  await startNow(match);
  check(match.status === 'active', 'match started');
  let round = 0;
  for (const sec of checkpoints) {
    trade(match, round++);
    await clockTo(match, sec);
  }
  await clockTo(match, match.config.durationSeconds + 2);
  for (let i = 0; i < 10 && match.status !== 'finished'; i++) await wait(500);
  check(match.status === 'finished', 'ended by the timer');
  const end = emitted.find((e) => e.ev === 'match:end');
  check(Boolean(end), 'match:end sent');
  const results = end ? end.payload.results : [];
  if (extra) await extra({ match, results, hands, emitted });
  return { match, results };
}

(async () => {
  await instruments.preloadAll?.();

  await runMode('quick', {
    checkpoints: [60, 200, 400, 550],
    extra: ({ match, hands, results }) => {
      check(hands.every((n) => n === 5), `5 cards dealt (${hands.join('/')})`);
      check(results.every((r) => r.mode && r.mode.key === 'quick'), 'results carry the mode block');
    },
  });

  await runMode('blitz', {
    checkpoints: [20, 60, 120, 170],
    extra: ({ match, hands, results }) => {
      check(hands.every((n) => n === 5), `5 cards dealt (${hands.join('/')})`);
      const heavy = Object.values(match.players).flatMap((p) => p.cards).filter((c) => ['epic', 'legendary'].includes(sabotage.CARDS[c.type].rarity));
      check(heavy.length === 0, 'no heavy cards held');
      check(results.some((r) => r.mode.highlights.includes('fastestWin')), 'fastest-win highlight on the result');
    },
  });

  await runMode('grand', {
    players: 5,
    checkpoints: [120, 290, 320, 590, 610, 890, 910, 1150],
    extra: ({ match, hands, emitted: ev }) => {
      check(hands.every((n) => n === 5), `5 cards dealt (${hands.join('/')})`);
      const found = match.marketEvents.filter((e) => e.found);
      check(match.marketEvents.length === 3, `3 market events planned (${found.length} found: ${found.map((e) => `${e.minute}m ${e.symbol} ${(e.movePct || 0).toFixed(2)}%`).join(', ')})`);
      check(ev.some((e) => e.ev === 'mode:checkpoint'), 'half-time card sent at minute 10');
      const steady = ev.find((e) => e.ev === 'match:end').payload.results.filter((r) => r.mode.steadyHand);
      check(steady.length <= 1, `Steady Hand awarded to ${steady.length ? steady[0].username : 'nobody'}`);
    },
  });

  await runMode('tournament', {
    players: 10,
    checkpoints: [100, 155, 181, 335, 361, 515, 541, 695, 721, 850],
    extra: ({ match, results, emitted: ev }) => {
      check(match.elimination.active, 'cuts active (10 players)');
      const cuts = ev.filter((e) => e.ev === 'elim:cut').map((e) => e.payload);
      const warns = ev.filter((e) => e.ev === 'elim:warning');
      check(cuts.length === 4, `4 cuts ran (${cuts.map((c) => `round ${c.round}: ${c.out.length} out, ${c.remaining} left`).join('; ')})`);
      check(warns.length >= 4, `"Cut in 0:30" warnings sent (${warns.length})`);
      const sorted = results.slice().sort((a, b) => a.rank - b.rank);
      const firstOut = sorted.findIndex((r) => r.mode.cutRound);
      check(firstOut > 0 && sorted.slice(firstOut).every((r) => r.mode.cutRound), 'every survivor ranks above every cut player');
      const rounds = sorted.slice(firstOut).map((r) => r.mode.cutRound);
      check(rounds.every((x, i) => i === 0 || x <= rounds[i - 1]), `later cuts rank above earlier ones (${rounds.join(',')})`);
    },
  });

  await runMode('solo', {
    players: 1,
    checkpoints: [60, 300, 500],
    extra: ({ match, hands }) => {
      check(Object.keys(match.players).length === 4, '1 player + 3 AI seats');
      const human = Object.values(match.players).find((p) => !p.isAI);
      check(hands[0] === 5, `5 cards dealt (${human.cards.map((c) => c.type).join(', ')})`);
      const chain = human.missions || [];
      check(chain.length === 3 && chain.filter((m) => m.locked).length >= 1, `3-mission chain (${chain.map((m) => `${m.id}${m.locked ? ' [locked]' : ''}${m.done ? ' [done]' : ''}`).join(', ')})`);
    },
  });

  await runMode('async', {
    players: 1,
    checkpoints: [120, 400],
    extra: ({ hands }) => check(hands.every((n) => n === 0), 'no cards in the Daily Challenge'),
  });

  await runMode('private', {
    players: 4,
    opts: { hostOptions: modeIdentity.hostOptions({ cards: true, deckLevel: 'basic', startingHand: 2, eliminationCuts: true, flavor: 'blitz' }) },
    checkpoints: [100, 181, 300, 361, 500],
    extra: ({ match, hands, emitted: ev }) => {
      check(hands.every((n) => n === 2), `host starting hand 2 (dealt ${hands.join('/')})`);
      check(Object.values(match.players).flatMap((p) => p.cards).every((c) => modeIdentity.cardTier(c.type, require('../server/progression').BASIC_DECK, sabotage.CARDS[c.type].rarity) === 'basic'), 'basic deck only');
      check(ev.filter((e) => e.ev === 'elim:cut').length >= 1, 'host turned cuts on: cuts ran');
    },
  });

  await runMode('private', {
    players: 3,
    opts: { hostOptions: modeIdentity.hostOptions({ cards: false }) },
    checkpoints: [100, 400],
    extra: ({ hands }) => check(hands.every((n) => n === 0), 'host turned cards off: no cards'),
  });

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll modes ran end to end');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
