'use strict';

// Admin records: match detail (standings, event timeline, chart data),
// competition detail, MT5-style account histories, CSV/JSON exports, PDF
// statements, dispute flags and a player's account list.
//
// Read-only towards matches and trades: the only writes here are a dispute
// flag, a statement record and a support-ticket link, never match state.

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { audit } = require('../lib/audit');
const records = require('../../server/records');
const statements = require('../../server/statementPdf');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCT_RE = /^\d{8}$/;
const TIMELINE_LIMIT = 5000;

const r2 = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 100) / 100);

async function must(q) {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
// A table that doesn't exist yet (records migration not run) reads as empty.
async function optional(q) {
  const { data, error } = await q;
  if (error) {
    if (/does not exist|schema cache|column/i.test(error.message || '')) return null;
    throw error;
  }
  return data;
}

function matchInstruments(m) {
  if (Array.isArray(m.instruments) && m.instruments.length) return m.instruments;
  return [m.instrument_1, m.instrument_2].filter(Boolean);
}

// One readable line per event (admins read this; it never reaches players).
function describe(e, nameOf) {
  const p = e.payload || {};
  const who = nameOf(e.player_id) || 'system';
  const n = (x) => (x == null ? '-' : x);
  switch (e.kind) {
    case 'join': return `${who} joined (account ${n(p.accountNumber)})`;
    case 'start': return `Match started: ${(p.instruments || []).join(', ')} at market x${n(p.replaySpeed)}`;
    case 'end': return 'Match ended';
    case 'order_open': return `${who} opened ${String(p.side || '').toLowerCase()} ${n(p.lots)} ${n(p.symbol)} @ ${n(p.price)}${p.sl != null ? ` SL ${p.sl}` : ''}${p.tp != null ? ` TP ${p.tp}` : ''}${p.byCard ? ` (forced by card ${p.byCard} from ${nameOf(p.attackerId) || 'opponent'})` : ''}${p.slippage ? ` slippage ${p.slippage}` : ''}`;
    case 'close': return `${who} closed ${p.reason === 'partial' ? `${n(p.pct)}% of ` : ''}${String(p.side || '').toLowerCase()} ${n(p.lots)} ${n(p.symbol)} @ ${n(p.price)}: ${p.pnl >= 0 ? '+' : ''}${n(r2(p.pnl))} (${n(p.reason)})`;
    case 'sltp': return `${who} ${p.symbol || ''} SL ${n(p.before && p.before.sl)} -> ${n(p.after && p.after.sl)}, TP ${n(p.before && p.before.tp)} -> ${n(p.after && p.after.tp)} by ${p.by === 'card' ? `card ${p.card} (${nameOf(p.attackerId) || 'opponent'})` : p.by || 'player'}`;
    case 'card': return `${nameOf(p.attacker) || who} played ${n(p.card)}${p.target ? ` on ${nameOf(p.target) || 'a player'}` : ''}${p.amount != null ? ` amount ${p.amount}` : ''}${p.amounts ? ` ${JSON.stringify(p.amounts)}` : ''}${p.targetEquityBefore != null ? ` (target equity ${p.targetEquityBefore} -> ${p.targetEquityAfter})` : ''}`;
    case 'spike_alert': return `Spike alert${p.inSeconds ? ` in ${p.inSeconds}s` : ''}`;
    case 'spike_result': return `Spike landed${p.movePct != null ? ` ${p.movePct}%` : ''}${p.symbol ? ` on ${p.symbol}` : ''}`;
    case 'disconnect': return `${who} lost connection`;
    case 'reconnect': return `${who} reconnected after ${n(p.offlineSeconds)}s`;
    case 'elimination': return `${who} eliminated in round ${n(p.round)} at equity ${n(p.equity)}`;
    case 'mission': return `${who} completed mission ${n(p.label || p.mission)} (+${n(p.coins)} coins)`;
    case 'loss_limit': return `${who} hit the loss limit (equity ${n(p.equity)})`;
    case 'leave': return `${who} left the match (${n(p.reason)})`;
    default: return `${e.kind}`;
  }
}

// Older matches (before the event log existed): a timeline rebuilt from
// trades and card plays, marked as such.
function fallbackTimeline(trades, cards) {
  const out = [];
  for (const t of trades) {
    out.push({ id: `t${t.id}o`, kind: 'order_open', player_id: t.player_id, real_at: t.opened_at, data_s: t.data_open_s ?? null, position_ref: t.position_ref || t.id, payload: { symbol: t.symbol, side: t.direction, lots: Number(t.lots), price: Number(t.entry_price), sl: t.stop_loss ?? null, tp: t.take_profit ?? null }, rebuilt: true });
    if (t.closed_at) out.push({ id: `t${t.id}c`, kind: 'close', player_id: t.player_id, real_at: t.closed_at, data_s: t.data_close_s ?? null, position_ref: t.position_ref || t.id, payload: { symbol: t.symbol, side: t.direction, lots: Number(t.lots), price: Number(t.exit_price), pnl: Number(t.pnl), reason: t.close_reason || 'unknown' }, rebuilt: true });
  }
  for (const c of cards) out.push({ id: `c${c.id}`, kind: 'card', player_id: c.player_id, real_at: c.played_at, data_s: null, payload: { attacker: c.player_id, target: c.target_player_id, card: c.card_type }, rebuilt: true });
  return out.sort((a, b) => new Date(a.real_at) - new Date(b.real_at));
}

const csvCell = (v) => {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function loadMatchDetail(id) {
  const match = await must(supabase.from('matches').select('*').eq('id', id).maybeSingle());
  if (!match) return null;
  const [mps, trades, cards, events, stats, replay, flags, reports] = await Promise.all([
    must(supabase.from('match_players').select('*, player:players(id, username, tier, is_persona)').eq('match_id', id)),
    must(supabase.from('trades').select('*').eq('match_id', id).order('opened_at', { ascending: true }).limit(10000)),
    must(supabase.from('sabotage_events').select('id, player_id, target_player_id, card_type, played_at').eq('match_id', id).order('played_at')),
    optional(supabase.from('match_events').select('*').eq('match_id', id).order('id', { ascending: true }).limit(TIMELINE_LIMIT)),
    optional(supabase.from('match_market_stats').select('symbol, curated, start_offset, replay_speed, changes_per_min, longest_flat_seconds, range_bps').eq('match_id', id)),
    must(supabase.from('replays').select('match_id').eq('match_id', id).maybeSingle()),
    optional(supabase.from('record_flags').select('*').eq('match_id', id).order('created_at', { ascending: false })),
    must(supabase.from('player_reports').select('id, reporter_id, reported_player_id, reason, status, created_at').eq('match_id', id)),
  ]);
  const names = new Map((mps || []).map((r) => [r.player_id, r.player ? r.player.username : null]));
  const nameOf = (pid) => (pid ? names.get(pid) || null : null);

  const byPlayer = new Map();
  for (const t of trades || []) {
    if (!byPlayer.has(t.player_id)) byPlayer.set(t.player_id, []);
    byPlayer.get(t.player_id).push(records.warTradeRow(t));
  }
  const evs = events && events.length ? events : fallbackTimeline(trades || [], cards || []);
  const startEvent = evs.find((e) => e.kind === 'start');
  const standings = (mps || []).map((mp) => {
    const tr = byPlayer.get(mp.player_id) || [];
    const curve = Array.isArray(mp.equity_curve) ? mp.equity_curve : null;
    const s = records.summarize({ trades: tr, curve, closing: mp.summary || null });
    const sum = mp.summary || {};
    return {
      rank: mp.final_rank,
      playerId: mp.player_id,
      handle: nameOf(mp.player_id),
      computer: Boolean(mp.player && mp.player.is_persona),
      accountNumber: mp.account_number ? Number(mp.account_number) : null,
      tier: mp.player ? mp.player.tier : null,
      finalEquity: mp.final_pnl == null ? null : r2(10000 + Number(mp.final_pnl)),
      pnl: mp.final_pnl == null ? null : Number(mp.final_pnl),
      maxDrawdown: s.maxDrawdown,
      trades: tr.length,
      winRate: s.winRate,
      cardsEarned: sum.cardsReceived ?? null,
      cardsPlayed: mp.cards_played ?? 0,
      missions: sum.missionsCompleted ?? null,
      heat: sum.heat ?? null,
      lateEntry: false,
      offlineSeconds: sum.offlineSeconds ?? null,
      eliminatedRound: sum.eliminatedRound ?? null,
      endReason: mp.end_reason || null,
    };
  }).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));

  return {
    kind: 'match',
    match: {
      id: match.id, mode: match.mode, status: match.status, roomCode: match.room_code, instruments: matchInstruments(match),
      createdAt: match.created_at, startTime: match.start_time, endTime: match.end_time,
      replaySpeed: (startEvent && startEvent.payload && startEvent.payload.replaySpeed) || (stats && stats[0] && stats[0].replay_speed) || 1,
      marketSeed: startEvent && startEvent.payload ? startEvent.payload.marketSeed ?? null : null,
      market: (stats || []).map((s) => ({ symbol: s.symbol, curated: s.curated, startOffset: s.start_offset, replaySpeed: s.replay_speed, changesPerMin: s.changes_per_min, longestFlatSeconds: s.longest_flat_seconds, rangeBps: s.range_bps })),
      winnerId: match.winner_id,
    },
    standings,
    timeline: evs.map((e) => ({ id: e.id, kind: e.kind, realAt: e.real_at, dataS: e.data_s == null ? null : Number(e.data_s), playerId: e.player_id, handle: nameOf(e.player_id), positionRef: e.position_ref || null, text: describe(e, nameOf), payload: e.payload, rebuilt: Boolean(e.rebuilt) })),
    timelineSource: events && events.length ? 'event_log' : 'rebuilt_from_trades',
    timelineTruncated: Boolean(events && events.length >= TIMELINE_LIMIT),
    hasReplay: Boolean(replay),
    flags: flags || [],
    reports: reports || [],
    recordsReady: events !== null,
  };
}

function router() {
  const r = express.Router();
  r.use((req, res, next) => (isConfigured ? next() : res.status(503).json({ error: 'Supabase not configured' })));

  r.get('/match/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Match not found' });
    try {
      const d = await loadMatchDetail(req.params.id);
      if (!d) return res.status(404).json({ error: 'Match not found' });
      res.json(d);
    } catch (e) {
      console.error('[records match]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // Timeline export: every event, data time and real time side by side.
  r.get('/match/:id/timeline.:fmt(csv|json)', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Match not found' });
    try {
      const d = await loadMatchDetail(req.params.id);
      if (!d) return res.status(404).json({ error: 'Match not found' });
      const name = `match-${d.match.roomCode || d.match.id}-timeline`;
      if (req.params.fmt === 'json') {
        res.setHeader('Content-Disposition', `attachment; filename="${name}.json"`);
        return res.json({ match: d.match, standings: d.standings, timeline: d.timeline, source: d.timelineSource });
      }
      const lines = [['id', 'real_time', 'data_seconds', 'kind', 'player', 'position', 'text', 'payload'].join(',')];
      for (const e of d.timeline) lines.push([e.id, e.realAt, e.dataS, e.kind, e.handle, e.positionRef, e.text, e.payload].map(csvCell).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
      res.send(`${lines.join('\r\n')}\r\n`);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Prices the match actually showed (from its replay) plus every trade, for
  // the detail chart. t = seconds since the match started.
  r.get('/match/:id/chart', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Match not found' });
    try {
      const [match, replay, trades] = await Promise.all([
        must(supabase.from('matches').select('id, start_time, created_at').eq('id', req.params.id).maybeSingle()),
        must(supabase.from('replays').select('price_data').eq('match_id', req.params.id).maybeSingle()),
        must(supabase.from('trades').select('player_id, symbol, direction, lots, entry_price, exit_price, pnl, opened_at, closed_at, ticket:ticket, position_ref').eq('match_id', req.params.id).limit(10000)).catch(async () => must(supabase.from('trades').select('player_id, symbol, direction, lots, entry_price, exit_price, pnl, opened_at, closed_at').eq('match_id', req.params.id).limit(10000))),
      ]);
      if (!match) return res.status(404).json({ error: 'Match not found' });
      const start = Date.parse(match.start_time || match.created_at);
      const secs = (iso) => (iso ? Math.round((Date.parse(iso) - start) / 1000) : null);
      const prices = {};
      for (const [sym, pts] of Object.entries((replay && replay.price_data) || {})) {
        const arr = Array.isArray(pts) ? pts : [];
        const step = Math.max(1, Math.ceil(arr.length / 1500));
        prices[sym] = arr.filter((_, i) => i % step === 0 || i === arr.length - 1).map((p) => [p.t, p.mid]);
      }
      res.json({
        prices,
        trades: (trades || []).map((t) => ({ playerId: t.player_id, symbol: t.symbol, type: String(t.direction).toLowerCase(), lots: Number(t.lots), ticket: t.ticket ?? null, openT: secs(t.opened_at), openPrice: Number(t.entry_price), closeT: secs(t.closed_at), closePrice: t.exit_price == null ? null : Number(t.exit_price), pnl: t.pnl == null ? null : Number(t.pnl) })),
        hasPrices: Boolean(replay),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Competition detail: header, standings (paged), recent closes, events.
  r.get('/competition/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Competition not found' });
    try {
      const page = Math.max(0, Number(req.query.page) || 0);
      const comp = await must(supabase.from('competitions').select('id, title, template_key, status, state, instruments, starts_at, ends_at, replay_speed, data_window_start, last_tick_data_time, sponsor_id, entry_fee_coins, is_test, settled_at, sponsor:sponsors(name)').eq('id', req.params.id).maybeSingle());
      if (!comp) return res.status(404).json({ error: 'Competition not found' });
      const [accounts, count, positions, events, flags] = await Promise.all([
        must(supabase.from('comp_accounts').select('*, player:players(username, tier)').eq('competition_id', comp.id).order('final_rank', { ascending: true, nullsFirst: false }).order('equity', { ascending: false }).range(page * 50, page * 50 + 49)),
        supabase.from('comp_accounts').select('id', { count: 'exact', head: true }).eq('competition_id', comp.id),
        must(supabase.from('comp_positions').select('*').eq('competition_id', comp.id).order('opened_at', { ascending: false }).limit(200)),
        optional(supabase.from('match_events').select('*').eq('competition_id', comp.id).order('id', { ascending: false }).limit(1000)),
        optional(supabase.from('record_flags').select('*').eq('competition_id', comp.id).order('created_at', { ascending: false })),
      ]);
      const names = new Map((accounts || []).map((a) => [a.player_id, a.player && a.player.username]));
      const nameOf = (pid) => names.get(pid) || null;
      res.json({
        kind: 'competition',
        competition: { ...comp, sponsorName: comp.sponsor ? comp.sponsor.name : null },
        standings: (accounts || []).map((a, i) => ({
          rank: a.final_rank ?? page * 50 + i + 1, playerId: a.player_id, handle: a.player && a.player.username, tier: a.player && a.player.tier,
          accountNumber: a.account_number ? Number(a.account_number) : null, equity: r2(a.equity), balance: r2(a.balance), pnl: r2(Number(a.equity) - Number(a.starting_capital)),
          trades: a.trade_count, status: a.status, prizeCoins: a.prize_coins,
        })),
        total: count.count || 0,
        page,
        recentTrades: (positions || []).map(records.compTradeRow).map((t, i) => ({ ...t, playerId: positions[i].player_id, handle: nameOf(positions[i].player_id) })),
        timeline: (events || []).map((e) => ({ id: e.id, kind: e.kind, realAt: e.real_at, dataAt: e.data_at, playerId: e.player_id, text: describe(e, nameOf), payload: e.payload })),
        flags: flags || [],
      });
    } catch (e) {
      console.error('[records competition]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ---- account histories --------------------------------------------------
  async function accountOr404(req, res) {
    if (!ACCT_RE.test(req.params.n)) { res.status(404).json({ error: 'Account not found' }); return null; }
    const acct = await records.loadAccount(supabase, req.params.n).catch((e) => {
      if (/account_number|does not exist/.test(e.message || '')) return null;
      throw e;
    });
    if (!acct) { res.status(404).json({ error: 'Account not found' }); return null; }
    return acct;
  }

  r.get('/account/:n', async (req, res) => {
    try {
      const acct = await accountOr404(req, res);
      if (!acct) return;
      const ids = new Set((acct.events || []).map((e) => e.payload && e.payload.attackerId).filter(Boolean));
      const { data: attackers } = ids.size ? await supabase.from('players').select('id, username').in('id', [...ids]) : { data: [] };
      const nm = new Map((attackers || []).map((p) => [p.id, p.username]));
      const [flags, statementsList] = await Promise.all([
        optional(supabase.from('record_flags').select('*').eq('target_type', 'account').eq('target_id', String(acct.accountNumber))),
        optional(supabase.from('account_statements').select('id, sha256, generated_by, created_at').eq('account_number', acct.accountNumber).order('created_at', { ascending: false }).limit(20)),
      ]);
      res.json({
        ...acct,
        events: undefined,
        modifications: records.modificationLog(acct.events, (id) => nm.get(id)),
        flags: flags || [],
        statements: statementsList || [],
      });
    } catch (e) {
      console.error('[records account]', e);
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/account/:n/trades.csv', async (req, res) => {
    try {
      const acct = await accountOr404(req, res);
      if (!acct) return;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="account-${acct.accountNumber}.csv"`);
      res.send(records.tradesCsv(acct.trades));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Regenerate the signed PDF statement (recorded with its hash).
  r.post('/account/:n/statement', async (req, res) => {
    try {
      const acct = await accountOr404(req, res);
      if (!acct) return;
      const { pdf, sha256, statementId } = await statements.issueStatement(supabase, acct, `admin:${req.admin.username}`);
      await audit(req, 'statement_issue', 'account', String(acct.accountNumber), { statementId, sha256 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="statement-${acct.accountNumber}.pdf"`);
      res.setHeader('X-Statement-Sha256', sha256);
      res.send(pdf);
    } catch (e) {
      console.error('[records statement]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // Check a statement someone sent in: by hash, or by uploading the file.
  r.post('/statements/verify', express.raw({ type: 'application/pdf', limit: '5mb' }), async (req, res) => {
    try {
      let sha = String((req.query.sha256 || (req.body && req.body.sha256) || '')).toLowerCase();
      if (Buffer.isBuffer(req.body) && req.body.length) sha = statements.signStatement(req.body).sha256;
      if (!/^[0-9a-f]{64}$/.test(sha)) return res.status(400).json({ error: 'Send the PDF file or its SHA-256' });
      res.json({ sha256: sha, ...(await statements.verifyStatementHash(supabase, sha)) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/player/:id/accounts', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Player not found' });
    try {
      const list = await records.listAccounts(supabase, req.params.id).catch((e) => {
        if (/account_number|does not exist/.test(e.message || '')) return [];
        throw e;
      });
      const closed = list.filter((a) => a.pnl != null);
      res.json({
        accounts: list,
        lifetime: {
          accounts: list.length,
          wins: list.filter((a) => a.rank === 1).length,
          netPnl: r2(closed.reduce((s, a) => s + a.pnl, 0)),
          bestPnl: closed.length ? r2(Math.max(...closed.map((a) => a.pnl))) : null,
          worstPnl: closed.length ? r2(Math.min(...closed.map((a) => a.pnl))) : null,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Handle or account number -> matching accounts (for search boxes).
  r.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ accounts: [], players: [] });
    try {
      if (ACCT_RE.test(q)) {
        const found = await records.findAccount(supabase, q).catch(() => null);
        return res.json({ accounts: found ? [{ accountNumber: Number(q), kind: found.kind, matchId: found.row.match_id || null, competitionId: found.row.competition_id || null, playerId: found.row.player_id }] : [], players: [] });
      }
      const players = await must(supabase.from('players').select('id, username').ilike('username', `%${q.slice(0, 40).replace(/[\\%_]/g, (c) => `\\${c}`)}%`).limit(20));
      res.json({ accounts: [], players: players || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- dispute flags --------------------------------------------------------
  r.post('/flags', express.json(), async (req, res) => {
    try {
      const { targetType, targetId, note, matchId, competitionId } = req.body || {};
      if (!['match', 'trade', 'account', 'competition'].includes(targetType)) return res.status(400).json({ error: 'targetType must be match, trade, account or competition' });
      const text = String(note || '').trim();
      if (!text || text.length > 2000) return res.status(400).json({ error: 'A note (up to 2000 characters) is required' });
      if (!targetId || String(targetId).length > 80) return res.status(400).json({ error: 'targetId is required' });
      const row = {
        target_type: targetType, target_id: String(targetId), note: text, created_by: req.admin.username,
        match_id: matchId && UUID_RE.test(matchId) ? matchId : null,
        competition_id: competitionId && UUID_RE.test(competitionId) ? competitionId : null,
      };
      const data = await must(supabase.from('record_flags').insert(row).select().single());
      await audit(req, 'record_flag', targetType, String(targetId), { note: text, flagId: data.id });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/flags/:id/resolve', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Flag not found' });
    try {
      const data = await must(supabase.from('record_flags').update({ resolved_at: new Date().toISOString() }).eq('id', req.params.id).select().maybeSingle());
      if (!data) return res.status(404).json({ error: 'Flag not found' });
      await audit(req, 'record_flag_resolve', data.target_type, data.target_id, { flagId: data.id });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
module.exports.describe = describe;
module.exports.fallbackTimeline = fallbackTimeline;
