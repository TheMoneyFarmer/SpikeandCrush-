'use strict';

window.TW = window.TW || {};

TW.Chart = (function () {
  // Seconds per candle. With 2 hours of pre-match history now loaded (see
  // loadPreMatchHistory), the higher timeframes are meaningful for browsing
  // history even though a 10-minute match itself never fills a complete H1/H4
  // bar live - same as real MT5 showing a partial forming candle.
  const TIMEFRAMES = [5, 10, 30, 60, 300, 900, 1800, 3600, 14400];
  const TIMEFRAME_LABELS = { 5: '5s', 10: '10s', 30: '30s', 60: 'M1', 300: 'M5', 900: 'M15', 1800: 'M30', 3600: 'H1', 14400: 'H4' };
  // How many candles to auto-fit into view right after switching to each timeframe.
  const TIMEFRAME_AUTOFIT_BARS = { 5: 60, 10: 60, 30: 60, 60: 60, 300: 48, 900: 32, 1800: 24, 3600: 24, 14400: 30 };
  const DEFAULT_TIMEFRAME = 5;
  const PRE_MATCH_SECONDS = 7200; // 2 hours - keep in sync with server/marketData.js

  let chart = null;
  let series = null;
  let activeSymbol = 'EURUSD';
  let ghosted = false;
  let timeframeSeconds = DEFAULT_TIMEFRAME;
  // {t: elapsedSeconds (negative = pre-match), mid}[] - full-resolution history,
  // keyed lazily per symbol (was hardcoded to EURUSD/XAUUSD only, which broke
  // every other instrument once match instrument rotation shipped).
  const rawTicks = {};
  const preMatchLoaded = {};
  const candleUpdateSubscribers = [];
  const symbolChangeSubscribers = [];

  const settings = {
    bullColor: '#00c896',
    bearColor: '#ff4444',
    background: 'dark',
    showGrid: true,
    crosshairStyle: 'solid', // solid | dashed | none
    priceScalePosition: 'right',
    showVolume: false,
  };

  const positionLines = new Map(); // positionId -> { entry, sl, tp } price line handles
  const positionData = new Map(); // positionId -> { symbol, direction, stopLoss, takeProfit, lots, entryPrice, colorIndex }
  let onSlTpModify = null; // (positionId, field, price) => void, set via enablePositionLineDragging
  let dragging = null; // { positionId, field, startPrice, colorIndex } while a drag is in progress

  // EURUSD/XAUUSD values are unchanged from before instrument rotation shipped
  // (kept exact, including XAUUSD's display-only 0.1 pip vs. the server's 0.01)
  // - the rest mirror server/instruments.js's pipSize/contractSize.
  const PIP_SIZE = {
    EURUSD: 0.0001, XAUUSD: 0.1,
    GBPUSD: 0.0001, USDJPY: 0.01, USDCHF: 0.0001, AUDUSD: 0.0001, USDCAD: 0.0001, NZDUSD: 0.0001,
    XAGUSD: 0.001, NAS100: 0.1, US30: 0.1, UK100: 0.1, GER40: 0.1, BRENT: 0.01, USOIL: 0.01,
    BTCUSD: 0.01, ETHUSD: 0.01, USTUSD: 0.0001, AAPL: 0.01,
  };
  const CONTRACT_SIZE = {
    EURUSD: 100000, XAUUSD: 100,
    GBPUSD: 100000, USDJPY: 100000, USDCHF: 100000, AUDUSD: 100000, USDCAD: 100000, NZDUSD: 100000,
    XAGUSD: 5000, NAS100: 1, US30: 1, UK100: 1, GER40: 1, BRENT: 1000, USOIL: 1000,
    BTCUSD: 1, ETHUSD: 1, USTUSD: 1, AAPL: 1,
  };
  const DRAG_COLOR = '#ffeb3b';
  const FLASH_COLOR = '#ff1744';
  // Position 1 (oldest of the up-to-3 visible) / 2 / 3 each get a distinct
  // entry/SL/TP palette so overlapping lines from different positions are
  // never ambiguous about which position they belong to.
  const POSITION_COLOR_SETS = [
    { entry: '#ffffff', sl: '#ff4444', tp: '#00c896' },
    { entry: '#4da6ff', sl: '#ff9800', tp: '#00e5ff' },
    { entry: '#b388ff', sl: '#ff4da6', tp: '#a6ff4d' },
  ];

  function pipsBetween(symbol, priceA, priceB) {
    const pip = PIP_SIZE[symbol] || 0.0001;
    return Math.abs(priceA - priceB) / pip;
  }

  function dollarAmount(symbol, lots, priceA, priceB) {
    const size = CONTRACT_SIZE[symbol] || 0;
    return Math.abs(priceA - priceB) * lots * size;
  }

  function currentPriceFor(symbol) {
    const ticks = rawTicks[symbol];
    return ticks && ticks.length ? ticks[ticks.length - 1].mid : null;
  }

  // The "time" values fed to this chart are match-elapsed seconds (0-600), not real
  // UNIX timestamps - lightweight-charts treats a bare number as UTCTimestamp seconds,
  // so passing 0-600 directly renders as "Jan 1 1970 00:00-00:10". A 10-minute match has
  // no real calendar date to show anyway, so every place time reaches the UI is formatted
  // as elapsed match clock (mm:ss) instead of a date.
  function formatElapsedClock(totalSeconds) {
    // Pre-match history carries negative elapsed times (up to -PRE_MATCH_SECONDS);
    // clamping those to 0 would collapse every historical tick mark onto the
    // same "00:00" label, so negatives get their own sign + hour-aware format.
    const negative = totalSeconds < 0;
    const s = Math.floor(Math.abs(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const sign = negative ? '-' : '';
    if (h > 0) {
      return `${sign}${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }
    return `${sign}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function init(containerId) {
    const container = document.getElementById(containerId);
    chart = LightweightCharts.createChart(container, {
      layout: { background: { color: '#0d0d0d' }, textColor: '#888888' },
      grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
      timeScale: {
        timeVisible: true,
        secondsVisible: true,
        borderColor: '#2a2a2a',
        tickMarkFormatter: (time) => formatElapsedClock(time),
        // A fixed pixel width per candle (rather than fitContent()'s "stretch whatever
        // few bars exist to fill the chart") is what avoids 1-2 candles at match start
        // rendering as giant blocks - the same fixed spacing then naturally shows more
        // bars as the match progresses, with shiftVisibleRangeOnNewBar (on by default)
        // auto-scrolling to keep the latest candle in view.
        barSpacing: 8,
      },
      localization: {
        timeFormatter: (time) => formatElapsedClock(time),
      },
      rightPriceScale: { borderColor: '#2a2a2a' },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      autoSize: true,
    });
    series = chart.addCandlestickSeries({
      upColor: settings.bullColor,
      downColor: settings.bearColor,
      borderVisible: false,
      wickUpColor: settings.bullColor,
      wickDownColor: settings.bearColor,
    });
  }

  function buildCandles(symbol, tf) {
    const candles = [];
    let prevMid = null;
    // rawTicks is sorted (pre-match history prepended once, then live ticks
    // appended in order) so a single left-to-right bucketing pass is safe -
    // bucket(-1, tf) is always -1 and bucket(0, tf) is always 0 for any tf,
    // so a pre-match tick and a live tick never land in the same bucket.
    for (const { t, mid } of rawTicks[symbol] || []) {
      const bucket = Math.floor(t / tf);
      let candle = candles[candles.length - 1];
      // No real order book exists in this simulated market, so "tick volume"
      // (cumulative tick-to-tick price movement) stands in for volume -
      // the same convention many retail forex platforms use.
      const movement = prevMid === null ? 0 : Math.abs(mid - prevMid);
      if (!candle || candle.bucket !== bucket) {
        candle = {
          bucket,
          time: bucket * tf,
          open: mid,
          high: mid,
          low: mid,
          close: mid,
          tickVolume: movement,
          isPreMatch: bucket < 0,
        };
        candles.push(candle);
      } else {
        candle.high = Math.max(candle.high, mid);
        candle.low = Math.min(candle.low, mid);
        candle.close = mid;
        candle.tickVolume += movement;
      }
      prevMid = mid;
    }
    return candles;
  }

  // Blends a hex color toward the chart background so pre-match candles read
  // as dimmed (~0.6 opacity) without needing per-bar alpha, which lightweight-
  // charts candlestick bars don't support directly - only solid color overrides.
  function blendTowardBackground(hex, alpha) {
    const bg = { r: 0x0d, g: 0x0d, b: 0x0d };
    const c = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
    const mix = (a, b) => Math.round(a * alpha + b * (1 - alpha));
    return `rgb(${mix(c.r, bg.r)}, ${mix(c.g, bg.g)}, ${mix(c.b, bg.b)})`;
  }

  let lastCandles = [];

  function refreshActiveSeries() {
    if (!series) return;
    const candles = buildCandles(activeSymbol, timeframeSeconds);
    lastCandles = candles;
    const dimBull = blendTowardBackground(settings.bullColor, 0.6);
    const dimBear = blendTowardBackground(settings.bearColor, 0.6);
    series.setData(
      candles.map((c) => {
        const bar = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
        if (c.isPreMatch) {
          const dim = c.close >= c.open ? dimBull : dimBear;
          bar.color = dim;
          bar.wickColor = dim;
          bar.borderColor = dim;
        }
        return bar;
      })
    );
    candleUpdateSubscribers.forEach((fn) => fn(candles));
  }

  function pushTick(symbol, elapsedSeconds, mid) {
    if (!rawTicks[symbol]) rawTicks[symbol] = [];
    rawTicks[symbol].push({ t: elapsedSeconds, mid });
    if (symbol === activeSymbol && !ghosted) refreshActiveSeries();
  }

  // Seeds 2 hours of dimmed historical candles ahead of any live ticks. Safe to
  // call once per match load; a second call for the same symbol is a no-op so
  // reconnects/re-renders don't duplicate the prefix.
  function loadPreMatchHistory(historyBySymbol) {
    Object.entries(historyBySymbol || {}).forEach(([symbol, ticks]) => {
      if (preMatchLoaded[symbol]) return;
      if (!rawTicks[symbol]) rawTicks[symbol] = [];
      const preTicks = ticks.map((p) => ({ t: p.t, mid: p.mid }));
      rawTicks[symbol] = preTicks.concat(rawTicks[symbol]);
      preMatchLoaded[symbol] = true;
    });
    if (!ghosted) refreshActiveSeries();
  }

  function setActiveSymbol(symbol) {
    const prevSymbol = activeSymbol;
    activeSymbol = symbol;
    positionLines.forEach((lines) => removePositionLineSet(lines));
    positionLines.clear();
    refreshActiveSeries();
    symbolChangeSubscribers.forEach((fn) => fn(symbol, prevSymbol));
  }

  function onSymbolChanged(fn) {
    symbolChangeSubscribers.push(fn);
  }

  function setTimeframe(seconds) {
    timeframeSeconds = seconds;
    refreshActiveSeries();
    // Snap to a meaningful window for the new timeframe. A logical (bar-index)
    // range set once, right in response to this explicit user action, is safe -
    // unlike setVisibleRange, it isn't fought by the next tick's setData() call
    // because shiftVisibleRangeOnNewBar extends from wherever the view already is.
    const barCount = TIMEFRAME_AUTOFIT_BARS[seconds] || 60;
    const total = lastCandles.length;
    if (total > 0 && chart) {
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - barCount), to: total });
    }
  }

  function setGhosted(active) {
    ghosted = active;
    const el = document.getElementById('chartCanvas');
    if (el) el.classList.toggle('chart-ghosted', active);
    if (!active) refreshActiveSeries();
  }

  function setVolatile(active) {
    const el = document.getElementById('chartCanvas');
    if (el) el.classList.toggle('chart-volatile', active);
  }

  function reset() {
    Object.keys(rawTicks).forEach((symbol) => delete rawTicks[symbol]);
    Object.keys(preMatchLoaded).forEach((symbol) => delete preMatchLoaded[symbol]);
  }

  function onCandlesUpdated(fn) {
    candleUpdateSubscribers.push(fn);
  }

  // ---- settings ------------------------------------------------------------------

  function applySettings(patch) {
    Object.assign(settings, patch);
    if (!chart || !series) return;

    series.applyOptions({
      upColor: settings.bullColor,
      downColor: settings.bearColor,
      wickUpColor: settings.bullColor,
      wickDownColor: settings.bearColor,
    });

    const isLight = settings.background === 'light';
    chart.applyOptions({
      layout: {
        background: { color: isLight ? '#ffffff' : '#0d0d0d' },
        textColor: isLight ? '#333333' : '#888888',
      },
      grid: {
        vertLines: { visible: settings.showGrid, color: isLight ? '#e5e5e5' : '#1f1f1f' },
        horzLines: { visible: settings.showGrid, color: isLight ? '#e5e5e5' : '#1f1f1f' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { visible: settings.crosshairStyle !== 'none', style: settings.crosshairStyle === 'dashed' ? 1 : 0 },
        horzLine: { visible: settings.crosshairStyle !== 'none', style: settings.crosshairStyle === 'dashed' ? 1 : 0 },
      },
      rightPriceScale: { visible: settings.priceScalePosition === 'right' },
      leftPriceScale: { visible: settings.priceScalePosition === 'left' },
    });
  }

  function getSettings() {
    return { ...settings };
  }

  // ---- position price lines (entry / SL / TP) ------------------------------------

  function removePositionLineSet(lines) {
    if (lines.entry) series.removePriceLine(lines.entry);
    if (lines.sl) series.removePriceLine(lines.sl);
    if (lines.tp) series.removePriceLine(lines.tp);
  }

  const MAX_VISIBLE_POSITION_LINES = 3; // chart-clutter cap, independent of the trading position limit

  function setPositionLines(positions) {
    if (!series) return;
    // `positions` is always the human viewer's own myAccount.positions mirror (see
    // game.js match:state/trade:executed handlers) - AI players' positions never reach
    // this function, so there's nothing to filter out on that front. What DOES need
    // capping is clutter: only render the most recently opened positions on this symbol.
    const seen = new Set();
    (positions || [])
      .filter((p) => p.symbol === activeSymbol)
      .slice(-MAX_VISIBLE_POSITION_LINES)
      .forEach((p, colorIndex) => {
        // Skip re-rendering the line currently under the user's finger/cursor -
        // the drag handler owns it (drawn in DRAG_COLOR) until the drag ends.
        if (dragging && dragging.positionId === p.id) {
          positionData.set(p.id, { ...positionData.get(p.id), lots: p.lots, entryPrice: p.entryPrice });
          seen.add(p.id);
          return;
        }

        const colors = POSITION_COLOR_SETS[colorIndex] || POSITION_COLOR_SETS[POSITION_COLOR_SETS.length - 1];
        positionData.set(p.id, {
          symbol: p.symbol,
          direction: p.direction,
          stopLoss: p.stopLoss,
          takeProfit: p.takeProfit,
          lots: p.lots,
          entryPrice: p.entryPrice,
          colorIndex,
        });
        seen.add(p.id);
        let lines = positionLines.get(p.id);
        if (!lines) {
          lines = {};
          positionLines.set(p.id, lines);
        }

        if (lines.entry) series.removePriceLine(lines.entry);
        lines.entry = series.createPriceLine({
          price: p.entryPrice,
          color: colors.entry,
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: `ENTRY ${p.lots} ${p.direction} @ ${p.entryPrice}`,
        });

        if (lines.sl) {
          series.removePriceLine(lines.sl);
          lines.sl = null;
        }
        if (p.stopLoss) {
          const risk = dollarAmount(p.symbol, p.lots, p.entryPrice, p.stopLoss);
          lines.sl = series.createPriceLine({
            price: p.stopLoss,
            color: colors.sl,
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: `SL -$${risk.toFixed(0)}`,
          });
        }

        if (lines.tp) {
          series.removePriceLine(lines.tp);
          lines.tp = null;
        }
        if (p.takeProfit) {
          const reward = dollarAmount(p.symbol, p.lots, p.entryPrice, p.takeProfit);
          lines.tp = series.createPriceLine({
            price: p.takeProfit,
            color: colors.tp,
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: `TP +$${reward.toFixed(0)}`,
          });
        }
      });

    for (const [id, lines] of positionLines) {
      if (!seen.has(id)) {
        removePositionLineSet(lines);
        positionLines.delete(id);
        positionData.delete(id);
      }
    }
  }

  // ---- drag SL/TP lines directly on the chart ------------------------------------

  function enablePositionLineDragging(containerId, onModify) {
    onSlTpModify = onModify;
    const container = document.getElementById(containerId);
    if (!container) return;

    let tooltipEl = null;
    let riskZoneEl = null;
    let rewardZoneEl = null;
    let longPressTimer = null;
    let touchStartY = null;

    function ensureOverlayEls() {
      // Appended to the wrapper we own (not the element handed to
      // LightweightCharts.createChart(), which the library treats as its own
      // to manage) so nothing here risks the chart library's internal DOM.
      const overlayParent = document.getElementById('chartCanvasWrap') || container;
      if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.style.cssText =
          'position:absolute;pointer-events:none;z-index:20;background:rgba(13,13,13,0.95);' +
          'border:1px solid #ffeb3b;border-radius:6px;padding:6px 10px;font-size:12px;' +
          "font-family:'JetBrains Mono',monospace;color:#fff;white-space:nowrap;display:none;line-height:1.5;";
        overlayParent.appendChild(tooltipEl);
      }
      if (!riskZoneEl) {
        riskZoneEl = document.createElement('div');
        riskZoneEl.style.cssText = 'position:absolute;left:0;width:100%;pointer-events:none;z-index:4;background:rgba(255,68,68,0.14);display:none;';
        overlayParent.appendChild(riskZoneEl);
      }
      if (!rewardZoneEl) {
        rewardZoneEl = document.createElement('div');
        rewardZoneEl.style.cssText = 'position:absolute;left:0;width:100%;pointer-events:none;z-index:4;background:rgba(0,200,150,0.14);display:none;';
        overlayParent.appendChild(rewardZoneEl);
      }
    }

    function findLineNear(y) {
      const threshold = 8;
      for (const [id, data] of positionData) {
        if (data.symbol !== activeSymbol) continue;
        if (data.stopLoss) {
          const ly = series.priceToCoordinate(data.stopLoss);
          if (ly !== null && Math.abs(ly - y) <= threshold) return { positionId: id, field: 'stopLoss' };
        }
        if (data.takeProfit) {
          const ly = series.priceToCoordinate(data.takeProfit);
          if (ly !== null && Math.abs(ly - y) <= threshold) return { positionId: id, field: 'takeProfit' };
        }
      }
      return null;
    }

    // Entry stays fixed - only SL/TP can ever be dragged (never offered by findLineNear).
    function validate(data, field, price) {
      const pip = PIP_SIZE[data.symbol] || 0.0001;
      if (field === 'stopLoss') {
        if (data.direction === 'BUY' && price >= data.entryPrice) return { valid: false, reason: 'Stop loss must stay below entry for a BUY' };
        if (data.direction === 'SELL' && price <= data.entryPrice) return { valid: false, reason: 'Stop loss must stay above entry for a SELL' };
      } else {
        if (data.direction === 'BUY' && price <= data.entryPrice) return { valid: false, reason: 'Take profit must stay above entry for a BUY' };
        if (data.direction === 'SELL' && price >= data.entryPrice) return { valid: false, reason: 'Take profit must stay below entry for a SELL' };
      }
      const current = currentPriceFor(data.symbol);
      if (current !== null && Math.abs(price - current) < 2 * pip) {
        return { valid: false, reason: 'Too close to the current price (min 2 pips) - would trigger instantly' };
      }
      return { valid: true };
    }

    function drawDragLine(price, color) {
      const lines = positionLines.get(dragging.positionId);
      if (!lines) return;
      const key = dragging.field === 'stopLoss' ? 'sl' : 'tp';
      if (lines[key]) series.removePriceLine(lines[key]);
      lines[key] = series.createPriceLine({
        price,
        color,
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: dragging.field === 'stopLoss' ? 'SL' : 'TP',
      });
    }

    function updateZones(data) {
      const entryY = series.priceToCoordinate(data.entryPrice);
      if (entryY === null) return;
      if (data.stopLoss !== null && data.stopLoss !== undefined) {
        const slY = series.priceToCoordinate(data.stopLoss);
        if (slY !== null) {
          riskZoneEl.style.top = `${Math.min(entryY, slY)}px`;
          riskZoneEl.style.height = `${Math.max(1, Math.abs(entryY - slY))}px`;
          riskZoneEl.style.display = 'block';
        }
      }
      if (data.takeProfit !== null && data.takeProfit !== undefined) {
        const tpY = series.priceToCoordinate(data.takeProfit);
        if (tpY !== null) {
          rewardZoneEl.style.top = `${Math.min(entryY, tpY)}px`;
          rewardZoneEl.style.height = `${Math.max(1, Math.abs(entryY - tpY))}px`;
          rewardZoneEl.style.display = 'block';
        }
      }
    }

    function updateTooltip(x, y, data, price, result) {
      const pips = pipsBetween(data.symbol, price, data.entryPrice);
      const amount = dollarAmount(data.symbol, data.lots, price, data.entryPrice);
      const label = dragging.field === 'stopLoss' ? 'SL' : 'TP';
      const amountLabel = dragging.field === 'stopLoss' ? `Risk: $${amount.toFixed(2)}` : `Reward: $${amount.toFixed(2)}`;
      const decimals = (PIP_SIZE[data.symbol] || 0.0001) < 0.01 ? 5 : 2;
      tooltipEl.innerHTML =
        `<strong>New ${label}: ${price.toFixed(decimals)}</strong><br/>${pips.toFixed(1)} pips from entry &middot; ${amountLabel}` +
        (result.valid ? '' : `<br/><span style="color:#ff5252;">${result.reason}</span>`);
      tooltipEl.style.borderColor = result.valid ? '#ffeb3b' : '#ff1744';
      tooltipEl.style.left = `${x + 14}px`;
      tooltipEl.style.top = `${Math.max(0, y - 40)}px`;
      tooltipEl.style.display = 'block';
    }

    function hideOverlays() {
      if (tooltipEl) tooltipEl.style.display = 'none';
      if (riskZoneEl) riskZoneEl.style.display = 'none';
      if (rewardZoneEl) rewardZoneEl.style.display = 'none';
    }

    function startDrag(hit) {
      ensureOverlayEls();
      const data = positionData.get(hit.positionId);
      if (!data) return false;
      dragging = { positionId: hit.positionId, field: hit.field, startPrice: data[hit.field] };
      chart.applyOptions({ handleScroll: false, handleScale: false });
      container.style.cursor = 'ns-resize';
      return true;
    }

    function moveDrag(x, y) {
      if (!dragging) return;
      const price = series.coordinateToPrice(y);
      if (price === null) return;
      const data = positionData.get(dragging.positionId);
      if (!data) return;
      const result = validate(data, dragging.field, price);
      data[dragging.field] = price;
      drawDragLine(price, result.valid ? DRAG_COLOR : FLASH_COLOR);
      updateZones(data);
      updateTooltip(x, y, data, price, result);
    }

    // Blinks the rejected line red a few times, then leaves it - the very next
    // price tick's normal renderPositions()/setPositionLines() call (within ~1s)
    // redraws it at the position's real color and its pre-drag price, completing
    // the "snap back" without needing to hand-animate a tween back to place.
    function flashInvalid(positionId, field, revertPrice) {
      const lines = positionLines.get(positionId);
      if (!lines) return;
      const key = field === 'stopLoss' ? 'sl' : 'tp';
      let blinks = 0;
      const blink = setInterval(() => {
        if (lines[key]) series.removePriceLine(lines[key]);
        lines[key] = series.createPriceLine({
          price: revertPrice,
          color: blinks % 2 === 0 ? FLASH_COLOR : 'rgba(255, 23, 68, 0.25)',
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: field === 'stopLoss' ? 'SL' : 'TP',
        });
        blinks += 1;
        if (blinks >= 4) clearInterval(blink);
      }, 100);
    }

    function endDrag() {
      if (!dragging) return;
      const { positionId, field, startPrice } = dragging;
      const data = positionData.get(positionId);
      chart.applyOptions({ handleScroll: true, handleScale: true });
      container.style.cursor = 'default';
      hideOverlays();

      if (!data) {
        dragging = null;
        return;
      }
      const finalPrice = data[field];
      const result = validate(data, field, finalPrice);

      if (!result.valid) {
        data[field] = startPrice;
        if (TW.toast) TW.toast(result.reason, 'danger');
        flashInvalid(positionId, field, startPrice);
        dragging = null;
        return;
      }

      dragging = null;
      if (onSlTpModify) onSlTpModify(positionId, field, finalPrice);
    }

    // ---- mouse --------------------------------------------------------------------
    container.addEventListener('mousedown', (e) => {
      const hit = findLineNear(e.offsetY);
      if (!hit) return;
      if (startDrag(hit)) moveDrag(e.offsetX, e.offsetY);
    });
    container.addEventListener('mousemove', (e) => {
      if (!dragging) {
        container.style.cursor = findLineNear(e.offsetY) ? 'ns-resize' : 'default';
        return;
      }
      moveDrag(e.offsetX, e.offsetY);
    });
    container.addEventListener('mouseup', endDrag);
    container.addEventListener('mouseleave', endDrag);

    // ---- touch: long-press to grab a line, drag, release to confirm ---------------
    function touchPoint(e) {
      const rect = container.getBoundingClientRect();
      const t = e.touches[0] || e.changedTouches[0];
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }

    container.addEventListener(
      'touchstart',
      (e) => {
        const { x, y } = touchPoint(e);
        const hit = findLineNear(y);
        if (!hit) return;
        touchStartY = y;
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (startDrag(hit)) {
            if (navigator.vibrate) navigator.vibrate(40);
            moveDrag(x, y);
          }
        }, 450);
      },
      { passive: true }
    );

    container.addEventListener(
      'touchmove',
      (e) => {
        if (!dragging) {
          if (longPressTimer && touchStartY !== null) {
            const { y } = touchPoint(e);
            if (Math.abs(y - touchStartY) > 10) {
              clearTimeout(longPressTimer);
              longPressTimer = null;
            }
          }
          return;
        }
        e.preventDefault();
        const { x, y } = touchPoint(e);
        moveDrag(x, y);
      },
      { passive: false }
    );

    container.addEventListener('touchend', () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      const wasDragging = !!dragging;
      endDrag();
      if (wasDragging && navigator.vibrate) navigator.vibrate(20);
    });
    container.addEventListener('touchcancel', () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      endDrag();
    });
  }

  return {
    TIMEFRAMES,
    TIMEFRAME_LABELS,
    DEFAULT_TIMEFRAME,
    PRE_MATCH_SECONDS,
    init,
    pushTick,
    loadPreMatchHistory,
    setActiveSymbol,
    setTimeframe,
    setGhosted,
    setVolatile,
    reset,
    onCandlesUpdated,
    onSymbolChanged,
    applySettings,
    getSettings,
    setPositionLines,
    enablePositionLineDragging,
    getChartInstance: () => chart,
    getSeriesInstance: () => series,
    getCandles: () => lastCandles,
    getPositionData: () => Array.from(positionData.entries()),
    formatElapsedClock,
    get activeSymbol() {
      return activeSymbol;
    },
    get timeframeSeconds() {
      return timeframeSeconds;
    },
  };
})();
