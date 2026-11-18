'use strict';

// The live price feed's switch, for competitions that need live market data
// (data_source = 'live').
//
//   liveFeed.ready   app_settings key, default false, super_admin only in the
//                    admin panel: the owner's "go" for live competitions.
//   healthy()        the feed's own health. In the game server (which runs
//                    the feed, server/liveMarket.js) it is the feed itself;
//                    elsewhere (the admin process) it is the game server's
//                    heartbeat (app_settings liveFeed.heartbeatAt, written
//                    every 15 s while healthy) being under 60 s old.
//
// A live competition can be opened, scheduled or entered only when BOTH are
// true (canGoLive). Enter buttons never show otherwise, server or client side.

const { liveMarket } = require('./liveMarket');

const CACHE_MS = 10000;
const HEARTBEAT_MS = 15000;
const HEARTBEAT_FRESH_MS = 60000;
let cache = { value: false, at: 0 };
let running = false; // this process runs the feed
let heartbeatAt = null; // last heartbeat seen from the game server (ms)

function healthy() {
  if (running) return liveMarket().healthy();
  return heartbeatAt !== null && Date.now() - heartbeatAt < HEARTBEAT_FRESH_MS;
}

function noteHeartbeat(value) {
  const t = Date.parse(value || '');
  heartbeatAt = Number.isFinite(t) ? t : null;
}

async function isReady(db) {
  if (Date.now() - cache.at < CACHE_MS) return cache.value;
  let value = false;
  try {
    if (db && db.getAppSetting) {
      value = (await db.getAppSetting('liveFeed.ready')) === true;
      if (!running) noteHeartbeat(await db.getAppSetting('liveFeed.heartbeatAt'));
    }
  } catch (e) {
    value = false; // no settings row or no table: not ready
  }
  cache = { value, at: Date.now() };
  return value;
}

async function canGoLive(db) {
  return (await isReady(db)) && healthy();
}

// Game server only: start the feed and write the heartbeat while it is healthy.
function start(db) {
  if (running || process.env.LIVE_FEED === 'off') return;
  running = true;
  liveMarket().start();
  if (db && db.isConfigured && db.setAppSetting) {
    setInterval(() => {
      if (liveMarket().healthy()) db.setAppSetting('liveFeed.heartbeatAt', new Date().toISOString()).catch(() => {});
    }, HEARTBEAT_MS).unref();
  }
}

function resetCache() {
  cache = { value: false, at: 0 };
}

module.exports = { healthy, isReady, canGoLive, resetCache, start, noteHeartbeat, status: () => ({ running, ...liveMarket().status() }) };
