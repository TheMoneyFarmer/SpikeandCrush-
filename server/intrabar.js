'use strict';

// Seeded intrabar path generator. Turns one base bar (open, high, low, close)
// into `n` one-second prices that:
//   - start exactly at the open and end exactly at the close,
//   - touch the high and the low (so re-aggregating the seconds gives back the
//     base bar's OHLC exactly - 1m, 5m, 15m candles are unchanged),
//   - never leave [low, high],
//   - move by at least one price point every second whenever the bar has any
//     range (no flat 1s/5s/10s candles inside an active bar),
//   - use step sizes scaled to that bar's own range,
//   - visit the high and low in a random but seed-fixed order.
// Same (seed, barKey) -> same path, for every player and every replay.
//
// Prices are handled as integers of the instrument's smallest price point
// (10^-decimals) so rounding can never create or remove a move.

function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

// mulberry32
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(seed, key) {
  return rng(hashString(`${seed}|${key}`));
}

// Walk from `from` to `to` in `steps` steps inside [lo, hi], writing into
// out[start+1 .. start+steps]. Every step moves at least one point when the
// band allows it; the last step lands exactly on `to`.
function walk(out, start, from, to, steps, lo, hi, rand, scale) {
  let x = from;
  for (let k = 1; k <= steps; k++) {
    const remaining = steps - k + 1;
    let next;
    if (remaining === 1) {
      next = to;
    } else if (remaining === 2 && x === to) {
      // Step away and come back so the last second still moves.
      next = x + 1 <= hi ? x + 1 : x - 1 >= lo ? x - 1 : x;
    } else {
      const drift = (to - x) / remaining;
      let s = Math.round(drift + (rand() * 2 - 1) * scale);
      if (s === 0) s = drift > 0 ? 1 : drift < 0 ? -1 : rand() < 0.5 ? 1 : -1;
      next = x + s;
      if (next > hi) next = hi;
      if (next < lo) next = lo;
      if (next === x) next = x - Math.sign(s) >= lo && x - Math.sign(s) <= hi ? x - Math.sign(s) : x;
      // Never drift so far that the remaining steps can't plausibly return:
      // keep within (remaining-1) * max(scale*2, 1) points of the target.
      const reach = (remaining - 1) * Math.max(2 * scale, 1);
      if (Math.abs(to - next) > reach) next = to + Math.sign(next - to) * Math.floor(reach);
      // Every second moves: if the clamps left the price where it was, take
      // one point toward the target (or away from it when already there).
      if (next === x) {
        const dir = to > x ? 1 : to < x ? -1 : x + 1 <= hi ? 1 : -1;
        if (x + dir >= lo && x + dir <= hi) next = x + dir;
        else if (x - dir >= lo && x - dir <= hi) next = x - dir;
      }
    }
    out[start + k] = next;
    x = next;
  }
}

// Path in integer points for one bar. o/h/l/c are integers.
function barPathPoints(o, h, l, c, n, rand) {
  const out = new Int32Array(n);
  out[0] = o;
  if (n === 1) return out;
  if (h === l) {
    out.fill(o);
    return out;
  }
  const range = h - l;
  const scale = Math.max(1, range * 0.18);
  // Up bars more often dip first (low then high), down bars the opposite -
  // the common shape of a real bar - but the seed decides each bar.
  const lowFirst = c >= o ? rand() < 0.65 : rand() < 0.35;
  const e1 = lowFirst ? l : h;
  const e2 = lowFirst ? h : l;
  const last = n - 1;
  // Times for the two extremes: t1 in [2, ~0.6 last], t2 in [t1+1, last-2].
  // At least two steps for the first and last legs, so an open that already
  // sits on an extreme (or a close equal to one) still moves away and back
  // instead of holding flat next to the bar boundary.
  const t1 = 2 + Math.floor(rand() * Math.max(1, Math.floor(last * 0.6) - 2));
  const t2 = Math.min(last - 2, t1 + 1 + Math.floor(rand() * Math.max(1, last - 2 - t1)));
  walk(out, 0, o, e1, t1, l, h, rand, scale);
  walk(out, t1, e1, e2, t2 - t1, l, h, rand, scale);
  walk(out, t2, e2, c, last - t2, l, h, rand, scale);
  return out;
}

// Price-space wrapper. decimals = instrument decimals. Returns Float64Array.
function barPath(bar, n, decimals, seed, key) {
  const p = 10 ** decimals;
  const toPts = (v) => Math.round(v * p);
  const o = toPts(bar.open);
  const c = toPts(bar.close);
  const h = Math.max(toPts(bar.high), o, c);
  const l = Math.min(toPts(bar.low), o, c);
  const pts = barPathPoints(o, h, l, c, n, rngFor(seed, key));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Number((pts[i] / p).toFixed(decimals));
  return out;
}

module.exports = { hashString, rng, rngFor, barPathPoints, barPath };
