'use strict';

window.TW = window.TW || {};

TW.Sabotage = (function () {
  let lastState = null;
  let selectedCardType = null;

  function render(state) {
    lastState = state;
    const me = state.players.find((p) => p.id === state.you);
    const myCards = me ? me.cards : [];
    const opponents = state.players.filter((p) => p.id !== state.you);

    const container = document.getElementById('cardSlots');
    if (!container) return;
    container.innerHTML = '';

    myCards.forEach((c) => {
      const def = state.cardCatalog.find((cd) => cd.id === c.type);
      if (!def) return;
      const div = document.createElement('div');
      div.className = 'sabotage-card' + (c.used ? ' used' : '') + (selectedCardType === c.type ? ' selected' : '');
      div.innerHTML = `
        <div class="icon">${def.icon}</div>
        <div class="name">${TW.escapeHtml(def.name)} <button type="button" class="help-btn" data-help="${def.id}" title="What does this card do?" onclick="event.stopPropagation()">?</button></div>
        <div class="desc">${TW.escapeHtml(def.description)}</div>
        <div class="category-tag">${TW.escapeHtml(def.category)}</div>
      `;
      if (!c.used) {
        div.addEventListener('click', () => {
          selectedCardType = selectedCardType === c.type ? null : c.type;
          render(lastState);
        });
      }
      container.appendChild(div);
    });

    renderTargetPicker(opponents);
  }

  function renderTargetPicker(opponents) {
    const wrap = document.getElementById('targetPicker');
    if (!wrap) return;
    if (!selectedCardType) {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
      return;
    }
    const def = lastState.cardCatalog.find((cd) => cd.id === selectedCardType);
    wrap.classList.remove('hidden');

    let html = `<strong>${TW.escapeHtml(def.name)}</strong>`;
    if (def.targeted) {
      html += `<select id="sabTargetSelect"><option value="">Choose target…</option>${opponents
        .map((o) => `<option value="${o.id}">${TW.escapeHtml(o.username)}</option>`)
        .join('')}</select>`;
    }
    if (def.requiresSymbol) {
      html += `<select id="sabSymbolSelect">${(lastState.instruments || ['EURUSD', 'XAUUSD'])
        .map((s) => `<option value="${s}">${s}</option>`)
        .join('')}</select>`;
    }
    html += `<button id="sabConfirmBtn" class="btn btn-primary">Play Card</button>`;
    html += `<button id="sabCancelBtn" class="btn">Cancel</button>`;
    wrap.innerHTML = html;

    document.getElementById('sabConfirmBtn').addEventListener('click', async () => {
      const targetSelect = document.getElementById('sabTargetSelect');
      const symbolSelect = document.getElementById('sabSymbolSelect');
      const targetId = targetSelect ? targetSelect.value : undefined;
      const symbol = symbolSelect ? symbolSelect.value : undefined;
      if (def.targeted && !targetId) {
        TW.toast('Choose a target first', 'warning');
        return;
      }
      const result = await TW.emitAck('sabotage:play', { cardType: selectedCardType, targetId, symbol });
      if (!result.success) {
        TW.toast(result.error, 'danger');
      } else {
        TW.toast(`${def.name} played!`, 'info');
        TW.Sound.play('cardPlayedByYou');
        if (window.TW && TW.Lottie) TW.Lottie.play('lightning');
      }
      selectedCardType = null;
      render(lastState);
    });

    document.getElementById('sabCancelBtn').addEventListener('click', () => {
      selectedCardType = null;
      render(lastState);
    });
  }

  function showIncoming(payload) {
    const name = payload.cardName || payload.cardType;
    let sub = 'Your position has been affected!';
    if (payload.cardType === 'news_bomb') sub = `"${payload.headline}"`;
    else if (payload.cardType === 'capital_drain') sub = `-$${payload.amount} drained from your capital`;
    else if (payload.cardType === 'mirror_trade' && payload.source) {
      sub = `${payload.source.direction} ${payload.source.lots} ${payload.source.symbol} mirrored onto your account`;
    } else if (payload.cardType === 'chart_ghost') sub = 'Your chart is frozen — trade blind!';
    else if (payload.cardType === 'position_freeze') sub = 'You cannot open new trades right now.';
    else if (payload.cardType === 'false_signal') sub = 'A fake indicator signal has appeared on your chart.';
    else if (payload.cardType === 'force_close') sub = 'One of your positions was force-closed at market.';
    else if (payload.cardType === 'spread_spike') sub = `Spread tripled on ${payload.symbol} for everyone except whoever played it.`;
    else if (payload.cardType === 'volatility_surge') sub = 'Price swings just doubled for everyone except whoever played it.';
    else if (payload.cardType === 'liquidity_drain') sub = 'Max lot size capped at 0.1 for everyone except whoever played it.';
    else if (payload.cardType === 'reversal_flash') sub = `Sharp reversal incoming on ${payload.symbol}!`;
    else if (payload.cardType === 'smoke_screen') sub = 'The leaderboard is blurred for everyone except whoever played it.';
    else if (payload.cardType === 'margin_scare') sub = 'Fake margin-call warning on your screen — your account is fine.';
    else if (payload.cardType === 'phantom_candle') sub = 'A fake candle just appeared on your chart.';
    else if (payload.cardType === 'blackout') sub = 'Your live P&L display just went blank.';
    else if (payload.cardType === 'static_burst') sub = 'Your chart is covered in visual static.';
    else if (payload.cardType === 'decoy_order') sub = 'Fake giant sell-wall alert on your screen — not real.';
    else if (payload.cardType === 'mirage') sub = 'A fake ghost position just appeared in your position list.';
    else if (payload.cardType === 'intel_leak') {
      sub = payload.targetUsername
        ? `You can see ${payload.targetUsername}'s real balance and open positions for a while.`
        : "You can see your target's real balance and open positions for a while.";
    } else if (payload.cardType === 'double_spread') sub = 'Spread doubled on every instrument for everyone except whoever played it.';
    else if (payload.cardType === 'time_warp') sub = 'Price feed delayed 3 seconds for everyone except whoever played it.';
    else if (payload.cardType === 'fog_of_war') sub = 'Random price jitter thrown into the feed for everyone except whoever played it.';
    else if (payload.cardType === 'panic_wave') sub = 'Every instrument is about to reverse at once!';
    else if (payload.cardType === 'dead_calm') sub = 'Price is frozen for everyone except whoever played it.';
    else if (payload.cardType === 'lockout') sub = 'You cannot close positions right now.';
    else if (payload.cardType === 'margin_call') sub = 'All of your positions were force-closed at market.';
    else if (payload.cardType === 'lot_limiter') sub = 'Your max lot size is capped at 0.05 for a while.';
    else if (payload.cardType === 'pip_theft') sub = `-$${payload.amount} stolen from your capital`;
    else if (payload.cardType === 'ghost_trade') sub = 'A losing position was forced onto your account.';
    else if (payload.cardType === 'stop_snipe') sub = "Your best position's stop-loss was dragged to break-even.";

    TW.showMatchNotification(`⚠️ ${name} — ${sub}`);
  }

  // FIX: market-wide cards no longer affect the player who played them - a
  // brief center-screen confirmation so they know it's deliberate, not a bug.
  function showImmune() {
    TW.showMatchNotification('🛡️ Your card does not affect you');
  }

  // Reversal Flash: the caster gets this 1s before the shared price reversal
  // actually starts moving - opponents get no such warning.
  function showReversalWarning() {
    TW.showMatchNotification('⚡ Reversal incoming...');
  }

  return { render, showIncoming, showImmune, showReversalWarning };
})();
