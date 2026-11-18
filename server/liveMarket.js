'use strict';

// Live market prices for live-data competitions (data_source = 'live').
//
// Crypto comes from Coinbase Exchange's public market data: the WebSocket
// "ticker" channel (every trade, no account or key) and the REST candles
// endpoint for history (charts, and refilling any gap after a restart).
// Other classes (forex, metals...) need a licensed feed and are not served:
// a live competition simply has no such instruments (chooseDataWindow drops
// them and says why).
//
// Storage, all in memory:
//   ticks    per symbol, one price per second that traded (last 72 h)
//   minutes  per symbol, 1-minute OHLC bars from REST (backfill, last 50 h)
// A price at time t is the last tick at or before t; before the first tick
// it walks the 1-minute bar (open, low/high, close) like the replay does.
//
// healthy(): socket open and BTC and ETH traded in the last HEALTH_SECONDS.
// A live competition never trades on a stale price: a coin with no trade for
// STALE_SECONDS, or any coin while the feed is unhealthy, quotes marketClosed
// (new trades blocked, closing allowed).

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';
const REST = 'https://api.exchange.coinbase.com';
const PRODUCTS = {
  BTCUSD: 'BTC-USD', ETHUSD: 'ETH-USD',
  // live-only coins (server/instruments.js LIVE_INSTRUMENTS)
  SOLUSD: 'SOL-USD', XRPUSD: 'XRP-USD', DOGEUSD: 'DOGE-USD', ADAUSD: 'ADA-USD',
  LTCUSD: 'LTC-USD', LINKUSD: 'LINK-USD', AVAXUSD: 'AVAX-USD', BCHUSD: 'BCH-USD',
};
// Feed health is judged on the busiest markets; a quieter coin that has not
// traded for STALE_SECONDS is closed to new trades on its own.
const CORE = ['BTCUSD', 'ETHUSD'];
const HEALTH_SECONDS = 30;
const KEEP_TICK_SECONDS = 72 * 3600;
const BACKFILL_SECONDS = 50 * 3600;
const STALE_SECONDS = 90;
const BASE_SECONDS = 300;

function createLiveMarket({ products = PRODUCTS, fetchImpl = (...a) => fetch(...a), WebSocketImpl = globalThis.WebSocket, now = () => Date.now(), log = console } = {}) {
  const ticks = {}; // symbol -> { t: number[], p: number[] }
  const minutes = {}; // symbol -> Map(minuteStart -> [o,h,l,c])
  const series = {}; // `${symbol}:${granularity}` -> { at, rows }
  let ws = null;
  let open = false;
  let started = false;
  let retryMs = 1000;

  for (const s of Object.keys(products)) {
    ticks[s] = { t: [], p: [] };
    minutes[s] = new Map();
  }
  const bySymbol = Object.fromEntries(Object.entries(products).map(([s, p]) => [p, s]));

  // ---- ingest -------------------------------------------------------------
  function addTick(symbol, sec, price) {
    const b = ticks[symbol];
    if (!b || !(price > 0) || !Number.isFinite(sec)) return;
    const n = b.t.length;
    if (n && sec < b.t[n - 1]) return; // out of order: ignore
    if (n && sec === b.t[n - 1]) b.p[n - 1] = price; // last trade of the second wins
    else { b.t.push(sec); b.p.push(price); }
    const cut = sec - KEEP_TICK_SECONDS;
    if (b.t[0] < cut) {
      let k = 0;
      while (k < b.t.length && b.t[k] < cut) k++;
      b.t.splice(0, k); b.p.splice(0, k);
    }
  }

  function onMessage(raw) {
    let m;
    try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch (e) { return; }
    if (m.type !== 'ticker' || !bySymbol[m.product_id]) return;
    const sec = Math.floor(Date.parse(m.time || '') / 1000);
    addTick(bySymbol[m.product_id], Number.isFinite(sec) ? sec : Math.floor(now() / 1000), Number(m.price));
  }

  function connect() {
    if (!WebSocketImpl) { log.warn('[live market] no WebSocket available'); return; }
    try { ws = new WebSocketImpl(WS_URL); } catch (e) { log.warn('[live market] connect failed:', e.message); return scheduleReconnect(); }
    ws.onopen = () => {
      open = true;
      retryMs = 1000;
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: Object.values(products), channels: ['ticker', 'heartbeat'] }));
      log.log('[live market] connected:', Object.keys(products).join(', '));
      backfill().catch((e) => log.warn('[live market] backfill failed:', e.message));
    };
    ws.onmessage = (ev) => onMessage(ev.data);
    ws.onerror = () => {};
    ws.onclose = () => { open = false; scheduleReconnect(); };
  }
  function scheduleReconnect() {
    if (!started) return;
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, 60000);
    setTimeout(connect, wait).unref?.();
  }

  // 1-minute bars for the last BACKFILL_SECONDS (300 per request).
  async function backfill(symbols = Object.keys(products)) {
    const end = Math.floor(now() / 1000 / 60) * 60;
    for (const s of symbols) {
      for (let to = end; to > end - BACKFILL_SECONDS; to -= 300 * 60) {
        const from = Math.max(to - 300 * 60, end - BACKFILL_SECONDS);
        const rows = await candlesRest(s, 60, from, to);
        for (const [t, lo, hi, o, c] of rows) minutes[s].set(t, [o, hi, lo, c]);
      }
    }
  }

  // Coinbase rows: [time, low, high, open, close, volume], newest first.
  async function candlesRest(symbol, granularity, fromSec, toSec) {
    const url = `${REST}/products/${products[symbol]}/candles?granularity=${granularity}&start=${new Date(fromSec * 1000).toISOString()}&end=${new Date(toSec * 1000).toISOString()}`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'spikecrush-live-market' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`candles ${symbol} ${granularity}: ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows.filter((r) => Array.isArray(r) && r.length >= 5).sort((a, b) => a[0] - b[0]) : [];
  }

  // Cached chart series (h1, d1, m5) straight from Coinbase, [t,o,h,l,c] ascending.
  async function chartSeries(symbol, granularity, bars) {
    if (!products[symbol]) return [];
    const key = `${symbol}:${granularity}`;
    const hit = series[key];
    if (hit && now() - hit.at < Math.min(granularity, 300) * 1000) return hit.rows;
    const end = Math.floor(now() / 1000 / granularity) * granularity;
    const out = [];
    for (let to = end; to > end - bars * granularity; to -= 300 * granularity) {
      const rows = await candlesRest(symbol, granularity, Math.max(to - 300 * granularity, end - bars * granularity), to).catch(() => []);
      out.unshift(...rows.map(([t, lo, hi, o, c]) => [t, o, hi, lo, c]));
    }
    const rows = [...new Map(out.map((r) => [r[0], r])).values()].sort((a, b) => a[0] - b[0]);
    series[key] = { at: now(), rows };
    return rows;
  }

  // ---- reads --------------------------------------------------------------
  function lastIndexAtOrBefore(arr, t) {
    let lo = 0;
    let hi = arr.length - 1;
    if (hi < 0 || arr[0] > t) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // Minute bar path: open, then the nearer extreme, the other, close.
  function minutePath(bar) {
    const [o, h, l, c] = bar;
    return c >= o ? [[0, o], [20, l], [40, h], [60, c]] : [[0, o], [20, h], [40, l], [60, c]];
  }
  function onPath(path, off) {
    for (let k = 1; k < path.length; k++) {
      const [t1, p1] = path[k];
      if (off <= t1) { const [t0, p0] = path[k - 1]; return t1 === t0 ? p1 : p0 + ((p1 - p0) * (off - t0)) / (t1 - t0); }
    }
    return path[path.length - 1][1];
  }

  // Mid price at second t, and whether that price is stale (no trade within
  // STALE_SECONDS before t on a feed that should be trading constantly).
  function midAt(symbol, t) {
    const b = ticks[symbol];
    if (!b) return null;
    const i = lastIndexAtOrBefore(b.t, t);
    if (i >= 0) return { mid: b.p[i], stale: t - b.t[i] > STALE_SECONDS };
    const m0 = Math.floor(t / 60) * 60;
    const bar = minutes[symbol].get(m0);
    if (bar) return { mid: onPath(minutePath(bar), t - m0), stale: false };
    // closest earlier minute bar (a quiet minute has no bar)
    const keys = [...minutes[symbol].keys()].filter((k) => k <= t);
    if (keys.length) { const k = Math.max(...keys); return { mid: minutes[symbol].get(k)[3], stale: t - k > 120 }; }
    return null;
  }

  // Points the price passed through in (from, to], for SL/TP and stop-out walks.
  function pathPoints(symbol, from, to) {
    const out = [];
    if (to <= from || !ticks[symbol]) return out;
    const b = ticks[symbol];
    const firstTick = b.t.length ? b.t[0] : Infinity;
    for (let m = Math.floor(from / 60) * 60; m < Math.min(to, firstTick); m += 60) {
      const bar = minutes[symbol].get(m);
      if (!bar) continue;
      for (const [off, p] of minutePath(bar)) { const t = m + off; if (t > from && t < to && t < firstTick) out.push({ t, mid: p }); }
    }
    let i = Math.max(0, lastIndexAtOrBefore(b.t, from) + 1);
    for (; i < b.t.length && b.t[i] < to; i++) if (b.t[i] > from) out.push({ t: b.t[i], mid: b.p[i] });
    const end = midAt(symbol, to);
    if (end) out.push({ t: to, mid: end.mid });
    return out;
  }

  // 5-minute bars in [from, dataTime] from minute bars and ticks; the bar that
  // contains dataTime is cut at dataTime.
  function bars5(symbol, from, dataTime) {
    if (!ticks[symbol]) return [];
    const out = new Map();
    const put = (t, p) => {
      const k = Math.floor(t / BASE_SECONDS) * BASE_SECONDS;
      if (k < Math.floor(from / BASE_SECONDS) * BASE_SECONDS || t > dataTime) return;
      const r = out.get(k);
      if (!r) out.set(k, [k, p, p, p, p]);
      else { r[2] = Math.max(r[2], p); r[3] = Math.min(r[3], p); r[4] = p; }
    };
    const b = ticks[symbol];
    const firstTick = b.t.length ? b.t[0] : Infinity;
    for (const m of [...minutes[symbol].keys()].sort((x, y) => x - y)) {
      if (m >= firstTick || m + 60 > dataTime + 60) continue;
      for (const [off, p] of minutePath(minutes[symbol].get(m))) if (m + off < firstTick) put(m + off, p);
    }
    for (let i = Math.max(0, lastIndexAtOrBefore(b.t, from)); i < b.t.length && b.t[i] <= dataTime; i++) put(b.t[i], b.p[i]);
    return [...out.values()].sort((x, y) => x[0] - y[0]);
  }

  function healthy() {
    if (!open) return false;
    const t = Math.floor(now() / 1000);
    return CORE.filter((s) => products[s]).every((s) => { const b = ticks[s]; return b.t.length && t - b.t[b.t.length - 1] <= HEALTH_SECONDS; });
  }

  function status() {
    const t = Math.floor(now() / 1000);
    return {
      connected: open,
      healthy: healthy(),
      symbols: Object.fromEntries(Object.keys(products).map((s) => { const b = ticks[s]; const last = b.t.length ? b.t[b.t.length - 1] : null; return [s, { lastTradeAgoSeconds: last === null ? null : t - last, price: last === null ? null : b.p[b.p.length - 1], ticks: b.t.length, minuteBars: minutes[s].size }]; })),
    };
  }

  function start() {
    if (started) return;
    started = true;
    connect();
  }
  function stop() {
    started = false;
    open = false;
    try { ws && ws.close(); } catch (e) { /* closed */ }
  }

  return { start, stop, healthy, status, supports: (s) => Boolean(products[s]), symbols: () => Object.keys(products), midAt, pathPoints, bars5, chartSeries, backfill, _addTick: addTick, _addMinute: (s, t, bar) => minutes[s].set(t, bar), _onMessage: onMessage, _setOpen: (v) => { open = v; } };
}

let shared = null;
const liveMarket = () => (shared ||= createLiveMarket());

module.exports = { createLiveMarket, liveMarket, PRODUCTS, STALE_SECONDS };
