'use strict';

// Long-form competitions (Daily / Weekly / Weekend / Monthly): trading
// accounts that live for hours to weeks against a replay of real market
// history (server/replayClock.js). Unlike a live match (gameEngine.js), every
// piece of state is in the database - accounts, positions, equity, settlement
// flags - so a restart, a second server instance or a player closing their
// laptop for a day changes nothing. The tick job reads it all back each run.

const compStates = require('./competitionStates');
const liveFeed = require('./liveFeed');
const crypto = require('crypto');
const db = require('./database');
const csvLoader = require('./csvLoader');
const instruments = require('./instruments');
const marginRules = require('./marginRules');
const replayClock = require('./replayClock');
const { GAME_RULES, baseRatingForPosition, tierForRating } = require('./gameEngine');
const { runPool, createMemo } = require('./concurrency');
const gameFeel = require('./config/gameFeel');

const NO_CASH_VALUE_LINE = 'Coins have no cash value and cannot be withdrawn or exchanged for money.';

const TICK_MS = 5000;
const LOCK_TTL_SECONDS = 15;
const SNAPSHOT_EVERY_MS = 5 * 60 * 1000;
// Equity curve points are thinned out in big competitions: 10,000 entrants at
// every 5 minutes would add about 1 GB a day.
const SNAPSHOT_EVERY_MS_LARGE = 15 * 60 * 1000;
const LARGE_COMPETITION = 1000;
const STANDINGS_CACHE_MS = 3000; // every player's screen asks; the numbers only move each tick
const SETTLE_CONCURRENCY = 8;
const SCHEDULE_EVERY_MS = 10 * 60 * 1000;
const LEADERBOARD_SIZE = 100;
const CHART_HISTORY_BARS = 500;
const ENDING_NOTICES = [
  { key: '1h', ms: 60 * 60 * 1000, label: '1 hour' },
  { key: '10m', ms: 10 * 60 * 1000, label: '10 minutes' },
];

const DAY_MS = 86400000;
const MIN_JOINABLE_FRACTION = 0.25;

// The four recurring formats. Times are UTC. Weekend runs crypto only - it's
// the only market that trades Saturday/Sunday, so anything else would just
// sit closed. Prizes are coins (never cash out - see help.html); a cash prize
// is only ever set per event by an admin.
const TEMPLATES = {
  daily: {
    title: 'Daily War — 22h Full Session',
    description: 'One full trading day: Asian open to New York close. Best equity at the bell wins.',
    instruments: ['EURUSD', 'GBPUSD', 'XAUUSD', 'NAS100', 'BTCUSD'],
    entryFee: 10,
    payouts: [
      { rank: 1, coins: 150 },
      { rank: 2, coins: 75 },
      { rank: 3, coins: 40 },
    ],
    // Mon-Fri, 00:00 -> 22:00 UTC
    next(fromMs) {
      for (let d = 0; d < 8; d++) {
        const day = new Date(Math.floor(fromMs / DAY_MS) * DAY_MS + d * DAY_MS);
        const wd = day.getUTCDay();
        if (wd === 0 || wd === 6) continue;
        if (day.getTime() < fromMs) continue;
        return {
          startsAt: day,
          endsAt: new Date(day.getTime() + 22 * 3600000),
        };
      }
      return null;
    },
  },
  weekly: {
    title: 'Weekly War — Mon to Fri',
    description: 'The whole trading week. Five sessions, one account, no resets.',
    instruments: ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'NAS100', 'US30', 'USOIL', 'BTCUSD'],
    entryFee: 25,
    payouts: [
      { rank: 1, coins: 600 },
      { rank: 2, coins: 300 },
      { rank: 3, coins: 150 },
    ],
    // Monday 00:00 -> Friday 21:00 UTC
    next(fromMs) {
      const today = Math.floor(fromMs / DAY_MS) * DAY_MS;
      for (let d = 0; d < 8; d++) {
        const day = new Date(today + d * DAY_MS);
        if (day.getUTCDay() !== 1 || day.getTime() < fromMs) continue;
        return {
          startsAt: day,
          endsAt: new Date(day.getTime() + 4 * DAY_MS + 21 * 3600000),
        };
      }
      return null;
    },
  },
  weekend: {
    title: 'Weekend Blitz',
    description: 'Crypto never sleeps. Saturday and Sunday on Bitcoin and Ethereum.',
    instruments: ['BTCUSD', 'ETHUSD'],
    entryFee: 15,
    payouts: [
      { rank: 1, coins: 250 },
      { rank: 2, coins: 125 },
      { rank: 3, coins: 60 },
    ],
    // Saturday 00:00 -> Sunday 23:00 UTC
    next(fromMs) {
      const today = Math.floor(fromMs / DAY_MS) * DAY_MS;
      for (let d = 0; d < 8; d++) {
        const day = new Date(today + d * DAY_MS);
        if (day.getUTCDay() !== 6 || day.getTime() < fromMs) continue;
        return {
          startsAt: day,
          endsAt: new Date(day.getTime() + DAY_MS + 23 * 3600000),
        };
      }
      return null;
    },
  },
  monthly: {
    title: 'Monthly Grand',
    description: 'A full month of markets. The long game — patience and risk control win this one.',
    instruments: ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'XAGUSD', 'NAS100', 'US30', 'GER40', 'USOIL', 'BTCUSD', 'ETHUSD'],
    entryFee: 50,
    payouts: [
      { rank: 1, coins: 2500 },
      { rank: 2, coins: 1250 },
      { rank: 3, coins: 600 },
      ...[4, 5, 6, 7, 8, 9, 10].map((rank) => ({ rank, coins: 100 })),
    ],
    // 1st of the month 00:00 -> 1st of the next month 00:00 UTC
    next(fromMs) {
      const from = new Date(fromMs);
      let start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
      if (start.getTime() < fromMs) start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
      return {
        startsAt: start,
        endsAt: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)),
      };
    },
  },
};

// A template's instruments minus any the curation (or admin) disabled, topped
// back up to the template's size with playable instruments of the same asset
// classes first, then the rest, in catalog activity order - so a competition
// never trades a thin instrument and never shrinks to nothing.
function competitionInstruments(wanted) {
  const playable = instruments.playableSymbols('competition');
  const kept = wanted.filter((s) => playable.includes(s));
  if (kept.length >= wanted.length) return kept;
  const classes = new Set(wanted.map((s) => instruments.getInstrument(s)?.category));
  const extra = [...playable.filter((s) => classes.has(instruments.getInstrument(s).category)), ...playable].filter((s, i, a) => !kept.includes(s) && a.indexOf(s) === i);
  return [...kept, ...extra].slice(0, wanted.length);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isLive(comp, nowMs = Date.now()) {
  return comp.status === 'active' && nowMs >= new Date(comp.starts_at).getTime() && nowMs < new Date(comp.ends_at).getTime();
}

// UTC hour -> which session a real trader would be in (for the play screen
// header), using the competition's own calendar time.
function sessionLabel(epochSeconds) {
  const h = new Date(epochSeconds * 1000).getUTCHours();
  if (h >= 13 && h < 21) return h < 16 ? 'London / New York' : 'New York';
  if (h >= 7 && h < 13) return 'London';
  return 'Asian';
}

function positionPnl(pos, quote) {
  const exit = pos.side === 'BUY' ? quote.bid : quote.ask;
  return {
    exit,
    pnl: round2(instruments.calculatePnL(pos.side, Number(pos.lots), Number(pos.entry_price), exit, pos.symbol)),
  };
}

function publicPosition(pos, quote) {
  const base = {
    id: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    lots: Number(pos.lots),
    entryPrice: Number(pos.entry_price),
    stopLoss: pos.stop_loss === null ? null : Number(pos.stop_loss),
    takeProfit: pos.take_profit === null ? null : Number(pos.take_profit),
    status: pos.status,
    openedAt: pos.opened_at,
  };
  if (pos.status === 'open') {
    return {
      ...base,
      currentPrice: quote ? (pos.side === 'BUY' ? quote.bid : quote.ask) : null,
      pnl: quote ? positionPnl(pos, quote).pnl : 0,
    };
  }
  return {
    ...base,
    exitPrice: Number(pos.exit_price),
    exitReason: pos.exit_reason,
    pnl: Number(pos.pnl),
    closedAt: pos.closed_at,
  };
}

// Same ordering everywhere: equity desc, then fewer trades, then whoever
// entered first. Disqualified accounts sort last and never take a prize.
function rankAccounts(accounts) {
  return accounts.slice().sort((a, b) => {
    const dq = (a.status === 'disqualified') - (b.status === 'disqualified');
    if (dq) return dq;
    return Number(b.equity) - Number(a.equity) || a.trade_count - b.trade_count || new Date(a.created_at) - new Date(b.created_at);
  });
}

// Spike alerts for long competitions: one tracker per competition engine.
// Returns events for this tick: an alert a few data-seconds before a real spike
// bar (time only), and its result once the bar is over.
function makeSpikeTracker() {
  const spikeState = new Map(); // compId -> { lastAlertAt (data time), pending }
  return function spikeEvents(comp, dataTime) {
    const cfg = gameFeel.get().spikeAlerts;
    const out = [];
    if (!cfg.enabled || !replayClock.isCuratedTime(dataTime)) return out;
    let st = spikeState.get(comp.id);
    if (!st) spikeState.set(comp.id, (st = { lastAlertAt: -Infinity, pending: null }));
    if (st.pending && dataTime >= st.pending.t + replayClock.BASE_SECONDS) {
      out.push({ event: 'comp:spike_result', payload: { id: st.pending.id, symbol: st.pending.symbol, movePct: st.pending.movePct, showSeconds: cfg.resultShowSeconds } });
      st.pending = null;
    }
    if (st.pending || dataTime - st.lastAlertAt < cfg.minGapSecondsLong) return out;
    // A tick runs every few seconds: look one tick plus the lead time ahead.
    const ahead = cfg.leadDataSeconds + Math.ceil(TICK_MS / 1000);
    for (const symbol of comp.instruments || []) {
      const sp = replayClock.compSpikeBetween(symbol, dataTime, dataTime + ahead);
      if (!sp) continue;
      st.pending = { id: `cspike-${comp.id.slice(0, 6)}-${sp.t}`, symbol, t: sp.t, movePct: sp.movePct };
      st.lastAlertAt = dataTime;
      out.push({ event: 'comp:spike_alert', payload: { id: st.pending.id, inSeconds: Math.max(1, sp.t - dataTime) } });
      break;
    }
    if (spikeState.size > 500) for (const k of spikeState.keys()) if (k !== comp.id) { spikeState.delete(k); break; }
    return out;
  };
}

function createCompEngine({ io, notifyPlayer }) {
  const holder = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  let tickTimer = null;
  let ticking = false;
  let lastScheduleAt = 0;
  let lastLockAt = 0;
  const standingsMemo = createMemo();

  // Long jobs keep hold of the runner lock so a second server doesn't start too.
  async function keepLock(nowMs = Date.now()) {
    if (nowMs - lastLockAt < 5000) return;
    lastLockAt = nowMs;
    await db.tryCompJobLock('comp_tick', holder, LOCK_TTL_SECONDS).catch(() => {});
  }

  // Everyone's rank, worked out once and shared. Sorting every entrant for every
  // player's screen doesn't survive a big competition.
  function standings(compId) {
    return standingsMemo(compId, STANDINGS_CACHE_MS, async () => {
      const accounts = await db.listCompAccounts(compId);
      const ranked = rankAccounts(accounts);
      return { accounts, ranked, rankById: new Map(ranked.map((a, i) => [a.id, i + 1])) };
    });
  }

  const room = (compId, playerId) => `comp:${compId}:${playerId}`;
  // Nobody watching is the common case in a long competition.
  const isWatching = (compId, playerId) => {
    const rooms = io.sockets?.adapter?.rooms;
    return rooms ? rooms.has(room(compId, playerId)) : true;
  };
  const emit = (compId, playerId, event, payload) => io.to(room(compId, playerId)).emit(event, { competitionId: compId, ...payload });

  function quotesFor(comp, dataTime) {
    const quotes = {};
    for (const sym of comp.instruments || []) {
      const q = replayClock.getPriceAt(sym, dataTime);
      if (q) quotes[sym] = q;
    }
    return quotes;
  }

  function equityOf(account, openPositions, quotes) {
    let equity = Number(account.balance);
    for (const pos of openPositions) {
      const q = quotes[pos.symbol];
      if (q) equity += positionPnl(pos, q).pnl;
    }
    return round2(equity);
  }

  async function requireNativeComp(compId) {
    const comp = await db.getCompetitionById(compId);
    if (!comp || !comp.is_published) throw Object.assign(new Error('Competition not found'), { status: 404 });
    if (comp.type === 'external') throw Object.assign(new Error("Enter this competition on the organizer's site"), { status: 400 });
    return comp;
  }

  async function requireTradeable(compId, playerId) {
    const comp = await requireNativeComp(compId);
    if (!isLive(comp)) {
      const startsIn = new Date(comp.starts_at).getTime() - Date.now();
      throw Object.assign(new Error(startsIn > 0 ? 'This competition has not started yet' : 'This competition has ended'), { status: 400 });
    }
    const account = await db.getCompAccount(compId, playerId);
    if (!account)
      throw Object.assign(new Error('You have not entered this competition'), {
        status: 403,
      });
    if (account.status !== 'active') {
      const why = account.status === 'loss_limit' ? 'Loss limit reached - your account is locked' : 'Your account is no longer active';
      throw Object.assign(new Error(why), { status: 400 });
    }
    return { comp, account };
  }

  // ---- entry -----------------------------------------------------------------------

  async function enter(compId, playerId) {
    const comp = await requireNativeComp(compId);
    if (['ended', 'void'].includes(comp.status) || Date.now() >= new Date(comp.ends_at).getTime()) {
      throw Object.assign(new Error('This competition has ended'), {
        status: 400,
      });
    }
    // Coming soon, paused, live-data-without-a-feed and money-with-a-fee are
    // refused here, before compEnter, so no coin ledger row is ever written.
    const gate = compStates.enterGate(comp, { liveOk: await liveFeed.canGoLive(db) });
    if (!gate.ok) throw Object.assign(new Error(gate.reason), { status: 400 });
    compStates.assertSeparation(comp);
    const result = await db.compEnter(comp.id, playerId, comp.entry_fee_coins || 0, GAME_RULES.STARTING_CAPITAL);
    if (result.error === 'insufficient_coins') throw Object.assign(new Error('Not enough coins'), { status: 400 });
    if (result.error)
      throw Object.assign(new Error('Could not enter competition'), {
        status: 400,
      });
    return { accountId: result.account_id, alreadyEntered: result.already };
  }

  // ---- reads -------------------------------------------------------------------------

  async function getAccountView(compId, playerId) {
    const comp = await requireNativeComp(compId);
    const account = await db.getCompAccount(compId, playerId);
    if (!account)
      throw Object.assign(new Error('You have not entered this competition'), {
        status: 403,
      });

    const nowMs = Math.min(Date.now(), new Date(comp.ends_at).getTime());
    const started = Date.now() >= new Date(comp.starts_at).getTime();
    const dataTime = started ? replayClock.dataTimeFor(comp, nowMs) : replayClock.dataTimeFor(comp, new Date(comp.starts_at).getTime());
    const quotes = quotesFor(comp, dataTime);
    const positions = await db.listCompPositions({ account_id: account.id }, { limit: 300 });
    const open = positions.filter((p) => p.status === 'open');
    const closed = positions.filter((p) => p.status === 'closed');
    const equity = comp.status === 'ended' || comp.status === 'void' ? Number(account.equity) : equityOf(account, open, quotes);

    const { accounts, rankById } = await standings(compId);
    // Exact to this player's latest equity in small competitions; in big ones the
    // rank from the last tick (at most a few seconds old) saves re-sorting everyone.
    const rank =
      accounts.length <= 500
        ? rankAccounts(accounts.map((a) => (a.id === account.id ? { ...a, equity } : a))).findIndex((a) => a.id === account.id) + 1
        : rankById.get(account.id) || accounts.length;
    const shift = replayClock.timeShiftFor(comp);

    return {
      competition: competitionSummary(comp),
      account: {
        id: account.id,
        status: account.status,
        startingCapital: Number(account.starting_capital),
        balance: Number(account.balance),
        equity,
        realisedPnl: Number(account.realised_pnl),
        tradeCount: account.trade_count,
        finalRank: account.final_rank,
        prizeCoins: account.prize_coins,
      },
      rank,
      entrants: accounts.length,
      positions: open.map((p) => publicPosition(p, quotes[p.symbol])),
      trades: closed.map((p) => publicPosition(p)),
      quotes,
      marketClosed: Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, q.marketClosed])),
      compTime: dataTime + shift,
      session: sessionLabel(dataTime + shift),
      rules: {
        ...marginRules.MARGIN_RULES,
        maxPositions: GAME_RULES.MAX_POSITIONS,
      },
      instrumentInfo: Object.fromEntries(
        (comp.instruments || []).map((sym) => {
          const cfg = instruments.getInstrument(sym);
          return [sym, { name: cfg.name, pipSize: cfg.pipSize, decimals: cfg.decimals, minLot: cfg.minLot }];
        })
      ),
    };
  }

  function competitionSummary(comp) {
    return {
      id: comp.id,
      title: comp.title,
      frequency: comp.frequency,
      status: comp.status,
      startsAt: comp.starts_at,
      endsAt: comp.ends_at,
      instruments: comp.instruments,
      entryFeeCoins: comp.entry_fee_coins,
      prizePayouts: comp.prize_payouts,
      replaySpeed: Number(comp.replay_speed),
      isTest: comp.is_test,
    };
  }

  // Top 100 + the caller. Only standings - never anyone's open positions, so
  // nobody can mirror a leader's trades mid-competition.
  async function getLeaderboard(compId, playerId) {
    const comp = await requireNativeComp(compId);
    const { accounts, ranked: live } = await standings(compId);
    const ended = comp.status === 'ended';
    const ranked = ended ? accounts.slice().sort((a, b) => (a.final_rank ?? 1e9) - (b.final_rank ?? 1e9)) : live;
    const toRow = (a, i) => ({
      rank: ended ? a.final_rank : i + 1,
      username: a.player?.username || 'Trader',
      equity: round2(Number(a.equity)),
      pnlPct: round2(((Number(a.equity) - Number(a.starting_capital)) / Number(a.starting_capital)) * 100),
      trades: a.trade_count,
      status: a.status,
      isMe: a.player_id === playerId,
    });
    const myIndex = ranked.findIndex((a) => a.player_id === playerId);
    return {
      leaderboard: ranked.slice(0, LEADERBOARD_SIZE).map(toRow),
      me: myIndex === -1 ? null : toRow(ranked[myIndex], myIndex),
      entrants: ranked.length,
    };
  }

  // ---- trading -----------------------------------------------------------------------

  function validateLots(symbol, lots) {
    const cfg = instruments.getInstrument(symbol);
    const n = Number(lots);
    // No upper limit: size is decided by free margin when the trade opens.
    if (!Number.isFinite(n) || n < cfg.minLot) {
      throw Object.assign(new Error(`Lot size must be at least ${cfg.minLot}`), { status: 400 });
    }
    return Math.round(n * 100) / 100;
  }

  // SL/TP sides are checked against the price the position would close at
  // (bid for a BUY, ask for a SELL), same as the live match engine.
  function validateStops(side, refPrice, stopLoss, takeProfit) {
    const parse = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
    const sl = parse(stopLoss);
    const tp = parse(takeProfit);
    if ((sl !== null && !Number.isFinite(sl)) || (tp !== null && !Number.isFinite(tp))) {
      throw Object.assign(new Error('Invalid stop loss or take profit'), {
        status: 400,
      });
    }
    if (sl !== null && ((side === 'BUY' && sl >= refPrice) || (side === 'SELL' && sl <= refPrice))) {
      throw Object.assign(new Error(`Stop loss must be ${side === 'BUY' ? 'below' : 'above'} the current price`), { status: 400 });
    }
    if (tp !== null && ((side === 'BUY' && tp <= refPrice) || (side === 'SELL' && tp >= refPrice))) {
      throw Object.assign(new Error(`Take profit must be ${side === 'BUY' ? 'above' : 'below'} the current price`), { status: 400 });
    }
    return { sl, tp };
  }

  async function openTrade(compId, playerId, { symbol, side, lots, stopLoss, takeProfit }) {
    const { comp, account } = await requireTradeable(compId, playerId);
    const dir = String(side || '').toUpperCase();
    if (dir !== 'BUY' && dir !== 'SELL')
      throw Object.assign(new Error('side must be BUY or SELL'), {
        status: 400,
      });
    if (!(comp.instruments || []).includes(symbol)) throw Object.assign(new Error('That instrument is not in this competition'), { status: 400 });
    const size = validateLots(symbol, lots);

    const open = await db.listCompPositions({
      account_id: account.id,
      status: 'open',
    });
    if (open.length >= GAME_RULES.MAX_POSITIONS)
      throw Object.assign(new Error('Maximum open positions reached'), {
        status: 400,
      });

    const dataTime = replayClock.dataTimeFor(comp);
    const quote = replayClock.getPriceAt(symbol, dataTime);
    if (!quote || quote.marketClosed) throw Object.assign(new Error('Market closed - you can still close trades'), { status: 400 });

    // A new trade has to fit in free margin.
    const allQuotes = quotesFor(comp, dataTime);
    const equity = equityOf(account, open, allQuotes);
    const usedNow = marginRules.usedMargin(open, (p) => (allQuotes[p.symbol] ? marginRules.mid(allQuotes[p.symbol]) : Number(p.entry_price)));
    const freeMargin = equity - usedNow;
    if (marginRules.positionMargin(symbol, size, marginRules.mid(quote)) > freeMargin) {
      const most = marginRules.maxAffordableLots(symbol, marginRules.mid(quote), freeMargin);
      throw Object.assign(new Error(most > 0 ? `Not enough free margin. You can open up to ${most} lots of ${symbol} right now` : 'No free margin left. Close a position to open a new one'), { status: 400 });
    }

    const entryPrice = dir === 'BUY' ? quote.ask : quote.bid;
    const { sl, tp } = validateStops(dir, dir === 'BUY' ? quote.bid : quote.ask, stopLoss, takeProfit);
    const position = await db.insertCompPosition({
      account_id: account.id,
      competition_id: comp.id,
      player_id: playerId,
      symbol,
      side: dir,
      lots: size,
      entry_price: entryPrice,
      stop_loss: sl,
      take_profit: tp,
    });
    await db.incrementCompTradeCount(account.id);
    return { position: publicPosition(position, quote) };
  }

  async function closeTrade(compId, playerId, positionId) {
    // Closing is allowed even with the market closed, but not once the
    // account is locked.
    const { comp } = await requireTradeable(compId, playerId);
    const pos = await db.getCompPosition(positionId);
    if (!pos || pos.player_id !== playerId || pos.competition_id !== comp.id || pos.status !== 'open') {
      throw Object.assign(new Error('Position not found'), { status: 404 });
    }
    const quote = replayClock.getPriceAt(pos.symbol, replayClock.dataTimeFor(comp));
    const { exit, pnl } = positionPnl(pos, quote);
    const closed = await db.compClosePosition(pos.id, exit, 'manual', pnl);
    if (!closed)
      throw Object.assign(new Error('Position already closed'), {
        status: 409,
      });
    return { positionId: pos.id, exitPrice: exit, pnl };
  }

  async function modifyTrade(compId, playerId, positionId, { stopLoss, takeProfit }) {
    const { comp } = await requireTradeable(compId, playerId);
    const pos = await db.getCompPosition(positionId);
    if (!pos || pos.player_id !== playerId || pos.competition_id !== comp.id || pos.status !== 'open') {
      throw Object.assign(new Error('Position not found'), { status: 404 });
    }
    const quote = replayClock.getPriceAt(pos.symbol, replayClock.dataTimeFor(comp));
    const { sl, tp } = validateStops(pos.side, pos.side === 'BUY' ? quote.bid : quote.ask, stopLoss, takeProfit);
    const updated = await db.updateCompPosition(pos.id, {
      stop_loss: sl,
      take_profit: tp,
    });
    if (!updated)
      throw Object.assign(new Error('Position already closed'), {
        status: 409,
      });
    return { position: publicPosition(updated, quote) };
  }

  // ---- chart -------------------------------------------------------------------------

  // Bar history up to the competition's current market time only - nothing
  // after it, on any timeframe. Times are shifted onto the competition's own
  // calendar. 5-minute bars back ~500 hourly candles, then real h1/d1 bars
  // from before that so 4h/D1 have depth too (all strictly older).
  async function getChartData(compId, playerId, symbol) {
    const comp = await requireNativeComp(compId);
    const account = await db.getCompAccount(compId, playerId);
    if (!account) throw Object.assign(new Error('Enter this competition to see its charts'), { status: 403 });
    if (!(comp.instruments || []).includes(symbol)) throw Object.assign(new Error('That instrument is not in this competition'), { status: 400 });

    const endMs = Math.min(Date.now(), new Date(comp.ends_at).getTime());
    const startMs = new Date(comp.starts_at).getTime();
    const dataTime = replayClock.dataTimeFor(comp, Math.max(startMs, endMs));
    const shift = replayClock.timeShiftFor(comp);

    const m5From = dataTime - CHART_HISTORY_BARS * 3600;
    const m5 = replayClock.candlesUpTo(symbol, m5From, dataTime);
    const m5Start = m5.length ? m5[0][0] : dataTime;
    const market = csvLoader.getMarketSeries(symbol);
    const h1 = market ? market.h1.filter((b) => b.time < m5Start && b.time >= m5Start - CHART_HISTORY_BARS * 4 * 3600) : [];
    const h1Start = h1.length ? h1[0].time : m5Start;
    const d1 = market ? market.d1.filter((b) => b.time + 86400 <= h1Start).slice(-CHART_HISTORY_BARS) : [];
    const row = (b) => [b.time + shift, b.open, b.high, b.low, b.close];

    const quote = replayClock.getPriceAt(symbol, dataTime);
    return {
      symbol,
      compTime: dataTime + shift,
      bars: {
        d1: d1.map(row),
        h1: h1.map(row),
        m5: m5.map(([t, o, h, l, c]) => [t + shift, o, h, l, c]),
      },
      quote,
    };
  }

  // ---- tick job ----------------------------------------------------------------------

  // SL/TP check for one position moving from prevPx to px (its closing-side
  // price). A level crossed between the two points fills at the level; a jump
  // that was already past it (weekend open) fills at the jumped-to price.
  function stopHit(pos, prevPx, px) {
    const sl = pos.stop_loss === null ? null : Number(pos.stop_loss);
    const tp = pos.take_profit === null ? null : Number(pos.take_profit);
    const buy = pos.side === 'BUY';
    const slHit = sl !== null && (buy ? px <= sl : px >= sl);
    const tpHit = tp !== null && (buy ? px >= tp : px <= tp);
    if (!slHit && !tpHit) return null;
    const level = slHit ? sl : tp;
    const wasShort = prevPx !== null && (slHit ? (buy ? prevPx > sl : prevPx < sl) : buy ? prevPx < tp : prevPx > tp);
    return { reason: slHit ? 'sl' : 'tp', exit: wasShort ? level : px };
  }

  const closingPrice = (pos, quote) => (pos.side === 'BUY' ? quote.bid : quote.ask);

  // Replays the price path between the last tick and now for one account, in
  // time order: at every point each open position's SL/TP is checked, then
  // the account's margin level at that same moment against the stop-out level.
  async function walkAccountPath(comp, acc, open, lastData, dataTime) {
    const startOf = (pos) => Math.max(lastData, replayClock.dataTimeFor(comp, new Date(pos.opened_at).getTime()));
    const times = new Set([dataTime]);
    for (const sym of new Set(open.map((p) => p.symbol))) {
      for (const pt of replayClock.pathBetween(sym, lastData, dataTime)) times.add(pt.t);
    }
    const prevPx = new Map(open.map((p) => [p.id, closingPrice(p, replayClock.getPriceAt(p.symbol, startOf(p)))]));
    let balance = Number(acc.balance);
    let live = open.slice();
    const equityAt = (t) => live.reduce((eq, pos) => eq + positionPnl(pos, replayClock.getPriceAt(pos.symbol, t)).pnl, balance);

    for (const t of [...times].sort((a, b) => a - b)) {
      for (const pos of live.slice()) {
        if (t <= startOf(pos)) continue;
        const quote = replayClock.getPriceAt(pos.symbol, t);
        const px = closingPrice(pos, quote);
        const hit = stopHit(pos, prevPx.get(pos.id), px);
        prevPx.set(pos.id, px);
        if (!hit) continue;
        const exit = Number(hit.exit.toFixed(instruments.getInstrument(pos.symbol).decimals));
        const pnl = round2(instruments.calculatePnL(pos.side, Number(pos.lots), Number(pos.entry_price), exit, pos.symbol));
        live = live.filter((p) => p !== pos);
        if (await db.compClosePosition(pos.id, exit, hit.reason, pnl)) {
          balance += pnl;
          emit(comp.id, pos.player_id, hit.reason === 'sl' ? 'comp:sl_hit' : 'comp:tp_hit', { positionId: pos.id, symbol: pos.symbol, exitPrice: exit, pnl });
        }
      }
      if (!live.length) continue;

      // Margin stop-out: close the biggest loser, then the next, until the
      // margin level recovers. Stored as 'loss_limit' (the table has no
      // stop_out reason; the play screen labels it Stopped out). The account stays open.
      let equity = equityAt(t);
      const usedAt = () => marginRules.usedMargin(live, (p) => marginRules.mid(replayClock.getPriceAt(p.symbol, t)));
      let level = marginRules.marginLevel(equity, usedAt());
      let closed = 0;
      while (level !== null && level <= marginRules.STOP_OUT_LEVEL && live.length) {
        const scored = live.map((p) => ({ p, ...positionPnl(p, replayClock.getPriceAt(p.symbol, t)) })).sort((x, y) => x.pnl - y.pnl);
        const { p: worst, exit, pnl } = scored[0];
        live = live.filter((p) => p !== worst);
        if (await db.compClosePosition(worst.id, exit, 'loss_limit', pnl)) {
          balance += pnl;
          closed += 1;
        }
        equity = equityAt(t);
        level = marginRules.marginLevel(equity, usedAt());
      }
      if (closed) emit(comp.id, acc.player_id, 'comp:stop_out', { closed, equity: round2(equity) });
    }
    return { balance, live };
  }

  const spikeEvents = makeSpikeTracker();

  async function tickCompetition(comp, nowMs) {
    const dataTime = replayClock.dataTimeFor(comp, nowMs);
    const lastData = comp.last_tick_data_time
      ? Math.floor(new Date(comp.last_tick_data_time).getTime() / 1000)
      : Math.floor(new Date(comp.data_window_start).getTime() / 1000);
    const openAll = await db.listOpenCompPositions(comp.id);
    const quotes = quotesFor(comp, dataTime);
    const shift = replayClock.timeShiftFor(comp);
    const fresh = await db.listCompAccounts(comp.id);
    const byAccount = {};
    for (const pos of openAll) (byAccount[pos.account_id] = byAccount[pos.account_id] || []).push(pos);
    const snapshotEvery = fresh.length > LARGE_COMPETITION ? SNAPSHOT_EVERY_MS_LARGE : SNAPSHOT_EVERY_MS;

    // 1) stops and stop-out along the path, 2) mark to market, snapshots.
    // An account with nothing open can't have moved, so it needs no work and, if
    // nothing changed, no write at all - that's most accounts most of the time.
    const writes = [];
    for (const acc of fresh) {
      if (acc.status !== 'active') continue;
      const held = byAccount[acc.id] || [];
      if (held.length) {
        const walked = await walkAccountPath(comp, acc, held, lastData, dataTime);
        byAccount[acc.id] = walked.live;
        acc.balance = round2(walked.balance);
        await keepLock();
      }
      const equity = equityOf(acc, byAccount[acc.id] || [], quotes);
      const changed = equity !== Number(acc.equity);
      const lastSnapshot = acc.last_snapshot_at ? new Date(acc.last_snapshot_at).getTime() : 0;
      const snapshot = nowMs - lastSnapshot >= snapshotEvery && (changed || held.length > 0 || !lastSnapshot);
      if (changed || snapshot) writes.push({ id: acc.id, equity, snapshot });
      acc.equity = equity;
    }
    await db.compApplyTicks(writes);

    const ranked = rankAccounts(fresh);
    // Spike alerts (long competitions): only real spike bars of the curated
    // series, at most one per spikeAlerts.minGapSecondsLong, time only.
    for (const ev of spikeEvents(comp, dataTime)) {
      for (const acc of ranked) if (isWatching(comp.id, acc.player_id)) emit(comp.id, acc.player_id, ev.event, ev.payload);
    }
    ranked.forEach((acc, i) => {
      if (!isWatching(comp.id, acc.player_id)) return;
      const open = byAccount[acc.id] || [];
      emit(comp.id, acc.player_id, 'comp:update', {
        compTime: dataTime + shift,
        session: sessionLabel(dataTime + shift),
        quotes,
        account: {
          status: acc.status,
          balance: Number(acc.balance),
          equity: Number(acc.equity),
        },
        positions: acc.status === 'active' ? open.map((p) => publicPosition(p, quotes[p.symbol])) : [],
        rank: i + 1,
        entrants: ranked.length,
      });
    });

    // 3) ending-soon notices, once each
    const left = new Date(comp.ends_at).getTime() - nowMs;
    const sent = new Set(comp.notices_sent || []);
    for (const notice of ENDING_NOTICES) {
      if (left > notice.ms || sent.has(notice.key) || left <= 0) continue;
      sent.add(notice.key);
      // Paced: thousands of notifications at once would flood the database.
      await runPool(fresh, SETTLE_CONCURRENCY, async (acc) => {
        emit(comp.id, acc.player_id, 'comp:ending_soon', {
          minutesLeft: Math.round(left / 60000),
        });
        if (notice.key === '1h') {
          await notifyPlayer(acc.player_id, 'comp_ending_soon', `${comp.title} ends in ${notice.label}`, { data: { competitionId: comp.id } });
        }
        await keepLock();
      });
    }

    await db.updateCompetition(comp.id, {
      last_tick_at: new Date(nowMs).toISOString(),
      last_tick_data_time: new Date(dataTime * 1000).toISOString(),
      notices_sent: Array.from(sent),
    });
  }

  // ---- settlement ----------------------------------------------------------------------

  // Safe to run any number of times: positions close once (status guard),
  // ranks are recomputed identically, prizes and notifications only go out
  // for accounts comp_pay_prize flips from unpaid to paid.
  async function settle(compId) {
    const comp = await db.getCompetitionById(compId);
    if (!comp || comp.status === 'void') return { settled: false, reason: 'void' };
    const endMs = new Date(comp.ends_at).getTime();
    const finalData = replayClock.dataTimeFor(comp, Math.min(Date.now(), endMs));
    const quotes = quotesFor(comp, finalData);

    const open = await db.listOpenCompPositions(comp.id);
    await runPool(open, SETTLE_CONCURRENCY, async (pos) => {
      const { exit, pnl } = positionPnl(pos, quotes[pos.symbol]);
      await db.compClosePosition(pos.id, exit, 'settle', pnl);
      await keepLock();
    });

    const accounts = (await db.listCompAccounts(comp.id)).map((a) => ({
      ...a,
      equity: Number(a.balance),
    }));
    const ranked = rankAccounts(accounts);
    // Prizes are coin credits only - coins have no cash value, so any legacy
    // `usd` amount on a payout row is ignored.
    const payouts = Object.fromEntries((comp.prize_payouts || []).map((p) => [p.rank, { coins: Number(p.coins) || 0 }]));
    const total = ranked.filter((a) => a.status !== 'disqualified').length;

    // Safe to re-run after an interruption: prize_paid stops anyone being paid or
    // re-rated twice, and an account already finished is skipped. If any account
    // fails this throws before the competition is marked ended, so the next tick
    // picks up the rest.
    let paid = 0;
    await runPool(ranked, SETTLE_CONCURRENCY, async (acc, i) => {
      await keepLock();
      const dq = acc.status === 'disqualified';
      const rank = dq ? null : i + 1;
      if (acc.prize_paid && acc.final_rank === rank) return;
      const prize = !dq && payouts[rank] ? payouts[rank] : {};
      const fields = {
        equity: acc.equity,
        final_rank: rank,
        final_pnl: round2(acc.equity - Number(acc.starting_capital)),
        status: acc.status === 'active' ? 'finished' : acc.status,
      };
      if (!acc.prize_paid)
        Object.assign(fields, {
          prize_coins: prize.coins || 0,
          prize_usd: 0,
        });
      await db.updateCompAccount(acc.id, fields);

      if (!(await db.compPayPrize(acc.id))) return; // already settled for this account
      paid++;
      if (rank && !comp.is_test) await applyRating(acc.player_id, rank, total);
      const prizeText = prize.coins ? `${prize.coins.toLocaleString()} coins` : '';
      const message = dq
        ? `${comp.title} has ended - your account was disqualified`
        : `${comp.title} ended - you finished #${rank} of ${total}${prizeText ? `, winning ${prizeText}` : ''}`;
      await notifyPlayer(acc.player_id, 'comp_ended', message, {
        data: {
          competitionId: comp.id,
          rank,
          prizeCoins: prize.coins || 0,
        },
      });
      emit(comp.id, acc.player_id, 'comp:ended', {
        rank,
        prize: { coins: prize.coins || 0 },
        entrants: total,
      });
    });

    await db.updateCompetition(comp.id, {
      status: 'ended',
      settled_at: comp.settled_at || new Date().toISOString(),
    });
    return { settled: true, accounts: ranked.length, newlyPaid: paid };
  }

  // Same per-position rating table as live matches; one competition counts
  // as one played "match" on the profile.
  async function applyRating(playerId, rank, total) {
    try {
      const player = await db.getPlayerById(playerId);
      if (!player) return;
      const newRating = Math.max(0, (player.war_rating || 0) + baseRatingForPosition(rank, total));
      await db.updatePlayer(playerId, {
        war_rating: newRating,
        tier: tierForRating(newRating),
        wins: (player.wins || 0) + (rank === 1 ? 1 : 0),
        losses: (player.losses || 0) + (rank === 1 ? 0 : 1),
        total_matches: (player.total_matches || 0) + 1,
      });
    } catch (e) {
      console.warn('[compEngine] rating update failed:', e.message);
    }
  }

  // ---- admin actions --------------------------------------------------------------------

  async function voidCompetition(compId) {
    const comp = await db.getCompetitionById(compId);
    if (!comp) throw Object.assign(new Error('Competition not found'), { status: 404 });
    if (comp.status === 'ended')
      throw Object.assign(new Error('Already settled - prizes are paid'), {
        status: 400,
      });
    await db.updateCompetition(comp.id, { status: 'void' });
    const open = await db.listOpenCompPositions(comp.id);
    for (const pos of open) await db.compClosePosition(pos.id, Number(pos.entry_price), 'void', 0);
    let refunded = 0;
    for (const acc of await db.listCompAccounts(comp.id)) {
      if (await db.compRefundEntry(acc.id, comp.entry_fee_coins || 0)) {
        refunded++;
        notifyPlayer(acc.player_id, 'comp_void', `${comp.title} was cancelled - your ${comp.entry_fee_coins || 0} coin entry was refunded`, {
          data: { competitionId: comp.id },
        });
      }
    }
    return { refunded };
  }

  async function disqualify(compId, playerId) {
    const comp = await db.getCompetitionById(compId);
    const account = await db.getCompAccount(compId, playerId);
    if (!comp || !account) throw Object.assign(new Error('Account not found'), { status: 404 });
    await db.updateCompAccount(account.id, { status: 'disqualified' });
    const dataTime = replayClock.dataTimeFor(comp, Math.min(Date.now(), new Date(comp.ends_at).getTime()));
    for (const pos of await db.listCompPositions({
      account_id: account.id,
      status: 'open',
    })) {
      const { exit, pnl } = positionPnl(pos, replayClock.getPriceAt(pos.symbol, dataTime));
      await db.compClosePosition(pos.id, exit, 'disqualified', pnl);
    }
    emit(comp.id, playerId, 'comp:update', {
      account: { status: 'disqualified' },
    });
    return { disqualified: true };
  }

  // ---- creating competitions ------------------------------------------------------------

  async function createCompetition({
    frequency = null,
    title,
    description,
    instruments: wanted,
    startsAt,
    endsAt,
    entryFee,
    payouts,
    replaySpeed = 1,
    isTest = false,
  }) {
    const id = crypto.randomUUID();
    const usedStarts = frequency ? await db.listRecentWindowStarts(frequency, replayClock.USED_WINDOW_MEMORY) : [];
    const window = replayClock.chooseDataWindow({
      id,
      startsAt,
      endsAt,
      replaySpeed,
      instruments: competitionInstruments(wanted),
      usedStarts,
    });
    for (const d of window.dropped) console.warn(`[compEngine] ${title}: dropped ${d.symbol} - ${d.reason}`);
    if (!window.dataWindowStart) throw new Error(`No replay data covers "${title}" - ${window.dropped.map((d) => d.symbol).join(', ')}`);

    const coinPayouts = payouts.map((p) => ({ rank: p.rank, coins: Number(p.coins) || 0 }));
    const totalCoins = coinPayouts.reduce((s, p) => s + p.coins, 0);
    const ordinal = (n) => `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n] || 'th'}`;
    const prizeDetails = Object.fromEntries(coinPayouts.map((p) => [ordinal(p.rank), `${p.coins.toLocaleString()} coins`]));
    return db.createCompetitionRow({
      id,
      title,
      description,
      rules: `Starting capital $${GAME_RULES.STARTING_CAPITAL.toLocaleString()}. Leverage ${marginRules.LEVERAGE}:1, up to ${GAME_RULES.MAX_POSITIONS} open positions, no lot limit (size is set by free margin). Margin call at ${marginRules.MARGIN_CALL_LEVEL}%, stop-out at ${marginRules.STOP_OUT_LEVEL}%. Replays real historical market data. ${NO_CASH_VALUE_LINE}`,
      type: 'native',
      prize_pool: 0,
      prize_pool_coins: totalCoins,
      prize_details: prizeDetails,
      prize_payouts: coinPayouts,
      instruments: window.instruments,
      entry_fee_coins: entryFee,
      starts_at: new Date(startsAt).toISOString(),
      ends_at: new Date(endsAt).toISOString(),
      is_published: true,
      frequency,
      replay_speed: replaySpeed,
      is_test: isTest,
      data_window_start: window.dataWindowStart,
      status: new Date(startsAt).getTime() <= Date.now() ? 'active' : 'scheduled',
    });
  }

  // Keeps the next occurrence of every template on the calendar so players
  // can enter ahead of time. Idempotent: skips any template that already has
  // a non-test competition starting at that slot.
  // The slot running right now (if enough of it is left to be worth
  // joining) and the next one to start, so the hub always shows both a LIVE
  // and a STARTS IN entry per format.
  function slotsFor(tpl, nowMs) {
    const slots = [];
    let from = nowMs - 32 * DAY_MS;
    for (let guard = 0; guard < 40; guard++) {
      const slot = tpl.next(from);
      if (!slot) break;
      const start = slot.startsAt.getTime();
      const end = slot.endsAt.getTime();
      if (start > nowMs) {
        slots.push(slot);
        break;
      }
      if (end > nowMs && (end - nowMs) / (end - start) >= MIN_JOINABLE_FRACTION) slots.push(slot);
      from = start + 1;
    }
    return slots;
  }

  async function scheduleUpcoming() {
    const created = [];
    // Templates admin has locked (Coming soon, paused, closed) or that need the
    // live feed before it is ready are not scheduled. Without the templates
    // table (migration not run yet) everything schedules as before.
    let states = null;
    try {
      states = Object.fromEntries((await db.listCompTemplates()).map((t) => [t.key, t]));
    } catch (e) {
      states = null;
    }
    const liveOk = await liveFeed.canGoLive(db);
    for (const [frequency, tpl] of Object.entries(TEMPLATES)) {
      const st = states && states[frequency];
      if (st && (!compStates.ENTERABLE_STATES.includes(st.state) || (st.data_source === 'live' && !liveOk))) continue;
      const existing = await db.listCompetitionsByFrequency(frequency, new Date(Date.now() - 40 * DAY_MS).toISOString());
      for (const slot of slotsFor(tpl, Date.now())) {
        if (existing.some((c) => new Date(c.starts_at).getTime() === slot.startsAt.getTime())) continue;
        try {
          const row = await createCompetition({
            frequency,
            title: tpl.title,
            description: tpl.description,
            instruments: tpl.instruments,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            entryFee: tpl.entryFee,
            payouts: tpl.payouts,
          });
          created.push(
            `${frequency} ${row.starts_at.slice(0, 16)} (${row.instruments.length} instruments, data from ${row.data_window_start.slice(0, 10)})`
          );
        } catch (e) {
          console.error(`[compEngine] could not schedule ${frequency}:`, e.message);
        }
      }
    }
    return created;
  }

  // ---- the job loop ---------------------------------------------------------------------

  async function tickOnce() {
    if (ticking) return;
    ticking = true;
    try {
      if (!(await db.tryCompJobLock('comp_tick', holder, LOCK_TTL_SECONDS))) return;
      const nowMs = Date.now();

      if (nowMs - lastScheduleAt >= SCHEDULE_EVERY_MS) {
        lastScheduleAt = nowMs;
        const created = await scheduleUpcoming();
        if (created.length) console.log(`[compEngine] scheduled: ${created.join('; ')}`);
      }

      for (const comp of await db.listNativeCompetitionsByStatus(['scheduled'])) {
        if (nowMs < new Date(comp.starts_at).getTime() || !comp.data_window_start) continue;
        if (
          await db.transitionCompetition(comp.id, 'scheduled', {
            status: 'active',
          })
        ) {
          await runPool(await db.listCompAccounts(comp.id), SETTLE_CONCURRENCY, (acc) =>
            notifyPlayer(acc.player_id, 'comp_started', `${comp.title} is live - good luck!`, { data: { competitionId: comp.id } })
          );
        }
      }

      for (const comp of await db.listNativeCompetitionsByStatus(['active'])) {
        if (!comp.data_window_start) continue;
        try {
          if (nowMs >= new Date(comp.ends_at).getTime()) {
            const result = await settle(comp.id);
            console.log(`[compEngine] settled "${comp.title}": ${result.accounts} accounts, ${result.newlyPaid} newly paid`);
          } else {
            await tickCompetition(comp, nowMs);
          }
        } catch (e) {
          console.error(`[compEngine] tick failed for ${comp.id}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[compEngine] tick error:', e.message);
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (tickTimer || !db.isConfigured) return;
    tickTimer = setInterval(tickOnce, TICK_MS);
    tickOnce();
    console.log(`[compEngine] started (tick every ${TICK_MS / 1000}s, runner ${holder})`);
  }

  function stop() {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  // Lets a socket subscribe to its own competition room once it proves it
  // has an account there.
  async function joinRoom(socket, compId) {
    const playerId = socket.data.player?.id;
    if (!playerId || !compId) return false;
    const account = await db.getCompAccount(compId, playerId).catch(() => null);
    if (!account) return false;
    socket.join(room(compId, playerId));
    return true;
  }

  return {
    TEMPLATES,
    enter,
    getAccountView,
    getLeaderboard,
    openTrade,
    closeTrade,
    modifyTrade,
    getChartData,
    settle,
    voidCompetition,
    disqualify,
    createCompetition,
    tickCompetition,
    scheduleUpcoming,
    tickOnce,
    start,
    stop,
    joinRoom,
  };
}

module.exports = { createCompEngine, TEMPLATES, competitionInstruments, rankAccounts, sessionLabel, TICK_MS, makeSpikeTracker };
