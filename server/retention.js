'use strict';

// Keeps the database from growing forever. Runs once a day on one server only.
// Match results, ratings and coin history are never touched: only replays of old
// matches, equity curves of long-finished competitions, read notifications,
// raw addresses in login/session records, and old analytics and tech events.
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

  // Privacy (analytics): raw addresses and full browser strings in login and
  // session records are cleared after LOGIN_IP_RETENTION_DAYS (default 30).
  // The rows stay (they are the login history); only those two fields go.
  // Idempotent: a second run finds nothing left to clear.
  const ipDays = days('LOGIN_IP_RETENTION_DAYS', 30);
  if (ipDays > 0 && db.client) {
    for (const table of ['login_events', 'sessions']) {
      const { data, error } = await db.client().from(table).update({ ip: null, user_agent: null }).lt('created_at', cutoff(ipDays, nowMs)).or('ip.not.is.null,user_agent.not.is.null').select('id');
      if (error) throw error;
      removed[`${table}_anonymised`] = (data || []).length;
    }
  }
  // Raw tech-health events (default 90 days) and analytics events (default 400
  // days: long enough for year-on-year cohorts). 0 keeps them forever.
  const techDays = days('TECH_EVENT_RETENTION_DAYS', 90);
  const analyticsDays = days('ANALYTICS_RETENTION_DAYS', 400);
  const tolerant = async (fn) => { try { return await fn(); } catch (e) { if (/tech_events|analytics_events|schema cache|42P01/.test(e.message || '')) return 0; throw e; } };
  if (techDays > 0) removed.tech_events = await tolerant(() => db.deleteOlderThan('tech_events', 'at', cutoff(techDays, nowMs)));
  if (analyticsDays > 0) removed.analytics_events = await tolerant(() => db.deleteOlderThan('analytics_events', 'occurred_at', cutoff(analyticsDays, nowMs)));
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
