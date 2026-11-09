'use strict';

window.TW = window.TW || {};

// Card tray (up to 4 cards), Heat meter and the target sheet. The server
// decides everything (grants, plays, shields); this only shows it and sends
// the player's choice. Targeting: tap a card, pick a player from the same
// ranked list as the leaderboard (searchable, with quick picks), confirm.
TW.Sabotage = (function () {
  let lastState = null;
  let hand = []; // [{ type, used, earned }]
  let streak = 0;
  let heat = 0;
  let heatMult = 1;
  let rows = []; // latest leaderboard rows
  let pendingCard = null;
  let lastStreakShown = 0;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const icon = (k, s) => (TW.CardIcons ? TW.CardIcons.svg(k, s) : '');
  const fire = () => (lastState && lastState.fire) || { handSize: 4, streakRewards: { 1: 1, 2: 1, 3: 2 }, refillAtStreak: 5, heat: { enabled: true, multipliers: [1, 1.5, 2, 3] } };
  const def = (type) => (lastState ? lastState.cardCatalog.find((c) => c.id === type) : null);
  const me = () => (lastState ? lastState.players.find((p) => p.id === lastState.you) : null);

  function render(state) {
    lastState = state;
    const p = me();
    if (p) {
      hand = p.cards || [];
      if (typeof p.streak === 'number') streak = p.streak;
      if (typeof p.heat === 'number') heat = p.heat;
    }
    drawTray();
    drawHeat();
  }

  // cards:update from the server (earned cards, streak, Heat).
  function update(payload) {
    const before = hand.filter((c) => !c.used).length;
    hand = payload.cards || hand;
    const prevStreak = streak;
    streak = payload.streak ?? streak;
    heat = payload.heat ?? heat;
    heatMult = payload.heatMultiplier ?? heatMult;
    const after = hand.filter((c) => !c.used).length;
    drawTray(after > before);
    drawHeat(streak !== prevStreak);
    if (streak > prevStreak) TW.Sound.play('streakUp');
    else if (streak === 0 && prevStreak > 0) TW.Sound.play('streakLost');
    if (after > before) TW.Sound.play('cardReceived');
    const e = payload.earned;
    if (payload.dethrone) TW.showMatchNotification('You took the crown - Dethrone card earned');
    else if (e && e.refill) TW.showMatchNotification(`Streak ${streak} - every card slot refilled`);
    else if (e && e.granted && e.granted.length) TW.showMatchNotification(`Streak ${streak} - +${e.granted.length} card${e.granted.length === 1 ? '' : 's'}`);
    else if (e && e.heat && !e.granted?.length && after >= fire().handSize) TW.showMatchNotification(`Hand full - +${e.heat} Heat instead`);
  }

  function nextCardText() {
    const f = fire();
    if (f.earnedCards === false) return 'Cards: dealt at start';
    const rewards = f.streakRewards || {};
    for (let s = streak + 1; s <= f.refillAtStreak; s++) {
      if (rewards[s] || s === f.refillAtStreak) return `${s - streak} more win${s - streak === 1 ? '' : 's'} = new card`;
    }
    return 'Next win = new card';
  }

  function drawTray(flash = false) {
    const box = document.getElementById('cardSlots');
    if (!box) return;
    const size = fire().handSize || 4;
    const live = hand.filter((c) => !c.used).slice(0, size);
    let html = '';
    live.forEach((c, i) => {
      const d = def(c.type);
      if (!d) return;
      html += `<button type="button" class="fire-card rarity-${d.rarity} kind-${d.kind}${flash && i === live.length - 1 ? ' fire-card-new' : ''}${pendingCard === c.type ? ' selected' : ''}" data-card="${c.type}" title="${TW.escapeHtml(d.name)}: ${TW.escapeHtml(d.description)}" aria-label="${TW.escapeHtml(d.name)}: ${TW.escapeHtml(d.description)}">
        <span class="fc-icon">${icon(d.icon, 22)}</span>
        <span class="fc-name">${TW.escapeHtml(d.name)}</span>
        <span class="fc-kind">${d.kind === 'defense' ? 'Self' : d.kind === 'market' ? 'All' : 'Target'}</span>
      </button>`;
    });
    for (let i = live.length; i < size; i++) {
      html += `<div class="fire-card empty" aria-label="Empty card slot"><span class="fc-icon">${icon('plus', 18)}</span><span class="fc-next">${TW.escapeHtml(nextCardText())}</span></div>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('button.fire-card').forEach((b) => b.addEventListener('click', () => choose(b.dataset.card)));
  }

  function drawHeat(animate = false) {
    const el = document.getElementById('heatMeter');
    if (!el) return;
    const f = fire();
    if (f.heat && f.heat.enabled === false) {
      el.hidden = true;
      return;
    }
    const mults = (f.heat && f.heat.multipliers) || [1, 1.5, 2, 3];
    heatMult = mults[Math.min(streak, mults.length - 1)];
    const stops = [1, 2, 3, f.refillAtStreak || 5];
    const pct = Math.min(100, (streak / (f.refillAtStreak || 5)) * 100);
    el.hidden = false;
    el.innerHTML = `
      <div class="hm-head"><span class="hm-icon">${icon('heat', 14)}</span><span class="hm-label">Heat</span><strong class="hm-score">${Math.round(heat)}</strong><span class="hm-mult">x${heatMult}</span></div>
      <div class="hm-bar" role="progressbar" aria-label="Win streak" aria-valuemin="0" aria-valuemax="${f.refillAtStreak || 5}" aria-valuenow="${streak}">
        <div class="hm-fill${animate && !reduceMotion ? ' hm-pulse' : ''}" style="width:${pct}%"></div>
        ${stops.map((s) => `<span class="hm-stop${streak >= s ? ' hit' : ''}" style="left:${(s / (f.refillAtStreak || 5)) * 100}%"></span>`).join('')}
      </div>
      <div class="hm-sub">Streak ${streak}${streak !== lastStreakShown && streak === 0 && lastStreakShown > 0 ? ' - reset' : ''}</div>`;
    lastStreakShown = streak;
  }

  // ---- playing a card -------------------------------------------------------------

  function choose(type) {
    const d = def(type);
    if (!d) return;
    if (d.kind === 'defense') {
      send(type, {});
      return;
    }
    pendingCard = type;
    drawTray();
    openSheet(d);
  }

  async function send(type, opts) {
    const d = def(type);
    const result = await TW.emitAck('sabotage:play', { cardType: type, ...opts });
    if (!result || !result.success) {
      TW.toast((result && result.error) || 'Card could not be played', 'danger');
      return false;
    }
    TW.Sound.play('cardPlayedByYou');
    const el = document.querySelector(`.fire-card[data-card="${type}"]`);
    if (el && !reduceMotion) el.classList.add('fire-card-played');
    TW.toast(`${d.name} played`, 'info');
    return true;
  }

  function statusLabel(s) {
    return { offline: 'Offline', shield: 'Shield', protected: 'Protected', frozen: 'Frozen', affected: 'Hit', out: 'Out' }[s] || s;
  }

  function blockedReason(r) {
    const s = r.status || [];
    if (s.includes('offline')) return 'Offline';
    if (s.includes('shield')) return 'Shield up';
    if (s.includes('protected')) return 'Just hit - protected';
    if (s.includes('out')) return 'Out of the match';
    return null;
  }

  function openSheet(d) {
    closeSheet();
    const you = lastState.you;
    const sheet = document.createElement('div');
    sheet.className = 'fire-sheet';
    sheet.id = 'targetSheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', `Play ${d.name}`);
    const needsTarget = d.targeted;
    const instrumentsList = lastState.instruments || [];
    sheet.innerHTML = `
      <div class="fs-panel">
        <div class="fs-head">
          <span class="fs-icon">${icon(d.icon, 22)}</span>
          <div><strong>${TW.escapeHtml(d.name)}</strong><div class="fs-desc">${TW.escapeHtml(d.description)}</div></div>
          <button type="button" class="fs-close" aria-label="Cancel">&times;</button>
        </div>
        ${needsTarget ? `
        <div class="fs-quick">
          <button type="button" data-pick="random">${icon('dice', 14)} Random</button>
          <button type="button" data-pick="leader">${icon('crown', 14)} Leader</button>
          <button type="button" data-pick="above">${icon('up', 14)} Above me</button>
          <button type="button" data-pick="below">${icon('down', 14)} Below me</button>
        </div>
        <label class="fs-search">${icon('search', 14)}<input type="search" placeholder="Search players" aria-label="Search players" /></label>
        <div class="fs-list" role="listbox" aria-label="Choose a target"></div>` : `
        <p class="fs-note">Hits every other player who is not shielded.</p>
        ${d.requiresSymbol ? `<label class="fs-symbol">Instrument <select>${instrumentsList.map((s) => `<option value="${s}">${s}</option>`).join('')}</select></label>` : ''}
        <button type="button" class="btn btn-primary fs-play">Play ${TW.escapeHtml(d.name)}</button>`}
      </div>`;
    document.body.appendChild(sheet);
    const close = () => {
      pendingCard = null;
      closeSheet();
      drawTray();
    };
    sheet.querySelector('.fs-close').addEventListener('click', close);
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) close();
    });
    document.addEventListener('keydown', escClose);

    if (!needsTarget) {
      sheet.querySelector('.fs-play').addEventListener('click', async () => {
        const sym = sheet.querySelector('.fs-symbol select');
        if (await send(d.id, { symbol: sym ? sym.value : undefined })) close();
      });
      return;
    }

    const list = sheet.querySelector('.fs-list');
    const search = sheet.querySelector('.fs-search input');
    const others = () => rows.filter((r) => r.id !== you);
    const draw = () => {
      const q = (search.value || '').trim().toLowerCase();
      const shown = others().filter((r) => !q || r.username.toLowerCase().includes(q)).slice(0, 200);
      list.innerHTML = shown.length ? shown.map((r) => {
        const why = blockedReason(r);
        return `<button type="button" class="fs-row${why ? ' blocked' : ''}" data-id="${r.id}" ${why ? 'aria-disabled="true"' : ''}>
          <span class="fs-rank">#${r.rank}</span>
          <span class="fs-name">${r.crown ? `<span class="fs-crown">${icon('crown', 13)}</span>` : ''}${TW.escapeHtml(r.username)}<span class="fs-tier">${TW.escapeHtml(r.tier || '')}${r.level ? ` · L${r.level}` : ''}</span></span>
          <span class="fs-eq ${r.pnl >= 0 ? 'text-buy' : 'text-sell'}">${TW.formatMoney(r.equity ?? 10000 + r.pnl)}</span>
          <span class="fs-tags">${(r.status || []).map((s) => `<span class="fs-tag tag-${s}">${statusLabel(s)}</span>`).join('')}${why ? `<span class="fs-why">${why}</span>` : ''}</span>
        </button>`;
      }).join('') : '<div class="fs-empty">No players match</div>';
      list.querySelectorAll('.fs-row:not(.blocked)').forEach((b) => b.addEventListener('click', () => fireAt(b.dataset.id)));
    };
    const fireAt = async (targetId) => {
      if (await send(d.id, { targetId })) close();
    };
    search.addEventListener('input', draw);
    sheet.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      const ok = others().filter((r) => !blockedReason(r));
      if (!ok.length) return TW.toast('No player can be targeted right now', 'warning');
      const mine = rows.find((r) => r.id === you);
      let pick = null;
      if (b.dataset.pick === 'random') pick = ok[Math.floor(Math.random() * ok.length)];
      else if (b.dataset.pick === 'leader') pick = ok.find((r) => r.crown) || ok[0];
      else if (b.dataset.pick === 'above') pick = mine ? ok.filter((r) => r.rank < mine.rank).pop() : null;
      else if (b.dataset.pick === 'below') pick = mine ? ok.find((r) => r.rank > mine.rank) : null;
      if (!pick) return TW.toast('Nobody there to target', 'warning');
      fireAt(pick.id);
    }));
    draw();
    search.focus({ preventScroll: true });
  }

  function escClose(e) {
    if (e.key === 'Escape') {
      pendingCard = null;
      closeSheet();
      drawTray();
    }
  }

  function closeSheet() {
    document.getElementById('targetSheet')?.remove();
    document.removeEventListener('keydown', escClose);
  }

  function setLeaderboard(newRows) {
    rows = newRows || [];
    const sheet = document.getElementById('targetSheet');
    if (sheet) {
      const input = sheet.querySelector('.fs-search input');
      if (input) input.dispatchEvent(new Event('input'));
    }
  }

  // ---- incoming --------------------------------------------------------------------

  const INCOMING = {
    profit_tax: (p) => (p.collected ? `Profit Tax collected: -${p.amount} from your win` : 'Profit Tax: your next winning close pays a share to them'),
    spread_blowout: () => 'Your spread is tripled on every instrument',
    slippage_storm: () => 'Your next 2 fills land 2 spreads worse',
    margin_squeeze: () => 'You can only open half the size your margin allows',
    stop_yank: () => 'Your stop loss was moved closer to the price',
    tp_snip: () => 'Your take profits were removed',
    order_freeze: () => 'You cannot change stop loss or take profit right now',
    trade_limit: () => 'You cannot open a new trade while you hold one',
    one_way: (p) => `You can only ${p.direction || 'trade one way'} for a while`,
    cooldown_jam: () => 'You must wait between opening trades',
    profit_skim: (p) => `-${p.amount} skimmed from your banked profit`,
    spread_spike: (p) => `Spread tripled on ${p.symbol} for everyone except whoever played it`,
    volatility_surge: () => 'Price swings doubled for everyone except whoever played it',
    liquidity_drain: () => 'Max lot size capped at 0.1 for everyone except whoever played it',
    reversal_flash: (p) => `Sharp reversal incoming on ${p.symbol}`,
    position_freeze: () => 'You cannot open new trades right now',
    force_close: () => 'One of your positions was force-closed at market',
    capital_drain: (p) => `-${p.amount} drained from your capital`,
    mirror_trade: (p) => (p.source ? `${p.source.direction} ${p.source.lots} ${p.source.symbol} mirrored onto your account` : 'A position was mirrored onto your account'),
    double_spread: () => 'Spread doubled on every instrument for everyone except whoever played it',
    time_warp: () => 'Price feed delayed 3 seconds for everyone except whoever played it',
    fog_of_war: () => 'Price jitter in the feed for everyone except whoever played it',
    panic_wave: () => 'Every instrument is about to reverse',
    dead_calm: () => 'Price frozen for everyone except whoever played it',
    lockout: () => 'You cannot close positions right now',
    margin_call: () => 'All of your positions were force-closed at market',
    lot_limiter: () => 'Your max lot size is capped at 0.05 for a while',
    pip_theft: (p) => `-${p.amount} stolen from your capital`,
    ghost_trade: () => 'A losing position was forced onto your account',
    stop_snipe: () => "Your best position's stop loss was dragged to break-even",
  };

  function showIncoming(payload) {
    const name = payload.cardName || payload.cardType;
    const fn = INCOMING[payload.cardType];
    TW.showMatchNotification(`${name}: ${fn ? fn(payload) : 'a card hit you'}`);
  }

  function showImmune() {
    TW.showMatchNotification('Your card does not affect you');
  }

  function showReversalWarning() {
    TW.showMatchNotification('Reversal incoming');
  }

  return { render, update, setLeaderboard, showIncoming, showImmune, showReversalWarning, closeSheet };
})();
