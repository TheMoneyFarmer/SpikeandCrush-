'use strict';

// One process of virtual players. Each does what the real pages do: load the lobby
// and keep polling it, connect a socket, join a match, fetch the chart, trade until
// the match ends, then play again. Some also hold a competition account.
const { io } = require('socket.io-client');

const BASE = process.env.TARGET;
const MODES = [['blitz', 0.7], ['quick', 0.2], ['solo', 0.1]];
const COMPETITION_SHARE = 0.2;
const STATS_POLL_MS = 15000;
const SLOW_POLL_MS = 60000;
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let samples = {};
let counts = {};
const sample = (label, ms) => (samples[label] = samples[label] || []).push(Math.round(ms));
const count = (label, n = 1) => { counts[label] = (counts[label] || 0) + n; };
setInterval(() => {
  process.send({ type: 'metrics', samples, counts, active: players.size, connected: [...players].filter((p) => p.socket?.connected).length });
  samples = {};
  counts = {};
}, 2000);

async function http(path, opts = {}, player, label) {
  const name = label || path.split('?')[0];
  const started = Date.now();
  try {
    const res = await fetch(BASE + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(player && opts.auth !== false ? { Authorization: `Bearer ${player.account.token}` } : {}) },
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    sample(`http ${name}`, Date.now() - started);
    if (!res.ok) count(`error ${name} ${res.status}`);
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, body };
  } catch (e) {
    count(`error ${name} ${e.name === 'TimeoutError' ? 'timeout' : e.message.slice(0, 40)}`);
    return { status: 0, body: null };
  }
}

function emitAck(player, event, data, label) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setTimeout(() => { count(`error ${label} no reply`); resolve(null); }, 15000);
    player.socket.emit(event, data, (res) => {
      clearTimeout(timer);
      sample(label, Date.now() - started);
      resolve(res);
    });
  });
}

const players = new Set();

// Node's fetch can throw setTypeOfService EINVAL from a dying socket, outside any
// promise. That's the test client's problem, not the server's: count it, carry on.
process.on('uncaughtException', (e) => count(`client ${e.code || e.message.slice(0, 30)}`));

function loadLobby(player) {
  http('/api/lobby/stats', {}, player);
  http('/api/lobby/me', {}, player);
  http('/api/competitions', {}, player);
  http('/api/competitions-mine', {}, player);
  http('/api/leaderboard?limit=10', {}, player);
  http('/api/stats/activity', {}, player);
  http('/api/announcements/active', {}, player);
}

function pickMode() {
  let roll = Math.random();
  for (const [mode, share] of MODES) { if ((roll -= share) < 0) return mode; }
  return 'blitz';
}

async function playOneMatch(player) {
  const mode = pickMode();
  const created = await http('/api/match/create', { method: 'POST', body: JSON.stringify({ mode }) }, player);
  if (!created.body?.matchId) { await sleep(rand(5000, 15000)); return; }
  const matchId = created.body.matchId;
  const joined = await emitAck(player, 'player:join', { matchId }, 'socket player:join');
  if (!joined?.success) { count(`error join ${joined?.error || 'none'}`); await sleep(5000); return; }

  const state = { started: false, ended: false, instruments: [], lastPrice: 0, positions: [] };
  const onState = (s) => { if (s?.instruments?.length) state.instruments = s.instruments; };
  const onStart = () => { state.started = true; count('match started'); };
  const onEnd = () => { state.ended = true; count('match finished'); };
  const onVoided = () => { state.ended = true; count('match voided'); };
  const onPrice = (d) => {
    const now = Date.now();
    if (state.lastPrice) {
      const gap = now - state.lastPrice;
      sample('price update gap', gap);
      if (gap > 2500) count('late price update');
    }
    state.lastPrice = now;
    count('price updates');
    if (d?.prices && !state.instruments.length) state.instruments = Object.keys(d.prices);
  };
  const s = player.socket;
  // The game screen rejoins its match whenever the connection comes back.
  const onReconnect = () => { emitAck(player, 'player:join', { matchId }, 'socket rejoin'); };
  s.on('connect', onReconnect);
  s.on('match:state', onState); s.on('match:start', onStart); s.on('match:end', onEnd); s.on('match:voided', onVoided); s.on('price:update', onPrice);
  try {
    http(`/api/match/${matchId}/history`, {}, player, '/api/match/:id/history');
    await sleep(rand(2000, 6000));
    s.emit('player:forceStart', {}, () => {});
    const waited = Date.now();
    while (!state.started && !state.ended && Date.now() - waited < 60000) await sleep(300);
    if (!state.started) { count('error match never started'); return; }
    sample('match start wait', Date.now() - waited);
    while (!state.ended && player.running) {
      await sleep(rand(8000, 20000));
      if (state.ended || !state.instruments.length) continue;
      if (state.positions.length && Math.random() < 0.5) {
        const res = await emitAck(player, 'trade:close', { positionId: state.positions.shift() }, 'socket trade:close');
        if (res && !res.success) count(`refused close: ${String(res.error).slice(0, 40)}`);
      } else {
        const symbol = state.instruments[Math.floor(Math.random() * state.instruments.length)];
        const res = await emitAck(player, 'trade:open', { symbol, direction: Math.random() < 0.5 ? 'BUY' : 'SELL', lots: 1 }, 'socket trade:open');
        const id = res?.position?.id || res?.positionId;
        if (res?.success && id) state.positions.push(id);
        else if (res && !res.success) count(`refused open: ${String(res.error).slice(0, 40)}`);
      }
    }
  } finally {
    s.off('connect', onReconnect);
    s.off('match:state', onState); s.off('match:start', onStart); s.off('match:end', onEnd); s.off('match:voided', onVoided); s.off('price:update', onPrice);
  }
}

async function competitionLoop(player) {
  const { body } = await http('/api/competitions', {}, player);
  const live = (body?.competitions || []).filter((c) => c.status === 'active' && c.type === 'native' && c.frequency);
  if (!live.length) return;
  const comp = live[Math.floor(Math.random() * live.length)];
  const entered = await http(`/api/competitions/${comp.id}/enter`, { method: 'POST' }, player, '/api/competitions/:id/enter');
  if (entered.status !== 200) return;
  const symbol = comp.instruments?.[0];
  if (symbol) {
    const opened = await http(`/api/competitions/${comp.id}/trade/open`, { method: 'POST', body: JSON.stringify({ symbol, side: 'BUY', lots: 0.1 }) }, player, '/api/competitions/:id/trade/open');
    if (opened.status === 200) count('competition trade');
  }
  while (player.running) {
    await sleep(rand(12000, 18000));
    http(`/api/competitions/${comp.id}/account`, {}, player, '/api/competitions/:id/account');
    http(`/api/competitions/${comp.id}/leaderboard`, {}, player, '/api/competitions/:id/leaderboard');
  }
}

function connect(player) {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = io(BASE, { auth: { token: player.account.token }, reconnection: false, timeout: 45000 });
    player.socket = s;
    s.once('connect', () => { sample('socket connect', Date.now() - started); resolve(true); });
    s.once('connect_error', (e) => { count(`error socket connect ${e.message.slice(0, 30)}`); resolve(false); });
  });
}

async function runPlayer(account) {
  const player = { account, running: true, timers: [] };
  players.add(player);
  loadLobby(player);
  player.timers.push(setInterval(() => http('/api/lobby/stats', {}, player), STATS_POLL_MS * rand(0.9, 1.1)));
  player.timers.push(setInterval(() => { http('/api/competitions', {}, player); http('/api/competitions-mine', {}, player); http('/api/leaderboard?limit=10', {}, player); http('/api/stats/activity', {}, player); }, SLOW_POLL_MS * rand(0.9, 1.1)));
  if (!(await connect(player))) { stopPlayer(player); return; }
  if (Math.random() < COMPETITION_SHARE) competitionLoop(player).catch((e) => count(`error competition ${e.message.slice(0, 30)}`));
  while (player.running) {
    if (!player.socket.connected) { if (!(await connect(player))) { await sleep(5000); continue; } }
    await playOneMatch(player).catch((e) => count(`error match loop ${e.message.slice(0, 40)}`));
    await sleep(rand(5000, 15000));
  }
}

function stopPlayer(player) {
  player.running = false;
  player.timers.forEach(clearInterval);
  player.socket?.disconnect();
  players.delete(player);
}

// Everyone's connection drops at once and comes back, as after a network blip.
function reconnectStorm() {
  for (const p of players) p.socket?.disconnect();
  for (const p of players) {
    const started = Date.now();
    p.socket.connect();
    p.socket.once('connect', () => sample('storm reconnect', Date.now() - started));
    p.socket.once('connect_error', (e) => count(`error storm ${e.message.slice(0, 30)}`));
  }
}

const queue = [];
process.on('message', (m) => {
  if (m.type === 'accounts') queue.push(...m.accounts);
  if (m.type === 'target') {
    let need = m.count - players.size;
    const spawn = setInterval(() => {
      if (need <= 0 || !queue.length) return clearInterval(spawn);
      need--;
      runPlayer(queue.shift()).catch((e) => count(`error player ${e.message.slice(0, 40)}`));
    }, m.spawnEveryMs);
  }
  if (m.type === 'storm') reconnectStorm();
  if (m.type === 'stop') { for (const p of [...players]) stopPlayer(p); setTimeout(() => process.exit(0), 500); }
});
process.send({ type: 'ready' });
