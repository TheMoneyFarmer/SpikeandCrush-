'use strict';

// Play screen for long-form competitions (/competition/:id). Everything on
// screen is rebuilt from GET /api/competitions/:id/account, so a refresh, a
// locked phone or a dropped connection loses nothing - the socket
// (comp:update every ~5s) only makes it live in between.
(function () {
  const compId = (window.location.pathname.match(/\/competition\/([0-9a-f-]{36})/i) || [])[1];
  // Base data is 5-minute bars, so seconds/1m timeframes have nothing to show.
  const COMP_TIMEFRAMES = [300, 900, 1800, 3600, 14400, 86400];
  const DEFAULT_TF = 900;
  const POLL_MS = 15000;
  const LEADERBOARD_MS = 30000;

  let view = null;
  let activeSymbol = null;
  let selectedLots = 1;
  let chartOrigin = null; // competition-calendar epoch seconds at chart t=0
  let lastPushedTime = {};
  let lastTradeIds = new Set();

  const $ = (id) => document.getElementById(id);
  const money = (n) => TW.formatMoney(Number(n) || 0);

  function fmtLeft(ms) {
    if (ms <= 0) return '0:00';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function fmtCompTime(epoch) {
    const d = new Date(epoch * 1000);
    // "Sat 31 Oct 03:30 UTC" - toUTCString() starts "Sat, 31 Oct 2026 ...".
    const [wd, day, mon] = d.toUTCString().replace(',', '').split(' ');
    return `${wd} ${day} ${mon} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  }

  // ---- rendering -----------------------------------------------------------------

  function renderHeader() {
    const c = view.competition;
    $('compTitle').textContent = c.title + (c.isTest ? ' (TEST)' : '');
    document.title = `${c.title} — Spike & Crush`;
    $('compEquity').textContent = money(view.account.equity);
    const pnl = view.account.equity - view.account.startingCapital;
    $('compPnl').textContent = `${pnl >= 0 ? '+' : ''}${money(pnl)}`;
    $('compPnl').className = `value ${pnl >= 0 ? 'text-buy' : 'text-sell'}`;
    $('compRank').textContent = view.rank ? `#${view.rank} / ${view.entrants}` : '—';
    $('compSession').textContent = view.session || '—';
    $('summaryBalance').textContent = money(view.account.balance);
    $('summaryEquity').textContent = money(view.account.equity);
    $('summaryTrades').textContent = view.account.tradeCount;
    if (view.compTime) $('quoteTime').textContent = fmtCompTime(view.compTime);
    renderBanner();
  }

  function renderBanner() {
    const c = view.competition;
    const banner = $('compBanner');
    const now = Date.now();
    let text = '';
    let cls = '';
    if (c.status === 'void') {
      text = 'This competition was cancelled - entry fees were refunded.';
      cls = 'closed';
    } else if (c.status === 'ended' || now >= new Date(c.endsAt).getTime()) {
      const a = view.account;
      const prize = a.prizeCoins ? `${Number(a.prizeCoins).toLocaleString()} coins` : '';
      text = a.finalRank ? `Competition over - you finished #${a.finalRank}${prize ? ` and won ${prize}` : ''}.` : 'Competition over - final results are being calculated.';
      cls = 'ended';
    } else if (now < new Date(c.startsAt).getTime()) {
      text = `Starts in ${fmtLeft(new Date(c.startsAt).getTime() - now)} - you're entered. Study the charts until then.`;
      cls = 'waiting';
    } else if (view.account.status === 'loss_limit') {
      text = `Loss limit reached - your account is locked at ${money(view.account.equity)} and stays on the leaderboard.`;
      cls = 'locked';
    } else if (view.account.status === 'disqualified') {
      text = 'Your account was disqualified from this competition.';
      cls = 'locked';
    } else if (view.marketClosed && view.marketClosed[activeSymbol]) {
      text = `${activeSymbol} market is closed right now - you can close trades but not open new ones.`;
      cls = 'closed';
    }
    banner.textContent = text;
    banner.className = `comp-banner ${cls}${text ? '' : ' hidden'}`;
  }

  function renderTimeLeft() {
    if (!view) return;
    const c = view.competition;
    const now = Date.now();
    const start = new Date(c.startsAt).getTime();
    const end = new Date(c.endsAt).getTime();
    $('compTimeLeft').textContent = now < start ? `Starts ${fmtLeft(start - now)}` : fmtLeft(end - now);
  }

  function renderTabs() {
    const wrap = $('instrumentTabs');
    if (!wrap.dataset.built) {
      wrap.dataset.built = '1';
      wrap.innerHTML = '';
      view.competition.instruments.forEach((sym) => {
        const btn = document.createElement('button');
        btn.className = 'instrument-tab';
        btn.dataset.symbol = sym;
        btn.textContent = sym;
        btn.addEventListener('click', () => selectSymbol(sym));
        wrap.appendChild(btn);
      });
    }
    wrap.querySelectorAll('.instrument-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.symbol === activeSymbol);
      b.classList.toggle('closed', !!(view.marketClosed && view.marketClosed[b.dataset.symbol]));
    });
  }

  function renderQuotes() {
    const q = view.quotes && view.quotes[activeSymbol];
    $('quoteBid').textContent = q ? q.bid : '-';
    $('quoteAsk').textContent = q ? q.ask : '-';
    const tradeable = view.account.status === 'active' && view.competition.status === 'active' && q && !q.marketClosed;
    $('buyBtn').disabled = !tradeable;
    $('sellBtn').disabled = !tradeable;
  }

  function renderPositions() {
    const list = $('positionsList');
    const positions = view.positions || [];
    TW.Chart.setPositionLines(
      positions.map((p) => ({ id: p.id, symbol: p.symbol, direction: p.side, lots: p.lots, entryPrice: p.entryPrice, stopLoss: p.stopLoss, takeProfit: p.takeProfit }))
    );
    $('gameMobileTradeBadge').classList.toggle('hidden', positions.length === 0);
    if (!positions.length) {
      list.innerHTML = '<div class="text-secondary" style="font-size:13px;">No open positions</div>';
      return;
    }
    list.innerHTML = positions
      .map(
        (p) => `
      <div class="position-row" data-id="${p.id}">
        <div class="position-main-row">
          <div class="info">
            <div><strong class="${p.side === 'BUY' ? 'text-buy' : 'text-sell'}">${p.side}</strong> ${p.lots} ${TW.escapeHtml(p.symbol)}</div>
            <div class="text-secondary">@ ${p.entryPrice}</div>
          </div>
          <div class="pnl ${p.pnl >= 0 ? 'text-buy' : 'text-sell'}">${money(p.pnl)}</div>
          <button class="btn" data-close style="min-height:36px;padding:6px 10px;">Close</button>
        </div>
        <div class="position-sltp-row">
          <label>SL</label><input type="number" step="any" data-sl value="${p.stopLoss ?? ''}" placeholder="off" />
          <label>TP</label><input type="number" step="any" data-tp value="${p.takeProfit ?? ''}" placeholder="off" />
          <button class="btn" data-save-sltp>Set</button>
        </div>
      </div>`
      )
      .join('');
  }

  function renderTrades() {
    const trades = view.trades || [];
    const reasons = { manual: 'Closed', sl: 'Stop loss', tp: 'Take profit', loss_limit: 'Stopped out', settle: 'Settled', void: 'Void', disqualified: 'DQ' };
    $('tradeHistory').innerHTML = trades.length
      ? trades
          .slice(0, 50)
          .map(
            (t) => `<div class="trade-history-row">
          <span><strong class="${t.side === 'BUY' ? 'text-buy' : 'text-sell'}">${t.side}</strong> ${t.lots} ${TW.escapeHtml(t.symbol)}</span>
          <span class="text-secondary">${reasons[t.exitReason] || t.exitReason}</span>
          <span class="${t.pnl >= 0 ? 'text-buy' : 'text-sell'}">${money(t.pnl)}</span>
        </div>`
          )
          .join('')
      : '<div class="text-secondary">No closed trades yet</div>';
  }

  function renderAll() {
    renderHeader();
    renderTabs();
    renderQuotes();
    renderPositions();
    renderTrades();
    renderTimeLeft();
  }

  async function loadLeaderboard() {
    try {
      const lb = await TW.api(`/api/competitions/${compId}/leaderboard`);
      const rows = lb.leaderboard.slice(0, 10);
      if (lb.me && !rows.some((r) => r.isMe)) rows.push(lb.me);
      $('leaderboardBody').innerHTML = rows
        .map(
          (r) => `<tr class="${r.isMe ? 'me' : ''}">
        <td>${r.rank ?? '—'}</td>
        <td>${TW.escapeHtml(r.username)}${r.status === 'loss_limit' ? ' 🔒' : ''}</td>
        <td>${money(r.equity)}</td>
        <td class="${r.pnlPct >= 0 ? 'text-buy' : 'text-sell'}">${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(2)}%</td>
        <td>${r.trades}</td></tr>`
        )
        .join('');
    } catch (e) {
      /* leaderboard is secondary - the next refresh retries */
    }
  }

  // ---- data loading ----------------------------------------------------------------

  async function loadView() {
    const next = await TW.api(`/api/competitions/${compId}/account`);
    // Closed trades that weren't there last time and weren't closed by this
    // tab (SL/TP/loss limit while the socket was down) still get their sound.
    const ids = new Set((next.trades || []).map((t) => t.id));
    if (view) {
      for (const t of next.trades || []) {
        if (!lastTradeIds.has(t.id) && t.exitReason !== 'manual') playExitSound(t.exitReason);
      }
    }
    lastTradeIds = ids;
    view = next;
    pushQuotesToChart(view.quotes, view.compTime);
    renderAll();
  }

  function pushQuotesToChart(quotes, compTime) {
    if (chartOrigin === null || !quotes || !compTime) return;
    for (const [sym, q] of Object.entries(quotes)) {
      if ((lastPushedTime[sym] || -Infinity) >= compTime) continue;
      lastPushedTime[sym] = compTime;
      TW.Chart.pushTick(sym, compTime - chartOrigin, q.mid);
    }
  }

  async function loadCharts() {
    const results = {};
    await Promise.all(
      view.competition.instruments.map(async (sym) => {
        try {
          results[sym] = await TW.api(`/api/chart-data/${encodeURIComponent(sym)}?compId=${compId}`);
        } catch (e) {
          console.warn(`[competition] chart history for ${sym} failed:`, e.message);
        }
      })
    );
    // Each request saw a slightly different market time (it keeps moving -
    // fast in a sped-up test). Anchor t=0 at the latest one so no symbol's
    // history ends after "now", and start each symbol's live line at its own time.
    const origin = Math.max(view.compTime, ...Object.values(results).map((d) => d.compTime));
    const history = {};
    for (const [sym, data] of Object.entries(results)) {
      const rel = (rows) => rows.map(([t, o, h, l, c]) => [t - origin, o, h, l, c]);
      history[sym] = {
        ticks: data.quote ? [{ t: data.compTime - origin, mid: data.quote.mid }] : [],
        context: { d1: rel(data.bars.d1), h1: rel(data.bars.h1), m5: rel(data.bars.m5) },
        alignOffset: ((origin % 86400) + 86400) % 86400,
      };
      lastPushedTime[sym] = data.compTime;
    }
    chartOrigin = origin;
    TW.Chart.setTimeOrigin(origin);
    TW.Chart.loadPreMatchHistory(history);
  }

  // ---- actions -------------------------------------------------------------------------

  function pipsToPrice(side, pips, kind) {
    const n = Number(pips);
    if (!pips || !Number.isFinite(n) || n <= 0) return null;
    const q = view.quotes[activeSymbol];
    const info = view.instrumentInfo[activeSymbol];
    const ref = side === 'BUY' ? q.bid : q.ask;
    const dist = n * info.pipSize;
    const below = (kind === 'sl') === (side === 'BUY');
    return Number((below ? ref - dist : ref + dist).toFixed(info.decimals));
  }

  async function openTrade(side) {
    const btn = side === 'BUY' ? $('buyBtn') : $('sellBtn');
    btn.disabled = true;
    try {
      await TW.api(`/api/competitions/${compId}/trade/open`, {
        method: 'POST',
        body: {
          symbol: activeSymbol,
          side,
          lots: selectedLots,
          stopLoss: pipsToPrice(side, $('preSlInput').value, 'sl'),
          takeProfit: pipsToPrice(side, $('preTpInput').value, 'tp'),
        },
      });
      TW.Sound.play('tradeOpen');
      await loadView();
    } catch (e) {
      TW.toast(e.message, 'danger');
    } finally {
      renderQuotes();
    }
  }

  async function closePosition(positionId) {
    try {
      const r = await TW.api(`/api/competitions/${compId}/trade/close`, { method: 'POST', body: { positionId } });
      TW.Sound.play(r.pnl >= 0 ? 'tradeProfitClose' : 'tradeLossClose');
      await loadView();
    } catch (e) {
      TW.toast(e.message, 'danger');
    }
  }

  async function modifyPosition(positionId, stopLoss, takeProfit) {
    try {
      await TW.api(`/api/competitions/${compId}/trade/modify`, { method: 'POST', body: { positionId, stopLoss, takeProfit } });
      TW.toast('Stop loss / take profit updated', 'info');
    } catch (e) {
      TW.toast(e.message, 'danger');
    }
    await loadView();
  }

  function playExitSound(reason) {
    if (reason === 'sl') TW.Sound.play('slHit');
    else if (reason === 'tp') TW.Sound.play('tpHit');
    else if (reason === 'loss_limit') TW.Sound.play('lossLimit');
  }

  function selectSymbol(sym) {
    activeSymbol = sym;
    TW.Chart.setActiveSymbol(sym);
    renderAll();
  }

  // ---- wiring ----------------------------------------------------------------------------

  function setupControls() {
    $('buyBtn').addEventListener('click', () => openTrade('BUY'));
    $('sellBtn').addEventListener('click', () => openTrade('SELL'));

    $('lotSelector').addEventListener('click', (e) => {
      const chip = e.target.closest('.lot-chip[data-lot]');
      if (!chip) return;
      $('lotSelector').querySelectorAll('.lot-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      selectedLots = Number(chip.dataset.lot);
      $('customLotInput').value = '';
    });
    $('customLotInput').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v) || v <= 0) return;
      $('lotSelector').querySelectorAll('.lot-chip').forEach((c) => c.classList.remove('active'));
      $('customLotChip').classList.add('active');
      selectedLots = v;
    });

    $('positionsList').addEventListener('click', (e) => {
      const row = e.target.closest('.position-row');
      if (!row) return;
      if (e.target.closest('[data-close]')) {
        e.target.disabled = true;
        closePosition(row.dataset.id);
      } else if (e.target.closest('[data-save-sltp]')) {
        modifyPosition(row.dataset.id, row.querySelector('[data-sl]').value || null, row.querySelector('[data-tp]').value || null);
      }
    });

    const tfWrap = $('timeframeSelector');
    COMP_TIMEFRAMES.forEach((tf) => {
      const btn = document.createElement('button');
      btn.textContent = TW.Chart.TIMEFRAME_LABELS[tf];
      btn.className = tf === DEFAULT_TF ? 'active' : '';
      btn.addEventListener('click', () => {
        TW.Chart.setTimeframe(tf);
        tfWrap.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
      tfWrap.appendChild(btn);
    });

    document.querySelectorAll('.game-mobile-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.game-mobile-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelector('.game-shell').dataset.mobileView = btn.dataset.view;
      });
    });

    // Back from a locked phone / another tab: resync from the server.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') loadView().catch(() => {});
    });
  }

  function setupSocket() {
    const socket = TW.connectSocket();
    if (!socket) return;
    const join = () => socket.emit('comp:join', { competitionId: compId }, () => {});
    socket.on('connect', join);
    if (socket.connected) join();

    socket.on('comp:update', (u) => {
      if (u.competitionId !== compId || !view) return;
      if (u.quotes) {
        view.quotes = u.quotes;
        view.marketClosed = Object.fromEntries(Object.entries(u.quotes).map(([s, q]) => [s, q.marketClosed]));
        pushQuotesToChart(u.quotes, u.compTime);
      }
      if (u.compTime) view.compTime = u.compTime;
      if (u.session) view.session = u.session;
      if (u.account) Object.assign(view.account, u.account);
      if (u.positions) view.positions = u.positions;
      if (u.rank) {
        view.rank = u.rank;
        view.entrants = u.entrants;
      }
      renderHeader();
      renderTabs();
      renderQuotes();
      renderPositions();
    });
    socket.on('comp:sl_hit', (e) => {
      if (e.competitionId !== compId) return;
      TW.toast(`Stop loss hit on ${e.symbol}: ${money(e.pnl)}`, 'danger');
      lastTradeIds.add(e.positionId);
      TW.Sound.play('slHit');
      loadView().catch(() => {});
    });
    socket.on('comp:tp_hit', (e) => {
      if (e.competitionId !== compId) return;
      TW.toast(`Take profit hit on ${e.symbol}: +${money(e.pnl)}`, 'success');
      lastTradeIds.add(e.positionId);
      TW.Sound.play('tpHit');
      loadView().catch(() => {});
    });
    socket.on('comp:stop_out', (e) => {
      TW.toast(`Stopped out: ${e.closed} losing position${e.closed === 1 ? '' : 's'} closed. Equity ${TW.formatMoney(e.equity)}`, 'danger');
      loadView();
    });
    socket.on('comp:loss_limit', (e) => {
      if (e.competitionId !== compId) return;
      TW.Sound.play('lossLimit');
      loadView().catch(() => {});
    });
    socket.on('comp:ending_soon', (e) => {
      if (e.competitionId !== compId) return;
      TW.Sound.play('warning');
      TW.toast(`${view.competition.title} ends in ${e.minutesLeft} minutes`, 'warning');
    });
    socket.on('comp:ended', (e) => {
      if (e.competitionId !== compId) return;
      TW.Sound.play(e.rank && e.rank <= 3 ? 'matchWin' : 'match_end');
      loadView().then(loadLeaderboard).catch(() => {});
    });
  }

  async function init() {
    TW.requireAuth();
    if (!compId) {
      window.location.href = '/competitions';
      return;
    }
    try {
      await loadView();
    } catch (e) {
      TW.toast(e.message, 'danger');
      setTimeout(() => (window.location.href = '/competitions'), 1500);
      return;
    }
    activeSymbol = view.competition.instruments[0];
    TW.Chart.init('chartCanvas');
    TW.Chart.setDimHistory(false);
    await loadCharts();
    TW.Chart.setActiveSymbol(activeSymbol);
    TW.Chart.setTimeframe(DEFAULT_TF);
    TW.Chart.enablePositionLineDragging('chartCanvas', (positionId, field, price) => {
      const pos = view.positions.find((p) => p.id === positionId);
      if (!pos) return;
      modifyPosition(positionId, field === 'stopLoss' ? price : pos.stopLoss, field === 'takeProfit' ? price : pos.takeProfit);
    });
    setupControls();
    setupSocket();
    renderAll();
    loadLeaderboard();

    setInterval(renderTimeLeft, 1000);
    setInterval(loadLeaderboard, LEADERBOARD_MS);
    // Safety net when the socket is down: the page still moves on its own.
    setInterval(() => {
      if (!TW.socket || !TW.socket.connected) loadView().catch(() => {});
    }, POLL_MS);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
