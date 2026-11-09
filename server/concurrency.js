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

module.exports = { runPool, createMemo };
