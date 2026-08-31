'use strict';

window.TW = window.TW || {};

// Canvas-overlay drawing tools (trend line / rectangle / fibonacci / text) hybridized
// with native lightweight-charts price lines (horizontal line), so horizontal lines
// stay pixel-perfect on the price axis while the rest render on a transparent
// <canvas> positioned over the chart and redrawn on every pan/zoom/data update.
TW.Drawing = (function () {
  let canvas = null;
  let ctx = null;
  let container = null;
  let activeTool = 'cursor';
  let magnetOn = false;
  let pendingPoint = null;
  let hoverPoint = null;

  const drawingsBySymbol = { EURUSD: [], XAUUSD: [] };
  const priceLineHandles = new Map(); // drawing object -> native priceLine handle (horizontal type only)

  function init(canvasId, containerId) {
    canvas = document.getElementById(canvasId);
    container = document.getElementById(containerId);
    if (!canvas || !container) return;
    ctx = canvas.getContext('2d');
    resizeCanvas();

    window.addEventListener('resize', () => {
      resizeCanvas();
      redraw();
    });

    const chart = TW.Chart.getChartInstance();
    if (chart) {
      chart.timeScale().subscribeVisibleLogicalRangeChange(() => redraw());
    }
    TW.Chart.onCandlesUpdated(() => redraw());
    TW.Chart.onSymbolChanged((symbol, prevSymbol) => {
      hideHorizontalLines(prevSymbol);
      showHorizontalLines(symbol);
      pendingPoint = null;
      redraw();
    });

    canvas.addEventListener('click', onClick);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('dblclick', () => {
      pendingPoint = null;
      redraw();
    });
  }

  function resizeCanvas() {
    if (!canvas || !container) return;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
  }

  function setTool(tool) {
    activeTool = tool;
    pendingPoint = null;
    if (canvas) {
      canvas.classList.toggle('drawing-active', tool !== 'cursor');
      canvas.style.cursor = '';
    }
    const chart = TW.Chart.getChartInstance();
    if (chart) {
      const isCursor = tool === 'cursor' || tool === 'crosshair';
      chart.applyOptions({ handleScroll: isCursor, handleScale: isCursor });
    }
    redraw();
  }

  function setMagnet(on) {
    magnetOn = on;
  }

  function currentDrawings() {
    const symbol = TW.Chart.activeSymbol;
    if (!drawingsBySymbol[symbol]) drawingsBySymbol[symbol] = [];
    return drawingsBySymbol[symbol];
  }

  function snapPoint(time, price) {
    if (!magnetOn) return { time, price };
    const candles = TW.Chart.getCandles();
    if (!candles.length) return { time, price };
    let nearest = candles[0];
    for (const c of candles) {
      if (Math.abs(c.time - time) < Math.abs(nearest.time - time)) nearest = c;
    }
    return { time: nearest.time, price: nearest.close };
  }

  function xyToTimePrice(x, y) {
    const chart = TW.Chart.getChartInstance();
    const series = TW.Chart.getSeriesInstance();
    if (!chart || !series) return null;
    const time = chart.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (time === null || price === null) return null;
    return { time, price };
  }

  function timePriceToXY(time, price) {
    const chart = TW.Chart.getChartInstance();
    const series = TW.Chart.getSeriesInstance();
    if (!chart || !series) return null;
    const x = chart.timeScale().timeToCoordinate(time);
    const y = series.priceToCoordinate(price);
    if (x === null || y === null) return null;
    return { x, y };
  }

  function eventPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ---- click handling --------------------------------------------------------------

  const ERASE_HINT_KEY = 'tw_seen_erase_hint';

  function notifyDrawingCreated() {
    if (!TW.toast) return;
    try {
      if (localStorage.getItem(ERASE_HINT_KEY)) return;
      localStorage.setItem(ERASE_HINT_KEY, '1');
    } catch (e) {
      /* storage unavailable - just skip the "only once" tracking, not worth failing over */
    }
    TW.toast('To remove a drawing: pick the eraser (⌫) and click it, or use 🗑️ to clear all', 'info');
  }

  function onClick(e) {
    if (activeTool === 'cursor' || activeTool === 'crosshair') return;
    const { x, y } = eventPoint(e);
    const tp = xyToTimePrice(x, y);
    if (!tp) return;
    const snapped = snapPoint(tp.time, tp.price);

    if (activeTool === 'eraser') {
      eraseNear(x, y);
      return;
    }

    if (activeTool === 'horizontal') {
      const d = { type: 'horizontal', price: snapped.price };
      currentDrawings().push(d);
      createHorizontalLine(d);
      redraw();
      notifyDrawingCreated();
      return;
    }

    if (activeTool === 'text') {
      const text = window.prompt('Annotation text:');
      if (text) {
        currentDrawings().push({ type: 'text', time: snapped.time, price: snapped.price, text });
        redraw();
        notifyDrawingCreated();
      }
      return;
    }

    if (activeTool === 'trend' || activeTool === 'rectangle' || activeTool === 'fib') {
      if (!pendingPoint) {
        pendingPoint = snapped;
      } else {
        currentDrawings().push({ type: activeTool, p1: pendingPoint, p2: snapped });
        pendingPoint = null;
        redraw();
        notifyDrawingCreated();
      }
    }
  }

  function onMouseMove(e) {
    if (activeTool === 'eraser') {
      const { x, y } = eventPoint(e);
      // Cursor swaps to a pointing hand right over anything the next click would
      // delete, and back to the eraser's own crosshair otherwise - without this,
      // clicking empty space with no visible reaction reads as "nothing happened,"
      // which is exactly the "can't delete it" complaint this is fixing.
      canvas.style.cursor = findDrawingIndexNear(x, y) !== -1 ? 'pointer' : 'crosshair';
      return;
    }
    if (!pendingPoint) return;
    const { x, y } = eventPoint(e);
    const tp = xyToTimePrice(x, y);
    if (!tp) return;
    hoverPoint = snapPoint(tp.time, tp.price);
    redraw();
  }

  const ERASE_THRESHOLD = 10; // a little more forgiving than a precise pixel-perfect click

  function findDrawingIndexNear(x, y) {
    const list = currentDrawings();
    for (let i = list.length - 1; i >= 0; i--) {
      if (hitTest(list[i], x, y, ERASE_THRESHOLD)) return i;
    }
    return -1;
  }

  function eraseNear(x, y) {
    const list = currentDrawings();
    const i = findDrawingIndexNear(x, y);
    if (i === -1) return;
    const d = list[i];
    if (d.type === 'horizontal') removeHorizontalLine(d);
    list.splice(i, 1);
    redraw();
  }

  function hitTest(d, x, y, threshold) {
    const series = TW.Chart.getSeriesInstance();
    if (d.type === 'horizontal') {
      const ly = series.priceToCoordinate(d.price);
      return ly !== null && Math.abs(ly - y) <= threshold;
    }
    if (d.type === 'text') {
      const p = timePriceToXY(d.time, d.price);
      return !!p && Math.abs(p.x - x) <= 40 && Math.abs(p.y - y) <= 14;
    }
    if (d.type === 'trend') {
      const a = timePriceToXY(d.p1.time, d.p1.price);
      const b = timePriceToXY(d.p2.time, d.p2.price);
      if (!a || !b) return false;
      return distToSegment(x, y, a.x, a.y, b.x, b.y) <= threshold;
    }
    if (d.type === 'rectangle' || d.type === 'fib') {
      const a = timePriceToXY(d.p1.time, d.p1.price);
      const b = timePriceToXY(d.p2.time, d.p2.price);
      if (!a || !b) return false;
      const minX = Math.min(a.x, b.x) - threshold;
      const maxX = Math.max(a.x, b.x) + threshold;
      const minY = Math.min(a.y, b.y) - threshold;
      const maxY = Math.max(a.y, b.y) + threshold;
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }
    return false;
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  // ---- native horizontal price lines ------------------------------------------------

  function createHorizontalLine(d) {
    const series = TW.Chart.getSeriesInstance();
    if (!series) return;
    const handle = series.createPriceLine({
      price: d.price,
      color: '#ffd700',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Solid,
      axisLabelVisible: true,
      title: 'H-Line',
    });
    priceLineHandles.set(d, handle);
  }

  function removeHorizontalLine(d) {
    const series = TW.Chart.getSeriesInstance();
    const handle = priceLineHandles.get(d);
    if (series && handle) series.removePriceLine(handle);
    priceLineHandles.delete(d);
  }

  function hideHorizontalLines(symbol) {
    (drawingsBySymbol[symbol] || []).forEach((d) => {
      if (d.type === 'horizontal') removeHorizontalLine(d);
    });
  }

  function showHorizontalLines(symbol) {
    (drawingsBySymbol[symbol] || []).forEach((d) => {
      if (d.type === 'horizontal') createHorizontalLine(d);
    });
  }

  // ---- render -------------------------------------------------------------------

  function redraw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawMatchStartLine();
    currentDrawings().forEach((d) => drawOne(d, false));
    if (pendingPoint && hoverPoint && (activeTool === 'trend' || activeTool === 'rectangle' || activeTool === 'fib')) {
      drawOne({ type: activeTool, p1: pendingPoint, p2: hoverPoint }, true);
    }
  }

  // Always-on system marker (not a user drawing, not erasable) showing exactly
  // where the 2-hour pre-match history ends and live trading begins.
  function drawMatchStartLine() {
    const chart = TW.Chart.getChartInstance();
    if (!chart) return;
    const x = chart.timeScale().timeToCoordinate(0);
    if (x === null) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.font = 'bold 11px sans-serif';
    const label = 'MATCH START';
    const textWidth = ctx.measureText(label).width;
    const padX = 6;
    const boxX = x + 6;
    ctx.fillStyle = 'rgba(13, 13, 13, 0.85)';
    ctx.fillRect(boxX, 4, textWidth + padX * 2, 18);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.strokeRect(boxX, 4, textWidth + padX * 2, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, boxX + padX, 17);
    ctx.restore();
  }

  function drawOne(d, isPreview) {
    if (d.type === 'horizontal') return; // rendered natively via series.createPriceLine

    ctx.save();
    ctx.strokeStyle = isPreview ? 'rgba(255,215,0,0.55)' : '#ffd700';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(isPreview ? [4, 4] : []);
    ctx.font = '11px sans-serif';

    if (d.type === 'text') {
      const p = timePriceToXY(d.time, d.price);
      if (p) {
        ctx.fillText(d.text, p.x + 5, p.y - 5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }

    const a = timePriceToXY(d.p1.time, d.p1.price);
    const b = timePriceToXY(d.p2.time, d.p2.price);
    if (!a || !b) {
      ctx.restore();
      return;
    }

    if (d.type === 'trend') {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    } else if (d.type === 'rectangle') {
      const minX = Math.min(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      ctx.fillStyle = 'rgba(255,215,0,0.12)';
      ctx.fillRect(minX, minY, w, h);
      ctx.strokeRect(minX, minY, w, h);
    } else if (d.type === 'fib') {
      const series = TW.Chart.getSeriesInstance();
      const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      levels.forEach((lvl) => {
        const price = d.p1.price + (d.p2.price - d.p1.price) * lvl;
        const y = series.priceToCoordinate(price);
        if (y === null) return;
        ctx.beginPath();
        ctx.moveTo(minX, y);
        ctx.lineTo(maxX, y);
        ctx.stroke();
        ctx.fillText(`${(lvl * 100).toFixed(1)}%  ${price.toFixed(5)}`, maxX + 4, y + 3);
      });
    }
    ctx.restore();
  }

  function clearAll() {
    hideHorizontalLines(TW.Chart.activeSymbol);
    drawingsBySymbol[TW.Chart.activeSymbol] = [];
    redraw();
  }

  return {
    init,
    setTool,
    setMagnet,
    redraw,
    clearAll,
    get activeTool() {
      return activeTool;
    },
  };
})();
