'use strict';

// The live price feed's switch, for competitions that need live market data
// (data_source = 'live'). Nothing here builds the feed: this is the extension
// point the live feed task plugs into.
//
//   liveFeed.ready   app_settings key, default false, super_admin only in the
//                    admin panel ("Set by the live feed deployment").
//   healthy()        the feed's own health check. Returns false until the
//                    live feed exists; replace the body when it does.
//
// A live competition can be opened, scheduled or entered only when BOTH are
// true (canGoLive). Enter buttons never show otherwise, server or client side.

const CACHE_MS = 10000;
let cache = { value: false, at: 0 };

function healthy() {
  // EXTENSION POINT (live feed task): return the feed's real health here,
  // e.g. "connected and last tick under N seconds old".
  return false;
}

async function isReady(db) {
  if (Date.now() - cache.at < CACHE_MS) return cache.value;
  let value = false;
  try {
    if (db && db.isConfigured) value = (await db.getAppSetting('liveFeed.ready')) === true;
  } catch (e) {
    value = false; // no settings row or no table: not ready
  }
  cache = { value, at: Date.now() };
  return value;
}

async function canGoLive(db) {
  return (await isReady(db)) && healthy();
}

function resetCache() {
  cache = { value: false, at: 0 };
}

module.exports = { healthy, isReady, canGoLive, resetCache };
