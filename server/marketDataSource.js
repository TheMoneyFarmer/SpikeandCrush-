'use strict';

// The competition engine's market data, chosen PER COMPETITION:
//
//   HistoricalReplay  data_source 'replay' (default): the long-form replay
//                     clock (server/replayClock.js). Label "Demo market data".
//   LiveFeed          data_source 'live': real prices from server/liveMarket.js
//                     (Coinbase public data for crypto). Data time is wall-clock
//                     time; nothing is shifted or curated, and there are no
//                     spike alerts (the future is unknown). While the feed is
//                     stale every quote is marketClosed: new trades are blocked,
//                     closing stays allowed.
//
// A running replay competition never switches source when the feed comes up.

const replayClock = require('./replayClock');
const instruments = require('./instruments');
const { liveMarket } = require('./liveMarket');

const HistoricalReplay = {
  name: 'historical',
  label: 'Demo market data',
  live: false,
  healthy: () => true,
  dataTimeFor: (...a) => replayClock.dataTimeFor(...a),
  getPriceAt: (...a) => replayClock.getPriceAt(...a),
  candlesUpTo: (...a) => replayClock.candlesUpTo(...a),
  chooseDataWindow: (...a) => replayClock.chooseDataWindow(...a),
  compSpikeBetween: (...a) => replayClock.compSpikeBetween(...a),
  isCuratedTime: (...a) => replayClock.isCuratedTime(...a),
  pathBetween: (...a) => replayClock.pathBetween(...a),
  timeShiftFor: (...a) => replayClock.timeShiftFor(...a),
  chartSeries: null,
  get USED_WINDOW_MEMORY() { return replayClock.USED_WINDOW_MEMORY; },
  get BASE_SECONDS() { return replayClock.BASE_SECONDS; },
};

// Same spread and rounding rule as the replay's quotes.
function quote(symbol, mid, marketClosed) {
  const cfg = instruments.getInstrument(symbol);
  const d = cfg.decimals;
  const m = Number(mid.toFixed(d));
  return { mid: m, bid: Number((m - cfg.spread / 2).toFixed(d)), ask: Number((m + cfg.spread / 2).toFixed(d)), marketClosed };
}

function makeLiveFeed(market = liveMarket, nowMs = () => Date.now()) {
  return {
    name: 'live',
    label: 'Live market data',
    live: true,
    healthy: () => market().healthy(),
    dataTimeFor: (comp, at = nowMs()) => Math.floor(at / 1000),
    timeShiftFor: () => 0,
    getPriceAt(symbol, dataTime) {
      const m = market().midAt(symbol, dataTime);
      if (!m) return null;
      // stale data, or "now" while the feed is down: closing only
      const down = dataTime >= Math.floor(nowMs() / 1000) - 2 && !market().healthy();
      return quote(symbol, m.mid, m.stale || down);
    },
    pathBetween: (symbol, from, to) => market().pathPoints(symbol, from, to),
    candlesUpTo(symbol, from, dataTime) {
      const d = instruments.getInstrument(symbol).decimals;
      return market().bars5(symbol, from, dataTime).map((r) => [r[0], ...r.slice(1).map((p) => Number(p.toFixed(d)))]);
    },
    chooseDataWindow({ startsAt, instruments: requested = [] }) {
      const ok = requested.filter((s) => market().supports(s));
      const dropped = requested.filter((s) => !market().supports(s)).map((s) => ({ symbol: s, reason: 'no live feed for this instrument yet' }));
      return { dataWindowStart: ok.length ? new Date(startsAt).toISOString() : null, instruments: ok, dropped };
    },
    compSpikeBetween: () => null,
    isCuratedTime: () => false,
    chartSeries: (symbol, granularity, bars) => market().chartSeries(symbol, granularity, bars),
    USED_WINDOW_MEMORY: 0,
    BASE_SECONDS: 300,
  };
}
const LiveFeed = makeLiveFeed();

// The source for one competition (or a data_source string).
function forComp(comp) {
  const src = typeof comp === 'string' ? comp : comp && comp.data_source;
  return src === 'live' ? LiveFeed : HistoricalReplay;
}

module.exports = { forComp, current: forComp, HistoricalReplay, LiveFeed, makeLiveFeed, label: (comp) => forComp(comp).label };
