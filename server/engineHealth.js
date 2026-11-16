'use strict';

// Engine health (stall monitoring): price-step lateness per match, how long a
// step takes, event-loop delay, memory, and clients that report missing more
// than 3 seconds of prices. Read by the admin Engine health card through the
// internal bridge (/internal/admin/engine-health). In memory, last 5 minutes.

const { monitorEventLoopDelay } = require('perf_hooks');

const WINDOW_MS = 5 * 60 * 1000;
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

let steps = []; // [atMs, lateMs, tookMs]
const perMatch = new Map(); // matchId -> { steps, lateMax }
const clientGaps = []; // [atMs, playerId, matchId, gapMs]
let lastLoopSample = { p99: 0, max: 0, at: Date.now() };

function prune(now = Date.now()) {
  const cut = now - WINDOW_MS;
  if (steps.length && steps[0][0] < cut) steps = steps.filter((x) => x[0] >= cut);
  while (clientGaps.length && clientGaps[0][0] < cut) clientGaps.shift();
}

function recordStep(matchId, lateMs, tookMs) {
  const now = Date.now();
  steps.push([now, Math.max(0, lateMs), tookMs]);
  const m = perMatch.get(matchId) || { steps: 0, lateMax: 0, at: now };
  m.steps++;
  m.lateMax = Math.max(m.lateMax, lateMs);
  m.at = now;
  perMatch.set(matchId, m);
  if (steps.length > 200000) prune(now);
}

function recordClientGap(playerId, matchId, gapMs) {
  clientGaps.push([Date.now(), playerId, matchId, Math.round(gapMs)]);
  console.warn(`[engine] client missed ${(gapMs / 1000).toFixed(1)}s of prices (player ${playerId}, match ${matchId})`);
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// Sampled every 10 s so the reading covers a stable window.
setInterval(() => {
  lastLoopSample = { p99: loop.percentile(99) / 1e6, max: loop.max / 1e6, at: Date.now() };
  loop.reset();
  const cut = Date.now() - WINDOW_MS;
  for (const [id, m] of perMatch) if (m.at < cut) perMatch.delete(id);
}, 10000).unref();

function snapshot({ redLagMs = Number(process.env.ENGINE_RED_LAG_MS) || 250 } = {}) {
  prune();
  const late = steps.map((x) => x[1]);
  const took = steps.map((x) => x[2]);
  const mem = process.memoryUsage();
  const p95 = Math.round(pct(late, 95));
  return {
    windowMinutes: WINDOW_MS / 60000,
    priceSteps: steps.length,
    stepLateP95Ms: p95,
    stepLateMaxMs: Math.round(Math.max(0, ...late)),
    stepTookP95Ms: Number(pct(took, 95).toFixed(2)),
    eventLoopP99Ms: Number(lastLoopSample.p99.toFixed(1)),
    eventLoopMaxMs: Number(lastLoopSample.max.toFixed(1)),
    heapMb: Math.round(mem.heapUsed / 1048576),
    rssMb: Math.round(mem.rss / 1048576),
    activeMatches: perMatch.size,
    clientGaps: clientGaps.slice(-20).map(([at, playerId, matchId, gapMs]) => ({ at: new Date(at).toISOString(), playerId, matchId, gapMs })),
    redLagMs,
    state: p95 > redLagMs ? 'red' : 'ok',
  };
}

module.exports = { recordStep, recordClientGap, snapshot };
