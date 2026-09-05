'use strict';

window.TW = window.TW || {};

(function () {
  TW.requireAuth();

  const params = new URLSearchParams(window.location.search);
  const matchId = params.get('matchId');
  if (!matchId) {
    window.location.href = '/play';
    return;
  }

  // EURUSD/XAUUSD values are unchanged from before instrument rotation shipped
  // - the rest mirror server/instruments.js's pipSize/contractSize.
  const CONTRACT_SIZE = {
    EURUSD: 100000, XAUUSD: 100,
    GBPUSD: 100000, USDJPY: 100000, USDCHF: 100000, AUDUSD: 100000, USDCAD: 100000, NZDUSD: 100000,
    XAGUSD: 5000, NAS100: 1, US30: 1, UK100: 1, GER40: 1, BRENT: 1000, USOIL: 1000,
    BTCUSD: 1, ETHUSD: 1, USTUSD: 1, AAPL: 1,
  };
  const PIP_SIZE = {
    EURUSD: 0.0001, XAUUSD: 0.1,
    GBPUSD: 0.0001, USDJPY: 0.01, USDCHF: 0.0001, AUDUSD: 0.0001, USDCAD: 0.0001, NZDUSD: 0.0001,
    XAGUSD: 0.001, NAS100: 0.1, US30: 0.1, UK100: 0.1, GER40: 0.1, BRENT: 0.01, USOIL: 0.01,
    BTCUSD: 0.01, ETHUSD: 0.01, USTUSD: 0.0001, AAPL: 0.01,
  };
  let sltpMode = 'pips';
  function liveClosePnl(direction, lots, entryPrice, exitPrice, symbol) {
    const size = CONTRACT_SIZE[symbol] || 0;
    const diff = direction === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice;
    return diff * lots * size;
  }

  let lastState = null;
  let lastPrices = {};
  let activeInstrument = 'EURUSD';
  let selectedLot = 1.0;
  let matchEnded = false;
  let riskLocked = false; // eliminated or 2-minute soft loss lock - independent of the position_freeze card timer
  let freezeLocked = false;
  let matchStartedAtMs = null; // real epoch ms from match:start, used to place feed events on the equity curve
  let rulesOverlayShown = false; // FIX: match rules summary shown once, on the first match:state this page receives

  // Authoritative-ish mirror of the player's own balance/positions, kept in
  // sync incrementally by trade:executed/trade:closed/capital_drain events
  // rather than only on match:state (which only broadcasts on lobby/sabotage
  // events, not on every trade) - otherwise the panel goes stale between
  // those broadcasts even though the server already applied the trade.
  let myAccount = { balance: 10000, positions: [] };

  TW.Chart.init('chartCanvas');
  window.reinitializeCharts = () => TW.Chart.refreshTheme();
  TW.Chart.enablePositionLineDragging('chartCanvas', async (positionId, field, price) => {
    const body = { positionId };
    body[field] = price;
    const result = await TW.emitAck('trade:modify', body);
    if (!result.success) TW.toast(result.error, 'danger');
    else TW.toast(`${field === 'stopLoss' ? 'Stop loss' : 'Take profit'} updated`, 'info');
  });
  TW.Indicators.init();
  TW.Drawing.init('drawingCanvas', 'chartCanvasWrap');

  // 2 hours of dimmed historical context before match start (see FIX: chart
  // history) - fetched once up front so it's already on the chart the moment
  // the trader sees the screen, with live ticks continuing seamlessly from it.
  fetch(`/api/match/${matchId}/history`)
    .then((r) => (r.ok ? r.json() : null))
    .then((history) => {
      if (history) TW.Chart.loadPreMatchHistory(history);
    })
    .catch(() => {});

  function setupChartToolbar() {
    // ---- drawing tools -----------------------------------------------------------
    const toolbar = document.getElementById('drawingToolbar');
    if (toolbar) {
      // Scoped to [data-tool] specifically - magnetToggleBtn and clearDrawingsBtn
      // also carry the .draw-tool-btn class (for shared styling) but aren't tool
      // selections, so a plain .draw-tool-btn selector here was previously calling
      // TW.Drawing.setTool(undefined) whenever either was clicked, silently leaving
      // the drawing canvas's pointer-events stuck "on" (blocking chart pan/zoom)
      // since no real tool matched to turn it back off.
      toolbar.querySelectorAll('.draw-tool-btn[data-tool]').forEach((btn) => {
        btn.addEventListener('click', () => {
          toolbar.querySelectorAll('.draw-tool-btn[data-tool]').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          TW.Drawing.setTool(btn.dataset.tool);
        });
      });
    }
    const magnetBtn = document.getElementById('magnetToggleBtn');
    if (magnetBtn) {
      magnetBtn.addEventListener('click', () => {
        const on = !magnetBtn.classList.contains('active');
        magnetBtn.classList.toggle('active', on);
        TW.Drawing.setMagnet(on);
        TW.toast(`Magnet snap ${on ? 'enabled' : 'disabled'}`, 'info');
      });
    }
    const clearDrawingsBtn = document.getElementById('clearDrawingsBtn');
    if (clearDrawingsBtn) {
      clearDrawingsBtn.addEventListener('click', () => {
        TW.Drawing.clearAll();
        TW.toast('Cleared all drawings on this chart', 'info');
      });
    }

    // ---- indicators dropdown -------------------------------------------------------
    const indicatorsBtn = document.getElementById('indicatorsBtn');
    const indicatorsMenu = document.getElementById('indicatorsMenu');
    const settingsBtn = document.getElementById('chartSettingsBtn');
    const settingsMenu = document.getElementById('chartSettingsMenu');

    function closeMenus(except) {
      if (indicatorsMenu && indicatorsMenu !== except) indicatorsMenu.classList.add('hidden');
      if (settingsMenu && settingsMenu !== except) settingsMenu.classList.add('hidden');
    }

    if (indicatorsBtn && indicatorsMenu) {
      indicatorsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willShow = indicatorsMenu.classList.contains('hidden');
        closeMenus();
        indicatorsMenu.classList.toggle('hidden', !willShow);
      });
    }
    if (settingsBtn && settingsMenu) {
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willShow = settingsMenu.classList.contains('hidden');
        closeMenus();
        settingsMenu.classList.toggle('hidden', !willShow);
      });
    }
    document.addEventListener('click', () => closeMenus());
    if (indicatorsMenu) indicatorsMenu.addEventListener('click', (e) => e.stopPropagation());
    if (settingsMenu) settingsMenu.addEventListener('click', (e) => e.stopPropagation());

    function selectedMaPeriods() {
      return Array.from(document.querySelectorAll('.ma-period:checked')).map((el) => Number(el.value));
    }

    const maToggle = document.getElementById('indMaToggle');
    if (maToggle) {
      maToggle.addEventListener('change', () => TW.Indicators.toggle('ma', maToggle.checked, { periods: selectedMaPeriods() }));
    }
    document.querySelectorAll('.ma-period').forEach((el) => {
      el.addEventListener('change', () => {
        if (maToggle && maToggle.checked) TW.Indicators.toggle('ma', true, { periods: selectedMaPeriods() });
      });
    });
    const bbToggle = document.getElementById('indBbToggle');
    if (bbToggle) bbToggle.addEventListener('change', () => TW.Indicators.toggle('bb', bbToggle.checked));
    const rsiToggle = document.getElementById('indRsiToggle');
    if (rsiToggle) rsiToggle.addEventListener('change', () => TW.Indicators.toggle('rsi', rsiToggle.checked));
    const macdToggle = document.getElementById('indMacdToggle');
    if (macdToggle) macdToggle.addEventListener('change', () => TW.Indicators.toggle('macd', macdToggle.checked));
    const volumeToggle = document.getElementById('indVolumeToggle');
    if (volumeToggle) volumeToggle.addEventListener('change', () => TW.Indicators.toggle('volume', volumeToggle.checked));

    // ---- chart settings gear -------------------------------------------------------
    function applyFromSettingsForm() {
      TW.Chart.applySettings({
        bullColor: document.getElementById('settingBullColor').value,
        bearColor: document.getElementById('settingBearColor').value,
        background: document.getElementById('settingBackground').value,
        showGrid: document.getElementById('settingShowGrid').checked,
        crosshairStyle: document.getElementById('settingCrosshair').value,
        priceScalePosition: document.getElementById('settingPriceScale').value,
      });
    }
    ['settingBullColor', 'settingBearColor', 'settingBackground', 'settingShowGrid', 'settingCrosshair', 'settingPriceScale'].forEach(
      (id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', applyFromSettingsForm);
      }
    );
  }
  setupChartToolbar();

  function updateTradeButtonsDisabled() {
    document.getElementById('buyBtn').disabled = riskLocked || freezeLocked;
    document.getElementById('sellBtn').disabled = riskLocked || freezeLocked;
  }

  function formatClock(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // FIX: match rules summary shown once, right after the first match:state
  // arrives (chart/positions render underneath while this is up). MAX_LOTS,
  // MAX_POSITIONS and the margin-call threshold below mirror the real,
  // match-mode-independent constants in server/gameEngine.js (MAX_LOTS = 10,
  // MAX_POSITIONS = 10, HARD_LOSS_PCT = 0.5 of the $10,000 starting capital)
  // - update both places together if those ever change.
  function showMatchRules(state) {
    const RULES_MAX_LOTS = 10.0;
    const RULES_MAX_POSITIONS = 10;
    const RULES_MARGIN_CALL_EQUITY = 5000;

    const overlay = document.createElement('div');
    overlay.className = 'match-rules-overlay';
    overlay.id = 'matchRulesOverlay';
    overlay.innerHTML = `
      <div class="match-rules-card">
        <div class="rules-header">
          <div class="rules-mode-badge">⚔️ ${TW.escapeHtml(state.modeLabel || state.mode)}</div>
          <div class="rules-countdown" id="rulesCountdown">5</div>
        </div>
        <h2 class="rules-title">Match Rules</h2>
        <div class="rules-grid">
          <div class="rule-item"><div class="rule-label">Starting Capital</div><div class="rule-value">$10,000</div></div>
          <div class="rule-item"><div class="rule-label">Duration</div><div class="rule-value">${formatClock(state.durationSeconds)} Minutes</div></div>
          <div class="rule-item"><div class="rule-label">Max Lot Size</div><div class="rule-value">${RULES_MAX_LOTS.toFixed(1)} Lots</div></div>
          <div class="rule-item"><div class="rule-label">Max Open Positions</div><div class="rule-value">${RULES_MAX_POSITIONS} Positions</div></div>
          <div class="rule-item"><div class="rule-label">Margin Call</div><div class="rule-value">Below $${RULES_MARGIN_CALL_EQUITY.toLocaleString()} equity</div></div>
          <div class="rule-item"><div class="rule-label">Sabotage Cards</div><div class="rule-value">${state.cardsPerPlayer} Cards — 1 use each</div></div>
          <div class="rule-item" style="grid-column:1 / -1;"><div class="rule-label">Instruments</div><div class="rule-value" style="font-size:12px;">${(state.instruments || []).join(' · ')}</div></div>
          <div class="rule-item"><div class="rule-label">Entry Cost</div><div class="rule-value">${state.entryCoins ?? 0} Coins</div></div>
          <div class="rule-item"><div class="rule-label">Winner</div><div class="rule-value" style="font-size:12px;">Highest P&amp;L at zero</div></div>
        </div>
        <div class="rules-reminder">
          <span class="reminder-icon">⚠️</span>
          All positions close automatically when the timer ends. No exceptions.
        </div>
        <button class="btn-rules-ready" id="rulesReadyBtn">Ready — Let's Trade</button>
        <p class="rules-disclaimer">Simulated trading environment. Historical market data. Not financial advice.</p>
      </div>
    `;
    document.body.appendChild(overlay);

    let countdown = 5;
    const countEl = overlay.querySelector('#rulesCountdown');
    const timer = setInterval(() => {
      countdown--;
      if (countEl) countEl.textContent = countdown;
      if (countdown <= 0) {
        clearInterval(timer);
        dismissMatchRules();
      }
    }, 1000);

    overlay.querySelector('#rulesReadyBtn').addEventListener('click', () => {
      clearInterval(timer);
      dismissMatchRules();
    });
  }

  function dismissMatchRules() {
    const overlay = document.getElementById('matchRulesOverlay');
    if (!overlay) return;
    overlay.style.transition = 'opacity 0.3s';
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 300);
  }

  function computeEquity() {
    let equity = myAccount.balance;
    myAccount.positions.forEach((pos) => {
      const price = lastPrices[pos.symbol];
      if (!price) return;
      const exit = pos.direction === 'BUY' ? price.bid : price.ask;
      equity += liveClosePnl(pos.direction, pos.lots, pos.entryPrice, exit, pos.symbol);
    });
    return equity;
  }

  function renderTopbar() {
    const equity = computeEquity();
    const pnl = equity - 10000;
    const pnlEl = document.getElementById('topbarPnl');
    pnlEl.textContent = TW.formatMoney(pnl);
    pnlEl.classList.remove('pnl-update');
    void pnlEl.offsetWidth;
    pnlEl.className = 'topbar-pnl-value pnl-update ' + (pnl >= 0 ? 'text-buy' : 'text-sell');
    document.getElementById('topbarEquity').textContent = `Equity: ${TW.formatMoney(equity)}`;
  }

  function renderAccountSummary() {
    const equity = computeEquity();
    const marginUsed = myAccount.positions.reduce((sum, pos) => {
      const price = lastPrices[pos.symbol];
      const notional = pos.lots * (CONTRACT_SIZE[pos.symbol] || 0) * (price ? price.mid : pos.entryPrice);
      return sum + notional / 100; // display-only, assumes 100:1 leverage
    }, 0);
    document.getElementById('summaryBalance').textContent = TW.formatMoney(myAccount.balance);
    document.getElementById('summaryEquity').textContent = TW.formatMoney(equity);
    document.getElementById('summaryMargin').textContent = TW.formatMoney(marginUsed);
  }

  // Keyed by position id so the SL/TP inputs are created once and never
  // rebuilt on the 1-second price tick - rebuilding them would wipe out
  // whatever the player is mid-typing before they click Set.
  const positionRowElements = new Map();

  function buildPositionRow(pos) {
    const row = document.createElement('div');
    row.className = 'position-row';
    row.innerHTML = `
      <div class="position-main-row">
        <div class="info">
          <div><strong class="${pos.direction === 'BUY' ? 'text-buy' : 'text-sell'}">${pos.direction}</strong> ${pos.lots} ${pos.symbol}</div>
          <div class="text-secondary">@ ${pos.entryPrice}</div>
        </div>
        <div class="pnl" data-pnl>${TW.formatMoney(0)}</div>
        <button class="btn" data-modify style="min-height:36px;padding:6px 10px;">Modify</button>
        <button class="btn" data-close style="min-height:36px;padding:6px 10px;">Close</button>
      </div>
      <div class="position-sltp-row">
        <label>SL</label>
        <input type="number" step="0.00001" data-sl value="${pos.stopLoss ?? ''}" placeholder="off" />
        <label>TP</label>
        <input type="number" step="0.00001" data-tp value="${pos.takeProfit ?? ''}" placeholder="off" />
        <button class="btn" data-save-sltp>Set</button>
      </div>
    `;

    row.querySelector('[data-close]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const result = await TW.emitAck('trade:close', { positionId: pos.id });
      if (!result.success) {
        TW.toast(result.error, 'danger');
        e.target.disabled = false;
      }
    });

    row.querySelector('[data-save-sltp]').addEventListener('click', async () => {
      const slInput = row.querySelector('[data-sl]');
      const tpInput = row.querySelector('[data-tp]');
      const stopLoss = slInput.value === '' ? null : Number(slInput.value);
      const takeProfit = tpInput.value === '' ? null : Number(tpInput.value);
      const result = await TW.emitAck('trade:modify', { positionId: pos.id, stopLoss, takeProfit });
      if (!result.success) TW.toast(result.error, 'danger');
      else TW.toast('Stop loss / take profit updated', 'info');
    });

    row.querySelector('[data-modify]').addEventListener('click', () => openModifyModal(pos));

    return row;
  }

  // ---- Modify modal: move to breakeven + partial close ----------------------------

  function openModifyModal(pos) {
    const live = myAccount.positions.find((p) => p.id === pos.id) || pos;

    // A BUY's stop loss triggers against the bid, which sits one spread below the
    // ask it opened at - so setting SL to the exact entry price on a position that
    // hasn't yet moved into profit closes it on the very next tick. Real platforms
    // only allow "move to breakeven" once the position is actually in profit;
    // otherwise it's a footgun that silently force-closes the trade.
    const quote = lastPrices[live.symbol];
    const exitPrice = quote ? (live.direction === 'BUY' ? quote.bid : quote.ask) : live.entryPrice;
    const currentPnl = quote ? liveClosePnl(live.direction, live.lots, live.entryPrice, exitPrice, live.symbol) : 0;
    const canBreakeven = currentPnl > 0;

    const overlay = document.createElement('div');
    overlay.className = 'modify-modal-overlay';
    overlay.innerHTML = `
      <div class="modify-modal-card">
        <h3>Modify Position</h3>
        <div class="modify-modal-sub">${live.direction} ${live.lots} ${live.symbol} @ ${live.entryPrice}</div>

        <div class="modify-modal-section">
          <label>Stop Loss</label>
          <button class="btn modify-breakeven-btn" data-breakeven ${canBreakeven ? '' : 'disabled'}
            title="${canBreakeven ? '' : 'Available once this position is in profit'}">
            Move to Breakeven (${live.entryPrice})${canBreakeven ? '' : ' — needs open profit'}
          </button>
        </div>

        <div class="modify-modal-section">
          <label>Partial Close</label>
          <div class="modify-slider-row">
            <input type="range" min="5" max="95" step="5" value="50" data-pct-slider />
            <span class="modify-pct-value" data-pct-value>50%</span>
          </div>
          <div class="modify-pct-chips">
            <button type="button" data-pct-chip="25">25%</button>
            <button type="button" data-pct-chip="50" class="active">50%</button>
            <button type="button" data-pct-chip="75">75%</button>
          </div>
        </div>

        <div class="modify-modal-actions">
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn btn-buy" data-confirm-partial>Close % Now</button>
        </div>
      </div>
    `;

    function close() {
      overlay.remove();
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('[data-cancel]').addEventListener('click', close);

    overlay.querySelector('[data-breakeven]').addEventListener('click', async () => {
      const result = await TW.emitAck('trade:modify', { positionId: live.id, stopLoss: live.entryPrice });
      if (!result.success) TW.toast(result.error, 'danger');
      else {
        TW.toast('Stop loss moved to breakeven', 'info');
        close();
      }
    });

    const slider = overlay.querySelector('[data-pct-slider]');
    const pctValue = overlay.querySelector('[data-pct-value]');
    const chips = overlay.querySelectorAll('[data-pct-chip]');

    function setPct(pct) {
      slider.value = pct;
      pctValue.textContent = `${pct}%`;
      chips.forEach((c) => c.classList.toggle('active', Number(c.dataset.pctChip) === pct));
    }

    slider.addEventListener('input', () => {
      pctValue.textContent = `${slider.value}%`;
      chips.forEach((c) => c.classList.remove('active'));
    });
    chips.forEach((chip) => {
      chip.addEventListener('click', () => setPct(Number(chip.dataset.pctChip)));
    });

    overlay.querySelector('[data-confirm-partial]').addEventListener('click', async () => {
      const pct = Number(slider.value);
      const result = await TW.emitAck('trade:close_partial', { positionId: live.id, percentage: pct });
      if (!result.success) TW.toast(result.error, 'danger');
      else {
        TW.toast(`Closed ${pct}% of position`, 'info');
        close();
      }
    });

    document.body.appendChild(overlay);
  }

  function renderPositions() {
    const list = document.getElementById('positionsList');
    const positions = myAccount.positions;
    TW.Chart.setPositionLines(positions);

    if (positions.length === 0) {
      positionRowElements.clear();
      list.innerHTML = '<div class="text-secondary" style="font-size:13px;">No open positions</div>';
      return;
    }

    if (positionRowElements.size === 0) list.innerHTML = ''; // clear the "No open positions" placeholder

    const seenIds = new Set();
    positions.forEach((pos) => {
      seenIds.add(pos.id);
      let entry = positionRowElements.get(pos.id);
      if (!entry) {
        const row = buildPositionRow(pos);
        entry = { row, pnlEl: row.querySelector('[data-pnl]') };
        positionRowElements.set(pos.id, entry);
        list.appendChild(entry.row);
      }

      const price = lastPrices[pos.symbol];
      let pnl = 0;
      if (price) {
        const exit = pos.direction === 'BUY' ? price.bid : price.ask;
        pnl = liveClosePnl(pos.direction, pos.lots, pos.entryPrice, exit, pos.symbol);
      }
      entry.pnlEl.textContent = TW.formatMoney(pnl);
      entry.pnlEl.classList.remove('pnl-update');
      void entry.pnlEl.offsetWidth;
      entry.pnlEl.className = 'pnl pnl-update ' + (pnl >= 0 ? 'text-buy' : 'text-sell');
    });

    for (const [id, entry] of positionRowElements) {
      if (!seenIds.has(id)) {
        entry.row.remove();
        positionRowElements.delete(id);
      }
    }
  }

  function renderQuotes() {
    const price = lastPrices[activeInstrument];
    if (!price) return;
    document.getElementById('quoteBid').textContent = price.bid;
    document.getElementById('quoteAsk').textContent = price.ask;
    document.getElementById('quoteSpread').textContent = price.spread;
  }

  function formatTimeframeLabel(seconds) {
    return TW.Chart.TIMEFRAME_LABELS[seconds] || `${seconds}s`;
  }

  function setupTimeframeSelector() {
    const wrap = document.getElementById('timeframeSelector');
    if (!wrap || wrap.dataset.built) return;
    wrap.dataset.built = '1';
    TW.Chart.TIMEFRAMES.forEach((tf) => {
      const btn = document.createElement('button');
      btn.textContent = formatTimeframeLabel(tf);
      btn.className = tf === TW.Chart.DEFAULT_TIMEFRAME ? 'active' : '';
      btn.addEventListener('click', () => {
        TW.Chart.setTimeframe(tf);
        wrap.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
      wrap.appendChild(btn);
    });
  }

  function setupInstrumentTabs(instruments) {
    const wrap = document.getElementById('instrumentTabs');
    if (wrap.dataset.built) return;
    wrap.dataset.built = '1';
    wrap.innerHTML = '';
    instruments.forEach((sym, i) => {
      const btn = document.createElement('button');
      btn.className = 'instrument-tab' + (i === 0 ? ' active' : '');
      btn.textContent = sym;
      btn.addEventListener('click', () => {
        activeInstrument = sym;
        wrap.querySelectorAll('.instrument-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        TW.Chart.setActiveSymbol(sym);
        renderQuotes();
        updateRiskCalc();
      });
      wrap.appendChild(btn);
    });
    activeInstrument = instruments[0];
    TW.Chart.setActiveSymbol(activeInstrument);
  }

  function setupLotSelector() {
    const wrap = document.getElementById('lotSelector');
    wrap.querySelectorAll('.lot-chip[data-lot]').forEach((chip) => {
      chip.addEventListener('click', () => {
        selectedLot = Number(chip.dataset.lot);
        wrap.querySelectorAll('.lot-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        document.getElementById('customLotInput').value = '';
        updateRiskCalc();
      });
    });
    const customInput = document.getElementById('customLotInput');
    customInput.addEventListener('input', () => {
      const val = Number(customInput.value);
      if (val > 0) {
        selectedLot = val;
        wrap.querySelectorAll('.lot-chip').forEach((c) => c.classList.remove('active'));
        document.getElementById('customLotChip').classList.add('active');
        updateRiskCalc();
      }
    });
  }

  function pipValueForLots(symbol, lots) {
    const pip = PIP_SIZE[symbol] || 0;
    const size = CONTRACT_SIZE[symbol] || 0;
    return pip * size * lots;
  }

  function updateRiskCalc() {
    const row = document.getElementById('riskCalcRow');
    if (!row) return;
    const slVal = Number(document.getElementById('preSlInput').value);
    const tpVal = Number(document.getElementById('preTpInput').value);
    const price = lastPrices[activeInstrument];
    const pipSize = PIP_SIZE[activeInstrument];

    let slPips = null;
    let tpPips = null;
    if (slVal > 0) slPips = sltpMode === 'pips' ? slVal : price ? Math.abs(price.mid - slVal) / pipSize : null;
    if (tpVal > 0) tpPips = sltpMode === 'pips' ? tpVal : price ? Math.abs(price.mid - tpVal) / pipSize : null;

    const parts = [];
    if (slPips) {
      const dollarRisk = slPips * pipValueForLots(activeInstrument, selectedLot);
      parts.push(`Risk: <strong class="text-sell">${TW.formatMoney(dollarRisk)}</strong>`);
    }
    if (slPips && tpPips) {
      parts.push(`RR: <strong>1:${(tpPips / slPips).toFixed(2)}</strong>`);
    }
    row.innerHTML = parts.join('');
  }

  function setupSltpControls() {
    const modeToggle = document.getElementById('sltpModeToggle');
    modeToggle.querySelectorAll('.lot-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        sltpMode = btn.dataset.mode;
        modeToggle.querySelectorAll('.lot-chip').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('preSlInput').value = '';
        document.getElementById('preTpInput').value = '';
        const isPips = sltpMode === 'pips';
        document.getElementById('slQuickPips').style.display = isPips ? 'flex' : 'none';
        document.getElementById('tpQuickPips').style.display = isPips ? 'flex' : 'none';
        document.getElementById('preSlInput').placeholder = isPips ? 'pips off' : 'price off';
        document.getElementById('preTpInput').placeholder = isPips ? 'pips off' : 'price off';
        updateRiskCalc();
      });
    });
    document.getElementById('slQuickPips').querySelectorAll('.lot-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('preSlInput').value = btn.dataset.pips;
        updateRiskCalc();
      });
    });
    document.getElementById('tpQuickPips').querySelectorAll('.lot-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('preTpInput').value = btn.dataset.pips;
        updateRiskCalc();
      });
    });
    document.getElementById('preSlInput').addEventListener('input', updateRiskCalc);
    document.getElementById('preTpInput').addEventListener('input', updateRiskCalc);
  }

  async function placeTrade(direction) {
    const slInput = document.getElementById('preSlInput');
    const tpInput = document.getElementById('preTpInput');
    const body = { symbol: activeInstrument, direction, lots: selectedLot };
    if (slInput.value) body[sltpMode === 'pips' ? 'stopLossPips' : 'stopLoss'] = Number(slInput.value);
    if (tpInput.value) body[sltpMode === 'pips' ? 'takeProfitPips' : 'takeProfit'] = Number(tpInput.value);

    const result = await TW.emitAck('trade:open', body);
    if (!result.success) {
      TW.toast(result.error, 'danger');
    } else {
      TW.Sound.play(direction === 'BUY' ? 'buyPlaced' : 'sellPlaced');
      slInput.value = '';
      tpInput.value = '';
      updateRiskCalc();
    }
  }

  document.getElementById('buyBtn').addEventListener('click', () => placeTrade('BUY'));
  document.getElementById('sellBtn').addEventListener('click', () => placeTrade('SELL'));

  // ---- match feed ticker ----------------------------------------------------

  const feedEntries = [];
  function renderFeed() {
    const track = document.getElementById('feedTrack');
    track.innerHTML = feedEntries.length
      ? feedEntries.map((t) => `<span>${TW.escapeHtml(t)}</span>`).join('<span>•</span>')
      : '<span>No activity. The calm before the crush.</span>';
    // restart the CSS scroll animation so newly appended text is included in the loop
    track.style.animation = 'none';
    void track.offsetWidth;
    track.style.animation = '';
  }
  function pushFeed(text) {
    feedEntries.push(text);
    if (feedEntries.length > 25) feedEntries.shift();
    renderFeed();
  }

  // ---- margin banner ----------------------------------------------------------

  function showMarginBanner(payload) {
    let banner = document.getElementById('marginBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'marginBanner';
      document.body.appendChild(banner);
    }

    let text;
    let persistent = false;
    switch (payload.level) {
      case 'eliminated':
        text = `🚨 MAX LOSS REACHED (-50%) — you are eliminated from this match (equity $${payload.equity})`;
        riskLocked = true;
        persistent = true;
        break;
      case 'soft_locked':
        text = `⛔ 2-minute loss limit hit (-20%) — trading locked until the next window (equity $${payload.equity}). Crushed. Daily limit reached.`;
        riskLocked = true;
        persistent = true;
        break;
      case 'window_reset':
        text = '✅ Trading unlocked for the new 2-minute window';
        riskLocked = false;
        break;
      default:
        text = `⚠️ Getting crushed. Add margin or exit. (equity $${payload.equity})`;
        break;
    }
    banner.className = 'margin-banner ' + (payload.level === 'window_reset' ? 'positive' : 'negative');
    updateTradeButtonsDisabled();

    banner.textContent = text;
    banner.style.display = 'block';
    clearTimeout(banner._hideTimer);
    if (!persistent) {
      banner._hideTimer = setTimeout(() => {
        banner.style.display = 'none';
      }, 5000);
    }
  }

  // ---- FIX: elimination / leave match ---------------------------------------
  // Eliminated players used to just sit there staring at a disabled trade
  // panel until the match ended for everyone else - this gives them a real
  // choice instead.

  function showEliminationModal(payload) {
    if (document.getElementById('eliminationModal')) return;
    const overlay = document.createElement('div');
    overlay.className = 'elimination-modal';
    overlay.id = 'eliminationModal';
    overlay.innerHTML = `
      <div class="elimination-card">
        <div class="elim-icon">💀</div>
        <h3 class="elim-title">You have been eliminated</h3>
        <p class="elim-body">Your account hit the margin call limit (equity $${payload.equity}). The match continues without you.</p>
        <div class="elim-options">
          <div class="elim-option watch">
            <div class="elim-option-title">👁️ Watch Until End</div>
            <div class="elim-option-desc">Stay and spectate. See final results and your ranking when the match ends. Your stats are saved.</div>
            <button class="btn" id="elimWatchBtn">Watch</button>
          </div>
          <div class="elim-option leave">
            <div class="elim-option-title">🚪 Leave Now</div>
            <div class="elim-option-desc">Leave immediately and join a new match. You'll get a summary notification when this match ends.</div>
            <div class="elim-warning">⚠️ You will forfeit any remaining coins and War Rating from this match. Your elimination is recorded as last place.</div>
            <button class="btn btn-leave" id="elimLeaveBtn">Leave Match</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#elimWatchBtn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#elimLeaveBtn').addEventListener('click', () => {
      overlay.remove();
      confirmLeaveMatch();
    });
  }

  // Small local confirm dialog rather than pulling in the whole tutorial.js
  // just for TW.confirmDialog - reuses .tutorial-confirm-* classes, which
  // are already on this page via css/tutorial.css.
  function confirmDialog({ title, body, confirmLabel }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'tutorial-confirm-overlay';
      overlay.innerHTML = `
        <div class="tutorial-confirm-box">
          <h3 style="margin:0 0 4px;font-size:16px;">${TW.escapeHtml(title)}</h3>
          <p>${TW.escapeHtml(body)}</p>
          <div class="tutorial-confirm-actions">
            <button class="btn-tutorial-skip" id="leaveConfirmCancel">Cancel</button>
            <button class="btn-tutorial-next" id="leaveConfirmOk">${TW.escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('#leaveConfirmCancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
      overlay.querySelector('#leaveConfirmOk').addEventListener('click', () => { overlay.remove(); resolve(true); });
    });
  }

  async function confirmLeaveMatch() {
    const confirmed = await confirmDialog({
      title: 'Leave this match?',
      body: 'You will forfeit remaining benefits from this match. Your final rank will be recorded as last place.',
      confirmLabel: 'Confirm Leave',
    });
    if (!confirmed) return;

    const result = await TW.emitAck('match:leave', { matchId });
    if (!result.success) {
      TW.toast(result.error || 'Could not leave the match', 'danger');
      return;
    }
    matchEnded = true;
    TW.toast('You left the match. Final rank recorded as last place.', 'warning');
    setTimeout(() => { window.location.href = '/play'; }, 1200);
  }

  // ---- sabotage visual side-effects --------------------------------------------

  const effectTimers = {};
  function clearEffectTimer(key) {
    if (effectTimers[key]) clearTimeout(effectTimers[key]);
  }

  function applySabotageVisuals(payload) {
    const durationMs = (payload.duration || 0) * 1000;
    switch (payload.cardType) {
      case 'news_bomb': {
        const ticker = document.getElementById('newsTicker');
        ticker.textContent = `📰 BREAKING: ${payload.headline}`;
        ticker.classList.remove('hidden');
        clearEffectTimer('news');
        effectTimers.news = setTimeout(() => ticker.classList.add('hidden'), durationMs);
        break;
      }
      case 'chart_ghost': {
        TW.Chart.setGhosted(true);
        clearEffectTimer('ghost');
        effectTimers.ghost = setTimeout(() => TW.Chart.setGhosted(false), durationMs);
        break;
      }
      case 'false_signal': {
        const overlay = document.getElementById('chartEffectOverlay');
        overlay.classList.add('active');
        overlay.innerHTML = `<div class="effect-title">⚠ RSI DIVERGENCE</div><div class="effect-sub">Fake RSI: ${payload.fakeRsi} — signal may not be real</div>`;
        clearEffectTimer('falseSignal');
        effectTimers.falseSignal = setTimeout(() => {
          overlay.classList.remove('active');
          overlay.innerHTML = '';
        }, durationMs);
        break;
      }
      case 'volatility_surge': {
        TW.Chart.setVolatile(true);
        clearEffectTimer('volatility');
        effectTimers.volatility = setTimeout(() => TW.Chart.setVolatile(false), durationMs);
        break;
      }
      case 'position_freeze': {
        freezeLocked = true;
        updateTradeButtonsDisabled();
        clearEffectTimer('freeze');
        effectTimers.freeze = setTimeout(() => {
          freezeLocked = false;
          updateTradeButtonsDisabled();
        }, durationMs);
        break;
      }
      default:
        // Every other card (spread_spike, liquidity_drain, reversal_flash,
        // smoke_screen, force_close, capital_drain, mirror_trade, and all 18
        // expansion-set cards) needs no extra visual beyond the incoming
        // overlay + feed text - their real effect is server-enforced
        // (blocked trades, worse fills, closed positions, balance changes),
        // not something that needs its own bespoke chart/UI treatment.
        break;
    }
  }

  // ---- end screen -----------------------------------------------------------

  const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

  function buildEquitySvg(history, feed, myUsername) {
    if (!history || history.length < 2) return '<div class="text-secondary" style="font-size:12px;">Not enough data yet.</div>';
    const width = 560;
    const height = 110;
    const pad = 6;
    const equities = history.map((h) => h.equity);
    const min = Math.min(...equities);
    const max = Math.max(...equities);
    const range = max - min || 1;
    const maxT = history[history.length - 1].t || 1;

    const xFor = (t) => pad + (Math.min(Math.max(t, 0), maxT) / maxT) * (width - pad * 2);
    const yFor = (equity) => height - pad - ((equity - min) / range) * (height - pad * 2);

    const points = history.map((h) => `${xFor(h.t).toFixed(1)},${yFor(h.equity).toFixed(1)}`).join(' ');
    const color = equities[equities.length - 1] >= equities[0] ? '#00c896' : '#ff4444';

    function equityAt(t) {
      let nearest = history[0];
      for (const h of history) if (Math.abs(h.t - t) < Math.abs(nearest.t - t)) nearest = h;
      return nearest.equity;
    }

    // Trade-open/close and sabotage-hit markers, placed by converting each feed
    // entry's real timestamp into match-elapsed seconds via matchStartedAtMs
    // (captured from the first price:update, see socket.on('price:update') above).
    const markers = [];
    if (feed && myUsername && matchStartedAtMs) {
      feed.forEach((entry) => {
        const t = (entry.ts - matchStartedAtMs) / 1000;
        if (t < 0 || t > maxT) return;
        const text = entry.text;
        if (text.startsWith(`${myUsername} opened`)) {
          markers.push({ t, type: 'open' });
        } else if (text.startsWith(`${myUsername} closed`)) {
          markers.push({ t, type: / \+\$/.test(text) ? 'close-win' : 'close-loss' });
        } else if (text.includes(' played ') && text.includes(myUsername) && !text.startsWith(myUsername)) {
          markers.push({ t, type: 'sabotage' });
        }
      });
    }

    const markerSvg = markers
      .map((m) => {
        const x = xFor(m.t);
        const y = yFor(equityAt(m.t));
        if (m.type === 'sabotage') {
          return `<path d="M ${x.toFixed(1)} ${(y - 7).toFixed(1)} l 5.5 10 l -11 0 z" fill="#ffb020" stroke="#0d0d0d" stroke-width="0.75" />`;
        }
        const fill = m.type === 'close-loss' ? '#ff4444' : m.type === 'close-win' ? '#00c896' : '#4da6ff';
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${fill}" stroke="#0d0d0d" stroke-width="1" />`;
      })
      .join('');

    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none">
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" />
      ${markerSvg}
    </svg>`;
  }

  function spawnGoldParticles() {
    const container = document.createElement('div');
    container.className = 'end-particles';
    for (let i = 0; i < 30; i++) {
      const p = document.createElement('div');
      p.className = 'end-particle';
      const angle = Math.random() * Math.PI * 2;
      const dist = 100 + Math.random() * 220;
      p.style.setProperty('--px', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--py', `${Math.sin(angle) * dist}px`);
      p.style.animationDelay = `${Math.random() * 0.2}s`;
      container.appendChild(p);
    }
    document.body.appendChild(container);
    setTimeout(() => container.remove(), 1600);
  }

  function showEndScreen(payload) {
    matchEnded = true;
    TW.Sound.play('drumRoll');

    const intro = document.createElement('div');
    intro.className = 'end-intro';
    intro.id = 'endIntro';
    intro.innerHTML = `
      <div class="sc-logo-wrapper results-logo">
        <div class="sc-logo">
          <span class="sc-s1">S</span><span class="sc-p">P</span><span class="sc-i">I</span><span class="sc-k">K</span><span class="sc-e">E</span><span class="sc-amp">&amp;</span><span class="sc-c">C</span><span class="sc-r">R</span><span class="sc-u">U</span><span class="sc-s2">S</span><span class="sc-h">H</span>
        </div>
        <span class="sc-logo-tagline">Up. Then not.</span>
      </div>
      <div class="intro-headline">THE RESULTS ARE IN</div>
    `;
    document.body.appendChild(intro);

    setTimeout(() => buildResultsScreen(payload), 1800);
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
  }

  function buildResultsScreen(payload) {
    document.getElementById('endIntro')?.remove();

    const sortedDesc = [...payload.results].sort((a, b) => b.rank - a.rank); // reveal last place first, winner last
    const me = payload.results.find((r) => r.playerId === lastState?.you);
    const playerCount = payload.results.length;

    const durationLabel = matchStartedAtMs ? formatClock((Date.now() - matchStartedAtMs) / 1000) : '10:00';
    const instrumentsLabel = (lastState?.instruments || ['EURUSD', 'XAUUSD']).join(' / ');

    const overlay = document.createElement('div');
    overlay.className = 'end-screen';
    overlay.innerHTML = `
      <div class="end-header">
        <h1 class="end-title">BATTLE COMPLETE</h1>
        <div class="end-subheader">${durationLabel} · ${TW.escapeHtml(instrumentsLabel)}</div>
      </div>
      <div class="end-rankings" id="endRankings"></div>
      <div class="end-personal-summary hidden" id="endPersonalSummary"></div>
      <div class="end-replay-timeline hidden" id="endReplayTimeline"></div>
      <div class="end-actions">
        <button class="btn btn-primary" id="playAgainBtn">⚔️ Play Again</button>
        <button class="btn btn-outline" id="shareResultBtn">📤 Share Result</button>
        <a class="btn" href="/profile">👤 View Stats</a>
        <a class="btn" href="/play">🏠 Home</a>
      </div>
    `;
    document.body.appendChild(overlay);
    if (me && me.rank === 1 && window.TW && TW.Lottie) TW.Lottie.play('win');

    const rankings = document.getElementById('endRankings');
    sortedDesc.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'end-rank-row' + (r.rank === 1 ? ' winner' : '');
      row.style.animationDelay = `${i * 1}s`;
      const changeSign = r.ratingChange >= 0 ? '+' : '';
      const pnlPct = ((r.pnl / 10000) * 100).toFixed(1);
      row.innerHTML = `
        ${r.rank === 1 ? '<div class="winner-label"><span class="winner-label-text">WINNER</span></div>' : ''}
        <div class="rr-main">
          <div class="crown">${r.rank === 1 ? '👑' : MEDALS[r.rank] || `#${r.rank}`}</div>
          <div class="rank-num">#${r.rank}</div>
          <div class="rr-name">
            <strong>${TW.escapeHtml(r.username)}</strong>
            <span class="pill ${TW.tierClass(r.newTier)}" style="font-size:10px;">${TW.TIER_ICON[r.newTier] || '🔰'} ${TW.escapeHtml(r.newTier)}</span>
            ${r.playerId === lastState?.you ? '<span class="pill pill-gold">YOU</span>' : ''}
          </div>
          <div class="rr-pnl ${r.pnl >= 0 ? 'text-buy' : 'text-sell'}">${TW.formatMoney(r.pnl)}<span class="pct">${
        r.pnl >= 0 ? '+' : ''
      }${pnlPct}%</span></div>
        </div>
        ${
          r.isDraw
            ? `<div class="rr-draw-notice">🤝 Shared ${ordinal(r.rank)} with ${r.drawWith.map((n) => TW.escapeHtml(n)).join(', ')}<br />Prize split: ${r.combinedPrizePercentage}% ÷ ${r.splitCount} = ${r.prizePercentage}%</div>`
            : r.rank === 1
              ? `<div class="rr-result-irony text-buy">You spiked. They got crushed.</div>`
              : r.rank === playerCount
                ? `<div class="rr-result-irony text-sell">You got crushed. They spiked.</div>`
                : ''
        }
        <div class="rr-stats">
          <span>Trades: <strong>${r.tradesMade}</strong></span>
          <span>Best: <strong class="text-buy">${TW.formatMoney(r.bestTrade)}</strong></span>
          <span>Worst: <strong class="text-sell">${TW.formatMoney(r.worstTrade)}</strong></span>
          <span>Cards: <strong>${r.cardsPlayed}</strong></span>
          <span>Rating: <strong class="rr-rating-change ${r.ratingChange >= 0 ? 'text-buy' : 'text-sell'}">${changeSign}${
        r.ratingChange
      }</strong> → ${r.newRating}</span>
          ${r.coinsAwarded ? `<span>🪙 +${r.coinsAwarded}</span>` : ''}
        </div>
      `;
      rankings.appendChild(row);

      if (r.rank === 1) {
        setTimeout(() => {
          spawnGoldParticles();
          TW.Sound.play('win_fanfare');
        }, i * 1000 + 200);
      }
    });

    // Personal summary + equity curve, revealed after the full rankings sequence.
    if (me) {
      setTimeout(() => {
        const cached = TW.getPlayer();
        const tierChanged = cached && me.oldTier !== me.newTier;
        if (cached) {
          cached.war_rating = me.newRating;
          cached.tier = me.newTier;
          // The header's coin balance reads this same cache - without bumping it here,
          // coins earned this match wouldn't show up until the next full page load.
          cached.coins = (cached.coins || 0) + (me.coinsAwarded || 0);
          TW.updatePlayerCache(cached);
          TW.updateHeader();
        }
        const section = document.getElementById('endPersonalSummary');
        section.classList.remove('hidden');
        const ratingUp = me.ratingChange >= 0;
        section.innerHTML = `
          <h3 style="margin-top:0;">Your War, Summarized</h3>
          <div class="rr-stats" style="border-top:none;padding-top:0;margin-top:0;">
            <span>Your rank: <strong>#${me.rank} of ${playerCount} players</strong></span>
            <span>P&amp;L this match: <strong class="${me.pnl >= 0 ? 'text-buy' : 'text-sell'}">${TW.formatMoney(me.pnl)}</strong></span>
            <span>War Rating: <strong class="rating-change ${ratingUp ? 'text-buy' : 'text-sell'}"><span class="rating-arrow">${
          ratingUp ? '▲' : '▼'
        }</span> ${ratingUp ? '+' : ''}${me.ratingChange}</strong> → <strong>${me.newRating}</strong></span>
            <span>Best trade: <strong class="text-buy">${TW.formatMoney(me.bestTrade)}</strong></span>
            ${me.coinsAwarded ? `<span class="coin-pop">🪙 Coins earned: <strong>+${me.coinsAwarded}</strong></span>` : ''}
          </div>
          ${
            tierChanged
              ? me.newTier === 'War Lord'
                ? `<div class="pill pill-gold rank-up-banner">👑 War Lord unlocked. You crushed it.</div>`
                : `<div class="pill pill-gold rank-up-banner">🎉 RANK UP! You are now a ${TW.escapeHtml(me.newTier)}!</div>`
              : ''
          }
          <div class="end-equity-curve">${buildEquitySvg(me.equityHistory, payload.feed, cached?.username)}</div>
        `;
        if (me.coinsAwarded) {
          TW.Sound.play('coin');
          if (window.TW && TW.Lottie) TW.Lottie.play('coins');
        }
        if (tierChanged) {
          TW.Sound.play('coinEarned');
          if (window.TW && TW.Lottie) TW.Lottie.play('rankup');
        }

        const timelineEl = document.getElementById('endReplayTimeline');
        const relevant = (payload.feed || []).filter(
          (entry) => entry.text.includes(cached?.username) || /played|hit stop loss|hit take profit/i.test(entry.text)
        );
        if (relevant.length > 0) {
          timelineEl.classList.remove('hidden');
          timelineEl.innerHTML =
            '<strong style="color:var(--text);">Match Replay</strong>' +
            relevant.map((e) => `<div>${TW.escapeHtml(e.text)}</div>`).join('') +
            `<div style="margin-top:8px;"><a href="/replay?match=${matchId}" class="text-secondary" style="font-size:12px;">🎬 Watch full replay →</a></div>`;
        }
      }, sortedDesc.length * 1000 + 400);
    }

    document.getElementById('playAgainBtn').addEventListener('click', async () => {
      try {
        const data = await TW.api('/api/match/create', { method: 'POST', body: { mode: 'quick' } });
        window.location.href = `lobby.html?matchId=${data.matchId}`;
      } catch (err) {
        TW.toast(err.message, 'danger');
        window.location.href = '/play';
      }
    });

    function drawResultCardPng() {
      const cached = TW.getPlayer();
      const canvas = document.createElement('canvas');
      canvas.width = 1000;
      canvas.height = 560;
      const ctx = canvas.getContext('2d');

      const grad = ctx.createLinearGradient(0, 0, 1000, 560);
      grad.addColorStop(0, '#06110d');
      grad.addColorStop(1, '#0d1f18');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1000, 560);

      ctx.fillStyle = '#00c896';
      ctx.font = '700 40px sans-serif';
      ctx.fillText('Trade', 60, 90);
      ctx.fillStyle = '#ffffff';
      ctx.fillText('Wars', 175, 90);

      if (me) {
        const won = me.rank === 1;
        ctx.fillStyle = won ? '#ffd700' : '#ffffff';
        ctx.font = '700 64px sans-serif';
        ctx.fillText(won ? '🏆 VICTORY' : `#${me.rank} FINISH`, 60, 220);

        ctx.fillStyle = me.pnl >= 0 ? '#00c896' : '#ff4444';
        ctx.font = '700 88px sans-serif';
        ctx.fillText(`${me.pnl >= 0 ? '+' : ''}${TW.formatMoney(me.pnl)}`, 60, 330);

        ctx.fillStyle = '#8a9a94';
        ctx.font = '400 26px sans-serif';
        ctx.fillText(`${cached?.username || 'Trader'} · ${me.newTier} tier · ${playerCount} traders`, 60, 380);
        ctx.fillText(`${durationLabel} · ${instrumentsLabel}`, 60, 415);
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 48px sans-serif';
        ctx.fillText('Battle Complete', 60, 220);
      }

      ctx.fillStyle = '#556b63';
      ctx.font = '400 20px sans-serif';
      ctx.fillText(window.location.host, 60, 500);

      return canvas.toDataURL('image/png');
    }

    function openShareModal() {
      const pnlPct = me ? ((me.pnl / 10000) * 100).toFixed(0) : '0';
      const shareText = me
        ? `I just finished #${me.rank} in Spike & Crush making ${me.pnl >= 0 ? '+' : ''}${TW.formatMoney(me.pnl)} (${pnlPct}%) in 10 minutes! Think you can beat that? Join at ${window.location.host}`
        : `I just finished a Spike & Crush match! Join at ${window.location.host}`;
      const pngDataUrl = drawResultCardPng();
      const replayUrl = `${window.location.origin}/replay?match=${matchId}`;

      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:400;';
      backdrop.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;width:420px;max-width:92vw;">
          <img src="${pngDataUrl}" style="width:100%;border-radius:8px;margin-bottom:14px;" />
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <a class="btn btn-outline" href="https://wa.me/?text=${encodeURIComponent(shareText)}" target="_blank" rel="noopener" style="text-decoration:none;">📱 WhatsApp</a>
            <a class="btn btn-outline" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}" target="_blank" rel="noopener" style="text-decoration:none;">🐦 Twitter/X</a>
            <button class="btn btn-outline" id="copyResultBtn">🔗 Copy Text</button>
          </div>
          <a href="${replayUrl}" style="display:block;margin-top:12px;font-size:12px;color:var(--text-secondary);">🎬 Watch full replay →</a>
          <button class="btn" id="closeShareModalBtn" style="width:100%;margin-top:14px;">Close</button>
        </div>
      `;
      document.body.appendChild(backdrop);
      backdrop.querySelector('#copyResultBtn').addEventListener('click', () => {
        navigator.clipboard.writeText(shareText).then(() => TW.toast('Copied!', 'info'));
      });
      backdrop.querySelector('#closeShareModalBtn').addEventListener('click', () => backdrop.remove());
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    }

    document.getElementById('shareResultBtn').addEventListener('click', openShareModal);
  }

  // ---- mobile bottom sheet ------------------------------------------------------

  document.getElementById('tradingPanelHandle')?.addEventListener('click', () => {
    document.getElementById('tradingPanel').classList.toggle('expanded');
  });

  // ---- socket wiring --------------------------------------------------------------

  const socket = TW.connectSocket();
  if (!socket) {
    window.location.href = '/play';
    return;
  }

  socket.on('connect', async () => {
    const result = await TW.emitAck('player:join', { matchId });
    if (result.success) {
      dismissReconnectOverlay();
    } else if (document.getElementById('reconnectOverlay')) {
      // We were mid-grace-period and the server has already forfeited us
      // (or something else is wrong) - a plain toast would leave the player
      // staring at a frozen board with no way out, so show a terminal state.
      showForfeitedOverlay(result.error);
    } else {
      TW.toast(result.error || 'Could not join match', 'danger');
    }
  });

  // ---- disconnect grace period ----------------------------------------------------
  // Server gives a disconnected human 60s to reconnect (gameEngine.js
  // startDisconnectGrace) before treating it as a forfeit. Socket.io's client
  // already retries automatically with backoff (see socket.js), so this is
  // purely the visible countdown - the server's own timer is authoritative.

  let reconnectCountdownTimer = null;

  function showReconnectOverlay() {
    if (document.getElementById('reconnectOverlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'reconnect-overlay';
    overlay.id = 'reconnectOverlay';
    overlay.innerHTML = `
      <div class="reconnect-card">
        <div class="reconnect-icon">📡</div>
        <div class="reconnect-title">Connection Lost</div>
        <div class="reconnect-body">Reconnecting to your match…</div>
        <div class="reconnect-countdown" id="reconnectCountdown">60</div>
        <div class="reconnect-warning">If you don't reconnect in time you'll receive last place.</div>
      </div>
    `;
    document.body.appendChild(overlay);

    let seconds = 60;
    reconnectCountdownTimer = setInterval(() => {
      seconds -= 1;
      const el = document.getElementById('reconnectCountdown');
      if (el) el.textContent = Math.max(0, seconds);
      if (seconds <= 0) {
        clearInterval(reconnectCountdownTimer);
        reconnectCountdownTimer = null;
      }
    }, 1000);
  }

  function dismissReconnectOverlay() {
    if (reconnectCountdownTimer) {
      clearInterval(reconnectCountdownTimer);
      reconnectCountdownTimer = null;
    }
    document.getElementById('reconnectOverlay')?.remove();
  }

  function showForfeitedOverlay(reason) {
    if (reconnectCountdownTimer) {
      clearInterval(reconnectCountdownTimer);
      reconnectCountdownTimer = null;
    }
    const overlay = document.getElementById('reconnectOverlay') || document.body.appendChild(Object.assign(document.createElement('div'), { className: 'reconnect-overlay', id: 'reconnectOverlay' }));
    overlay.classList.add('reconnect-forfeited');
    overlay.innerHTML = `
      <div class="reconnect-card">
        <div class="reconnect-icon">💀</div>
        <div class="reconnect-title">Match Forfeited</div>
        <div class="reconnect-body">${TW.escapeHtml(reason && reason !== 'Join the match via the API before connecting' ? reason : 'You were disconnected too long. Last place recorded.')}</div>
        <button class="btn-rules-ready" onclick="window.location='/trading-floor'">Return Home</button>
      </div>
    `;
  }

  socket.on('disconnect', () => {
    if (!matchId || (lastState && lastState.status === 'finished')) return;
    showReconnectOverlay();
  });

  socket.on('match:player_disconnected', (data) => {
    TW.toast(`📡 ${data.username} lost connection — ${data.graceSeconds}s to reconnect`, 'warning');
  });

  socket.on('match:player_reconnected', (data) => {
    TW.toast(`✅ ${data.username} reconnected`, 'info');
  });

  socket.on('match:state', (state) => {
    lastState = state;
    setupInstrumentTabs(state.instruments);
    TW.Sabotage.render(state);
    if (!rulesOverlayShown) {
      rulesOverlayShown = true;
      showMatchRules(state);
    }

    const me = state.players.find((p) => p.id === state.you);
    if (me) {
      myAccount.balance = me.balance;
      myAccount.positions = me.positions || [];
      riskLocked = Boolean(me.eliminated || me.softLocked);
      updateTradeButtonsDisabled();
    }

    renderPositions();
    renderAccountSummary();
    renderTopbar();
  });

  let lastCountdownSecond = null;
  socket.on('price:update', (data) => {
    if (matchStartedAtMs === null) matchStartedAtMs = Date.now() - data.elapsedSeconds * 1000;
    lastPrices = data.prices;
    Object.entries(data.prices).forEach(([symbol, price]) => TW.Chart.pushTick(symbol, data.elapsedSeconds, price.mid));
    renderQuotes();
    renderTopbar();
    renderPositions();
    renderAccountSummary();

    const timerEl = document.getElementById('topbarTimer');
    timerEl.textContent = formatClock(data.timeRemaining);
    const wasLow = timerEl.classList.contains('low');
    timerEl.classList.toggle('low', data.timeRemaining <= 60);
    timerEl.classList.toggle('critical', data.timeRemaining <= 10 && data.timeRemaining > 0);
    if (!wasLow && data.timeRemaining <= 60 && data.timeRemaining > 0) TW.Sound.play('oneMinuteWarning');

    if (data.timeRemaining <= 10 && data.timeRemaining >= 1 && data.timeRemaining !== lastCountdownSecond) {
      TW.Sound.play('countdown');
    }
    lastCountdownSecond = data.timeRemaining;
  });

  socket.on('trade:executed', (data) => {
    if (!data.modified) TW.toast(data.mirrored ? 'A position was mirrored onto your account!' : 'Trade executed', 'info');
    if (data.position) {
      const idx = myAccount.positions.findIndex((p) => p.id === data.position.id);
      if (idx === -1) myAccount.positions.push(data.position);
      else myAccount.positions[idx] = data.position;
      renderPositions();
      renderAccountSummary();
      renderTopbar();
    }
  });

  socket.on('trade:closed', (data) => {
    if (data.reason === 'stop_loss') {
      TW.showMatchNotification(`💥 Stop loss hit — ${TW.formatMoney(Math.abs(data.pnl))} lost`);
      TW.Sound.play('sl_hit');
    } else if (data.reason === 'take_profit') {
      TW.showMatchNotification(`🎯 Take profit hit — +${TW.formatMoney(Math.abs(data.pnl))} secured`);
      TW.Sound.play('tp_hit');
    } else {
      TW.toast(`Position closed: ${TW.formatMoney(data.pnl)}`, data.pnl >= 0 ? 'info' : 'warning');
      TW.Sound.play(data.pnl >= 0 ? 'profit' : 'loss');
    }
    myAccount.positions = myAccount.positions.filter((p) => p.id !== data.positionId);
    myAccount.balance = data.balance;
    renderPositions();
    renderAccountSummary();
    renderTopbar();
  });

  socket.on('trade:partial_closed', (data) => {
    TW.toast(`Partial close: ${data.closedLots} lots for ${TW.formatMoney(data.pnl)}`, data.pnl >= 0 ? 'info' : 'warning');
    TW.Sound.play(data.pnl >= 0 ? 'closeProfit' : 'closeLoss');
    const pos = myAccount.positions.find((p) => p.id === data.positionId);
    if (pos) pos.lots = data.remainingLots;
    myAccount.balance = data.balance;
    renderPositions();
    renderAccountSummary();
    renderTopbar();
  });

  const SABOTAGE_SOUND_MAP = { news_bomb: 'newsBomb', force_close: 'forceClose', chart_ghost: 'chartGhost' };
  socket.on('sabotage:incoming', (payload) => {
    TW.Sabotage.showIncoming(payload);
    applySabotageVisuals(payload);
    TW.Sound.play(SABOTAGE_SOUND_MAP[payload.cardType] || 'cardReceived');
    if (window.TW && TW.Lottie) TW.Lottie.play('fire');
    if (payload.cardType === 'capital_drain' && payload.amount) {
      myAccount.balance -= payload.amount;
      renderAccountSummary();
      renderTopbar();
    }
  });
  // FIX: market-wide cards (volatility_surge, spread_spike, liquidity_drain,
  // smoke_screen) now exempt the player who cast them - server confirms it
  // with this event right after the card resolves.
  socket.on('sabotage:immune', () => TW.Sabotage.showImmune());
  // Reversal Flash: private 1s heads-up before the shared price reversal
  // actually starts - opponents only learn about it once it's already moving.
  socket.on('sabotage:reversal_warning', () => TW.Sabotage.showReversalWarning());

  // match:feed already carries every sabotage:broadcast message (gameEngine
  // pushes the same feedText to both) - only listen once to avoid duplicate ticker lines.
  socket.on('match:feed', (entry) => pushFeed(entry.text));
  socket.on('margin:warning', (payload) => {
    showMarginBanner(payload);
    if (payload.level === 'eliminated') {
      TW.Sound.play('stopLossHit');
      showEliminationModal(payload);
    } else {
      TW.Sound.play('margin_alert');
      if (payload.level === 'warning') TW.showMatchNotification(`⚠️ Margin warning — equity $${payload.equity}`);
    }
  });

  let lastViewerRank = null;
  socket.on('leaderboard:update', (payload) => {
    TW.Leaderboard.render(payload, lastState?.you);
    const myRow = payload.rows.find((r) => r.id === lastState?.you);
    if (myRow && lastViewerRank !== null && myRow.rank > lastViewerRank) {
      TW.showMatchNotification(`📉 You just got overtaken — now #${myRow.rank}`);
    }
    if (myRow && lastViewerRank !== null && myRow.rank !== lastViewerRank) TW.Sound.play('leaderboardChange');
    if (myRow) lastViewerRank = myRow.rank;
  });

  socket.on('match:countdown', () => {}); // already past lobby by the time game.html loads
  socket.on('match:draw_detected', (payload) => {
    const myUsername = TW.getPlayer()?.username;
    const mine = (payload.drawGroups || []).find((g) => g.players?.includes(myUsername));
    if (mine) {
      TW.toast(`🤝 Shared ${ordinal(mine.rank)} at ${TW.formatMoney(mine.pnl)} - split ${mine.splitFrom}% ÷ ${mine.splitCount}`, 'info');
    }
  });
  socket.on('match:end', (payload) => {
    if (!matchEnded) {
      TW.Sound.play('match_end');
      showEndScreen(payload);
    }
  });
  // Admin panel actions (server/internalAdmin.js) - kicked/voided players get
  // a clear reason and are sent home rather than left staring at a match that
  // server-side no longer includes them.
  socket.on('match:kicked', (payload) => {
    matchEnded = true;
    TW.toast(payload.reason || 'You were removed from this match by an admin.', 'danger');
    setTimeout(() => { window.location.href = '/play'; }, 2000);
  });
  socket.on('match:voided', (payload) => {
    if (matchEnded) return;
    matchEnded = true;
    TW.toast(payload.reason || 'This match was cancelled by an admin.', 'warning');
    setTimeout(() => { window.location.href = '/play'; }, 2500);
  });

  document.getElementById('leaveMatchBtn')?.addEventListener('click', () => confirmLeaveMatch());

  setupLotSelector();
  setupTimeframeSelector();
  setupSltpControls();
})();
