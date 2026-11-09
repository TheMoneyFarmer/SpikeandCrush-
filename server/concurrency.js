'use strict';

// Runs fn over items with at most `limit` running at once, so a job touching
// thousands of rows neither crawls one at a time nor floods the database. Every
// item is tried; the first failure is rethrown at the end so the caller can retry.
async function runPool(items, limit, fn) {
  let next = 0;
  let firstError = null;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        await fn(items[index], index);
      } catch (e) {
        if (!firstError) firstError = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (firstError) throw firstError;
}

// Remembers a computed value for ttlMs, and callers arriving while it is being
// computed share that one computation.
function createMemo({ maxEntries = 200 } = {}) {
  const values = new Map();
  const pending = new Map();
  return async function memo(key, ttlMs, compute) {
    const hit = values.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve()
      .then(compute)
      .then((value) => {
        values.set(key, { at: Date.now(), value });
        if (values.size > maxEntries) values.delete(values.keys().next().value);
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}

// A ceiling on database traffic: at most `max` requests in flight, the rest wait
// their turn. Without it a spike opens thousands of connections at once, which
// overloads the database and runs the machine out of network ports. The timeout
// only starts once a request is really sent, and waiting too long fails it cleanly.
function createFetchLimiter({ max, timeoutMs, queueTimeoutMs, fetchImpl = fetch }) {
  let inFlight = 0;
  const waiting = [];
  const release = () => {
    inFlight--;
    const next = waiting.shift();
    if (next) next();
  };
  const limited = async (url, opts = {}) => {
    if (inFlight >= max) {
      await new Promise((resolve, reject) => {
        const entry = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(Object.assign(new Error('Database is busy'), { code: 'DB_QUEUE_TIMEOUT' }));
        }, queueTimeoutMs);
        waiting.push(entry);
      });
    }
    inFlight++;
    try {
      const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      return await fetchImpl(url, { ...opts, signal });
    } finally {
      release();
    }
  };
  limited.stats = () => ({ inFlight, waiting: waiting.length });
  return limited;
}

module.exports = { runPool, createMemo, createFetchLimiter };
