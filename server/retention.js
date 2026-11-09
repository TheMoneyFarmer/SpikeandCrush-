'use strict';

// Keeps the database from growing forever. Runs once a day on one server only.
// Match results, ratings and coin history are never touched: only replays of old
// matches, equity curves of long-finished competitions, and read notifications.
// Set a *_DAYS variable to 0 to keep that data forever.

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_EVERY_MS = DAY_MS;
const FIRST_RUN_AFTER_MS = 10 * 60 * 1000;

const days = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== undefined && process.env[name] !== '' ? value : fallback;
};
const cutoff = (n, nowMs) => new Date(nowMs - n * DAY_MS).toISOString();

async function runRetention(db, nowMs = Date.now()) {
  const replayDays = days('REPLAY_RETENTION_DAYS', 90);
  const notificationDays = days('NOTIFICATION_RETENTION_DAYS', 90);
  const snapshotDays = days('COMP_SNAPSHOT_RETENTION_DAYS', 30);
  const removed = { replays: 0, notifications: 0, snapshots: 0 };
  if (replayDays > 0) removed.replays = await db.deleteOlderThan('replays', 'created_at', cutoff(replayDays, nowMs), { idColumn: 'match_id' });
  if (notificationDays > 0) {
    removed.notifications = await db.deleteOlderThan('notifications', 'created_at', cutoff(notificationDays, nowMs), {
      extra: (query) => query.eq('read', true),
    });
  }
  if (snapshotDays > 0) removed.snapshots = await db.pruneEndedCompSnapshots(cutoff(snapshotDays, nowMs));
  return removed;
}

function startRetention(db) {
  if (!db.isConfigured) return;
  const run = async () => {
    try {
      // Held for most of a day, so only one server does this per day.
      if (!(await db.tryCompJobLock('retention', `${process.pid}`, 20 * 60 * 60))) return;
      const removed = await runRetention(db);
      console.log('[retention]', JSON.stringify(removed));
    } catch (e) {
      console.warn('[retention] failed:', e.message);
    }
  };
  setTimeout(run, FIRST_RUN_AFTER_MS).unref();
  setInterval(run, RUN_EVERY_MS).unref();
}

module.exports = { runRetention, startRetention };
