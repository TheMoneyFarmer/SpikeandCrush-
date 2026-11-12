'use strict';

// MT5-style account records, shared by the admin panel and the player's own
// read-only history. Every function here reads; nothing writes match or
// trade state.
//
// One "account" is one seat: a match_players row (war modes) or a
// comp_accounts row (competitions), named by its 8-digit account number.
// Trades come from `trades` / `comp_positions`, the modification log and the
// timeline from `match_events`.

const STARTING_CAPITAL = 10000;

const WAR_COMMENTS = {
  manual: '', partial: 'partial close', stop_loss: 'SL hit', take_profit: 'TP hit', stop_out: 'margin call',
  sabotage: 'force close by card', elimination: 'elimination', match_end: 'match end', left_match: 'left match',
  admin_kick: 'removed by admin', disconnect: 'disconnect', loss_limit: 'loss limit',
};
const COMP_COMMENTS = { manual: '', sl: 'SL hit', tp: 'TP hit', loss_limit: 'loss limit', settle: 'competition end' };

const r2 = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 100) / 100);

// ---- trade rows ------------------------------------------------------------

function warTradeRow(t) {
  const reason = t.close_reason || (t.closed_at ? null : 'open');
  return {
    ticket: t.ticket ?? null,
    deal: t.deal ?? null,
    positionRef: t.position_ref || null,
    openTime: t.opened_at,
    closeTime: t.closed_at || null,
    type: String(t.direction || '').toLowerCase() === 'sell' ? 'sell' : 'buy',
    volume: Number(t.lots),
    symbol: t.symbol,
    openPrice: Number(t.entry_price),
    sl: t.stop_loss == null ? null : Number(t.stop_loss),
    tp: t.take_profit == null ? null : Number(t.take_profit),
    closePrice: t.exit_price == null ? null : Number(t.exit_price),
    commission: 0,
    swap: 0,
    profit: t.pnl == null ? null : Number(t.pnl),
    reason,
    comment: [t.comment || WAR_COMMENTS[reason] || '', t.backfilled ? 'ids back-filled' : ''].filter(Boolean).join('; '),
    dataOpenS: t.data_open_s == null ? null : Number(t.data_open_s),
    dataCloseS: t.data_close_s == null ? null : Number(t.data_close_s),
    backfilled: Boolean(t.backfilled),
  };
}

function compTradeRow(p) {
  const reason = p.exit_reason || (p.status === 'open' ? 'open' : null);
  return {
    ticket: p.ticket ?? null,
    deal: p.deal ?? null,
    positionRef: p.id,
    openTime: p.opened_at,
    closeTime: p.closed_at || null,
    type: String(p.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy',
    volume: Number(p.lots),
    symbol: p.symbol,
    openPrice: Number(p.entry_price),
    sl: p.stop_loss == null ? null : Number(p.stop_loss),
    tp: p.take_profit == null ? null : Number(p.take_profit),
    closePrice: p.exit_price == null ? null : Number(p.exit_price),
    commission: 0,
    swap: 0,
    profit: p.pnl == null ? null : Number(p.pnl),
    reason,
    comment: [COMP_COMMENTS[reason] || reason || '', p.backfilled ? 'ids back-filled' : ''].filter(Boolean).join('; '),
    dataOpenS: null,
    dataCloseS: null,
    backfilled: Boolean(p.backfilled),
  };
}

// ---- summary ---------------------------------------------------------------

// Peak-to-trough drop over an equity series [{t, equity}] (t = seconds or ISO).
function maxDrawdown(curve) {
  let peak = -Infinity;
  let best = { amount: 0, pct: 0, at: null, peak: null };
  for (const p of curve || []) {
    const e = Number(p.equity);
    if (!Number.isFinite(e)) continue;
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > best.amount) best = { amount: dd, pct: peak > 0 ? (dd / peak) * 100 : 0, at: p.t, peak };
  }
  return { amount: r2(best.amount), pct: r2(best.pct), at: best.at };
}

// A balance-only curve from closed trades, for accounts with no equity curve.
function balanceCurve(trades, startingCapital) {
  let bal = startingCapital;
  const out = [{ t: null, equity: bal }];
  for (const t of trades.filter((x) => x.closeTime && x.profit != null).sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime))) {
    bal += t.profit;
    out.push({ t: t.closeTime, equity: bal });
  }
  return out;
}

function summarize({ trades, startingCapital = STARTING_CAPITAL, closing = null, curve = null, extra = {} }) {
  const closed = trades.filter((t) => t.closeTime && t.profit != null);
  const wins = closed.filter((t) => t.profit > 0);
  const losses = closed.filter((t) => t.profit < 0);
  const grossProfit = wins.reduce((a, t) => a + t.profit, 0);
  const grossLoss = losses.reduce((a, t) => a + t.profit, 0);
  const net = grossProfit + grossLoss;
  const holds = closed.map((t) => (new Date(t.closeTime) - new Date(t.openTime)) / 1000).filter((s) => Number.isFinite(s) && s >= 0);
  const series = curve && curve.length ? curve : balanceCurve(trades, startingCapital);
  const dd = maxDrawdown(series);
  const balance = r2(startingCapital + net);
  return {
    startingCapital,
    balance,
    equity: closing && closing.equity != null ? closing.equity : balance,
    margin: closing ? closing.margin : 0,
    freeMargin: closing ? closing.freeMargin : balance,
    marginLevel: closing ? closing.marginLevel : null,
    floatingPnl: closing ? closing.floatingPnl : 0,
    grossProfit: r2(grossProfit),
    grossLoss: r2(grossLoss),
    netProfit: r2(net),
    profitFactor: grossLoss < 0 ? r2(grossProfit / Math.abs(grossLoss)) : null,
    maxDrawdown: dd.amount,
    maxDrawdownPct: dd.pct,
    maxDrawdownAt: dd.at,
    winRate: closed.length ? r2((wins.length / closed.length) * 100) : null,
    averageWin: wins.length ? r2(grossProfit / wins.length) : null,
    averageLoss: losses.length ? r2(grossLoss / losses.length) : null,
    largestWin: wins.length ? r2(Math.max(...wins.map((t) => t.profit))) : null,
    largestLoss: losses.length ? r2(Math.min(...losses.map((t) => t.profit))) : null,
    trades: closed.length,
    openTrades: trades.length - closed.length,
    longTrades: trades.filter((t) => t.type === 'buy').length,
    shortTrades: trades.filter((t) => t.type === 'sell').length,
    averageHoldSeconds: holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : null,
    commission: 0,
    swap: 0,
    ...extra,
  };
}

// SL/TP changes from the event log, oldest first, with who caused them.
function modificationLog(events, nameOf = () => null) {
  return (events || [])
    .filter((e) => e.kind === 'sltp')
    .map((e) => {
      const p = e.payload || {};
      const by = p.by === 'card' ? `card ${p.card}${p.attackerId ? ` by ${nameOf(p.attackerId) || 'opponent'}` : ''}` : p.by || 'player';
      return { realAt: e.real_at, dataS: e.data_s == null ? null : Number(e.data_s), positionRef: e.position_ref, symbol: p.symbol, before: p.before, after: p.after, by };
    });
}

// ---- CSV in MT5 report column order ---------------------------------------
// MT5 "Positions" columns, then the extras this game records.
const MT5_COLUMNS = ['Time', 'Position', 'Symbol', 'Type', 'Volume', 'Price', 'S / L', 'T / P', 'Time', 'Price', 'Commission', 'Swap', 'Profit', 'Deal', 'Comment', 'Data open (s)', 'Data close (s)'];

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const mt5Time = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace(/-/g, '.') : '');

function tradesCsv(trades) {
  const lines = [MT5_COLUMNS.join(',')];
  for (const t of trades) {
    lines.push([
      mt5Time(t.openTime), t.ticket, t.symbol, t.type, t.volume, t.openPrice, t.sl, t.tp,
      mt5Time(t.closeTime), t.closePrice, t.commission, t.swap, t.profit, t.deal, t.comment, t.dataOpenS, t.dataCloseS,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ---- loaders (any supabase-js client with the service role) --------------

async function must(q) {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

// Where an account number lives: a war seat or a competition entry.
async function findAccount(sb, number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 10000000 || n > 99999999) return null;
  const mp = await must(sb.from('match_players').select('*').eq('account_number', n).maybeSingle());
  if (mp) return { kind: 'match', row: mp };
  const ca = await must(sb.from('comp_accounts').select('*').eq('account_number', n).maybeSingle());
  if (ca) return { kind: 'competition', row: ca };
  return null;
}

async function loadAccount(sb, number) {
  const found = await findAccount(sb, number);
  if (!found) return null;
  if (found.kind === 'match') {
    const mp = found.row;
    const [match, player, tradeRows, events] = await Promise.all([
      must(sb.from('matches').select('id, mode, status, room_code, instruments, instrument_1, instrument_2, start_time, end_time, created_at').eq('id', mp.match_id).maybeSingle()),
      must(sb.from('players').select('id, username, tier').eq('id', mp.player_id).maybeSingle()),
      must(sb.from('trades').select('*').eq('match_id', mp.match_id).eq('player_id', mp.player_id).order('opened_at', { ascending: true })),
      must(sb.from('match_events').select('*').eq('match_id', mp.match_id).eq('player_id', mp.player_id).order('id', { ascending: true }).limit(5000)).catch(() => []),
    ]);
    const trades = (tradeRows || []).map(warTradeRow);
    const s = mp.summary || {};
    const curve = Array.isArray(mp.equity_curve) ? mp.equity_curve : null;
    return {
      kind: 'match',
      accountNumber: Number(mp.account_number),
      player,
      match,
      finalRank: mp.final_rank,
      endReason: mp.end_reason,
      trades,
      curve,
      events: events || [],
      summary: summarize({
        trades,
        startingCapital: s.startingCapital || STARTING_CAPITAL,
        closing: mp.summary ? s : null,
        curve,
        extra: {
          cardsReceived: s.cardsReceived ?? null,
          cardsPlayed: mp.cards_played ?? s.cardsPlayed ?? null,
          missionsCompleted: s.missionsCompleted ?? null,
          heat: s.heat ?? null,
          lateEntry: false,
          finalPnl: mp.final_pnl == null ? null : Number(mp.final_pnl),
          offlineSeconds: s.offlineSeconds ?? null,
          eliminatedRound: s.eliminatedRound ?? null,
        },
      }),
    };
  }
  const ca = found.row;
  const [competition, player, positions, snaps, events] = await Promise.all([
    must(sb.from('competitions').select('id, title, status, instruments, starts_at, ends_at, replay_speed, data_window_start, sponsor_id').eq('id', ca.competition_id).maybeSingle()),
    must(sb.from('players').select('id, username, tier').eq('id', ca.player_id).maybeSingle()),
    must(sb.from('comp_positions').select('*').eq('account_id', ca.id).order('opened_at', { ascending: true })),
    must(sb.from('comp_equity_snapshots').select('ts, equity').eq('account_id', ca.id).order('ts', { ascending: true }).limit(5000)),
    must(sb.from('match_events').select('*').eq('competition_id', ca.competition_id).eq('player_id', ca.player_id).order('id', { ascending: true }).limit(5000)).catch(() => []),
  ]);
  const trades = (positions || []).map(compTradeRow);
  const start = Number(ca.starting_capital) || STARTING_CAPITAL;
  const curve = (snaps || []).map((x) => ({ t: x.ts, equity: Number(x.equity) }));
  const equity = Number(ca.equity);
  return {
    kind: 'competition',
    accountNumber: Number(ca.account_number),
    player,
    competition,
    finalRank: ca.final_rank,
    endReason: ca.status,
    trades,
    curve,
    events: events || [],
    summary: summarize({
      trades,
      startingCapital: start,
      closing: { equity: r2(equity), margin: null, freeMargin: null, marginLevel: null, floatingPnl: r2(equity - Number(ca.balance)) },
      curve: curve.length ? [{ t: competition && competition.starts_at, equity: start }, ...curve] : null,
      extra: { cardsReceived: null, cardsPlayed: null, lateEntry: false, finalPnl: ca.final_pnl == null ? null : Number(ca.final_pnl) },
    }),
  };
}

// Every account a player has held, newest first.
async function listAccounts(sb, playerId, { limit = 200 } = {}) {
  const [seats, comps] = await Promise.all([
    must(sb.from('match_players').select('account_number, final_rank, final_pnl, match:matches(id, mode, status, created_at)').eq('player_id', playerId).not('account_number', 'is', null).limit(limit)),
    must(sb.from('comp_accounts').select('account_number, final_rank, final_pnl, status, created_at, competition:competitions(id, title)').eq('player_id', playerId).not('account_number', 'is', null).limit(limit)),
  ]);
  const rows = [
    ...(seats || []).map((s) => ({ accountNumber: Number(s.account_number), kind: 'match', mode: s.match && s.match.mode, matchId: s.match && s.match.id, status: s.match && s.match.status, date: s.match && s.match.created_at, rank: s.final_rank, pnl: s.final_pnl == null ? null : Number(s.final_pnl) })),
    ...(comps || []).map((c) => ({ accountNumber: Number(c.account_number), kind: 'competition', mode: c.competition && c.competition.title, competitionId: c.competition && c.competition.id, status: c.status, date: c.created_at, rank: c.final_rank, pnl: c.final_pnl == null ? null : Number(c.final_pnl) })),
  ];
  return rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

module.exports = {
  STARTING_CAPITAL,
  MT5_COLUMNS,
  warTradeRow,
  compTradeRow,
  summarize,
  maxDrawdown,
  modificationLog,
  tradesCsv,
  findAccount,
  loadAccount,
  listAccounts,
};
