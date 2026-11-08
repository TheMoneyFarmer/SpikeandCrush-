'use strict';
// The example match behind "How a match works": rules only, with no drawing and
// no page access, so tests and balance bots can play it faster than real time.
//
// Rules follow the real Quick War where they can (card effects, prize split,
// highest P&L wins). It is sped up to about a minute, on one instrument.
// Last place earning nothing is a choice for this example: see PRIZES.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SCHowMatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ADJUST HERE ----------------------------------------------------------------
  const RULES = {
    duration: 75,          // seconds in a round
    pnlPerPoint: 14,       // P&L per price point at 1 lot
    lots: [0.5, 1, 2],     // sizes a player can pick
    stopOut: 420,          // a trade losing this much is force-closed
    freeze: 10,            // Chart Ghost seconds
    pipTheft: 150,
    finalSeconds: 5,       // reaching the bell early leaves this much time
    candleSeconds: 0.4,
  };
  // Quick War: 10-coin entry, 4 players, 15% kept: a pot of 34 coins, split
  // 50/25/15/10%. This example pays last place nothing.
  const PRIZES = { 1: 17, 2: 9, 3: 5, 4: 0 };
  const HAND = ['chart-ghost', 'force-close', 'pip-theft'];
  // ----------------------------------------------------------------------------

  function mulberry(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // A market with its own shape each round: climbs, sharp crashes, quiet chop.
  function buildMarket(rand, duration) {
    const segs = []; let t = 0;
    const pick = (a, b) => a + rand() * (b - a);
    t = 0;
    segs.push({ kind: 'climb', until: (t += pick(6, 11)), drift: pick(1.5, 2.3) });
    while (t < duration + 5) {
      segs.push({ kind: 'crash', until: (t += pick(2, 3.5)), drift: -pick(6.5, 10) });
      segs.push({ kind: 'chop', until: (t += pick(3, 6)), drift: 0 });
      const roll = rand();
      if (roll < 0.25) { // a slow bleed instead of a climb, so Sell can win too
        segs.push({ kind: 'bleed', until: (t += pick(6, 10)), drift: -pick(1.2, 2) });
        segs.push({ kind: 'bounce', until: (t += pick(2, 3)), drift: pick(5, 7.5) });
      } else {
        segs.push({ kind: 'climb', until: (t += pick(6, 11)), drift: pick(1.5, 2.4) });
      }
    }
    return segs;
  }

  // How each rival plays. They only ever read the price, never the future.
  const STYLES = {
    Rival: { lots: 1, entryWait: [1.5, 3.5], takeProfit: 150, exitDrop: 2.2, patience: 0.9, follow: 0.85, cards: 2, cardEvery: [16, 26] },
    'Player 3': { lots: 0.5, entryWait: [2.5, 5.5], takeProfit: 70, exitDrop: 1.4, patience: 0.5, follow: 0.7, cards: 1, cardEvery: [28, 40] },
    'Player 4': { lots: 2, entryWait: [1.5, 4.5], takeProfit: 340, exitDrop: 7, patience: 2.6, follow: 0.5, cards: 1, cardEvery: [22, 44] },
  };

  function create(seed) {
    const rand = mulberry(seed);
    const market = buildMarket(rand, RULES.duration);
    const mk = (name, me) => ({
      name, me: !!me, bank: 0, pos: null, frozen: 0,
      hand: me ? HAND.slice() : [], cardsLeft: me ? 3 : STYLES[name].cards,
      nextEntry: 0, nextCard: 0, exitT: 0,
      stats: { trades: 0, wins: 0, losses: 0, best: null, worst: 0, stopOuts: 0, played: 0, hitsTaken: 0, stolenFrom: 0, heldThroughCrash: 0 },
    });
    const players = [mk('You', true), mk('Rival'), mk('Player 3'), mk('Player 4')];
    const m = {
      seed, t: 0, duration: RULES.duration, price: 100, prev: 100, slow: 100, peak: 100, trough: 100,
      market, segIndex: 0, players, events: [], ended: false, result: null, started: false, rand,
      lowestRank: 1,
    };
    players.slice(1).forEach((p) => { const s = STYLES[p.name]; p.nextEntry = between(rand, s.entryWait); p.nextCard = between(rand, s.cardEvery); });
    return m;
  }
  function between(rand, [a, b]) { return a + rand() * (b - a); }

  const seg = (m) => m.market[Math.min(m.segIndex, m.market.length - 1)];
  const emit = (m, type, data) => m.events.push(Object.assign({ type }, data));
  const live = (m, p) => (p.pos ? p.pos.dir * (m.price - p.pos.entry) * RULES.pnlPerPoint * p.pos.lots : 0);
  const total = (m, p) => p.bank + live(m, p);

  function standings(m) {
    return m.players.map((p, i) => ({ i, name: p.name, pnl: total(m, p) })).sort((a, b) => b.pnl - a.pnl || a.i - b.i);
  }
  function rankOf(m, i) { return standings(m).findIndex((s) => s.i === i) + 1; }

  function open(m, i, dir, lots) {
    const p = m.players[i];
    if (m.ended || p.pos) return false;
    p.pos = { dir, lots, entry: m.price, openedAt: m.t, sawCrash: false };
    p.stats.trades++;
    emit(m, 'open', { i, dir, lots, entry: m.price });
    return true;
  }
  function close(m, i, why) {
    const p = m.players[i];
    if (!p.pos) return null;
    const pnl = Math.round(live(m, p));
    const pos = p.pos;
    p.bank += pnl; p.pos = null;
    p.stats.best = p.stats.best === null ? pnl : Math.max(p.stats.best, pnl);
    p.stats.worst = Math.min(p.stats.worst, pnl);
    if (pnl >= 0) p.stats.wins++; else p.stats.losses++;
    if (why === 'stop') p.stats.stopOuts++;
    if (pos.sawCrash && pos.dir > 0 && pnl < 0) p.stats.heldThroughCrash++;
    emit(m, 'close', { i, pnl, why: why || 'manual', dir: pos.dir });
    return pnl;
  }
  // Card effects match the real game: Force Close takes their open trade at
  // market, Chart Ghost freezes their price display, Pip Theft moves capital.
  function play(m, from, id, to) {
    const a = m.players[from], b = m.players[to];
    if (m.ended || !b || from === to) return false;
    if (id === 'force-close' && !b.pos) return false; // the real game refuses and keeps the card
    if (a.me) {
      const k = a.hand.indexOf(id);
      if (k < 0) return false;
      a.hand.splice(k, 1);
    } else {
      if (a.cardsLeft <= 0) return false;
      a.cardsLeft--;
    }
    a.stats.played++;
    b.stats.hitsTaken++;
    let effect = {};
    if (id === 'force-close') {
      effect = { pnl: close(m, to, 'forced') };
    } else if (id === 'chart-ghost') {
      b.frozen = RULES.freeze;
      effect = { seconds: RULES.freeze };
    } else if (id === 'pip-theft') {
      b.bank -= RULES.pipTheft; a.bank += RULES.pipTheft;
      b.stats.stolenFrom += RULES.pipTheft;
      effect = { amount: RULES.pipTheft };
    }
    emit(m, 'card', Object.assign({ from, to, id }, effect));
    return true;
  }

  function stepRival(m, i, dt) {
    const p = m.players[i], s = STYLES[p.name];
    const slope = m.price - m.slow;
    if (p.frozen > 0) return; // a frozen rival can't see the chart, so can't react
    if (p.pos) {
      const l = live(m, p);
      const drop = p.pos.dir > 0 ? p.peakSeen - m.price : m.price - p.peakSeen;
      p.peakSeen = p.pos.dir > 0 ? Math.max(p.peakSeen, m.price) : Math.min(p.peakSeen, m.price);
      const wantOut = l >= s.takeProfit || drop >= s.exitDrop;
      if (wantOut) { p.exitT += dt; if (p.exitT >= s.patience) { close(m, i, 'manual'); p.exitT = 0; p.nextEntry = m.t + between(m.rand, s.entryWait); } } else p.exitT = 0;
    } else if (m.t >= p.nextEntry) {
      const withTrend = m.rand() < s.follow;
      const dir = (slope >= 0) === withTrend ? 1 : -1;
      if (open(m, i, dir, s.lots)) p.peakSeen = m.price;
    }
    if (p.cardsLeft > 0 && m.t >= p.nextCard) {
      // aim at whoever leads, unless that's them
      const order = standings(m).filter((x) => x.i !== i);
      const target = order[0].i;
      const tp = m.players[target];
      const id = tp.pos && Math.abs(live(m, tp)) > 40 && live(m, tp) > 0 ? 'force-close' : m.rand() < 0.5 ? 'pip-theft' : 'chart-ghost';
      emit(m, 'warn', { from: i, to: target, id });
      p.queued = { id, to: target, at: m.t + 1 };
      p.nextCard = m.t + between(m.rand, s.cardEvery);
    }
    if (p.queued && m.t >= p.queued.at) { const q = p.queued; p.queued = null; play(m, i, q.id, q.to); }
  }

  function step(m, dt) {
    if (m.ended || !m.started) return;
    m.t += dt;
    while (m.segIndex < m.market.length - 1 && m.t >= m.market[m.segIndex].until) { m.segIndex++; if (seg(m).kind === 'crash') onCrash(m); }
    m.prev = m.price;
    m.price += (seg(m).drift + (m.rand() - 0.5) * 3.2) * dt;
    m.slow += (m.price - m.slow) * Math.min(1, dt * 0.9);
    m.players.forEach((p) => { if (p.frozen > 0) { p.frozen -= dt; if (p.frozen <= 0) { p.frozen = 0; emit(m, 'unfreeze', { i: m.players.indexOf(p) }); } } });
    for (let i = 1; i < 4; i++) stepRival(m, i, dt);
    m.players.forEach((p, i) => { if (p.pos && live(m, p) <= -RULES.stopOut) close(m, i, 'stop'); });
    m.lowestRank = Math.max(m.lowestRank, rankOf(m, 0));
    if (m.t >= m.duration) finish(m);
  }
  function onCrash(m) {
    m.players.forEach((p) => { if (p.pos && p.pos.dir > 0) p.pos.sawCrash = true; });
    emit(m, 'crash', {});
  }

  function start(m) { m.started = true; }
  function hurry(m) { // the visitor reached the bell: only a few seconds remain
    if (m.ended) return;
    m.duration = Math.min(m.duration, m.t + RULES.finalSeconds);
    m.hurried = true;
  }

  function finish(m) {
    if (m.ended) return;
    m.players.forEach((p, i) => { if (p.pos) close(m, i, 'bell'); });
    m.ended = true;
    const order = standings(m);
    const rank = order.findIndex((o) => o.i === 0) + 1;
    const you = m.players[0];
    m.result = {
      order, rank, coins: PRIZES[rank], pnl: Math.round(you.bank),
      winner: order[0].name, margin: Math.round(order[0].pnl - (order[1] ? order[1].pnl : 0)),
      story: tellStory(m, rank), stats: you.stats,
    };
    emit(m, 'end', { result: m.result });
  }

  // The headline and one useful tip come from how the visitor actually played.
  function tellStory(m, rank) {
    const you = m.players[0], s = you.stats, rivalsGap = Math.round(standings(m)[0].pnl - you.bank);
    const places = { 1: '1st place', 2: '2nd place', 3: '3rd place', 4: 'Last place' };
    let line, tip;
    if (s.trades === 0 && s.played === 0) {
      line = 'You watched the whole round from the side.';
      tip = 'No trades means no profit. Press Buy or Sell next time.';
    } else if (rank === 1) {
      if (s.trades === 0) { line = 'You won without a single trade. Pure sabotage.'; tip = 'Cards alone did it. Now try cards and trades together.'; }
      else if (m.lowestRank >= 4) { line = 'From last place to first. What a comeback.'; tip = 'Real matches run ten minutes, so there’s time for this.'; }
      else if (s.stolenFrom === 0 && s.hitsTaken === 0) { line = 'Clean win. Nobody laid a finger on you.'; tip = 'Stay ahead and expect the cards to come for you.'; }
      else if (s.hitsTaken > 0) { line = 'They came for you and you still won.'; tip = 'The leader gets targeted first. You held on anyway.'; }
      else { line = 'You read the market and took the pot.'; tip = 'Bank profit before the crash and you’ll keep winning.'; }
    } else if (s.stopOuts > 0) {
      line = 'A trade ran too far and got stopped out.'; tip = 'Smaller size or an earlier exit keeps you in the round.';
    } else if (s.heldThroughCrash > 0) {
      line = 'You held through the crash. Up. Then not.'; tip = 'Close while you’re up. Green only counts once it’s banked.';
    } else if (s.played === 0 && rank > 1) {
      line = 'You never played a card.'; tip = `You finished ${rivalsGap.toLocaleString('en-US')} behind. A card or two could have closed that.`;
    } else if (s.trades === 0) {
      line = 'Cards alone weren’t enough.'; tip = 'Open a trade too. Rivals were earning while you waited.';
    } else if (s.hitsTaken > 1) {
      line = 'The rivals sabotaged you out of it.'; tip = 'Use your cards before they use theirs.';
    } else if (rank === 2) {
      line = `So close. ${rivalsGap.toLocaleString('en-US')} short of the pot.`; tip = 'One more clean trade or one more card would have done it.';
    } else {
      line = 'The market and your rivals got the better of you.'; tip = 'Watch for the turn, bank early, and aim cards at the leader.';
    }
    return { place: places[rank], line, tip };
  }

  // Drains what happened since last asked; the drawing code plays these back.
  function drain(m) { const e = m.events; m.events = []; return e; }

  return { RULES, PRIZES, HAND, create, start, step, open, close, play, hurry, finish, standings, rankOf, live, total, seg, drain };
});
