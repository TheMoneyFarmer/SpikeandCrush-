'use strict';

// The one relative-time formatter for the whole site, loaded by pages as
// /js/time-ago.js (TW.timeAgo) and required by the server as a module.
// Accepts epoch seconds, epoch milliseconds, ISO strings or Date objects.
// null / invalid / future -> "just now"; past a week -> short date ("12 Oct").
(function (root) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Anything below this is an epoch in seconds (1e11 s is the year 5138;
  // 1e11 ms is 1973), so both units are told apart safely.
  const SECONDS_EPOCH_LIMIT = 1e11;

  function toMs(ts) {
    if (ts === null || ts === undefined || ts === '') return NaN;
    if (ts instanceof Date) return ts.getTime();
    if (typeof ts === 'number' || (typeof ts === 'string' && /^\d+(\.\d+)?$/.test(ts.trim()))) {
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= 0) return NaN;
      return n < SECONDS_EPOCH_LIMIT ? n * 1000 : n;
    }
    if (typeof ts === 'string') return Date.parse(ts);
    return NaN;
  }

  function timeAgo(ts, nowMs = Date.now()) {
    const ms = toMs(ts);
    if (!Number.isFinite(ms)) return 'just now';
    const diff = (nowMs - ms) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
    const d = new Date(ms);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { timeAgo };
  else {
    root.TW = root.TW || {};
    root.TW.timeAgo = timeAgo;
  }
})(typeof window !== 'undefined' ? window : globalThis);
