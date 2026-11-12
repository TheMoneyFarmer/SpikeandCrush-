'use strict';

// The per-match event log (table match_events): every order, close, SL/TP
// change, card play, spike alert, disconnect, elimination and mission, with
// real time and market (data) time side by side. Admin reads it to rebuild
// a match; nothing ever edits it.
//
// Writes are batched (one insert per flush) so a busy match costs one
// request every couple of seconds, not one per click. The queue is bounded:
// under database trouble the oldest rows are dropped and counted, and the
// game itself never waits on the log.

const DEFAULT_FLUSH_MS = 2000;
const DEFAULT_MAX_QUEUE = 20000;
const BATCH = 500;

function createMatchLog({ insert, flushMs = DEFAULT_FLUSH_MS, maxQueue = DEFAULT_MAX_QUEUE, warn = console.warn } = {}) {
  let queue = [];
  let flushing = null;
  let dropped = 0;
  let written = 0;
  let disabled = false;
  let timer = null;

  function record(row) {
    if (disabled || !insert || !row || !row.kind) return;
    queue.push({
      match_id: row.matchId || null,
      competition_id: row.competitionId || null,
      player_id: row.playerId || null,
      kind: row.kind,
      real_at: new Date(row.realAt || Date.now()).toISOString(),
      data_s: row.dataS == null ? null : Math.round(Number(row.dataS) * 1000) / 1000,
      data_at: row.dataAt ? new Date(row.dataAt).toISOString() : null,
      position_ref: row.positionRef || null,
      payload: row.payload || {},
    });
    if (queue.length > maxQueue) {
      const over = queue.length - maxQueue;
      queue.splice(0, over);
      dropped += over;
    }
    if (!timer) {
      timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs);
      if (timer.unref) timer.unref();
    }
  }

  async function flush() {
    if (flushing) return flushing;
    if (!queue.length) return undefined;
    flushing = (async () => {
      while (queue.length && !disabled) {
        const batch = queue.slice(0, BATCH);
        try {
          await insert(batch);
          queue.splice(0, batch.length);
          written += batch.length;
        } catch (e) {
          // The table doesn't exist yet (migration not run): stop quietly.
          if (/match_events/.test(e.message || '') && /does not exist|schema cache|relation/.test(e.message || '')) {
            disabled = true;
            queue = [];
            warn('[matchLog] match_events table missing - event log off until the migration runs');
            return;
          }
          warn('[matchLog] write failed, will retry:', e.message);
          return;
        }
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  function stats() {
    return { queued: queue.length, written, dropped, disabled };
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    return flush();
  }

  return { record, flush, stats, stop };
}

// Downsample a long series to at most `max` points, always keeping the first
// and last point and the lowest point (so max drawdown survives the cut).
function downsample(points, max = 300) {
  if (!Array.isArray(points) || points.length <= max) return points || [];
  const step = (points.length - 1) / (max - 2);
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.round(i * step)]);
  out.push(points[points.length - 1]);
  let low = points[0];
  for (const p of points) if (p.equity < low.equity) low = p;
  if (!out.includes(low)) {
    out.push(low);
    out.sort((a, b) => a.t - b.t);
  }
  return out;
}

module.exports = { createMatchLog, downsample };
