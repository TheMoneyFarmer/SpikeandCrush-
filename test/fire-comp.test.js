'use strict';

// Part 1B.3 / test 6-7: long competitions on activity-filtered series.
process.env.SUPABASE_SERVICE_KEY = '';
const test = require('node:test');
const assert = require('node:assert');
const replayClock = require('../server/replayClock');
const curated = require('../server/curated');
const gameFeel = require('../server/config/gameFeel');
const { TEMPLATES, competitionInstruments } = require('../server/compEngine');

const LIMIT = gameFeel.get().market.flatLimitSeconds;

function simulate(symbols, startIso, seconds) {
  const start = Math.floor(new Date(startIso).getTime() / 1000);
  const out = {};
  for (const sym of symbols) {
    let longest = 0;
    let run = 0;
    let prev = null;
    let closed = 0;
    const medRange = curated.load().instruments[sym].medRange;
    const window = [];
    let thin = 0;
    for (let t = start; t < start + seconds; t++) {
      const q = replayClock.getPriceAt(sym, t);
      if (q.marketClosed) closed++;
      if (prev !== null && q.mid === prev) longest = Math.max(longest, ++run);
      else run = 0;
      prev = q.mid;
      // rolling 3-minute range, sampled every 60s
      window.push(q.mid);
      if (window.length > 180) window.shift();
      if (window.length === 180 && (t - start) % 60 === 0 && Math.max(...window) - Math.min(...window) < medRange) thin++;
    }
    out[sym] = { longest, closed, thin3min: thin, checks3min: Math.floor((seconds - 180) / 60) };
  }
  return out;
}

test('a new Daily Full Session (22h of data time, fast-forwarded) never goes flat past the limit', () => {
  const tpl = TEMPLATES.daily;
  const occ = tpl.next(Date.UTC(2026, 10, 10));
  const w = replayClock.chooseDataWindow({ id: 'daily-sim', startsAt: occ.startsAt, endsAt: occ.endsAt, instruments: competitionInstruments(tpl.instruments) });
  assert.ok(replayClock.isCuratedTime(Math.floor(new Date(w.dataWindowStart).getTime() / 1000)), 'not a curated window');
  const res = simulate(w.instruments, w.dataWindowStart, 22 * 3600);
  console.log('Daily 22h simulation:', JSON.stringify(res));
  for (const [sym, r] of Object.entries(res)) {
    assert.ok(r.longest <= LIMIT, `${sym} flat ${r.longest}s`);
    assert.strictEqual(r.closed, 0, `${sym} market closed ${r.closed}s`);
    assert.strictEqual(r.thin3min, 0, `${sym}: ${r.thin3min} 3-minute stretches ranged less than the median 1-minute move`);
  }
});

test('mirrored second pass: seam at the loop end is exact and the path is not a repeat', () => {
  const sym = 'BTCUSD';
  const n = JSON.parse(require('fs').readFileSync(require('path').join(curated.getDir(), `${sym}.comp.json`))).bars.length;
  const e = replayClock.compEpoch();
  const endFirst = e + n * 300 - 1;
  const a = replayClock.getPriceAt(sym, endFirst).mid;
  const b = replayClock.getPriceAt(sym, endFirst + 1).mid;
  const step = Math.abs(b - a) / a;
  assert.ok(step < 0.001, `jump ${step}`);
  const first = replayClock.candlesUpTo(sym, e, e + 3000).map((r) => r[4]);
  const second = replayClock.candlesUpTo(sym, e + n * 300, e + n * 300 + 3000).map((r) => r[4]);
  assert.notDeepStrictEqual(first, second);
});

test('chart candles never include anything after the data time; forming candle closes on the quote', () => {
  const e = replayClock.compEpoch();
  for (let k = 0; k < 200; k++) {
    const t = e + 600 * 300 + Math.floor(Math.random() * 100000);
    const rows = replayClock.candlesUpTo('XAUUSD', t - 500 * 300, t);
    assert.ok(rows.every((r) => r[0] <= t));
    assert.strictEqual(rows[rows.length - 1][4], replayClock.getPriceAt('XAUUSD', t).mid);
  }
});

test('switch off: new competitions use raw history again; running curated ones keep their series', () => {
  gameFeel.applyOverrides({ market: { curatedCompetitions: false } });
  const occ = TEMPLATES.weekend.next(Date.UTC(2026, 10, 10));
  const w = replayClock.chooseDataWindow({ id: 'raw-1', startsAt: occ.startsAt, endsAt: occ.endsAt, instruments: ['BTCUSD', 'ETHUSD'] });
  gameFeel.applyOverrides({});
  assert.ok(!replayClock.isCuratedTime(Math.floor(new Date(w.dataWindowStart).getTime() / 1000)));
  const e = replayClock.compEpoch();
  assert.strictEqual(replayClock.getPriceAt('BTCUSD', e + 1000).marketClosed, false);
});

test('long competitions: spike alerts only for real spike bars, time only, spaced out, off when disabled', () => {
  const { makeSpikeTracker } = require('../server/compEngine');
  const tpl = TEMPLATES.daily;
  const occ = tpl.next(Date.UTC(2026, 10, 10));
  const w = replayClock.chooseDataWindow({ id: 'spike-sim', startsAt: occ.startsAt, endsAt: occ.endsAt, instruments: competitionInstruments(tpl.instruments) });
  const comp = { id: 'spike-sim-comp', instruments: w.instruments };
  const start = Math.floor(new Date(w.dataWindowStart).getTime() / 1000);
  const track = makeSpikeTracker();
  const alerts = [];
  const results = [];
  for (let t = start; t < start + 22 * 3600; t += 5) {
    for (const ev of track(comp, t)) (ev.event === 'comp:spike_alert' ? alerts : results).push({ t, ...ev.payload });
  }
  console.log(`22h Daily: ${alerts.length} spike alerts, ${results.length} results`);
  assert.ok(alerts.length > 0, 'no spikes announced in 22 hours');
  assert.strictEqual(results.length, alerts.length);
  const gap = gameFeel.get().spikeAlerts.minGapSecondsLong;
  for (let i = 0; i < alerts.length; i++) {
    assert.deepStrictEqual(Object.keys(alerts[i]).sort(), ['id', 'inSeconds', 't']);
    assert.ok(!w.instruments.some((s) => alerts[i].id.includes(s)), 'alert id names the instrument');
    if (i) assert.ok(alerts[i].t - alerts[i - 1].t >= gap, 'alerts too close together');
    const r = results[i];
    // The announced move is the real bar's move on the curated series.
    const barStart = Number(r.id.split('-').pop());
    const q0 = replayClock.getPriceAt(r.symbol, barStart).mid;
    const q1 = replayClock.getPriceAt(r.symbol, barStart + 299).mid;
    assert.ok(Math.abs(((q1 - q0) / q0) * 100 - r.movePct) < 0.01, `${r.symbol} move ${r.movePct} vs ${((q1 - q0) / q0) * 100}`);
  }
  gameFeel.applyOverrides({ spikeAlerts: { enabled: false } });
  const off = makeSpikeTracker();
  let any = 0;
  for (let t = start; t < start + 6 * 3600; t += 5) any += off(comp, t).length;
  gameFeel.applyOverrides({});
  assert.strictEqual(any, 0);
});
