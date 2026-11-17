'use strict';

// The competition engine's market data, behind one interface so the live feed
// can replace the replay later without touching the engine.
//
//   HistoricalReplay  works today: the long-form replay clock (server/replayClock.js).
//                     Label: "Demo market data". Never called "live".
//   LiveFeed          stub until a real feed is connected: every price call throws
//                     "Live feed not connected"; healthy() is false, so
//                     liveFeed.canGoLive() stays false and competitions stay
//                     Coming soon even if liveFeed.ready is switched on.
//
// The engine calls current() for prices and label() for what to show players.

const replayClock = require('./replayClock');
const liveFeed = require('./liveFeed');

const HistoricalReplay = {
  name: 'historical',
  label: 'Demo market data',
  live: false,
  healthy: () => true,
  // The replay clock's API, passed straight through.
  dataTimeFor: (...a) => replayClock.dataTimeFor(...a),
  getPriceAt: (...a) => replayClock.getPriceAt(...a),
  candlesUpTo: (...a) => replayClock.candlesUpTo(...a),
  chooseDataWindow: (...a) => replayClock.chooseDataWindow(...a),
  compSpikeBetween: (...a) => replayClock.compSpikeBetween(...a),
  isCuratedTime: (...a) => replayClock.isCuratedTime(...a),
  pathBetween: (...a) => replayClock.pathBetween(...a),
  timeShiftFor: (...a) => replayClock.timeShiftFor(...a),
  get USED_WINDOW_MEMORY() { return replayClock.USED_WINDOW_MEMORY; },
  get BASE_SECONDS() { return replayClock.BASE_SECONDS; },
};

const notConnected = () => {
  throw Object.assign(new Error('Live feed not connected'), { status: 503 });
};
const LiveFeed = {
  name: 'live',
  label: 'Live market data',
  live: true,
  healthy: () => liveFeed.healthy(),
  dataTimeFor: notConnected,
  getPriceAt: notConnected,
  candlesUpTo: notConnected,
  chooseDataWindow: notConnected,
  compSpikeBetween: notConnected,
  isCuratedTime: notConnected,
  pathBetween: notConnected,
  timeShiftFor: notConnected,
  USED_WINDOW_MEMORY: 0,
  get BASE_SECONDS() { return replayClock.BASE_SECONDS; },
};

// The live feed is used only when it reports healthy; until then (always,
// today) the replay serves every competition and is labelled honestly.
function current() {
  return LiveFeed.healthy() ? LiveFeed : HistoricalReplay;
}

module.exports = { current, HistoricalReplay, LiveFeed, label: () => current().label };
