'use strict';

// The live match card: while a player has a match running and is anywhere
// else on the site, it shows their P&L and open trades with Continue and
// Forfeit. Open by default on Home, a small bar elsewhere. The server's
// numbers are the only source: this file just asks for them every 2 seconds.
(function () {
  const TW = window.TW;
  if (!TW || !TW.isLoggedIn || !TW.isLoggedIn() || window.__twLiveMatch) return;
  window.__twLiveMatch = true;

  const POLL_LIVE_MS = 2000;
  const POLL_IDLE_MS = 30000; // catches a match started on another device or tab
  const OPEN_KEY = 'sc_live_match_open';

  const STYLE = `
    .lm-card { position: fixed; left: 20px; bottom: 20px; z-index: 9000; width: 340px; max-width: calc(100vw - 32px); border-radius: 14px; background: var(--surface, #12192b); border: 1px solid var(--border, #2a3550); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45); color: var(--text-primary, #fff); font-family: inherit; font-size: 14px; }
    .lm-bar { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 52px; padding: 8px 12px; background: none; border: 0; border-radius: 14px; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .lm-bar:focus-visible, .lm-card button:focus-visible, .lm-card a:focus-visible { outline: 2px solid var(--accent, #4d8dff); outline-offset: 2px; }
    .lm-dot { flex: 0 0 8px; width: 8px; height: 8px; border-radius: 50%; background: var(--sell, #ff3d5c); animation: lm-pulse 1.6s ease-in-out infinite; }
    @keyframes lm-pulse { 50% { opacity: 0.35; } }
    @media (prefers-reduced-motion: reduce) { .lm-dot { animation: none; } }
    .lm-title { flex: 1 1 auto; min-width: 0; }
    .lm-mode { display: block; overflow: hidden; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
    .lm-meta { display: block; overflow: hidden; font-size: 12px; color: var(--text-secondary, #aab4c8); font-variant-numeric: tabular-nums; white-space: nowrap; text-overflow: ellipsis; }
    .lm-pnl { flex: 0 0 auto; font-weight: 700; font-variant-numeric: tabular-nums; }
    .lm-up { color: var(--buy, #00c896); }
    .lm-down { color: var(--sell, #ff3d5c); }
    .lm-chev { flex: 0 0 18px; display: flex; color: var(--text-secondary, #aab4c8); transition: transform 0.15s ease; }
    .lm-card.lm-open .lm-chev { transform: rotate(180deg); }
    .lm-body { display: none; padding: 0 12px 12px; }
    .lm-card.lm-open .lm-body { display: block; }
    .lm-label { margin: 2px 0 6px; font-size: 12px; color: var(--text-secondary, #aab4c8); }
    .lm-trades { max-height: 168px; margin: 0 0 12px; padding: 0; overflow-y: auto; list-style: none; border-top: 1px solid var(--border, #2a3550); }
    .lm-trades li { display: flex; align-items: center; gap: 8px; min-height: 40px; border-bottom: 1px solid var(--border, #2a3550); font-size: 13px; font-variant-numeric: tabular-nums; }
    .lm-sym { flex: 1 1 auto; min-width: 0; overflow: hidden; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
    .lm-side { flex: 0 0 auto; font-size: 12px; color: var(--text-secondary, #aab4c8); }
    .lm-trade-pnl { flex: 0 0 76px; font-weight: 600; text-align: right; }
    .lm-none { margin: 0 0 12px; font-size: 13px; color: var(--text-secondary, #aab4c8); }
    .lm-actions { display: flex; gap: 8px; }
    .lm-btn { flex: 1 1 0; display: flex; align-items: center; justify-content: center; min-height: 44px; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--border, #2a3550); background: transparent; color: inherit; font: inherit; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
    .lm-btn:disabled { opacity: 0.6; cursor: default; }
    .lm-primary { flex-grow: 2; background: var(--accent, #4d8dff); border-color: var(--accent, #4d8dff); color: #fff; }
    .lm-danger { color: var(--sell, #ff3d5c); }
    .lm-danger-solid { background: var(--sell, #ff3d5c); border-color: var(--sell, #ff3d5c); color: #fff; }
    .lm-confirm { margin: 0 0 12px; font-size: 13px; line-height: 1.45; }
    @media (max-width: 768px) {
      .lm-card { left: 12px; bottom: calc(92px + env(safe-area-inset-bottom)); width: calc(100vw - 88px); max-width: none; }
      .lm-card.lm-open { width: calc(100vw - 24px); }
      body.lm-card-open #twSupportWidgetRoot { visibility: hidden; }
    }
  `;
  const CHEVRON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';

  const money = (n) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const tone = (n) => (n > 0 ? 'lm-up' : n < 0 ? 'lm-down' : '');
  const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  let card = null;
  let els = null;
  let live = null;
  let confirming = false;
  let pollTimer = null;
  let clockTimer = null;

  function storedOpen() {
    try {
      const v = sessionStorage.getItem(OPEN_KEY);
      if (v !== null) return v === '1';
    } catch (e) { /* storage blocked: use the page default */ }
    return document.body.dataset.page === 'index';
  }

  function setOpen(open) {
    card.classList.toggle('lm-open', open);
    document.body.classList.toggle('lm-card-open', open);
    els.bar.setAttribute('aria-expanded', String(open));
  }

  function build() {
    if (!document.getElementById('lmStyle')) {
      const style = document.createElement('style');
      style.id = 'lmStyle';
      style.textContent = STYLE;
      document.head.appendChild(style);
    }
    card = document.createElement('section');
    card.className = 'lm-card';
    card.id = 'lmCard';
    card.setAttribute('aria-label', 'Your live match');
    card.innerHTML = `
      <button type="button" class="lm-bar" aria-controls="lmBody">
        <span class="lm-dot" aria-hidden="true"></span>
        <span class="lm-title"><span class="lm-mode"></span><span class="lm-meta"></span></span>
        <span class="lm-pnl"></span>
        <span class="lm-chev">${CHEVRON}</span>
      </button>
      <div class="lm-body" id="lmBody">
        <div class="lm-trades-wrap"></div>
        <div class="lm-foot"></div>
      </div>`;
    document.body.appendChild(card);
    els = {
      bar: card.querySelector('.lm-bar'),
      mode: card.querySelector('.lm-mode'),
      meta: card.querySelector('.lm-meta'),
      pnl: card.querySelector('.lm-pnl'),
      trades: card.querySelector('.lm-trades-wrap'),
      foot: card.querySelector('.lm-foot'),
    };
    els.bar.addEventListener('click', () => {
      const open = !card.classList.contains('lm-open');
      setOpen(open);
      try { sessionStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (e) { /* not remembered */ }
    });
    setOpen(storedOpen());
    renderFoot();
  }

  function destroy() {
    card?.remove();
    card = null;
    els = null;
    confirming = false;
    document.body.classList.remove('lm-card-open');
  }

  // Rebuilt only when it changes, so polling never steals focus from a button.
  function renderFoot() {
    if (confirming) {
      els.foot.innerHTML = `
        <p class="lm-confirm">Forfeit this match? Your open trades close now, you finish last, and you can't rejoin.</p>
        <div class="lm-actions">
          <button type="button" class="lm-btn" data-lm="keep">Keep playing</button>
          <button type="button" class="lm-btn lm-danger-solid" data-lm="yes">Forfeit</button>
        </div>`;
      els.foot.querySelector('[data-lm="keep"]').addEventListener('click', () => { confirming = false; renderFoot(); });
      els.foot.querySelector('[data-lm="yes"]').addEventListener('click', forfeit);
      return;
    }
    els.foot.innerHTML = `
      <div class="lm-actions">
        <a class="lm-btn lm-primary" data-lm="continue" href="/game.html?matchId=${encodeURIComponent(live ? live.matchId : '')}">Continue match</a>
        <button type="button" class="lm-btn lm-danger" data-lm="forfeit">Forfeit</button>
      </div>`;
    els.foot.querySelector('[data-lm="forfeit"]').addEventListener('click', () => { confirming = true; renderFoot(); });
  }

  async function forfeit(e) {
    e.currentTarget.disabled = true;
    const matchId = live && live.matchId;
    const result = await TW.emitAck('match:forfeit', { matchId });
    if (result.success) {
      live = null;
      destroy();
      TW.toast?.('Match forfeited. You finished last.', 'info');
      schedule(POLL_IDLE_MS);
      return;
    }
    TW.toast?.(result.error || 'Could not forfeit the match', 'danger');
    confirming = false;
    if (card) renderFoot();
    poll();
  }

  function metaText() {
    const parts = [];
    if (live.status === 'countdown') parts.push('Starting');
    else if (live.remainingSeconds !== null) parts.push(`${clock(live.remainingSeconds)} left`);
    if (live.eliminated) parts.push('Eliminated');
    else if (live.rank) parts.push(`#${live.rank} of ${live.playerCount}`);
    return parts.join(' · ');
  }

  function render() {
    const firstRender = !card;
    if (firstRender) build();
    els.mode.textContent = live.modeLabel;
    els.meta.textContent = metaText();
    els.pnl.textContent = money(live.pnl);
    els.pnl.className = `lm-pnl ${tone(live.pnl)}`;
    const trades = live.positions;
    els.trades.innerHTML = trades.length
      ? `<p class="lm-label">Open trades (${trades.length})</p><ul class="lm-trades">${trades.map((p) => `
          <li>
            <span class="lm-sym">${TW.escapeHtml(p.symbol)}</span>
            <span class="lm-side">${p.direction === 'BUY' ? 'Buy' : 'Sell'} ${Number(p.lots)}</span>
            <span class="lm-trade-pnl ${tone(p.pnl)}">${money(p.pnl)}</span>
          </li>`).join('')}</ul>`
      : '<p class="lm-none">No open trades. The match clock keeps running.</p>';
    if (firstRender) renderFoot();
  }

  function schedule(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    if (document.hidden) return; // visibilitychange restarts this
    const result = await TW.emitAck('match:live', {});
    // A dropped connection is not "no match": keep showing what we have.
    if (!result.success) {
      schedule(POLL_LIVE_MS);
      return;
    }
    const pageMatch = new URLSearchParams(location.search).get('matchId');
    live = result.live && result.live.matchId !== pageMatch ? result.live : null;
    if (live) render();
    else destroy();
    schedule(live ? POLL_LIVE_MS : POLL_IDLE_MS);
  }

  function start(socket) {
    if (!socket) return;
    socket.on('connect', poll);
    if (socket.connected) poll();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      if (!live || !card || live.remainingSeconds === null || live.remainingSeconds <= 0) return;
      live.remainingSeconds -= 1;
      els.meta.textContent = metaText();
    }, 1000);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // A few pages (Help, Terms and so on) don't otherwise open a socket. They
  // need one here too: the socket is what tells the server the player is still
  // on the site, so reading Help doesn't forfeit the match.
  async function init() {
    try {
      if (!window.io) await loadScript('/socket.io/socket.io.js');
      if (!TW.connectSocket) await loadScript('/js/socket.js');
      start(TW.connectSocket());
    } catch (e) {
      console.warn('[live-match] could not connect', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
