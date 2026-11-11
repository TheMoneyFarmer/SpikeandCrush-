'use strict';

// Cards, streaks, Heat and missions inside long competitions (owner decision
// 2026-11-11: full attacks, rivals can be hit online or offline). The same
// rules as matches (server/cards.js and server/sabotage.js), run against
// competition accounts in the database instead of an in-memory match:
//   - each account's card state is comp_accounts.fire (JSON), cached here
//   - a card play builds a tiny "match" from the two accounts, runs the real
//     sabotage.playCard, then writes hand, effects, money and positions back
//   - timed effects (freeze, lot limiter, spread blowout...) are checked when
//     the target trades; instant ones (force close, drain...) apply at once
// Price-feed cards (volatility surge, reversal flash, time warp, fog of war,
// panic wave, dead calm) bend a match's private feed; a competition shares
// one replay clock, so they are never dealt here. Lifeline needs cuts.

const db = require('./database');
const sabotage = require('./sabotage');
const cardRules = require('./cards');
const modeIdentity = require('./config/modeIdentity');
const gameFeel = require('./config/gameFeel');
const progression = require('./progression');
const instruments = require('./instruments');

const EXCLUDED = ['volatility_surge', 'reversal_flash', 'time_warp', 'fog_of_war', 'panic_wave', 'dead_calm', 'lifeline'];
const COMP_CARDS = Object.keys(sabotage.CARDS).filter((id) => !EXCLUDED.includes(id));
const COMP_MISSIONS = ['hold_60', 'two_wins', 'play_card', 'streak_3', 'tp_hit'];
const SAVE_DELAY_MS = 1500;
const round2 = (n) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

function rules() {
  const r = modeIdentity.rulesFor('quick');
  return { ...r, missions: { ...r.missions, pool: COMP_MISSIONS, chain: false } };
}

function createCompFire({ emit, getLoadout, standings }) {
  const cache = new Map(); // accountId -> p
  const dirty = new Set();
  const marketByComp = new Map(); // compId -> market effects (spread spike, double spread, liquidity drain)
  const matchByComp = new Map(); // compId -> { cardTargetedAt }
  let saveTimer = null;

  const ready = () => db.compFireReady();
  const market = (compId) => {
    if (!marketByComp.has(compId)) marketByComp.set(compId, sabotage.createMarketEffects());
    return marketByComp.get(compId);
  };
  const matchLike = (comp) => {
    if (!matchByComp.has(comp.id)) matchByComp.set(comp.id, { id: comp.id, cardTargetedAt: {} });
    const m = matchByComp.get(comp.id);
    m.rules = rules();
    m.instruments = comp.instruments || [];
    m.marketEffects = market(comp.id);
    m.rand = Math.random;
    return m;
  };

  function serialize(p) {
    return {
      v: 1,
      cards: p.cards,
      streak: p.streak,
      bestStreak: p.bestStreak,
      heat: p.heat,
      bestHeat: p.bestHeat,
      qualifyingWins: p.qualifyingWins,
      cardsEarned: p.cardsEarned,
      cardsPlayed: p.cardsPlayed,
      cardGrantTimes: p.cardGrantTimes.slice(-20),
      grantedTrades: [...p.grantedTrades].slice(-300),
      lastOpenAt: p.lastOpenAt,
      effects: p.effects,
      missions: p.missions,
      missionsDay: p.missionsDay,
      missionCoins: p.missionCoins,
      missionsCompleted: p.missionsCompleted,
      earnDay: p.earnDay,
    };
  }

  function markDirty(p) {
    dirty.add(p.accountId);
    if (!saveTimer) saveTimer = setTimeout(flush, SAVE_DELAY_MS);
    if (saveTimer.unref) saveTimer.unref();
  }

  async function flush() {
    saveTimer = null;
    const ids = [...dirty];
    dirty.clear();
    for (const id of ids) {
      const p = cache.get(id);
      if (p) await db.updateCompAccountFire(id, serialize(p)).catch((e) => console.warn('[compFire] save failed:', e.message));
    }
  }

  // The account's card state, dealt on first use (5 cards from the player's
  // unlocked cards, saved deck first) and with today's missions.
  async function stateFor(comp, account) {
    let p = cache.get(account.id);
    if (!p) {
      const f = account.fire && typeof account.fire === 'object' ? account.fire : {};
      const loadout = await getLoadout(account.player_id).catch(() => null);
      const unlocked = ((loadout && loadout.unlockedCards) || progression.BASIC_DECK).filter((id) => COMP_CARDS.includes(id));
      p = cardRules.initPlayer({ id: account.player_id, accountId: account.id, username: account.player?.username || 'Trader', socketId: 'comp', isAI: false }, { unlockedCards: unlocked });
      p.effects = { ...sabotage.createPlayerEffects(), ...(f.effects || {}) };
      p.cardsPlayed = f.cardsPlayed || 0;
      if (Array.isArray(f.cards)) {
        Object.assign(p, {
          cards: f.cards,
          streak: f.streak || 0,
          bestStreak: f.bestStreak || 0,
          heat: f.heat || 0,
          bestHeat: f.bestHeat || 0,
          qualifyingWins: f.qualifyingWins || 0,
          cardsEarned: f.cardsEarned || 0,
          cardGrantTimes: f.cardGrantTimes || [],
          grantedTrades: new Set(f.grantedTrades || []),
          lastOpenAt: f.lastOpenAt || 0,
          missions: f.missions || [],
          missionsDay: f.missionsDay || null,
          missionCoins: f.missionCoins || 0,
          missionsCompleted: f.missionsCompleted || 0,
          earnDay: f.earnDay || today(),
        });
      } else {
        const r = rules().cards;
        p.cards = sabotage.dealCards(Math.min(r.handSize, r.startCount || r.handSize), (loadout && loadout.deck) || [], unlocked);
        p.earnDay = today();
        p.missionsDay = null;
        p.missionCoins = 0;
        p.missionsCompleted = 0;
        cache.set(account.id, p);
        markDirty(p);
      }
      cache.set(account.id, p);
    }
    p.username = account.player?.username || p.username;
    // A new day: fresh missions and a fresh earned-card allowance.
    if (p.missionsDay !== today()) {
      cardRules.assignMissions(matchLike(comp), p, { hasSpikes: false });
      p.missionsDay = today();
      p.missionCoins = 0;
      markDirty(p);
    }
    if (p.earnDay !== today()) {
      p.earnDay = today();
      p.cardsEarned = 0;
      markDirty(p);
    }
    return p;
  }

  const fireConfig = () => {
    const f = gameFeel.get();
    const r = rules().cards;
    return { handSize: r.handSize, earnedCards: r.earnedCards, streakRewards: r.streakRewards, refillAtStreak: r.refillAtStreak, heat: { enabled: f.heat.enabled, multipliers: f.heat.multipliers } };
  };

  function view(p) {
    return {
      cards: p.cards,
      streak: p.streak,
      bestStreak: p.bestStreak,
      heat: p.heat,
      heatMultiplier: cardRules.heatMultiplier(p.streak),
      missions: p.missions,
      cardsPlayed: p.cardsPlayed,
      effects: Object.fromEntries(Object.entries(p.effects || {}).filter(([, e]) => e && (e.until ? Date.now() < e.until : true)).map(([k, e]) => [k, { until: e.until || null }])),
    };
  }

  const push = (comp, p, extra = {}) => emit(comp.id, p.id, 'comp:cards', { ...view(p), ...extra });

  // ---- what the target's own trading runs into --------------------------------
  const on = (e, now) => Boolean(e && now < e.until);
  const shielded = (p, now) => sabotage.hasShieldCard(p, now);

  // Extra half-spread on a fill from spread cards (market + this player's).
  function spreadExtra(comp, p, symbol, quote, now) {
    const m = market(comp.id);
    let mult = 1;
    const sym = m[symbol];
    if (sym && now < sym.spreadUntil && sym.spreadCasterId !== p.id && !shielded(p, now)) mult *= sym.spreadMultiplier;
    if (now < m.doubleSpreadUntil && m.doubleSpreadCasterId !== p.id && !shielded(p, now)) mult *= 2;
    if (on(p.effects.spread_blowout, now)) mult *= p.effects.spread_blowout.multiplier;
    return mult > 1 ? ((quote.ask - quote.bid) * (mult - 1)) / 2 : 0;
  }

  function takeSlippage(p, symbol, now) {
    const s = p.effects.slippage_storm;
    if (!s || now >= s.until || !(s.fillsLeft > 0)) return 0;
    s.fillsLeft -= 1;
    if (s.fillsLeft <= 0) p.effects.slippage_storm = null;
    markDirty(p);
    return instruments.getSpread(symbol) * s.spreads;
  }

  const refuse = (msg) => Object.assign(new Error(msg), { status: 400 });

  // Before a new trade: blocks and caps, then the entry price after spread
  // and slippage cards. Returns the adjusted entry.
  function beforeOpen(comp, p, { symbol, side, lots, openCount, freeMargin, quote, entry }) {
    const now = Date.now();
    const fx = p.effects;
    const m = market(comp.id);
    if (on(fx.position_freeze, now)) throw refuse('Position Freeze active - you cannot open trades right now');
    if (on(fx.trade_limit, now) && openCount >= 1) throw refuse('Trade Limit active - close your open trade before opening another');
    if (on(fx.one_way, now) && side !== fx.one_way.direction) throw refuse(`One Way active - you can only ${fx.one_way.direction} right now`);
    if (on(fx.cooldown_jam, now) && p.lastOpenAt && now - p.lastOpenAt < fx.cooldown_jam.gapSeconds * 1000) {
      throw refuse(`Cooldown Jam active - wait ${Math.ceil((p.lastOpenAt + fx.cooldown_jam.gapSeconds * 1000 - now) / 1000)}s before your next trade`);
    }
    const drained = now < m.liquidityDrainUntil && m.liquidityDrainCasterId !== p.id && !shielded(p, now);
    const cap = Math.min(drained ? 0.1 : Infinity, on(fx.lot_limiter, now) ? 0.05 : Infinity);
    if (lots > cap) throw refuse(`A card limits your lot size to ${cap} right now`);
    if (on(fx.margin_squeeze, now)) {
      const mid = (quote.bid + quote.ask) / 2;
      const most = Math.floor(require('./marginRules').maxAffordableLots(symbol, mid, freeMargin) * fx.margin_squeeze.share * 100) / 100;
      if (lots > most) throw refuse(`Margin Squeeze active - you can open up to ${most} lots right now`);
    }
    const dec = instruments.getInstrument(symbol).decimals;
    const worse = spreadExtra(comp, p, symbol, quote, now) + takeSlippage(p, symbol, now);
    return worse ? Number((entry + (side === 'BUY' ? worse : -worse)).toFixed(dec)) : entry;
  }

  function afterOpen(comp, p, { meaningful }) {
    p.lastOpenAt = Date.now();
    missions(comp, p, { type: 'open', meaningful, sinceSpikeMs: null });
    markDirty(p);
  }

  function beforeClose(p) {
    if (on(p.effects.lockout, Date.now())) throw refuse('Lockout active - you cannot close positions right now');
  }

  function exitPrice(comp, p, pos, quote, exit) {
    const now = Date.now();
    const worse = spreadExtra(comp, p, pos.symbol, quote, now) + takeSlippage(p, pos.symbol, now);
    if (!worse) return exit;
    const dec = instruments.getInstrument(pos.symbol).decimals;
    return Number((exit + (pos.side === 'BUY' ? -worse : worse)).toFixed(dec));
  }

  function beforeModify(p) {
    if (on(p.effects.order_freeze, Date.now())) throw refuse('Order Freeze active - you cannot change stop loss or take profit right now');
  }

  // ---- after every close: Profit Tax, streak, cards, Heat, missions, XP -------
  async function afterClose(comp, account, pos, pnl, reason, { equity } = {}) {
    if (!(await ready())) return;
    const p = await stateFor(comp, account);
    const now = Date.now();
    const tax = p.effects.profit_tax;
    if (pnl > 0 && tax && now < tax.until && tax.byAccount) {
      const floor = Number(account.starting_capital || 10000) * gameFeel.get().cards.floorPctOfCapital;
      const room = Math.max(0, Number(equity ?? Number(account.balance) + pnl) - floor);
      const amount = Math.min(round2(pnl * tax.share), tax.cap, Math.floor(room * 100) / 100);
      if (amount > 0 && (await db.compCardTransfer(account.id, tax.byAccount, amount).catch(() => false))) {
        emit(comp.id, p.id, 'sabotage:incoming', { cardType: 'profit_tax', amount, collected: true, cardName: 'Profit Tax' });
        if (tax.byPlayer) emit(comp.id, tax.byPlayer, 'comp:card_result', { cardType: 'profit_tax', collected: amount });
      }
      p.effects.profit_tax = null;
    }
    const position = { id: pos.id, openedAt: new Date(pos.opened_at).getTime() };
    const why = { sl: 'stop_loss', tp: 'take_profit', loss_limit: 'stop_out' }[reason] || reason;
    const earned = cardRules.onTradeClosed(matchLike(comp), p, { position, pnl, reason: why, nowMs: now, startingCapital: Number(account.starting_capital || 10000) });
    const marginRules = require('./marginRules');
    const meaningful = marginRules.positionMargin(pos.symbol, Number(pos.lots), Number(pos.entry_price)) >= 10000 * cardRules.MEANINGFUL_MARGIN_SHARE;
    missions(comp, p, { type: 'close', nowMs: now, qualifying: earned.qualifying, reason: why, heldMs: now - position.openedAt, meaningful, streak: p.streak });
    if (earned.qualifying) xp(comp, p, gameFeel.get().progression.xp.qualifyingWin, `xp:comp:${pos.id}`);
    markDirty(p);
    push(comp, p, { earned });
  }

  // Held-position missions (hold_60), from the competition tick, for
  // accounts whose state is already loaded (players who are playing).
  function onTick(comp, accountId, open, quotes) {
    const p = cache.get(accountId);
    if (!p) return;
    const marginRules = require('./marginRules');
    for (const pos of open) {
      const q = quotes[pos.symbol];
      if (!q) continue;
      missions(comp, p, { type: 'tick', heldMs: Date.now() - new Date(pos.opened_at).getTime(), meaningful: marginRules.positionMargin(pos.symbol, Number(pos.lots), marginRules.mid(q)) >= 10000 * cardRules.MEANINGFUL_MARGIN_SHARE });
    }
  }

  function missions(comp, p, ev) {
    const before = (p.missions || []).map((m) => m.progress).join(',');
    const done = cardRules.missionEvent(p, ev);
    if (!done.length) {
      if ((p.missions || []).map((m) => m.progress).join(',') !== before) {
        markDirty(p);
        emit(comp.id, p.id, 'missions:update', { missions: p.missions });
      }
      return;
    }
    const m = gameFeel.get().missions;
    for (const mission of done) {
      const coins = Math.max(0, Math.min(m.coinsPerMission, m.perMatchCoinCap - (p.missionCoins || 0)));
      p.missionCoins = (p.missionCoins || 0) + coins;
      p.missionsCompleted = (p.missionsCompleted || 0) + 1;
      mission.coins = coins;
      emit(comp.id, p.id, 'missions:complete', { mission, coins });
      const key = `${comp.id}:${p.id}:${p.missionsDay}:${mission.id}`;
      if (coins > 0) {
        (async () => {
          const paidToday = await db.coinsOfTypeToday(p.id, 'mission_reward').catch(() => 0);
          const allowed = Math.max(0, Math.min(coins, m.perDayCoinCap - paidToday));
          if (allowed > 0) await db.creditCoins(p.id, allowed, { type: 'mission_reward', idempotencyKey: `mission:comp:${key}` });
        })().catch((e) => console.warn('[compFire] mission reward failed:', e.message));
      }
      xp(comp, p, gameFeel.get().progression.xp.missionCompleted, `xp:comp:mission:${key}`);
    }
    markDirty(p);
    emit(comp.id, p.id, 'missions:update', { missions: p.missions });
  }

  function xp(comp, p, amount, key) {
    if (!(amount > 0) || !db.awardXp) return;
    (async () => {
      const stored = db.getProgress ? await db.getProgress(p.id).catch(() => null) : null;
      const todayXp = stored && stored.xp_day === today() ? stored.xp_today : 0;
      const gained = progression.capForDay(amount, todayXp);
      if (gained > 0) await db.awardXp(p.id, { matchId: comp.id, amount: gained, key, bestStreak: p.bestStreak, bestHeat: p.bestHeat });
    })().catch((e) => console.warn('[compFire] xp failed:', e.message));
  }

  // ---- playing a card -------------------------------------------------------------
  const asPosition = (row) => ({ id: row.id, symbol: row.symbol, direction: row.side, lots: Number(row.lots), entryPrice: Number(row.entry_price), stopLoss: row.stop_loss === null ? null : Number(row.stop_loss), takeProfit: row.take_profit === null ? null : Number(row.take_profit), openedAt: new Date(row.opened_at).getTime() });

  // ctx: { comp, caster: account, target: account|null, cardType, symbol,
  //   openOf(accountId) -> open position rows, quoteOf(symbol) -> quote,
  //   equityOf(account, openRows) -> equity, leaderAccountId }
  async function play(ctx) {
    const { comp, caster: casterAcc, target: targetAcc, cardType } = ctx;
    if (!(await ready())) throw refuse('Cards in competitions switch on after a quick server update');
    const now = Date.now();
    const def = sabotage.CARDS[cardType];
    if (!def || EXCLUDED.includes(cardType)) throw refuse('That card is not used in competitions');
    const caster = await stateFor(comp, casterAcc);
    const target = targetAcc ? await stateFor(comp, targetAcc) : null;
    if (def.targeted && !targetAcc) throw refuse('Choose a target player');
    if (targetAcc && targetAcc.status !== 'active') throw refuse(`${target.username} is no longer trading`);
    const match = matchLike(comp);
    const casterOpen = await ctx.openOf(casterAcc.id);
    const targetOpen = targetAcc ? await ctx.openOf(targetAcc.id) : [];
    caster.positions = casterOpen.map(asPosition);
    caster.balance = Number(casterAcc.balance);
    if (target) {
      target.positions = targetOpen.map(asPosition);
      target.balance = Number(targetAcc.balance);
    }
    match.players = { [caster.id]: caster, ...(target ? { [target.id]: target } : {}) };
    const blocked = cardRules.checkPlay(match, caster, cardType, target, now);
    if (blocked) throw refuse(blocked);
    const targetEquity = targetAcc ? ctx.equityOf(targetAcc, targetOpen) : null;
    const result = sabotage.playCard(match, caster.id, cardType, { targetId: target && target.id, symbol: ctx.symbol, targetEquity, startingCapital: Number(casterAcc.starting_capital || 10000), maxPositions: ctx.maxPositions || 10, rand: Math.random }, now);
    if (!result.success) throw refuse(result.error);
    if (target && target.effects.profit_tax && cardType === 'profit_tax') Object.assign(target.effects.profit_tax, { byAccount: casterAcc.id, byPlayer: caster.id });

    // Money: Capital Drain (target only), Pip Theft and Profit Skim (target -> caster).
    if (['capital_drain', 'pip_theft', 'profit_skim'].includes(cardType)) {
      const amount = result.amounts.amount;
      const ok = await db.compCardTransfer(targetAcc.id, cardType === 'capital_drain' ? null : casterAcc.id, amount).catch(() => false);
      if (!ok) {
        // Nothing moved: give the card back.
        const c = caster.cards.find((x) => x.type === cardType && x.used);
        if (c) c.used = false;
        markDirty(caster);
        throw refuse('The card could not be applied - try again');
      }
    }
    // Position actions against the competition's prices.
    const dec = (s) => instruments.getInstrument(s).decimals;
    const exitOf = (row) => {
      const q = ctx.quoteOf(row.symbol);
      return q ? (row.side === 'BUY' ? q.bid : q.ask) : null;
    };
    const pnlOf = (row) => {
      const exit = exitOf(row);
      return exit === null ? null : { exit, pnl: round2(instruments.calculatePnL(row.side, Number(row.lots), Number(row.entry_price), exit, row.symbol)) };
    };
    const best = (rows) => rows.map((r) => ({ r, x: pnlOf(r) })).filter((o) => o.x).sort((a, b) => b.x.pnl - a.x.pnl)[0];
    const closeRow = async (row) => {
      const x = pnlOf(row);
      if (!x) return;
      if (await db.compClosePosition(row.id, x.exit, 'sabotage', x.pnl)) {
        await afterClose(comp, { ...targetAcc, balance: Number(targetAcc.balance) + x.pnl }, row, x.pnl, 'sabotage');
      }
    };
    if (result.forceCloseTarget) {
      const b = best(targetOpen);
      if (b) await closeRow(b.r);
    }
    if (result.forceCloseAllTarget) for (const row of targetOpen) await closeRow(row);
    if (result.stopYankTarget) {
      const big = targetOpen.slice().sort((a, b) => Number(b.lots) - Number(a.lots))[0];
      const exit = exitOf(big);
      if (exit !== null) {
        const spread = instruments.getSpread(big.symbol);
        const before = big.stop_loss === null ? null : Number(big.stop_loss);
        const dist = before ? Math.abs(exit - before) : (spread * sabotage.CARD_AMOUNTS.stopYankNewSpreads) / sabotage.CARD_AMOUNTS.stopYankShare;
        const newDist = Math.max(spread, dist * sabotage.CARD_AMOUNTS.stopYankShare);
        const sl = Number((big.side === 'BUY' ? exit - newDist : exit + newDist).toFixed(dec(big.symbol)));
        await db.updateCompPosition(big.id, { stop_loss: sl });
        result.amounts = { positionId: big.id, stopBefore: before, stopAfter: sl };
      }
    }
    if (result.tpSnipTarget) for (const row of targetOpen.filter((r) => r.take_profit !== null)) await db.updateCompPosition(row.id, { take_profit: null });
    if (result.stopSnipeTarget) {
      const b = best(targetOpen);
      if (b) await db.updateCompPosition(b.r.id, { stop_loss: Number(b.r.entry_price) });
    }
    const insertFor = async (symbol, side, lots, entry) => {
      await db.insertCompPosition({ account_id: targetAcc.id, competition_id: comp.id, player_id: targetAcc.player_id, symbol, side, lots, entry_price: entry, stop_loss: null, take_profit: null });
    };
    if (result.mirrorSource) {
      const q = ctx.quoteOf(result.mirrorSource.symbol);
      if (q) await insertFor(result.mirrorSource.symbol, result.mirrorSource.direction, result.mirrorSource.lots, result.mirrorSource.direction === 'BUY' ? q.ask : q.bid);
    }
    if (result.ghostTrade) {
      const { symbol, direction } = result.ghostTrade;
      const q = ctx.quoteOf(symbol);
      const pip = instruments.getInstrument(symbol).pipSize;
      if (q) await insertFor(symbol, direction, 0.05, Number((direction === 'BUY' ? q.ask + 3 * pip : q.bid - 3 * pip).toFixed(dec(symbol))));
    }

    if (target && def.targeted) cardRules.afterHit(match, target, now);
    if (target && ctx.leaderAccountId === targetAcc.id && gameFeel.get().heat.enabled) {
      caster.heat += gameFeel.get().heat.sabotageLeaderBonus;
      caster.bestHeat = Math.max(caster.bestHeat, caster.heat);
    }
    missions(comp, caster, { type: 'card' });
    markDirty(caster);
    if (target) markDirty(target);
    push(comp, caster);
    if (target) {
      for (const n of result.notify) if (n.to === target.id) emit(comp.id, target.id, n.event, { ...n.payload, cardName: def.name, by: caster.username });
      push(comp, target);
    }
    delete caster.positions;
    if (target) delete target.positions;
    return { cardType, name: def.name, target: target ? target.username : null, feedText: result.feedText, amounts: result.amounts, symbol: result.symbol };
  }

  // Leaderboard tags for the target picker (only for loaded accounts).
  function statusOf(accountId) {
    const p = cache.get(accountId);
    if (!p) return [];
    const now = Date.now();
    const tags = [];
    if (sabotage.hasShieldCard(p, now)) tags.push('shield');
    else if (p.effects.hitShield && now < p.effects.hitShield.until) tags.push('protected');
    const fx = sabotage.activeTargetEffect(p, now);
    if (fx) tags.push(fx === 'position_freeze' ? 'frozen' : 'affected');
    return tags;
  }

  const catalog = () => sabotage.getCardCatalog().filter((c) => COMP_CARDS.includes(c.id));

  return { ready, stateFor, view, fireConfig, catalog, beforeOpen, afterOpen, beforeClose, exitPrice, beforeModify, afterClose, onTick, play, statusOf, flush, _cache: cache };
}

module.exports = { createCompFire, COMP_CARDS, EXCLUDED };
