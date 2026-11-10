'use strict';

window.TW = window.TW || {};

// Card tray (up to 4 cards), Heat meter and the target sheet. The server
// decides everything (grants, plays, shields); this only shows it and sends
// the player's choice. Targeting: tap a card, pick a player from the same
// ranked list as the leaderboard (searchable, with quick picks), right there
// in the cards panel. Cards look like the landing page card and can be spun.
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
    drawTray();
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

  // ---- the cards themselves -------------------------------------------------------
  // Same face as the landing page card (js/card-art.js), built in HTML so it
  // stays sharp at tray size. Faint candles are seeded by the card name, like
  // the landing art, so every card has its own chart behind it.

  const KIND_LABEL = { defense: 'Defense card', market: 'Market card' };
  const candleCache = {};
  function candleSvg(seed, alpha, base, spread) {
    const key = `${seed}:${alpha}:${base}`;
    if (candleCache[key]) return candleCache[key];
    let s = seed >>> 0;
    let v = base;
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const W = 1000, cw = W / 26;
    let out = '';
    for (let i = 0; i < 26; i++) {
      const open = v, close = v + (r() - 0.5) * spread, up = close < open;
      const fill = up ? `rgba(31,211,138,${alpha})` : `rgba(255,77,106,${alpha})`;
      const top = Math.min(open, close);
      out += `<rect x="${(i * cw + cw * 0.46).toFixed(1)}" y="${(top - spread * 0.25).toFixed(1)}" width="${(cw * 0.08).toFixed(1)}" height="${(Math.abs(close - open) + spread * 0.5).toFixed(1)}" fill="${fill}"/>`;
      out += `<rect x="${(i * cw + cw * 0.2).toFixed(1)}" y="${top.toFixed(1)}" width="${(cw * 0.6).toFixed(1)}" height="${Math.max(3, Math.abs(close - open)).toFixed(1)}" fill="${fill}"/>`;
      v = close;
    }
    return (candleCache[key] = `<svg class="sc-art" viewBox="0 0 1000 1409" preserveAspectRatio="none" aria-hidden="true">${out}</svg>`);
  }

  function cardHtml(d, extraClass = '') {
    return `<button type="button" class="sc-card kind-${d.kind} rarity-${d.rarity} ${extraClass}" data-card="${d.id}" aria-label="${TW.escapeHtml(d.name)}: ${TW.escapeHtml(d.description)}">
      <span class="sc-spin">
        <span class="sc-face sc-front">
          ${candleSvg(d.name.length * 97, 0.42, 1409 * 0.38, 1409 * 0.06)}
          <span class="sc-bar"></span>
          <span class="sc-icon">${icon(d.icon, 24)}</span>
          <span class="sc-text">
            <span class="sc-label">${KIND_LABEL[d.kind] || 'Sabotage card'}</span>
            <span class="sc-name">${TW.escapeHtml(d.name)}</span>
            <span class="sc-desc">${TW.escapeHtml(d.description)}</span>
          </span>
          <span class="sc-sheen"></span>
        </span>
        <span class="sc-face sc-back">
          ${candleSvg(4242, 0.5, 1409 * 0.5, 1409 * 0.075)}
          <span class="sc-mark"><b class="s">Spike</b><i>&amp;</i><b class="c">Crush</b></span>
          <span class="sc-sheen"></span>
        </span>
      </span>
    </button>`;
  }

  // Drag sideways to spin, like the landing card: it keeps turning after you
  // let go and settles on whichever face is nearer. A tap (no drag) is a click.
  // On a mouse the card also tilts toward the pointer.
  function makeSpinnable(el, { onTap, settleTo = 180 } = {}) {
    const spin = el.querySelector('.sc-spin');
    let angle = 0, vel = 0, dragging = false, moved = false, startX = 0, lastX = 0, lastT = 0, raf = 0;
    const set = () => {
      el.style.setProperty('--ry', `${angle}deg`);
      const a = ((angle % 360) + 360) % 360;
      el.style.setProperty('--sheen', `${20 + (a / 360) * 160}%`);
    };
    const facingBack = () => {
      const a = ((angle % 360) + 360) % 360;
      return a > 90 && a < 270;
    };
    function settle() {
      cancelAnimationFrame(raf);
      const step = () => {
        if (Math.abs(vel) > 0.05 && !reduceMotion) {
          angle += vel;
          vel *= 0.93;
          set();
          raf = requestAnimationFrame(step);
          return;
        }
        vel = 0;
        el.classList.remove('is-turning');
        angle = Math.round(angle / settleTo) * settleTo;
        set();
      };
      raf = requestAnimationFrame(step);
    }
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      dragging = true;
      moved = false;
      startX = lastX = e.clientX;
      lastT = performance.now();
      vel = 0;
      cancelAnimationFrame(raf);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) {
        if (e.pointerType === 'mouse' && !el.classList.contains('is-turning')) {
          const r = el.getBoundingClientRect();
          el.style.setProperty('--rx', `${(((e.clientY - r.top) / r.height) - 0.5) * -10}deg`);
          el.style.setProperty('--sheen', `${((e.clientX - r.left) / r.width) * 100}%`);
        }
        return;
      }
      const dx = e.clientX - lastX;
      if (!moved && Math.abs(e.clientX - startX) > 6) {
        moved = true;
        el.classList.add('is-turning');
        el.setPointerCapture(e.pointerId);
        el.style.setProperty('--rx', '0deg');
      }
      if (!moved) return;
      const now = performance.now();
      angle += dx * 0.9;
      vel = (dx * 0.9) * Math.min(1, 16 / Math.max(1, now - lastT));
      lastX = e.clientX;
      lastT = now;
      set();
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      if (moved) settle();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { if (!dragging) el.style.setProperty('--rx', '0deg'); });
    el.addEventListener('click', (e) => {
      if (moved) { e.preventDefault(); moved = false; return; }
      if (facingBack()) { turnBy(180); return; } // first tap turns a face-down card over
      onTap && onTap(e);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        turnBy(e.key === 'ArrowLeft' ? -180 : 180);
      }
    });
    function turnBy(deg) {
      cancelAnimationFrame(raf);
      angle = Math.round((angle + deg) / settleTo) * settleTo;
      el.classList.remove('is-turning');
      set();
    }
    set();
    void spin;
    return { turnBy };
  }

  // The tray keeps each card's element (and so its angle) between updates;
  // only cards that are new get dealt in. Keyed by position in the hand,
  // which the server never reorders (used cards stay in place, marked used).
  const trayEls = new Map(); // key -> { el, type }
  let trayDrawn = false;

  function drawTray() {
    const box = document.getElementById('cardSlots');
    if (!box) return;
    box.classList.add('sc-tray');
    const size = fire().handSize || 4;
    const live = [];
    hand.forEach((c, i) => { if (!c.used && live.length < size) live.push({ key: `${i}`, type: c.type }); });

    const keep = new Set();
    const nodes = [];
    live.forEach(({ key, type }) => {
      const d = def(type);
      if (!d) return;
      let entry = trayEls.get(key);
      if (!entry || entry.type !== type) {
        const tmp = document.createElement('div');
        tmp.innerHTML = cardHtml(d);
        const el = tmp.firstElementChild;
        makeSpinnable(el, { onTap: () => choose(type, el) });
        if (!reduceMotion) {
          el.classList.add('is-dealing');
          el.style.setProperty('--deal-delay', '0ms');
          el.addEventListener('animationend', () => el.classList.remove('is-dealing'), { once: true });
          if (!trayDrawn) el.querySelector('.sc-spin').style.animationDelay = `${nodes.length * 110}ms`;
        }
        entry = { el, type };
        trayEls.set(key, entry);
      }
      entry.el.classList.toggle('selected', pendingCard === type);
      keep.add(key);
      nodes.push(entry.el);
    });
    for (const [key, entry] of trayEls) {
      if (!keep.has(key)) {
        entry.el.remove();
        trayEls.delete(key);
      }
    }
    for (let i = nodes.length; i < size; i++) {
      const slot = document.createElement('div');
      slot.className = 'sc-slot';
      slot.setAttribute('aria-label', 'Empty card slot');
      slot.innerHTML = `${icon('plus', 18)}<span>${TW.escapeHtml(nextCardText())}</span>`;
      nodes.push(slot);
    }
    // Re-append in order: existing cards move without being rebuilt.
    box.querySelectorAll('.sc-slot').forEach((s) => s.remove());
    nodes.forEach((n) => box.appendChild(n));
    trayDrawn = true;
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

  let playEl = null; // the card that was tapped, to return focus to
  function choose(type, fromEl) {
    const d = def(type);
    if (!d) return;
    if (d.kind === 'defense') {
      send(type, {});
      return;
    }
    pendingCard = type;
    playEl = fromEl || null;
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
    const el = document.querySelector(`#cardSlots .sc-card[data-card="${type}"]`);
    if (el && !reduceMotion) el.classList.add('is-played');
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

  // The picker opens inside the cards panel, in place of the tray, so the
  // chart stays visible. The chosen card sits beside it and can be spun.
  function openSheet(d) {
    document.getElementById('targetSheet')?.remove(); // switching cards: keep pendingCard
    const panel = document.querySelector('.sabotage-panel');
    const tray = document.getElementById('cardSlots');
    if (!panel || !tray) return;
    const you = lastState.you;
    const box = document.createElement('div');
    box.className = 'sc-play';
    box.id = 'targetSheet';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', `Play ${d.name}`);
    const needsTarget = d.targeted;
    const instrumentsList = lastState.instruments || [];
    box.innerHTML = `
      <div class="sc-stage">${cardHtml(d, 'is-entering is-swaying')}<span class="sc-stage-hint">Drag to turn</span></div>
      <div class="sc-pick">
        <div class="sc-pick-head">
          <div><strong>${TW.escapeHtml(d.name)}</strong><p title="${TW.escapeHtml(d.description)}">${TW.escapeHtml(d.description)}</p></div>
          <button type="button" class="fs-close" aria-label="Cancel">&times;</button>
        </div>
        ${needsTarget ? `
        <div class="sc-pick-tools">
          <div class="fs-quick">
            <button type="button" data-pick="random">${icon('dice', 14)} Random</button>
            <button type="button" data-pick="leader">${icon('crown', 14)} Leader</button>
            <button type="button" data-pick="above">${icon('up', 14)} Above</button>
            <button type="button" data-pick="below">${icon('down', 14)} Below</button>
          </div>
          <label class="fs-search">${icon('search', 14)}<input type="search" placeholder="Search players" aria-label="Search players" /></label>
        </div>
        <div class="fs-list" role="listbox" aria-label="Choose a target"></div>` : `
        <p class="fs-note">Hits every other player who is not shielded.</p>
        ${d.requiresSymbol ? `<label class="fs-symbol">Instrument <select>${instrumentsList.map((s) => `<option value="${s}">${s}</option>`).join('')}</select></label>` : ''}
        <button type="button" class="btn btn-primary fs-play">Play ${TW.escapeHtml(d.name)}</button>`}
      </div>`;
    tray.after(box);
    panel.classList.add('sc-playing');

    const stageCard = box.querySelector('.sc-stage .sc-card');
    stageCard.tabIndex = 0;
    stageCard.addEventListener('animationend', (e) => { if (e.animationName === 'sc-enter') stageCard.classList.remove('is-entering'); });
    makeSpinnable(stageCard, { settleTo: 180 });
    // Swaying stops for good once the player takes hold of the card.
    stageCard.addEventListener('pointerdown', () => stageCard.classList.remove('is-swaying', 'is-entering'));
    stageCard.addEventListener('keydown', () => stageCard.classList.remove('is-swaying', 'is-entering'));

    const close = () => closeSheet(true);
    box.querySelector('.fs-close').addEventListener('click', close);
    document.addEventListener('keydown', escClose);

    if (!needsTarget) {
      box.querySelector('.fs-play').addEventListener('click', async () => {
        const sym = box.querySelector('.fs-symbol select');
        if (await send(d.id, { symbol: sym ? sym.value : undefined })) closeSheet(false);
      });
      box.querySelector('.fs-play').focus({ preventScroll: true });
      return;
    }

    const list = box.querySelector('.fs-list');
    const search = box.querySelector('.fs-search input');
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
      if (await send(d.id, { targetId })) closeSheet(false);
    };
    search.addEventListener('input', draw);
    box.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
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
    // A phone keyboard would cover the list, so only focus search with a mouse.
    if (window.matchMedia('(pointer: fine)').matches) search.focus({ preventScroll: true });
    else box.querySelector('[data-pick]').focus({ preventScroll: true });
  }

  function escClose(e) {
    if (e.key === 'Escape') closeSheet(true);
  }

  function closeSheet(returnFocus) {
    const box = document.getElementById('targetSheet');
    document.removeEventListener('keydown', escClose);
    if (!box) return;
    box.remove();
    document.querySelector('.sabotage-panel')?.classList.remove('sc-playing');
    pendingCard = null;
    drawTray();
    if (returnFocus && playEl && playEl.isConnected) playEl.focus({ preventScroll: true });
    playEl = null;
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
