'use strict';

// Long-form competitions (Daily / Weekly / Weekend / Monthly): trading
// accounts that live for hours to weeks against a replay of real market
// history (server/replayClock.js). Unlike a live match (gameEngine.js), every
// piece of state is in the database - accounts, positions, equity, settlement
// flags - so a restart, a second server instance or a player closing their
// laptop for a day changes nothing. The tick job reads it all back each run.

const crypto = require('crypto');
const db = require('./database');
const csvLoader = require('./csvLoader');
const instruments = require('./instruments');
const replayClock = require('./replayClock');
const { GAME_RULES, baseRatingForPosition, tierForRating } = require('./gameEngine');

const TICK_MS = 5000;
const LOCK_TTL_SECONDS = 15;
const SNAPSHOT_EVERY_MS = 5 * 60 * 1000;
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

function createCompEngine({ io, notifyPlayer }) {
  const holder = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  let tickTimer = null;
  let ticking = false;
  let lastScheduleAt = 0;

  const room = (compId, playerId) => `comp:${compId}:${playerId}`;
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

    const accounts = await db.listCompAccounts(compId);
    const live = accounts.map((a) => (a.id === account.id ? { ...a, equity } : a));
    const ranked = rankAccounts(live);
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
        prizeUsd: Number(account.prize_usd),
      },
      rank: ranked.findIndex((a) => a.id === account.id) + 1,
      entrants: accounts.length,
      positions: open.map((p) => publicPosition(p, quotes[p.symbol])),
      trades: closed.map((p) => publicPosition(p)),
      quotes,
      marketClosed: Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, q.marketClosed])),
      compTime: dataTime + shift,
      session: sessionLabel(dataTime + shift),
      rules: {
        maxLots: GAME_RULES.MAX_LOTS,
        maxPositions: GAME_RULES.MAX_POSITIONS,
        lossLimitPct: GAME_RULES.HARD_LOSS_PCT,
      },
      instrumentInfo: Object.fromEntries(
        (comp.instruments || []).map((sym) => {
          const cfg = instruments.getInstrument(sym);
          return [sym, { name: cfg.name, pipSize: cfg.pipSize, decimals: cfg.decimals, minLot: cfg.minLot, maxLot: Math.min(cfg.maxLot, GAME_RULES.MAX_LOTS) }];
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
    const accounts = await db.listCompAccounts(compId);
    const ended = comp.status === 'ended';
    const ranked = ended ? accounts.slice().sort((a, b) => (a.final_rank ?? 1e9) - (b.final_rank ?? 1e9)) : rankAccounts(accounts);
    const rows = ranked.map((a, i) => ({
      rank: ended ? a.final_rank : i + 1,
      username: a.player?.username || 'Trader',
      equity: round2(Number(a.equity)),
      pnlPct: round2(((Number(a.equity) - Number(a.starting_capital)) / Number(a.starting_capital)) * 100),
      trades: a.trade_count,
      status: a.status,
      isMe: a.player_id === playerId,
    }));
    const top = rows.slice(0, LEADERBOARD_SIZE);
    const me = rows.find((r) => r.isMe);
    return { leaderboard: top, me: me || null, entrants: rows.length };
  }

  // ---- trading -----------------------------------------------------------------------

  function validateLots(symbol, lots) {
    const cfg = instruments.getInstrument(symbol);
    const max = Math.min(GAME_RULES.MAX_LOTS, cfg.maxLot);
    const n = Number(lots);
    if (!Number.isFinite(n) || n < cfg.minLot || n > max) {
      throw Object.assign(new Error(`Lot size must be between ${cfg.minLot} and ${max}`), { status: 400 });
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

    // There's no separate margin requirement in this game - the risk rule is
    // the loss limit. Refuse new risk once equity is already at it.
    const equity = equityOf(account, open, quotesFor(comp, dataTime));
    if (equity <= Number(account.starting_capital) * (1 - GAME_RULES.HARD_LOSS_PCT)) {
      throw Object.assign(new Error('Equity is at the loss limit'), {
        status: 400,
      });
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
    // account is locked (loss limit already closed everything).
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
  // the account's equity at that same moment against the loss limit. Prices
  // move in straight lines between path points, so equity does too - the
  // stop-out happens at the exact moment equity crosses the floor, not
  // wherever the next 5-second tick happens to land.
  async function walkAccountPath(comp, acc, open, lastData, dataTime) {
    const floor = Number(acc.starting_capital) * (1 - GAME_RULES.HARD_LOSS_PCT);
    const startOf = (pos) => Math.max(lastData, replayClock.dataTimeFor(comp, new Date(pos.opened_at).getTime()));
    const times = new Set([dataTime]);
    for (const sym of new Set(open.map((p) => p.symbol))) {
      for (const pt of replayClock.pathBetween(sym, lastData, dataTime)) times.add(pt.t);
    }
    const prevPx = new Map(open.map((p) => [p.id, closingPrice(p, replayClock.getPriceAt(p.symbol, startOf(p)))]));
    let balance = Number(acc.balance);
    let live = open.slice();
    const equityAt = (t) => live.reduce((eq, pos) => eq + positionPnl(pos, replayClock.getPriceAt(pos.symbol, t)).pnl, balance);
    let prev = { t: lastData, equity: equityAt(lastData) };

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
      if (!live.length) {
        prev = { t, equity: balance };
        continue;
      }

      const equity = equityAt(t);
      if (equity > floor) {
        prev = { t, equity };
        continue;
      }
      if (!(await db.lockCompAccount(acc.id, { status: 'loss_limit', loss_limit_hit_at: new Date().toISOString() }))) {
        return { balance, live, locked: false };
      }
      // Interpolate back to the moment equity actually hit the floor.
      const crossT =
        prev.equity > floor && prev.equity !== equity ? Math.round(prev.t + ((prev.equity - floor) / (prev.equity - equity)) * (t - prev.t)) : t;
      for (const pos of live) {
        const { exit, pnl } = positionPnl(pos, replayClock.getPriceAt(pos.symbol, crossT));
        if (await db.compClosePosition(pos.id, exit, 'loss_limit', pnl)) balance += pnl;
      }
      return { balance, live: [], locked: true };
    }
    return { balance, live, locked: false };
  }

  async function tickCompetition(comp, nowMs) {
    const dataTime = replayClock.dataTimeFor(comp, nowMs);
    const lastData = comp.last_tick_data_time
      ? Math.floor(new Date(comp.last_tick_data_time).getTime() / 1000)
      : Math.floor(new Date(comp.data_window_start).getTime() / 1000);
    const openAll = await db.listCompPositions({ competition_id: comp.id, status: 'open' }, { limit: 5000 });
    const quotes = quotesFor(comp, dataTime);
    const shift = replayClock.timeShiftFor(comp);
    const fresh = await db.listCompAccounts(comp.id);
    const byAccount = {};
    for (const pos of openAll) (byAccount[pos.account_id] = byAccount[pos.account_id] || []).push(pos);

    // 1) stops and loss limit along the path, 2) mark to market, snapshots
    for (const acc of fresh) {
      if (acc.status !== 'active') continue;
      const walked = await walkAccountPath(comp, acc, byAccount[acc.id] || [], lastData, dataTime);
      byAccount[acc.id] = walked.live;
      acc.balance = round2(walked.balance);
      const equity = walked.locked ? acc.balance : equityOf(acc, walked.live, quotes);
      if (walked.locked) {
        acc.status = 'loss_limit';
        emit(comp.id, acc.player_id, 'comp:loss_limit', { equity });
        notifyPlayer(acc.player_id, 'comp_loss_limit', `Loss limit hit in ${comp.title} - your account is locked at $${equity.toFixed(2)}`, {
          data: { competitionId: comp.id },
        });
      }
      const fields = { equity };
      if (!acc.last_snapshot_at || nowMs - new Date(acc.last_snapshot_at).getTime() >= SNAPSHOT_EVERY_MS) {
        await db.insertCompEquitySnapshot(acc.id, equity);
        fields.last_snapshot_at = new Date(nowMs).toISOString();
      }
      await db.updateCompAccount(acc.id, fields);
      acc.equity = equity;
    }

    const ranked = rankAccounts(fresh);
    ranked.forEach((acc, i) => {
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
      for (const acc of fresh) {
        emit(comp.id, acc.player_id, 'comp:ending_soon', {
          minutesLeft: Math.round(left / 60000),
        });
        if (notice.key === '1h') {
          notifyPlayer(acc.player_id, 'comp_ending_soon', `${comp.title} ends in ${notice.label}`, { data: { competitionId: comp.id } });
        }
      }
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

    const open = await db.listCompPositions({ competition_id: comp.id, status: 'open' }, { limit: 5000 });
    for (const pos of open) {
      const { exit, pnl } = positionPnl(pos, quotes[pos.symbol]);
      await db.compClosePosition(pos.id, exit, 'settle', pnl);
    }

    const accounts = (await db.listCompAccounts(comp.id)).map((a) => ({
      ...a,
      equity: Number(a.balance),
    }));
    const ranked = rankAccounts(accounts);
    const payouts = Object.fromEntries((comp.prize_payouts || []).map((p) => [p.rank, p]));
    const total = ranked.filter((a) => a.status !== 'disqualified').length;

    let paid = 0;
    for (let i = 0; i < ranked.length; i++) {
      const acc = ranked[i];
      const dq = acc.status === 'disqualified';
      const rank = dq ? null : i + 1;
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
          prize_usd: prize.usd || 0,
        });
      await db.updateCompAccount(acc.id, fields);

      if (!(await db.compPayPrize(acc.id))) continue; // already settled for this account
      paid++;
      if (rank && !comp.is_test) await applyRating(acc.player_id, rank, total);
      const prizeText = [prize.coins ? `${prize.coins} coins` : null, prize.usd ? `$${prize.usd} cash (claim it in your Wallet)` : null]
        .filter(Boolean)
        .join(' + ');
      const message = dq
        ? `${comp.title} has ended - your account was disqualified`
        : `${comp.title} ended - you finished #${rank} of ${total}${prizeText ? `, winning ${prizeText}` : ''}`;
      notifyPlayer(acc.player_id, 'comp_ended', message, {
        data: {
          competitionId: comp.id,
          rank,
          prizeCoins: prize.coins || 0,
          prizeUsd: prize.usd || 0,
        },
      });
      emit(comp.id, acc.player_id, 'comp:ended', {
        rank,
        prize: { coins: prize.coins || 0, usd: prize.usd || 0 },
        entrants: total,
      });
    }

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
    const open = await db.listCompPositions({ competition_id: comp.id, status: 'open' }, { limit: 5000 });
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
      instruments: wanted,
      usedStarts,
    });
    for (const d of window.dropped) console.warn(`[compEngine] ${title}: dropped ${d.symbol} - ${d.reason}`);
    if (!window.dataWindowStart) throw new Error(`No replay data covers "${title}" - ${window.dropped.map((d) => d.symbol).join(', ')}`);

    const totalCoins = payouts.reduce((s, p) => s + (p.coins || 0), 0);
    const totalUsd = payouts.reduce((s, p) => s + (p.usd || 0), 0);
    const ordinal = (n) => `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n] || 'th'}`;
    const prizeDetails = Object.fromEntries(
      payouts.map((p) => [ordinal(p.rank), [p.coins ? `${p.coins} coins` : null, p.usd ? `$${p.usd}` : null].filter(Boolean).join(' + ')])
    );
    return db.createCompetitionRow({
      id,
      title,
      description,
      rules: `Starting capital $${GAME_RULES.STARTING_CAPITAL.toLocaleString()}. Max ${GAME_RULES.MAX_LOTS} lots per trade, ${GAME_RULES.MAX_POSITIONS} open positions. Losing ${GAME_RULES.HARD_LOSS_PCT * 100}% of starting capital locks your account at its final equity. Replays real historical market data.`,
      type: 'native',
      prize_pool: totalUsd,
      prize_details: prizeDetails,
      prize_payouts: payouts,
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
    for (const [frequency, tpl] of Object.entries(TEMPLATES)) {
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
          for (const acc of await db.listCompAccounts(comp.id)) {
            notifyPlayer(acc.player_id, 'comp_started', `${comp.title} is live - good luck!`, { data: { competitionId: comp.id } });
          }
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
    scheduleUpcoming,
    tickOnce,
    start,
    stop,
    joinRoom,
  };
}

module.exports = { createCompEngine, TEMPLATES, rankAccounts, sessionLabel };
