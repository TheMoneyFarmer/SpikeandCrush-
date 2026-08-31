'use strict';

window.TW = window.TW || {};

// Computes and renders chart indicators on top of TW.Chart's main series
// (MA, Bollinger Bands, Volume) or in synced sub-panel charts below it
// (RSI, MACD). Recomputes automatically whenever TW.Chart's candles refresh.
TW.Indicators = (function () {
  const MA_COLORS = { 20: '#2196F3', 50: '#FF9800', 200: '#9C27B0' };

  const state = {
    ma: { enabled: false, periods: [20] },
    bb: { enabled: false, period: 20, stdDev: 2 },
    rsi: { enabled: false, period: 14 },
    macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    volume: { enabled: false },
  };

  const maSeries = {}; // period -> series
  let bbSeries = null; // { upper, middle, lower }
  let volumeSeries = null;

  let rsiChart = null;
  let rsiSeries = null;
  let macdChart = null;
  let macdLineSeries = null;
  let macdSignalSeries = null;
  let macdHistSeries = null;
  let syncing = false;

  // ---- math -----------------------------------------------------------------------

  function computeSMA(candles, period) {
    const result = [];
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
      result.push({ time: candles[i].time, value: sum / period });
    }
    return result;
  }

  function computeEMASeries(points, period) {
    // points: [{time, value}]
    const k = 2 / (period + 1);
    const result = [];
    let prev = points[0].value;
    result.push({ time: points[0].time, value: prev });
    for (let i = 1; i < points.length; i++) {
      prev = points[i].value * k + prev * (1 - k);
      result.push({ time: points[i].time, value: prev });
    }
    return result;
  }

  function computeBollinger(candles, period, mult) {
    const upper = [];
    const middle = [];
    const lower = [];
    for (let i = period - 1; i < candles.length; i++) {
      const slice = candles.slice(i - period + 1, i + 1).map((c) => c.close);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
      const std = Math.sqrt(variance);
      middle.push({ time: candles[i].time, value: mean });
      upper.push({ time: candles[i].time, value: mean + mult * std });
      lower.push({ time: candles[i].time, value: mean - mult * std });
    }
    return { upper, middle, lower };
  }

  function computeRSI(candles, period) {
    if (candles.length <= period) return [];
    const result = [];
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    result.push({ time: candles[period].time, value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss) });
    for (let i = period + 1; i < candles.length; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const value = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      result.push({ time: candles[i].time, value });
    }
    return result;
  }

  function computeMACD(candles, fast, slow, signalPeriod) {
    const closePoints = candles.map((c) => ({ time: c.time, value: c.close }));
    const emaFast = computeEMASeries(closePoints, fast);
    const emaSlow = computeEMASeries(closePoints, slow);
    const macdLine = candles.map((c, i) => ({ time: c.time, value: emaFast[i].value - emaSlow[i].value }));
    const signalLine = computeEMASeries(macdLine, signalPeriod);
    const histogram = macdLine.map((m, i) => ({ time: m.time, value: m.value - signalLine[i].value }));
    return { macdLine, signalLine, histogram };
  }

  // ---- sub-panel chart setup --------------------------------------------------------

  function ensureRsiChart() {
    const pane = document.getElementById('rsiPane');
    if (!pane) return;
    pane.classList.remove('hidden');
    if (rsiChart) return;
    rsiChart = LightweightCharts.createChart(pane, {
      layout: { background: { color: '#0d0d0d' }, textColor: '#888888' },
      grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
      timeScale: {
        timeVisible: true,
        secondsVisible: true,
        borderColor: '#2a2a2a',
        tickMarkFormatter: (time) => TW.Chart.formatElapsedClock(time),
      },
      localization: { timeFormatter: (time) => TW.Chart.formatElapsedClock(time) },
      rightPriceScale: { borderColor: '#2a2a2a' },
      autoSize: true,
    });
    rsiSeries = rsiChart.addLineSeries({ color: '#ffd700', lineWidth: 2 });
    rsiSeries.createPriceLine({
      price: 70,
      color: 'rgba(255,68,68,0.6)',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Overbought',
    });
    rsiSeries.createPriceLine({
      price: 30,
      color: 'rgba(0,200,150,0.6)',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Oversold',
    });
    syncPaneToMain(rsiChart);
  }

  function ensureMacdChart() {
    const pane = document.getElementById('macdPane');
    if (!pane) return;
    pane.classList.remove('hidden');
    if (macdChart) return;
    macdChart = LightweightCharts.createChart(pane, {
      layout: { background: { color: '#0d0d0d' }, textColor: '#888888' },
      grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
      timeScale: {
        timeVisible: true,
        secondsVisible: true,
        borderColor: '#2a2a2a',
        tickMarkFormatter: (time) => TW.Chart.formatElapsedClock(time),
      },
      localization: { timeFormatter: (time) => TW.Chart.formatElapsedClock(time) },
      rightPriceScale: { borderColor: '#2a2a2a' },
      autoSize: true,
    });
    macdHistSeries = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    macdLineSeries = macdChart.addLineSeries({ color: '#2196F3', lineWidth: 1 });
    macdSignalSeries = macdChart.addLineSeries({ color: '#ff9800', lineWidth: 1 });
    syncPaneToMain(macdChart);
  }

  function syncPaneToMain(paneChart) {
    const mainChart = TW.Chart.getChartInstance();
    if (!mainChart) return;
    mainChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncing || !range) return;
      syncing = true;
      paneChart.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    });
  }

  // ---- redraw --------------------------------------------------------------------

  function redraw(candlesArg) {
    const candles = candlesArg || TW.Chart.getCandles();
    const chart = TW.Chart.getChartInstance();
    if (!chart || !candles || candles.length === 0) return;

    // Moving averages
    Object.keys(maSeries).forEach((p) => {
      if (!state.ma.enabled || !state.ma.periods.includes(Number(p))) {
        chart.removeSeries(maSeries[p]);
        delete maSeries[p];
      }
    });
    if (state.ma.enabled) {
      state.ma.periods.forEach((period) => {
        if (!maSeries[period]) {
          maSeries[period] = chart.addLineSeries({
            color: MA_COLORS[period] || '#2196F3',
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          });
        }
        maSeries[period].setData(computeSMA(candles, Math.min(period, candles.length - 1) === 0 ? 1 : period));
      });
    }

    // Bollinger Bands
    if (state.bb.enabled) {
      if (!bbSeries) {
        bbSeries = {
          upper: chart.addLineSeries({ color: 'rgba(33,150,255,0.55)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
          middle: chart.addLineSeries({ color: 'rgba(33,150,255,0.9)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
          lower: chart.addLineSeries({ color: 'rgba(33,150,255,0.55)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
        };
      }
      const { upper, middle, lower } = computeBollinger(candles, state.bb.period, state.bb.stdDev);
      bbSeries.upper.setData(upper);
      bbSeries.middle.setData(middle);
      bbSeries.lower.setData(lower);
    } else if (bbSeries) {
      chart.removeSeries(bbSeries.upper);
      chart.removeSeries(bbSeries.middle);
      chart.removeSeries(bbSeries.lower);
      bbSeries = null;
    }

    // Volume (tick-volume proxy, see chart.js)
    if (state.volume.enabled) {
      if (!volumeSeries) {
        volumeSeries = chart.addHistogramSeries({
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
          priceLineVisible: false,
          lastValueVisible: false,
        });
        chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      }
      volumeSeries.setData(
        candles.map((c) => ({
          time: c.time,
          value: c.tickVolume || 0,
          color: c.close >= c.open ? 'rgba(0,200,150,0.5)' : 'rgba(255,68,68,0.5)',
        }))
      );
    } else if (volumeSeries) {
      chart.removeSeries(volumeSeries);
      volumeSeries = null;
    }

    // RSI sub-panel
    const rsiPane = document.getElementById('rsiPane');
    if (state.rsi.enabled) {
      ensureRsiChart();
      rsiSeries.setData(computeRSI(candles, state.rsi.period));
    } else if (rsiPane) {
      rsiPane.classList.add('hidden');
    }

    // MACD sub-panel
    const macdPane = document.getElementById('macdPane');
    if (state.macd.enabled) {
      ensureMacdChart();
      const { macdLine, signalLine, histogram } = computeMACD(candles, state.macd.fast, state.macd.slow, state.macd.signal);
      macdLineSeries.setData(macdLine);
      macdSignalSeries.setData(signalLine);
      macdHistSeries.setData(
        histogram.map((h) => ({ time: h.time, value: h.value, color: h.value >= 0 ? 'rgba(0,200,150,0.6)' : 'rgba(255,68,68,0.6)' }))
      );
    } else if (macdPane) {
      macdPane.classList.add('hidden');
    }
  }

  function toggle(name, enabled, options) {
    if (!state[name]) return;
    state[name].enabled = enabled;
    if (options) Object.assign(state[name], options);
    redraw();
  }

  function getState() {
    return JSON.parse(JSON.stringify(state));
  }

  function init() {
    TW.Chart.onCandlesUpdated(redraw);
  }

  return { init, toggle, getState, redraw };
})();
