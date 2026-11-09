'use strict';

// The server watching itself: how full it is, whether new matches should be
// refused before it falls over, a health line in the logs each minute, and an
// email to the owner when something is wrong. No outside service needed.

const v8 = require('v8');
const { monitorEventLoopDelay } = require('perf_hooks');

const MAX_LIVE_MATCHES = Number(process.env.MAX_LIVE_MATCHES) || 2000;
const HEAP_FULL_RATIO = 0.85;
const LAG_FULL_MS = 500; // p99 event loop delay at which the server is struggling
const SAMPLE_EVERY_MS = 60 * 1000;
const ALERT_EVERY_MS = 30 * 60 * 1000; // at most one email per problem per half hour
const ERRORS_BEFORE_RESTART = 10; // uncaught errors in one minute before giving up
const BUSY_MESSAGE = 'The game is very busy right now. Please try again in a minute.';

function createOpsMonitor({ liveMatches, connectedSockets, sendAlert, exit = process.exit, intervalMs = SAMPLE_EVERY_MS }) {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let lagP99Ms = 0;
  const lastAlert = new Map();
  let recentCrashes = [];

  function snapshot() {
    const heap = v8.getHeapStatistics();
    const mem = process.memoryUsage();
    return {
      matches: liveMatches(),
      maxMatches: MAX_LIVE_MATCHES,
      sockets: connectedSockets(),
      heapUsedMb: Math.round(heap.used_heap_size / 1048576),
      heapLimitMb: Math.round(heap.heap_size_limit / 1048576),
      heapRatio: Math.round((heap.used_heap_size / heap.heap_size_limit) * 100) / 100,
      offHeapMb: Math.round(mem.arrayBuffers / 1048576),
      rssMb: Math.round(mem.rss / 1048576),
      lagP99Ms,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  // Whether a NEW match may start. Matches already running are never touched.
  function hasRoom() {
    const s = snapshot();
    return s.matches < MAX_LIVE_MATCHES && s.heapRatio < HEAP_FULL_RATIO && lagP99Ms < LAG_FULL_MS;
  }

  function blockNewMatchesWhenFull(req, res, next) {
    if (hasRoom()) return next();
    console.warn('[ops] refusing a new match, server full', JSON.stringify(snapshot()));
    alert('full', 'Server is refusing new matches', snapshot());
    res.status(503).json({ error: BUSY_MESSAGE, busy: true });
  }

  function alert(key, subject, details) {
    const now = Date.now();
    if (now - (lastAlert.get(key) || 0) < ALERT_EVERY_MS) return;
    lastAlert.set(key, now);
    Promise.resolve()
      .then(() => sendAlert?.(subject, details))
      .catch((e) => console.warn('[ops] alert failed:', e.message));
  }

  function sample() {
    lagP99Ms = Math.round(loop.percentile(99) / 1e6);
    loop.reset();
    const s = snapshot();
    console.log('[ops]', JSON.stringify(s));
    if (s.heapRatio >= HEAP_FULL_RATIO) alert('heap', 'Server memory is nearly full', s);
    if (lagP99Ms >= LAG_FULL_MS) alert('lag', 'Server is overloaded (slow event loop)', s);
    if (s.matches >= MAX_LIVE_MATCHES) alert('matches', 'Server has reached its match limit', s);
    return s;
  }

  // Node's default on an unhandled rejection is to kill the process, taking every
  // live match with it. One bad promise must not do that. An uncaught exception
  // can leave things half done, so repeated ones restart the server: Railway
  // brings it back and match recovery refunds anything lost.
  function onError(kind, error) {
    const message = (error && error.stack) || String(error);
    console.error(`[ops] ${kind}:`, message);
    alert(`${kind}:${String(error && error.message).slice(0, 80)}`, `Server error: ${kind}`, { message: message.slice(0, 1500) });
    if (kind !== 'uncaughtException') return false;
    const now = Date.now();
    recentCrashes = recentCrashes.filter((t) => now - t < 60 * 1000);
    recentCrashes.push(now);
    if (recentCrashes.length < ERRORS_BEFORE_RESTART) return false;
    console.error('[ops] too many uncaught errors, restarting');
    exit(1);
    return true;
  }

  function start() {
    process.on('unhandledRejection', (reason) => onError('unhandledRejection', reason));
    process.on('uncaughtException', (error) => onError('uncaughtException', error));
    setInterval(sample, intervalMs).unref();
  }

  return { start, sample, snapshot, hasRoom, blockNewMatchesWhenFull, onError, alert, BUSY_MESSAGE };
}

module.exports = { createOpsMonitor, MAX_LIVE_MATCHES };
