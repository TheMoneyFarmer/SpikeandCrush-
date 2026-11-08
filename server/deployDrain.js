'use strict';

// Safe deploys: live matches exist only in this process's memory, so a
// restart would drop every match in progress. Before a deploy the server is
// put into "drain" mode:
//   - no NEW matches or lobbies start (players are told an update is coming),
//   - matches and lobbies that already exist play out normally,
//   - once none are left, the deploy may go ahead.
//
// Two ways in:
//   1. The GitHub workflow .github/workflows/safe-deploy.yml (with Railway's
//      "Wait for CI" on): POST /api/deploy/drain, wait for /api/deploy/status
//      to report safeToDeploy, then let Railway deploy.
//   2. SIGTERM (Railway stopping the old deployment): drain, wait for live
//      matches to finish, then exit - bounded by RAILWAY_DEPLOYMENT_DRAINING_SECONDS.
//
// Drain always has an expiry so a cancelled or failed deploy can never leave
// the live server refusing new matches for long.

const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 45 * 60;
// Waiting lobbies never start on their own (only the host's Start War does),
// so a lobby left open would block a deploy forever. During a drain they get
// this long to start; after that, ones nobody started are closed and every
// player's entry coins are refunded (nothing has been played yet).
const LOBBY_GRACE_MS = (Number(process.env.DEPLOY_LOBBY_GRACE_SECONDS) || 120) * 1000;
const LOBBY_CLOSED_MESSAGE = 'This lobby was closed for a quick update. Your entry coins have been refunded. You can start a new match in a few minutes.';
const MAX_TTL_SECONDS = 2 * 60 * 60;
const UPDATING_MESSAGE = 'Spike & Crush is installing an update. New matches open again in a few minutes. Matches already running are not affected.';

function createDeployDrain({ gameEngine, io, notifyPlayer }) {
  let state = { draining: false, since: null, until: null, reason: null };
  let shuttingDown = false;

  function expireIfDue() {
    if (state.draining && state.until && Date.now() > state.until && !shuttingDown) {
      console.log('[deploy] drain expired - new matches allowed again');
      setDraining(false);
    }
  }

  function setDraining(on, { ttlSeconds = DEFAULT_TTL_SECONDS, reason = null } = {}) {
    const ttl = Math.min(MAX_TTL_SECONDS, Math.max(60, Number(ttlSeconds) || DEFAULT_TTL_SECONDS));
    state = on
      ? { draining: true, since: state.draining ? state.since : Date.now(), until: Date.now() + ttl * 1000, reason }
      : { draining: false, since: null, until: null, reason: null };
    io.emit('server:updating', { updating: state.draining, message: state.draining ? UPDATING_MESSAGE : null });
    console.log(`[deploy] drain ${on ? `ON (${ttl}s${reason ? `, ${reason}` : ''})` : 'OFF'}`);
    return status();
  }

  // Tournament lobbies are left alone: cancelling one would orphan the
  // bracket's matchup. Everything else in 'waiting' is closed with refunds.
  let closing = false;
  async function closeIdleLobbies() {
    if (!state.draining || closing || Date.now() - state.since < LOBBY_GRACE_MS) return 0;
    closing = true;
    let closed = 0;
    try {
      for (const summary of gameEngine.listActiveMatches()) {
        if (summary.status !== 'waiting' || summary.mode === 'tournament') continue;
        const match = gameEngine.getMatch(summary.id);
        if (!match || match.status !== 'waiting') continue;
        io.to(`match:${match.id}`).emit('match:voided', { reason: LOBBY_CLOSED_MESSAGE });
        const humans = match.playerOrder.filter((id) => match.players[id] && !match.players[id].isAI);
        for (const pid of humans) {
          const r = await gameEngine.leaveMatch(match.id, pid).catch((e) => ({ success: false, error: e.message }));
          if (r && r.success) notifyPlayer?.(pid, 'lobby_closed_update', LOBBY_CLOSED_MESSAGE);
          else console.warn('[deploy] could not close lobby seat', match.id, pid, r && r.error);
        }
        closed++;
      }
      if (closed) console.log(`[deploy] closed ${closed} idle lobby(ies) with refunds`);
    } finally {
      closing = false;
    }
    return closed;
  }
  setInterval(() => closeIdleLobbies().catch((e) => console.warn('[deploy] lobby close failed:', e.message)), 15000).unref();

  function isDraining() {
    expireIfDue();
    return state.draining;
  }

  function status() {
    expireIfDue();
    const live = gameEngine.listActiveMatches();
    const activeMatches = live.filter((m) => m.status === 'active' || m.status === 'countdown');
    const waitingLobbies = live.filter((m) => m.status === 'waiting');
    const longest = activeMatches.reduce((mx, m) => Math.max(mx, m.remainingSeconds || 0), 0);
    return {
      draining: state.draining,
      drainingSince: state.since ? new Date(state.since).toISOString() : null,
      drainExpiresAt: state.until ? new Date(state.until).toISOString() : null,
      activeMatches: activeMatches.length,
      waitingLobbies: waitingLobbies.length,
      longestRemainingSeconds: longest,
      // Safe = nothing live in memory that a restart would destroy. Long-form
      // competitions live in the database and survive restarts.
      safeToDeploy: activeMatches.length === 0 && waitingLobbies.length === 0,
      lobbiesCloseAt: state.since ? new Date(state.since + LOBBY_GRACE_MS).toISOString() : null,
    };
  }

  // Shared-secret check for the drain switch (DEPLOY_DRAIN_TOKEN, no default:
  // unset means the HTTP switch is disabled).
  function tokenOk(req) {
    const expected = process.env.DEPLOY_DRAIN_TOKEN;
    const given = String(req.headers['x-deploy-token'] || '');
    if (!expected || !given || given.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  function mount(app) {
    // Public, counts only (live match numbers are already public on the site).
    app.get('/api/deploy/status', (req, res) => res.json(status()));
    app.post('/api/deploy/drain', (req, res) => {
      if (!process.env.DEPLOY_DRAIN_TOKEN) return res.status(503).json({ error: 'Drain switch not configured' });
      if (!tokenOk(req)) return res.status(403).json({ error: 'Forbidden' });
      const on = req.body?.on !== false;
      res.json(setDraining(on, { ttlSeconds: req.body?.ttlSeconds, reason: req.body?.reason ? String(req.body.reason).slice(0, 120) : 'deploy' }));
    });
  }

  // Express middleware for routes that START a new match.
  function blockNewMatches(req, res, next) {
    if (!isDraining()) return next();
    res.status(503).json({ error: UPDATING_MESSAGE, updating: true });
  }

  // Railway sends SIGTERM to the old deployment once the new one is live.
  // Keep serving the matches still running here, then exit when they're done
  // (or when Railway's draining window is about to end).
  function handleSigterm() {
    if (shuttingDown) return;
    shuttingDown = true;
    const windowSeconds = Number(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS) || 0;
    const deadline = Date.now() + Math.max(0, windowSeconds - 10) * 1000;
    setDraining(true, { ttlSeconds: MAX_TTL_SECONDS, reason: 'SIGTERM' });
    // A match counts as over as soon as endMatch marks it finished, but its
    // results, rating changes and prize coins are written to the database
    // just after that. Only exit once nothing has been live for SETTLE_MS, so
    // those writes (and the players' end screens) always complete.
    const SETTLE_MS = (Number(process.env.DEPLOY_SETTLE_SECONDS) || 20) * 1000;
    let safeSince = null;
    const check = () => {
      const s = status();
      safeSince = s.safeToDeploy ? safeSince || Date.now() : null;
      const settled = safeSince && Date.now() - safeSince >= SETTLE_MS;
      if (settled || Date.now() >= deadline) {
        console.log(`[deploy] exiting (${settled ? 'no live matches left' : 'draining window ending'}, ${s.activeMatches} active)`);
        process.exit(0);
      }
      console.log(safeSince ? '[deploy] no live matches - letting final results save before exit' : `[deploy] waiting for ${s.activeMatches} match(es), ${s.waitingLobbies} lobby(ies) to finish`);
      setTimeout(check, 5000);
    };
    check();
  }
  process.on('SIGTERM', handleSigterm);

  return { mount, isDraining, status, setDraining, blockNewMatches, closeIdleLobbies, UPDATING_MESSAGE };
}

module.exports = { createDeployDrain, UPDATING_MESSAGE };
