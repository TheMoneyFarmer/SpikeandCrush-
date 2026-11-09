'use strict';

// In-match card economy and engagement loop (fire gameplay, Parts 2B and 3):
// earned cards (killstreak rules on trading performance), Heat, play guards
// (shields, per-target limits), the crown and dethrone, quick missions and
// spike alerts. Pure match-state logic: gameEngine.js calls these and does the
// emitting, coin payouts and persistence. Every number comes from
// server/config/gameFeel.js. The client only displays what this decides.
//
// Nothing here touches P&L, equity, ranking or prizes: Heat is a separate
// cosmetic score, and cards change trading state only through sabotage.js.

const gameFeel = require('./config/gameFeel');
const sabotage = require('./sabotage');
const intrabar = require('./intrabar');

const cfg = () => gameFeel.get();

// ---- player state -------------------------------------------------------------

function initPlayer(p, { unlockedCards = null } = {}) {
  p.streak = 0;
  p.bestStreak = 0;
  p.heat = 0;
  p.bestHeat = 0;
  p.qualifyingWins = 0;
  p.cardsEarned = 0;
  p.cardGrantTimes = [];
  p.grantedTrades = new Set();
  p.unlockedCards = Array.isArray(unlockedCards) && unlockedCards.length ? unlockedCards.slice() : null;
  p.lastOpenAt = 0;
  p.dethroneGrants = new Map(); // leaderChangeKey -> true
  p.lastDethroneAt = 0;
  p.missions = [];
  return p;
}

function handCount(p) {
  return p.cards.filter((c) => !c.used).length;
}

function pool(p) {
  return p.unlockedCards || Object.keys(sabotage.CARDS);
}

function heatMultiplier(streak) {
  const m = cfg().heat.multipliers;
  return m[Math.min(streak, m.length - 1)];
}

// ---- earning ---------------------------------------------------------------------

// Is this close a qualifying win? Returns the reason it isn't, or null.
function disqualify(pnl, position, nowMs, startingCapital, reason) {
  const c = cfg().cards;
  if (reason === 'sabotage') return 'closed by a card';
  if (!(pnl >= c.minWinPctOfCapital * startingCapital)) return 'too small';
  if (nowMs - position.openedAt < c.minHoldSeconds * 1000) return 'held too short';
  if (Math.floor(position.openedAt / 1000) === Math.floor(nowMs / 1000)) return 'opened and closed in the same second';
  return null;
}

// Grant up to n cards, respecting hand size, per-minute and per-match caps.
// Extra rewards with a full hand become Heat. Returns { granted: [types], heat }.
function grantCards(p, n, nowMs, rand) {
  const c = cfg().cards;
  const out = { granted: [], heat: 0, capped: 0 };
  for (let k = 0; k < n; k++) {
    p.cardGrantTimes = p.cardGrantTimes.filter((t) => nowMs - t < 60000);
    if (p.cardsEarned >= c.maxCardsPerMatch || p.cardGrantTimes.length >= c.maxCardsPerMinute) {
      out.capped++;
      continue;
    }
    if (handCount(p) >= c.handSize) {
      out.heat += c.heatPerOverflowCard;
      continue;
    }
    const type = sabotage.drawWeighted(pool(p), rand);
    if (!type) break;
    p.cards.push({ type, used: false, earned: true });
    p.cardsEarned++;
    p.cardGrantTimes.push(nowMs);
    out.granted.push(type);
  }
  p.heat += out.heat;
  p.bestHeat = Math.max(p.bestHeat, p.heat);
  return out;
}

// Called for every full close. Returns what happened for the engine to emit.
function onTradeClosed(match, p, { position, pnl, reason, nowMs, startingCapital = 10000 }) {
  const c = cfg().cards;
  const res = { qualifying: false, streak: p.streak, granted: [], heat: 0, reset: false, why: null };
  if (!c.earnedCards) return res;
  if (p.grantedTrades.has(position.id)) {
    res.why = 'already counted';
    return res;
  }
  p.grantedTrades.add(position.id);
  if (pnl < 0) {
    if (reason !== 'sabotage' && p.streak > 0) {
      p.streak = 0;
      res.reset = true;
    }
    res.streak = p.streak;
    return res;
  }
  const why = disqualify(pnl, position, nowMs, startingCapital, reason);
  if (why) {
    res.why = why;
    return res;
  }
  res.qualifying = true;
  p.streak += 1;
  p.qualifyingWins += 1;
  p.bestStreak = Math.max(p.bestStreak, p.streak);
  if (cfg().heat.enabled) {
    const gained = Math.round(cfg().heat.basePerWin * heatMultiplier(p.streak));
    p.heat += gained;
    p.bestHeat = Math.max(p.bestHeat, p.heat);
    res.heat += gained;
  }
  let n;
  if (p.streak < c.refillAtStreak) n = Number(c.streakRewards[p.streak]) || 0;
  else if (p.streak === c.refillAtStreak) n = Math.max(1, c.handSize - handCount(p));
  else n = c.perWinAfterRefill;
  // Rank benefit "faster streak" (top tiers): one more card at streak 3.
  if (p.streak === 3 && (cfg().progression.fasterStreakTiers || []).includes(p.tier)) n += 1;
  const g = grantCards(p, n, nowMs, match.rand || Math.random);
  res.granted = g.granted;
  res.heat += g.heat;
  res.capped = g.capped;
  res.streak = p.streak;
  res.refill = p.streak === c.refillAtStreak;
  return res;
}

// ---- play guards ---------------------------------------------------------------

function isOffline(p) {
  return !p.isAI && !p.socketId;
}

// Why `caster` may not play `cardType` on `target` right now, or null.
function checkPlay(match, caster, cardType, target, nowMs) {
  const c = cfg().cards;
  const def = sabotage.CARDS[cardType];
  if (!def) return 'Unknown card';
  if (caster.unlockedCards && !caster.unlockedCards.includes(cardType)) return 'That card is locked for you';
  if (!def.targeted) return null;
  if (!target) return 'Choose a target player';
  if (target.id === caster.id) return 'Cannot target yourself';
  if (target.eliminated) return `${target.username} is out of the match`;
  if (isOffline(target)) return `${target.username} is offline`;
  if (sabotage.hasShieldCard(target, nowMs)) return `${target.username} has a Shield up`;
  if (target.effects.hitShield && nowMs < target.effects.hitShield.until) {
    return `${target.username} was just hit - protected for ${Math.ceil((target.effects.hitShield.until - nowMs) / 1000)}s`;
  }
  const last = (match.cardTargetedAt || {})[target.id];
  if (last && nowMs - last < c.sameTargetCooldownSeconds * 1000) return `${target.username} was targeted a moment ago`;
  if (sabotage.TIMED_TARGET_EFFECTS.includes(cardType)) {
    const on = sabotage.activeTargetEffect(target, nowMs);
    if (on) return `${target.username} is already under ${sabotage.CARDS[on] ? sabotage.CARDS[on].name : on}`;
  }
  return null;
}

// After an attack card lands on a target.
function afterHit(match, target, nowMs) {
  const c = cfg().cards;
  if (!match.cardTargetedAt) match.cardTargetedAt = {};
  match.cardTargetedAt[target.id] = nowMs;
  target.effects.hitShield = { until: nowMs + c.hitShieldSeconds * 1000, by: null };
}

// The status badges the target picker shows for every player.
function targetStatus(p, nowMs) {
  const tags = [];
  if (isOffline(p)) tags.push('offline');
  if (sabotage.hasShieldCard(p, nowMs)) tags.push('shield');
  else if (p.effects.hitShield && nowMs < p.effects.hitShield.until) tags.push('protected');
  const on = sabotage.activeTargetEffect(p, nowMs);
  if (on) tags.push(on === 'position_freeze' ? 'frozen' : 'affected');
  if (p.eliminated) tags.push('out');
  return tags;
}

// ---- crown and dethrone --------------------------------------------------------

// rows: leaderboard rows sorted best first ({ id }). Returns the dethrone
// grant (or null) when the lead changes hands.
function updateCrown(match, rows, nowMs) {
  const g = cfg().crown;
  if (!g.enabled || !rows.length) return null;
  // Ties keep the current leader.
  const top = rows[0];
  const tied = rows.length > 1 && rows[1].pnl === top.pnl;
  const prev = match.leaderId || null;
  if (tied && prev && rows.some((r) => r.id === prev && r.pnl === top.pnl)) return null;
  if (prev === top.id) return null;
  match.leaderId = top.id;
  if (!prev) return { leaderId: top.id, previous: null, grant: null };
  // One card per lead change (this function only runs once per change), and
  // the per-player cooldown stops two players farming by trading the lead.
  const p = match.players[top.id];
  const key = `${prev}->${top.id}@${nowMs}`;
  let grant = null;
  if (g.dethroneCard && p && nowMs - p.lastDethroneAt >= g.dethroneCooldownSeconds * 1000) {
    p.dethroneGrants.set(key, true);
    p.lastDethroneAt = nowMs;
    grant = grantCards(p, 1, nowMs, match.rand || Math.random);
  }
  return { leaderId: top.id, previous: prev, grant };
}

// ---- quick missions ------------------------------------------------------------

const MISSIONS = {
  hold_60: { label: 'Hold a trade for 60 seconds', target: 1 },
  two_wins: { label: 'Close two trades in profit', target: 2 },
  play_card: { label: 'Play a card', target: 1 },
  spike_entry: { label: 'Open a position within 15s of a spike alert', target: 1, needsSpikes: true },
  streak_3: { label: 'Reach a 3-win streak', target: 3 },
  tp_hit: { label: 'Close a trade at your take profit', target: 1 },
};

// Missions only count trades of real size: margin of at least 0.5% of capital.
const MEANINGFUL_MARGIN_SHARE = 0.005;

function assignMissions(match, p, { hasSpikes }) {
  const m = cfg().missions;
  if (!m.enabled || p.isAI) return [];
  const rand = intrabar.rngFor(match.marketSeed || match.id, `missions:${p.id}`);
  const ids = Object.keys(MISSIONS).filter((id) => hasSpikes || !MISSIONS[id].needsSpikes);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  p.missions = ids.slice(0, m.perMatch).map((id) => ({ id, label: MISSIONS[id].label, progress: 0, target: MISSIONS[id].target, done: false }));
  return p.missions;
}

// Advance missions on an event. Returns the missions completed by this event.
// ev: { type: 'close'|'open'|'card'|'tick', qualifying, reason, heldMs, meaningful, sinceSpikeMs, streak }
function missionEvent(p, ev) {
  const done = [];
  for (const m of p.missions || []) {
    if (m.done) continue;
    switch (m.id) {
      case 'hold_60':
        if ((ev.type === 'close' || ev.type === 'tick') && ev.meaningful && ev.heldMs >= 60000) m.progress = 1;
        break;
      case 'two_wins':
        if (ev.type === 'close' && ev.qualifying) m.progress += 1;
        break;
      case 'play_card':
        if (ev.type === 'card') m.progress = 1;
        break;
      case 'spike_entry':
        if (ev.type === 'open' && ev.meaningful && ev.sinceSpikeMs !== null && ev.sinceSpikeMs <= 15000) m.progress = 1;
        break;
      case 'streak_3':
        if (ev.type === 'close') m.progress = Math.max(m.progress, Math.min(3, ev.streak || 0));
        break;
      case 'tp_hit':
        if (ev.type === 'close' && ev.qualifying && ev.reason === 'take_profit') m.progress = 1;
        break;
      default:
    }
    if (m.progress >= m.target) {
      m.done = true;
      done.push(m);
    }
  }
  return done;
}

// ---- spike alerts ----------------------------------------------------------------

// From the real indexed spike events of this match's instruments (data
// seconds from match start): keep the ones that leave room for the lead time
// and are spaced out, so alerts never pile up.
function planSpikes(events, durationDataSeconds) {
  const s = cfg().spikeAlerts;
  if (!s.enabled) return [];
  const minGap = Math.max(60, s.leadDataSeconds * 4);
  const sorted = events.filter((e) => e.dataSecond >= s.leadDataSeconds && e.dataSecond + 60 <= durationDataSeconds).sort((a, b) => a.dataSecond - b.dataSecond);
  const out = [];
  for (const e of sorted) {
    if (out.length && e.dataSecond - out[out.length - 1].dataSecond < minGap) continue;
    // Opaque id: it goes out with the alert, so it must not name the instrument.
    out.push({ ...e, id: `spike-${out.length + 1}`, alerted: false, resolved: false });
  }
  return out;
}

// Called every tick with the current data second. Returns events to emit.
function spikeTick(match, dataSecond) {
  const s = cfg().spikeAlerts;
  const out = [];
  if (!s.enabled) return out;
  for (const sp of match.spikePlan || []) {
    if (!sp.alerted && dataSecond >= sp.dataSecond - s.leadDataSeconds && dataSecond < sp.dataSecond) {
      sp.alerted = true;
      // Only the time: never the direction, the size or even the instrument.
      out.push({ event: 'spike:alert', payload: { id: sp.id, inSeconds: sp.dataSecond - dataSecond } });
    }
    if (sp.alerted && !sp.resolved && dataSecond >= sp.dataSecond + 60) {
      sp.resolved = true;
      out.push({ event: 'spike:result', payload: { id: sp.id, symbol: sp.symbol, movePct: sp.movePct, showSeconds: s.resultShowSeconds } });
    }
  }
  return out;
}

module.exports = {
  MISSIONS,
  MEANINGFUL_MARGIN_SHARE,
  initPlayer,
  handCount,
  heatMultiplier,
  disqualify,
  grantCards,
  onTradeClosed,
  checkPlay,
  afterHit,
  targetStatus,
  isOffline,
  updateCrown,
  assignMissions,
  missionEvent,
  planSpikes,
  spikeTick,
};
