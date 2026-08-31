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
        <div class="name">${TW.escapeHtml(def.name)}</div>
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
    const title = payload.cardName || payload.cardType;
    let sub = 'Your position has been affected!';
    if (payload.cardType === 'news_bomb') sub = `"${payload.headline}"`;
    else if (payload.cardType === 'capital_drain') sub = `-$${payload.amount} drained from your capital`;
    else if (payload.cardType === 'mirror_trade' && payload.source) {
      sub = `${payload.source.direction} ${payload.source.lots} ${payload.source.symbol} mirrored onto your account`;
    } else if (payload.cardType === 'chart_ghost') sub = 'Your chart is frozen — trade blind!';
    else if (payload.cardType === 'position_freeze') sub = 'You cannot open new trades right now.';
    else if (payload.cardType === 'false_signal') sub = 'A fake indicator signal has appeared on your chart.';
    else if (payload.cardType === 'force_close') sub = 'One of your positions was force-closed at market.';
    else if (payload.cardType === 'spread_spike') sub = `Spread tripled on ${payload.symbol}.`;
    else if (payload.cardType === 'volatility_surge') sub = 'Price swings just doubled for everyone.';
    else if (payload.cardType === 'liquidity_drain') sub = 'Max lot size capped at 0.1 for everyone.';
    else if (payload.cardType === 'reversal_flash') sub = `Sharp reversal incoming on ${payload.symbol}!`;
    else if (payload.cardType === 'smoke_screen') sub = 'The leaderboard is blurred for everyone.';

    const overlay = document.createElement('div');
    overlay.className = 'sabotage-overlay';
    overlay.innerHTML = `
      <div class="sabotage-overlay-card">
        <div class="icon">⚠️</div>
        <h3>${TW.escapeHtml(title)}</h3>
        <div>${TW.escapeHtml(sub)}</div>
        <div class="sabotage-overlay-irony text-sell">It's about to get crushed.</div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 2600);
  }

  return { render, showIncoming };
})();
