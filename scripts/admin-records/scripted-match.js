'use strict';

// Records end to end on a real match (dev database, local servers):
// a Solo match with an open, two SL/TP changes, a partial close, two closes,
// ended through the admin bridge; then the database, the admin record APIs,
// the MT5 CSV, the signed PDF (and a tampered copy) and the player's own-only
// view are checked against the trades as recorded.
//
//   GAME=http://localhost:3070 ADMIN=http://localhost:3071 ACCTS=... \
//   SMOKE_ADMIN_USER=... SMOKE_ADMIN_PASS=... node scripts/admin-records/scripted-match.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const io = require('socket.io-client');
const { createClient } = require('@supabase/supabase-js');

const GAME = process.env.GAME || 'http://localhost:3070';
const ADMIN = process.env.ADMIN || 'http://localhost:3071';
const accts = require(process.env.ACCTS);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round(x * 100) / 100;

async function api(base, p, { method = 'GET', body, token, cookie, raw } = {}) {
  const res = await fetch(base + p, { method, headers: { 'content-type': raw ? 'application/pdf' : 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) });
  return res;
}
const json = async (res) => res.json().catch(() => null);

(async () => {
  const login = async (a) => json(await api(GAME, '/api/auth/login', { method: 'POST', body: { username: a.username, password: a.password } }));
  const A = await login(accts[0]);
  const B = await login(accts[1]);
  const made = await json(await api(GAME, '/api/match/create', { method: 'POST', body: { mode: 'solo' }, token: A.token }));
  const matchId = made.matchId;
  if (!matchId) throw new Error(`create failed: ${JSON.stringify(made)}`);
  const s = io(GAME, { auth: { token: A.token }, transports: ['websocket'] });
  let accountFromSocket = null;
  s.on('account:number', (d) => { accountFromSocket = d.accountNumber; });
  // The game screen reads its own seat from match:state (publicPlayer, self only).
  let accountFromState = null;
  s.on('match:state', (st) => { const me = (st.players || []).find((p) => p.id === st.you); if (me && me.accountNumber) accountFromState = me.accountNumber; });
  await new Promise((r, j) => { s.on('connect', r); s.on('connect_error', (e) => j(new Error(`socket: ${e.message}`))); setTimeout(() => j(new Error('socket did not connect')), 10000); });
  console.log('  socket connected');
  const emit = (ev, data) => new Promise((r) => {
    const t = setTimeout(() => { console.log(`  (no reply to ${ev})`); r({ success: false, error: `no reply to ${ev}` }); }, 8000);
    s.emit(ev, data, (x) => { clearTimeout(t); r(x); });
  });
  console.log('  join', JSON.stringify(await emit('player:join', { matchId })).slice(0, 120));
  console.log('  start', JSON.stringify(await emit('lobby:start_war', {})).slice(0, 120));
  let m;
  for (let i = 0; i < 40; i++) { m = await json(await api(GAME, `/api/match/${matchId}`)); if (m.status === 'active') break; await sleep(1000); }
  ok('scripted Solo match is live', m.status === 'active', `${matchId} ${m.instruments.join(',')}`);
  const [sym0, sym1] = m.instruments;

  const o1 = await emit('trade:open', { symbol: sym0, direction: 'BUY', lots: 0.5 });
  const pos = o1.position;
  const pip = Math.abs(pos.entryPrice) * 0.002;
  const m1 = await emit('trade:modify', { positionId: pos.id, stopLoss: Number((pos.entryPrice - pip).toPrecision(8)), takeProfit: Number((pos.entryPrice + pip).toPrecision(8)) });
  await sleep(1500);
  const m2 = await emit('trade:modify', { positionId: pos.id, takeProfit: null });
  await sleep(1200);
  const p1 = await emit('trade:close_partial', { positionId: pos.id, percentage: 50 });
  await sleep(1500);
  const c1 = await emit('trade:close', { positionId: pos.id });
  const o2 = await emit('trade:open', { symbol: sym1 || sym0, direction: 'SELL', lots: 0.3 });
  await sleep(2000);
  const c2 = await emit('trade:close', { positionId: o2.position.id });
  ok('trades placed through the real game', [o1, m1, m2, p1, c1, o2, c2].every((x) => x && x.success), [o1, m1, m2, p1, c1, o2, c2].map((x) => (x && x.success ? 'ok' : x && x.error)).join(','));
  const pnls = [p1.pnl, c1.pnl, c2.pnl];

  // end it through the admin bridge, as an admin "End now" would
  const end = await fetch(`${GAME}/internal/admin/matches/${matchId}/force-end`, { method: 'POST', headers: { 'x-internal-secret': process.env.INTERNAL_ADMIN_SECRET || '' } });
  ok('match ended', end.ok, String(end.status));
  await sleep(6000); // event log flush (2 s) + result writes
  s.close();

  // ---- database ------------------------------------------------------------
  const { data: mp } = await sb.from('match_players').select('*').eq('match_id', matchId).eq('player_id', accts[0].playerId).single();
  const acct = Number(mp.account_number);
  ok('seat has an 8-digit account number', acct >= 10000000 && acct <= 99999999, String(acct));
  ok('the game screen gets its account number (match state)', accountFromState === acct, `state ${accountFromState}, push ${accountFromSocket}`);
  const { data: trades } = await sb.from('trades').select('*').eq('match_id', matchId).eq('player_id', accts[0].playerId).order('ticket');
  ok('3 trade rows (partial, rest, second trade) with ticket, deal, reason, account', trades.length === 3 && trades.every((t) => t.ticket && t.deal && t.close_reason && Number(t.account_number) === acct && t.data_open_s != null && t.data_close_s != null && !t.backfilled), JSON.stringify(trades.map((t) => [t.ticket, t.deal, t.close_reason, t.data_open_s, t.data_close_s])));
  const recorded = trades.map((t) => Number(t.pnl)).sort((a, b) => a - b);
  ok('recorded P&L equals what the game returned', JSON.stringify(recorded) === JSON.stringify(pnls.map(Number).sort((a, b) => a - b)), `${recorded} vs ${pnls}`);
  const partial = trades.find((t) => t.close_reason === 'partial');
  ok('partial close keeps the SL it had and its comment', partial && partial.comment === 'partial close 50%' && partial.stop_loss != null, JSON.stringify(partial && [partial.comment, partial.stop_loss, partial.take_profit]));
  const { data: events } = await sb.from('match_events').select('*').eq('match_id', matchId).order('id');
  const kinds = events.map((e) => e.kind);
  const need = ['start', 'join', 'order_open', 'sltp', 'close', 'end'];
  ok('event log has every step', need.every((k) => kinds.includes(k)) && kinds.filter((k) => k === 'sltp').length === 2 && kinds.filter((k) => k === 'close').length >= 3, kinds.join(','));
  const ordered = events.every((e, i) => i === 0 || Date.parse(e.real_at) >= Date.parse(events[i - 1].real_at) - 5);
  ok('events carry real and market time, in order', ordered && events.filter((e) => e.kind !== 'join').every((e) => e.data_s != null), `${events.length} events`);
  const sl = events.filter((e) => e.kind === 'sltp');
  ok('SL/TP changes keep before and after and who', sl[0].payload.before.sl === null && sl[0].payload.after.sl != null && sl[1].payload.after.tp === null && sl.every((e) => e.payload.by === 'player'), JSON.stringify(sl.map((e) => e.payload)));
  ok('closing figures and equity curve stored', mp.summary && mp.summary.equity != null && 'marginLevel' in mp.summary && Array.isArray(mp.equity_curve) && mp.equity_curve.length > 2, `curve ${mp.equity_curve && mp.equity_curve.length} points`);

  // ---- admin record APIs ----------------------------------------------------------
  const lr = await api(ADMIN, '/api/auth/login', { method: 'POST', body: { username: process.env.SMOKE_ADMIN_USER, password: process.env.SMOKE_ADMIN_PASS } });
  const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
  const detail = await json(await api(ADMIN, `/api/records/match/${matchId}`, { cookie }));
  ok('admin match detail reads the event log', detail.timelineSource === 'event_log' && detail.standings.some((x) => x.accountNumber === acct), `${detail.timeline.length} events`);
  const a = await json(await api(ADMIN, `/api/records/account/${acct}`, { cookie }));
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const gp = wins.reduce((x, y) => x + y, 0);
  const gl = losses.reduce((x, y) => x + y, 0);
  const hand = { net: r2(gp + gl), pf: gl < 0 ? r2(gp / -gl) : null, wr: r2((wins.length / pnls.length) * 100) };
  ok('summary matches hand-computed figures', a.summary.netProfit === hand.net && a.summary.profitFactor === hand.pf && a.summary.winRate === hand.wr && a.summary.trades === 3, `net ${a.summary.netProfit}/${hand.net} pf ${a.summary.profitFactor}/${hand.pf} win ${a.summary.winRate}/${hand.wr}`);
  ok('modification log shows both changes by the player', a.modifications.length === 2 && a.modifications.every((x) => x.by === 'player'));
  ok('final P&L on the seat equals net profit', r2(Number(mp.final_pnl)) === hand.net, `${mp.final_pnl} vs ${hand.net}`);
  const csv = await (await api(ADMIN, `/api/records/account/${acct}/trades.csv`, { cookie })).text();
  ok('CSV in MT5 column order', csv.startsWith('Time,Position,Symbol,Type,Volume,Price,S / L,T / P,Time,Price,Commission,Swap,Profit') && csv.trim().split('\r\n').length === 4);
  const pdfRes = await api(ADMIN, `/api/records/account/${acct}/statement`, { method: 'POST', cookie });
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  const sha = pdfRes.headers.get('x-statement-sha256');
  ok('PDF statement issued', pdf.slice(0, 8).toString() === '%PDF-1.4' && /^[0-9a-f]{64}$/.test(sha || ''), `${pdf.length} bytes`);
  const v1 = await json(await api(ADMIN, '/api/records/statements/verify', { method: 'POST', cookie, raw: pdf }));
  const bad = Buffer.from(pdf); bad[300] ^= 1;
  const v2 = await json(await api(ADMIN, '/api/records/statements/verify', { method: 'POST', cookie, raw: bad }));
  ok('statement verifies; a changed copy does not', v1.genuine === true && v1.accountNumber === acct && v2.genuine === false, `${v1.genuine}/${v2.genuine}`);
  const flag = await api(ADMIN, '/api/records/flags', { method: 'POST', cookie, body: { targetType: 'trade', targetId: String(trades[0].ticket), note: 'scripted test flag', matchId } });
  ok('dispute flag recorded', flag.ok);

  // ---- player's own view ----------------------------------------------------------
  const mine = await api(GAME, `/api/records/mine/${acct}`, { token: A.token });
  const theirs = await api(GAME, `/api/records/mine/${acct}`, { token: B.token });
  const minePdf = await api(GAME, `/api/records/mine/${acct}/statement.pdf`, { token: A.token });
  ok('player sees only their own account', mine.status === 200 && theirs.status === 404 && minePdf.status === 200, `${mine.status}/${theirs.status}/${minePdf.status}`);
  const mj = await json(mine);
  ok('player view hides internal ids', !JSON.stringify(mj).includes('positionRef') && !JSON.stringify(mj).includes('attackerId'));

  // ---- the record pages change nothing ----------------------------------------------
  const before = JSON.stringify((await sb.from('trades').select('id, pnl, exit_price, closed_at').eq('match_id', matchId).order('id')).data);
  for (const p of [`/api/records/match/${matchId}`, `/api/records/match/${matchId}/chart`, `/api/records/match/${matchId}/timeline.json`, `/api/records/account/${acct}`]) await api(ADMIN, p, { cookie });
  const after = JSON.stringify((await sb.from('trades').select('id, pnl, exit_price, closed_at').eq('match_id', matchId).order('id')).data);
  ok('reading the records leaves trades unchanged', before === after);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed  (match ${matchId}, account ${acct})`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
