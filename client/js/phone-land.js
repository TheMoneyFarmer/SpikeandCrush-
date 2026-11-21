'use strict';

// Phone landscape game screen. On a phone (touch screen, short side up to
// 500px) with "Rotate game to landscape" on, the match is laid out as a
// landscape game: a 64px left rail with five tabs (Assets, Chart, Play,
// Trade, Arena), a 36px header, the spike strip in its own row, the chart in
// the middle and a 200px order rail on the right.
//
// Like js/arena-layout.js it MOVES the existing elements (chart, card tray,
// standings, positions, ticket parts) instead of copying them, so every
// socket listener and id in js/game.js keeps working; leaving the layout puts
// them back. Trading goes through TW.Game (js/game.js), i.e. the same
// trade:open / trade:close / trade:modify events; the server validates and
// fills. Nothing here computes a fill or a P&L.
//
// Orientation (Part 1): on the first tap the page asks for fullscreen and a
// landscape lock (Android, installed app). Where that is refused and the phone
// is held upright, the "Turn your phone" card shows (the chart library can't
// be used under a CSS rotation - see docs/mobile-landscape/README.md).
(function () {
  window.TW = window.TW || {};
  const coarse = window.matchMedia('(pointer: coarse)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isPhone = () => coarse.matches && Math.min(window.innerWidth, window.innerHeight) <= 500;
  const prefs = () => (TW.PhonePrefs ? TW.PhonePrefs.get() : { rotate: true, confirmTrades: false, haptics: true });
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (TW.escapeHtml ? TW.escapeHtml(String(s ?? '')) : String(s ?? ''));
  const money = (n) => (TW.formatMoney ? TW.formatMoney(n) : String(n));
  const ICON = {
    assets: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    chart: '<path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/>',
    play: '<path d="M8 5v14l11-7z"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    trade: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
    arena: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5M5 14l4 4M7 17l-3 3M3 19l2 2"/>',
    crown: '<path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  };
  const svg = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

  let on = false;
  let tab = 'chart';
  let ticketOpen = false;
  const homes = [];
  let root = null;
  const session = { closed: 0, won: 0, net: 0, peak: null, maxDd: 0 };
  const firstMid = {};
  const effects = { frozenUntil: 0, lockedUntil: 0 };
  // For tests and the report: what the orientation layers did.
  const orient = { fullscreen: null, lock: null, mode: null, attempts: [] };

  function move(el, target, prepend) {
    if (!el || !target || el.parentNode === target) return;
    if (!homes.some((h) => h.el === el)) homes.push({ el, parent: el.parentNode, next: el.nextSibling });
    if (prepend) target.prepend(el); else target.appendChild(el);
  }
  function restore() {
    while (homes.length) {
      const { el, parent, next } = homes.pop();
      parent.insertBefore(el, next && next.parentNode === parent ? next : null);
    }
  }

  // ---- build -------------------------------------------------------------------
  function build() {
    root = document.createElement('div');
    root.id = 'plRoot';
    root.className = 'pl-root';
    root.innerHTML = `
      <nav class="pl-rail" aria-label="Match">
        <button type="button" class="pl-railbtn" data-tab="assets" data-tour="rail-assets">${svg('assets')}<span>Assets</span></button>
        <button type="button" class="pl-railbtn" data-tab="chart" data-tour="rail-chart">${svg('chart')}<span>Chart</span></button>
        <button type="button" class="pl-play" id="plPlayBtn" data-tour="rail-play" aria-label="Open the order ticket" aria-expanded="false" aria-controls="plTicket">${svg('play', 24)}</button>
        <button type="button" class="pl-railbtn" data-tab="trade" data-tour="rail-trade">${svg('trade')}<span>Trade</span><i class="pl-badge" id="plTradeBadge" hidden></i></button>
        <button type="button" class="pl-railbtn" data-tab="arena" data-tour="rail-arena">${svg('arena')}<span>Arena</span></button>
      </nav>
      <div class="pl-main">
        <header class="pl-head">
          <div class="pl-quote"><b id="plSym">-</b><span class="pl-bid mono" id="plBid">-</span><span class="pl-ask mono" id="plAsk">-</span><span class="pl-spr mono" id="plSpr"></span></div>
          <div class="pl-head-r" id="plHeadR"><span class="pl-acct mono" id="plAcct"></span><span class="pl-headtimer" id="plHeadTimer"></span></div>
        </header>
        <div class="pl-spike" id="plSpike" data-tour="spike-strip"></div>
        <div class="pl-body">
          <section class="pl-tab pl-tab-chart" data-pane="chart" aria-label="Chart">
            <div class="pl-chartcol">
              <div class="pl-tools"><div id="plTf" class="pl-tf"></div><div class="pl-toast" id="plToast" role="status" aria-live="polite"></div></div>
              <div class="pl-chartbox" id="plChartBox" data-tour="chart"></div>
              <div class="pl-band" id="plBand"></div>
            </div>
            <aside class="pl-order" data-tour="order-rail" aria-label="Order">
              <div class="pl-timerslot" id="plTimerSlot"></div>
              <div class="pl-pnl"><span>Open P&amp;L</span><b class="mono" id="plPnl">0.00</b></div>
              <div class="pl-tiles"><div><span>Equity</span><b class="mono" id="plEq">-</b></div><div><span>Rank</span><b class="mono" id="plRank">-</b></div></div>
              <div class="pl-lots" id="plLots" role="group" aria-label="Lot size" data-tour="lot-chips"></div>
              <div class="pl-bs" data-tour="buy-sell">
                <button type="button" class="pl-buy" id="plBuy"><span>BUY</span><b class="mono" id="plBuyPx">-</b></button>
                <button type="button" class="pl-sell" id="plSell"><span>SELL</span><b class="mono" id="plSellPx">-</b></button>
              </div>
              <div class="pl-foot"><span id="plOpenCount">0 open</span><button type="button" class="pl-closeall" id="plCloseAll">Close all</button></div>
              <div class="pl-flag" id="plFlag" hidden></div>
            </aside>
          </section>
          <section class="pl-tab pl-tab-assets" data-pane="assets" aria-label="Assets">
            <div class="pl-assets" role="table" aria-label="Quotes">
              <div class="pl-arow pl-ahead" role="row"><span>Symbol</span><span>Bid</span><span>Ask</span><span>Spread</span><span>Change</span><span></span></div>
              <div id="plAssetRows"></div>
            </div>
            <p class="pl-note" id="plAssetsNote"></p>
          </section>
          <section class="pl-tab pl-tab-trade" data-pane="trade" aria-label="Trade">
            <div class="pl-poscol" data-tour="positions"><div class="pl-colhead"><b>Open positions</b><span class="mono" id="plAcct2"></span></div><div id="plPosSlot" class="pl-posslot"></div><div class="pl-summary mono" id="plSummary"></div></div>
            <div class="pl-lbcol" id="plLbSlot" data-tour="leaderboard"></div>
          </section>
          <section class="pl-tab pl-tab-arena" data-pane="arena" aria-label="Arena">
            <div class="pl-cardscol" id="plCardsSlot" data-tour="target-picker"></div>
            <div class="pl-sidecol">
              <div class="pl-crown" id="plCrown" data-tour="crown"></div>
              <div class="pl-missions" id="plMissions" data-tour="missions"></div>
              <a class="pl-collection" href="/cards" id="plCollection">Card collection</a>
            </div>
          </section>
        </div>
      </div>
      <div class="pl-ticket" id="plTicket" hidden role="dialog" aria-label="Order ticket" data-tour="quick-ticket">
        <div class="pl-ticket-head"><b>New order</b><button type="button" class="pl-x" id="plTicketClose" aria-label="Close the ticket">${svg('close', 18)}</button></div>
        <div class="pl-ticket-body" id="plTicketBody"></div>
      </div>
      <div class="pl-turn" id="plTurn" hidden role="dialog" aria-label="Turn your phone">
        <div>${svg('phone', 48)}<b>Turn your phone sideways</b><p>Matches play in landscape. Turn your phone, or switch this off in Settings.</p><button type="button" id="plTurnDismiss" class="pl-turnbtn">Play upright this time</button></div>
      </div>`;
    document.body.appendChild(root);

    // Elements moved in from game.html (their listeners stay with them).
    move($('spikeStrip'), $('plSpike'));
    move($('timeframeSelector'), $('plTf'));
    move($('chartCanvasWrap'), $('plChartBox'));
    move(document.querySelector('.sabotage-panel'), $('plBand'));
    move($('timerRing'), $('plTimerSlot'));
    move($('matchSponsorChip'), $('plHeadR'), true);
    move($('marketSpeedBadge'), $('plHeadR'), true);
    move(document.querySelector('.positions-block'), $('plPosSlot'));
    move($('leaderboardPanel'), $('plLbSlot'));
    // The quick ticket is the existing ticket: instruments, lots, SL/TP,
    // BUY/SELL and the margin line.
    const tb = $('plTicketBody');
    move($('instrumentTabs'), tb);
    const lotWrap = $('lotSelector') && $('lotSelector').parentElement;
    move(lotWrap, tb);
    const sltpWrap = $('sltpModeToggle') && $('sltpModeToggle').closest('.sltp-header') && $('sltpModeToggle').closest('.sltp-header').parentElement;
    move(sltpWrap, tb);
    move(document.querySelector('#tradingPanel .trade-buttons'), tb);
    move(document.querySelector('#tradingPanel .account-summary'), tb);
    // 0.01 and 10 in the ticket's lot list (phone only).
    const ls = $('lotSelector');
    if (ls && !ls.querySelector('.pl-extra')) {
      const mk = (v) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'lot-chip pl-extra'; b.textContent = v; b.addEventListener('click', () => { TW.Game.setLot(v); markLots(); }); return b; };
      ls.prepend(mk(0.01));
      ls.insertBefore(mk(10), $('customLotChip'));
    }

    root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('plPlayBtn').addEventListener('click', () => setTicket(!ticketOpen));
    $('plTicketClose').addEventListener('click', () => setTicket(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ticketOpen) setTicket(false); });
    // tap outside the ticket (not on the Play button) closes it
    document.addEventListener('pointerdown', (e) => {
      if (!ticketOpen) return;
      if (e.target.closest('#plTicket, #plPlayBtn, .toast, .tw-toast, .modal-overlay')) return;
      setTicket(false);
    }, true);
    $('plBuy').addEventListener('click', () => oneClick('BUY'));
    $('plSell').addEventListener('click', () => oneClick('SELL'));
    $('plCloseAll').addEventListener('click', closeAll);
    // "Play upright this time": back to the existing portrait layout for this visit.
    $('plTurnDismiss').addEventListener('click', () => { orient.dismissedTurn = true; evaluate(); });
    // A card tapped on the Chart tab opens its picker on the Arena tab (the
    // tray is moved only after its own tap handling has opened the picker).
    const panel = document.querySelector('.sabotage-panel');
    if (panel) new MutationObserver(() => { if (on && tab === 'chart' && document.getElementById('targetSheet')) setTab('arena'); }).observe(panel, { childList: true });
    // Standings row -> Arena with that player preselected for the next card.
    $('plLbSlot').addEventListener('click', (e) => {
      const row = e.target.closest('[data-player-id], tr[data-id], .race-row[data-id]');
      const id = row && (row.dataset.playerId || row.dataset.id);
      if (!id || id === (TW.Game.state().you)) return;
      if (TW.Sabotage && TW.Sabotage.setPreselect) TW.Sabotage.setPreselect(id);
      setTab('arena');
      flash('Pick a card to play on that player');
    });
    $('plAssetRows').addEventListener('click', onAssetClick);
    buildLots();
  }

  // ---- tabs and ticket ------------------------------------------------------------
  function setTab(next) {
    tab = next;
    root.dataset.tab = next;
    root.querySelectorAll('.pl-railbtn').forEach((b) => {
      const sel = b.dataset.tab === next;
      b.classList.toggle('sel', sel);
      b.setAttribute('aria-current', sel ? 'page' : 'false');
    });
    // The card tray lives in the chart's bottom band on the Chart tab and in
    // the Arena tab's first column there; the timer sits in the order rail on
    // the Chart tab and in the header elsewhere.
    const panel = document.querySelector('.sabotage-panel');
    if (next === 'arena') move(panel, $('plCardsSlot')); else if (next === 'chart') move(panel, $('plBand'));
    move($('timerRing'), next === 'chart' && !railHidden() ? $('plTimerSlot') : $('plHeadTimer'));
    if (next !== 'arena' && TW.Sabotage && TW.Sabotage.closeSheet && document.getElementById('targetSheet')) TW.Sabotage.closeSheet(true);
    if (next === 'assets') renderAssets();
    if (next === 'arena') renderArena();
    if (next === 'trade') renderSummary();
    window.dispatchEvent(new Event('resize'));
  }

  // The order rail steps aside while the ticket is open when there isn't room
  // for chart + ticket + rail (the ticket has its own BUY/SELL).
  const railHidden = () => ticketOpen && root.getBoundingClientRect().width - 64 - 380 - 200 < 200;
  function setTicket(open) {
    ticketOpen = open;
    if (open && tab !== 'chart') setTab('chart');
    $('plTicket').hidden = !open;
    root.classList.toggle('ticket-open', open);
    root.classList.toggle('rail-off', railHidden());
    $('plPlayBtn').setAttribute('aria-expanded', String(open));
    $('plPlayBtn').innerHTML = svg(open ? 'close' : 'play', 24);
    $('plPlayBtn').setAttribute('aria-label', open ? 'Close the order ticket' : 'Open the order ticket');
    if (open) {
      const p = prefs();
      const sl = $('preSlInput');
      const tp = $('preTpInput');
      if (p.defaultSlTp && sl && tp && !sl.value && !tp.value) {
        const pipsBtn = document.querySelector('#sltpModeToggle [data-mode="pips"]');
        if (pipsBtn && !pipsBtn.classList.contains('active')) pipsBtn.click();
        sl.value = p.slPips;
        tp.value = p.tpPips;
        sl.dispatchEvent(new Event('input'));
      }
    }
    move($('timerRing'), tab === 'chart' && !railHidden() ? $('plTimerSlot') : $('plHeadTimer'));
    window.dispatchEvent(new Event('resize'));
  }

  // ---- order rail -------------------------------------------------------------------
  // Lots for forex and CFDs, whole shares for stocks, whole contracts for futures.
  const activeSym = () => (TW.Game ? TW.Game.state().active : null);
  const wholeUnits = () => Boolean(TW.Units && TW.Units.whole(activeSym()));
  function lotSet() {
    if (wholeUnits()) return TW.Units.chips(activeSym()).slice(0, 4);
    const fc = TW.FireConfig || {};
    return fc.lotChips || [0.1, 0.5, 1, 5];
  }
  function buildLots() {
    const wrap = $('plLots');
    wrap.innerHTML = `${lotSet().map((v) => `<button type="button" class="pl-lot" data-lot="${v}">${v}</button>`).join('')}<button type="button" class="pl-lot pl-lotmore" id="plLotMore" aria-label="More lot sizes" aria-expanded="false">...</button>`;
    wrap.querySelectorAll('[data-lot]').forEach((b) => {
      let timer = null;
      // Long press opens the full list; a tap picks the chip.
      b.addEventListener('pointerdown', () => { timer = setTimeout(() => { timer = null; openLotSheet(); }, 500); });
      const cancel = () => { if (timer) clearTimeout(timer); };
      b.addEventListener('pointerleave', cancel);
      b.addEventListener('click', () => { if (timer === null && b.dataset.longpressed) return; cancel(); timer = null; TW.Game.setLot(b.dataset.lot); markLots(); });
    });
    $('plLotMore').addEventListener('click', openLotSheet);
    markLots();
  }
  function markLots() {
    const cur = TW.Game ? Number(TW.Game.state().lot) : 1;
    $('plLots').querySelectorAll('[data-lot]').forEach((b) => b.classList.toggle('on', Number(b.dataset.lot) === cur));
    const more = $('plLotMore');
    if (more) {
      const inSet = lotSet().some((v) => Number(v) === cur);
      more.textContent = inSet ? '...' : String(cur);
      more.classList.toggle('on', !inSet);
    }
    const note = $('plAssetsNote');
    if (note) note.innerHTML = `${dotHtml('hot')} busy now ${dotHtml('warm')} moving ${dotHtml('quiet')} quiet. BUY and SELL here use your size: <b class="mono">${TW.Units ? TW.Units.size(activeSym(), cur) : cur}</b>.`;
  }
  function openLotSheet() {
    const whole = wholeUnits();
    const all = whole ? TW.Units.chips(activeSym()) : (TW.FireConfig && TW.FireConfig.allLots) || [0.01, 0.1, 0.5, 1, 2, 5, 10];
    let sheet = $('plLotSheet');
    if (sheet) { sheet.remove(); $('plLotMore').setAttribute('aria-expanded', 'false'); return; }
    sheet = document.createElement('div');
    sheet.id = 'plLotSheet';
    sheet.className = 'pl-lotsheet';
    sheet.innerHTML = `${all.map((v) => `<button type="button" class="pl-lot" data-v="${v}">${v}</button>`).join('')}<label class="pl-lotcustom">Custom<input type="number" min="${whole ? 1 : 0.01}" step="${whole ? 1 : 0.01}" inputmode="${whole ? 'numeric' : 'decimal'}" aria-label="Custom size" /></label>`;
    $('plLots').after(sheet);
    $('plLotMore').setAttribute('aria-expanded', 'true');
    sheet.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { TW.Game.setLot(b.dataset.v); markLots(); sheet.remove(); $('plLotMore').setAttribute('aria-expanded', 'false'); }));
    const inp = sheet.querySelector('input');
    inp.addEventListener('change', () => { if (Number(inp.value) > 0) { TW.Game.setLot(inp.value); markLots(); sheet.remove(); } });
  }

  async function oneClick(direction, symbol) {
    if (Date.now() < effects.frozenUntil) { flash('Position Freeze: you can\'t open trades right now', 'bad'); return; }
    if (symbol && symbol !== TW.Game.state().active) TW.Game.setInstrument(symbol);
    const st = TW.Game.state();
    if (prefs().confirmTrades) {
      const px = st.prices[st.active];
      const ok = await confirmStep(`${direction} ${TW.Units ? TW.Units.size(st.active, st.lot) : st.lot} ${st.active}`, `At about ${px ? (direction === 'BUY' ? px.ask : px.bid) : 'market'}. The server fills at the live price.`);
      if (!ok) return;
    }
    const before = st.positions.length;
    await TW.Game.placeTrade(direction);
    const after = TW.Game.state().positions.length;
    if (after > before || TW.Game.state().positions.some((p) => !st.positions.find((q) => q.id === p.id))) {
      if (prefs().haptics && navigator.vibrate) navigator.vibrate(15);
      flash(`${direction} ${st.lot} ${st.active} filled`, direction === 'BUY' ? 'good' : 'bad');
    }
  }

  // A small confirm card inside the order rail (never over the chart).
  function confirmStep(title, body) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = 'pl-confirm';
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-label', title);
      box.innerHTML = `<b>${esc(title)}</b><p>${esc(body)}</p><div><button type="button" class="pl-cno">Cancel</button><button type="button" class="pl-cyes">Place order</button></div>`;
      document.querySelector(ticketOpen ? '#plTicket' : '.pl-order').appendChild(box);
      const done = (v) => { box.remove(); resolve(v); };
      box.querySelector('.pl-cyes').addEventListener('click', () => done(true));
      box.querySelector('.pl-cno').addEventListener('click', () => done(false));
      box.querySelector('.pl-cyes').focus();
    });
  }

  async function closeAll() {
    if (Date.now() < effects.lockedUntil) { flash('Lockout: you can\'t close positions right now', 'bad'); return; }
    const ids = TW.Game.state().positions.map((p) => p.id);
    for (const id of ids) {
      const r = await TW.Game.closePosition(id);
      if (r && !r.success && TW.toast) TW.toast(r.error, 'danger');
    }
  }

  let toastTimer = null;
  function flash(text, tone = '', ms = 1200) {
    const t = $('plToast');
    if (!t) return;
    t.textContent = String(text || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?\s*/gu, '');
    t.className = `pl-toast show ${tone}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'pl-toast'; }, ms);
  }

  // While the phone layout is on, the site's toasts and match notifications
  // show in the tools row above the chart, never over it. The plain
  // "Trade executed" toast is skipped: the fill line says it already.
  function routeMessages() {
    if (TW._plRouted) return;
    TW._plRouted = true;
    const origToast = TW.toast;
    const origNotify = TW.showMatchNotification;
    const tone = (type) => (type === 'danger' || type === 'error' ? 'bad' : type === 'success' ? 'good' : '');
    TW.toast = function (msg, type) {
      if (!on) return origToast && origToast.apply(this, arguments);
      if (/^Trade executed$/.test(String(msg))) return undefined;
      return flash(msg, tone(type), type === 'danger' || type === 'error' ? 3000 : 2000);
    };
    TW.showMatchNotification = function (msg) {
      if (!on) return origNotify && origNotify.apply(this, arguments);
      return flash(msg, '', 2500);
    };
  }

  // ---- live numbers -------------------------------------------------------------------
  function renderRail() {
    const st = TW.Game.state();
    const px = st.prices[st.active];
    $('plSym').textContent = st.active || '-';
    $('plBid').textContent = px ? px.bid : '-';
    $('plAsk').textContent = px ? px.ask : '-';
    $('plSpr').textContent = px ? `spr ${px.spread}` : '';
    $('plBuyPx').textContent = px ? px.ask : '-';
    $('plSellPx').textContent = px ? px.bid : '-';
    // P&L / equity / rank: the same figures the top bar already shows.
    const pnlEl = $('topbarPnl');
    if (pnlEl) {
      $('plPnl').textContent = pnlEl.textContent;
      $('plPnl').className = `mono ${/^-|-\$/.test(pnlEl.textContent) ? 'neg' : 'pos'}`;
    }
    const eq = $('summaryEquity');
    if (eq) $('plEq').textContent = eq.textContent;
    const rk = $('topbarRank');
    if (rk) $('plRank').textContent = rk.textContent.replace(/\s+/g, ' ');
    const n = st.positions.length;
    $('plOpenCount').textContent = `${n}${st.maxPositions ? ` / ${st.maxPositions}` : ''} open`;
    $('plCloseAll').disabled = n === 0 || Date.now() < effects.lockedUntil;
    $('plTradeBadge').hidden = n === 0;
    $('plTradeBadge').textContent = n || '';
    const acct = st.accountNumber ? `Account ${st.accountNumber}` : '';
    $('plAcct2').textContent = acct;
    $('plAcct').textContent = tab === 'trade' ? acct : '';
    const frozen = Date.now() < effects.frozenUntil;
    const locked = Date.now() < effects.lockedUntil;
    $('plBuy').disabled = frozen;
    $('plSell').disabled = frozen;
    $('plFlag').hidden = !frozen && !locked;
    $('plFlag').textContent = frozen ? 'FROZEN: no new trades' : locked ? 'LOCKED: no closing' : '';
    root.classList.toggle('pl-locked', locked);
    if (tab === 'assets') renderAssetPrices();
  }

  const dotHtml = (lvl) => `<i class="pl-dot ${lvl}" aria-hidden="true"></i>`;
  function renderAssets() {
    const st = TW.Game.state();
    const act = (TW.FireConfig && TW.FireConfig.activity) || {};
    $('plAssetRows').innerHTML = st.instruments.map((s) => `<div class="pl-arow${s === st.active ? ' cur' : ''}" role="row" data-sym="${esc(s)}" tabindex="0">
      <span class="pl-asym">${dotHtml(act[s] || 'quiet')}<b>${esc(s)}</b><em class="sr-only">${act[s] || 'quiet'}</em></span>
      <span class="mono neg" data-k="bid">-</span><span class="mono pos" data-k="ask">-</span><span class="mono" data-k="spr">-</span><span class="mono" data-k="chg">-</span>
      <span class="pl-abtns"><button type="button" class="pl-abuy" data-act="BUY" aria-label="Buy ${esc(s)}">BUY</button><button type="button" class="pl-asell" data-act="SELL" aria-label="Sell ${esc(s)}">SELL</button></span></div>`).join('');
    renderAssetPrices();
    markLots();
  }
  function renderAssetPrices() {
    const st = TW.Game.state();
    $('plAssetRows').querySelectorAll('.pl-arow').forEach((row) => {
      const p = st.prices[row.dataset.sym];
      if (!p) return;
      row.querySelector('[data-k="bid"]').textContent = p.bid;
      row.querySelector('[data-k="ask"]').textContent = p.ask;
      row.querySelector('[data-k="spr"]').textContent = p.spread;
      const base = firstMid[row.dataset.sym];
      const c = base ? ((p.mid - base) / base) * 100 : 0;
      const el = row.querySelector('[data-k="chg"]');
      el.textContent = `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`;
      el.className = `mono ${c >= 0 ? 'pos' : 'neg'}`;
      row.classList.toggle('cur', row.dataset.sym === st.active);
    });
  }
  function onAssetClick(e) {
    const row = e.target.closest('.pl-arow[data-sym]');
    if (!row) return;
    const btn = e.target.closest('[data-act]');
    if (btn) { oneClick(btn.dataset.act, row.dataset.sym); return; }
    TW.Game.setInstrument(row.dataset.sym);
    setTab('chart');
  }

  function renderSummary() {
    const dd = session.maxDd ? money(-session.maxDd) : money(0);
    $('plSummary').innerHTML = `Closed <b>${session.closed}</b> · Won <b>${session.won}</b> · Net <b class="${session.net >= 0 ? 'pos' : 'neg'}">${money(session.net)}</b> · Max drawdown <b>${dd}</b>`;
  }

  function renderArena() {
    const rows = TW.Fire && TW.Fire.getRows ? TW.Fire.getRows() : [];
    const you = TW.Game.state().you;
    const lead = rows.find((r) => r.crown) || rows[0];
    const me = rows.find((r) => r.id === you);
    $('plCrown').innerHTML = lead ? `<div class="pl-crownhead">${svg('crown', 16)}<b>Crown</b></div>
      <div class="pl-crownname">${esc(lead.username)}${lead.id === you ? ' (you)' : ''}</div>
      <div class="pl-crownsub">${me && lead.id !== you ? `You are ${money((lead.equity ?? (TW.matchCapital ? TW.matchCapital() : 10000) + lead.pnl) - (me.equity ?? (TW.matchCapital ? TW.matchCapital() : 10000) + me.pnl))} behind. Overtake to earn a card.` : lead.id === you ? 'Hold it to the bell.' : ''}</div>` : '';
    const ms = TW.Fire && TW.Fire.getMissions ? TW.Fire.getMissions() : [];
    $('plMissions').innerHTML = `<b class="pl-mhead">Missions</b>${ms.length ? ms.map((m) => {
      const pct = m.target ? Math.min(100, Math.round(((m.progress || 0) / m.target) * 100)) : m.done ? 100 : 0;
      return `<div class="pl-mission${m.done ? ' done' : ''}"><span>${esc(m.label || m.id)}</span><span class="mono">${m.progress || 0}/${m.target || 1}</span><i style="--p:${pct}%"></i></div>`;
    }).join('') : '<p class="pl-note">No missions in this mode.</p>'}`;
  }

  // ---- events ------------------------------------------------------------------------------
  function onGame(e) {
    if (!on) return;
    const d = e.detail || {};
    if (d.type === 'units') {
      // Market changed between lots, shares and contracts: the 0.01 and 10 lot
      // extras only make sense for lots.
      document.querySelectorAll('#lotSelector .pl-extra').forEach((b) => { b.hidden = wholeUnits(); });
      if ($('plLots')) buildLots();
      return;
    }
    if (d.type === 'prices') {
      const st = TW.Game.state();
      for (const [s, p] of Object.entries(st.prices)) if (!(s in firstMid)) firstMid[s] = p.mid;
      renderRail();
      if (d.timeRemaining != null) $('plHeadTimer').dataset.t = d.timeRemaining;
    } else if (d.type === 'positions') {
      if (d.closed && Number.isFinite(Number(d.closed.pnl))) {
        session.closed += 1;
        if (d.closed.pnl > 0) session.won += 1;
        session.net = Math.round((session.net + Number(d.closed.pnl)) * 100) / 100;
        if (tab === 'trade') renderSummary();
      }
      renderRail();
    } else if (d.type === 'leaderboard') {
      const me = (d.rows || []).find((r) => r.id === TW.Game.state().you);
      if (me) {
        const eq = me.equity ?? (TW.matchCapital ? TW.matchCapital() : 10000) + me.pnl;
        session.peak = session.peak === null ? eq : Math.max(session.peak, eq);
        session.maxDd = Math.max(session.maxDd, session.peak - eq);
      }
      if (tab === 'arena') renderArena();
    } else if (d.type === 'missions') {
      if (tab === 'arena') renderArena();
    } else if (d.type === 'state') {
      if (!$('plLots').dataset.mode && TW.FireConfig) { $('plLots').dataset.mode = '1'; buildLots(); }
      renderRail();
    }
  }

  function wireEffects() {
    const s = TW.socket;
    if (!s || s._plWired) return;
    s._plWired = true;
    s.on('sabotage:incoming', (p) => {
      const ms = (Number(p && p.duration) || 0) * 1000;
      if (!ms) return;
      if (p.cardType === 'position_freeze') effects.frozenUntil = Date.now() + ms;
      if (p.cardType === 'lockout') effects.lockedUntil = Date.now() + ms;
      renderRail();
      setTimeout(renderRail, ms + 50);
    });
  }

  // ---- orientation (Part 1) -----------------------------------------------------------------
  // Upright phone without a lock: either the CSS rotation (rotate the whole
  // page 90 degrees) or the "Turn your phone" card. ROTATE_MODE picks; the
  // chart's own touch handling decides which can ship (see the README).
  const ROTATE_MODE = new URLSearchParams(location.search).get('plrot') || 'turn';
  function applyOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    const rotate = on && portrait && ROTATE_MODE === 'css' && orient.lock !== 'ok';
    const showTurn = on && portrait && !rotate && !orient.dismissedTurn;
    document.documentElement.classList.toggle('pl-portrait', on && portrait);
    document.documentElement.classList.toggle('pl-rot', rotate);
    if (root) $('plTurn').hidden = !showTurn;
    orient.mode = !on ? 'off' : !portrait ? (orient.lock === 'ok' ? 'locked-landscape' : 'landscape') : rotate ? 'css-rotation' : showTurn ? 'turn-card' : 'upright';
  }

  // Fullscreen + landscape lock need a user gesture: the first tap on the
  // game screen asks for both. Any refusal falls through silently.
  async function tryLock() {
    orient.attempts.push(Date.now());
    const el = document.documentElement;
    try {
      if (el.requestFullscreen && !document.fullscreenElement) { await el.requestFullscreen({ navigationUI: 'hide' }); orient.fullscreen = 'ok'; }
      else orient.fullscreen = el.requestFullscreen ? 'already' : 'unsupported';
    } catch (e) { orient.fullscreen = `refused: ${e.name || e.message}`; }
    try {
      if (screen.orientation && screen.orientation.lock) { await screen.orientation.lock('landscape'); orient.lock = 'ok'; }
      else orient.lock = 'unsupported';
    } catch (e) { orient.lock = `refused: ${e.name || e.message}`; }
    applyOrientation();
  }
  function unlock() {
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* not locked */ }
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) { /* not fullscreen */ }
  }

  // ---- on / off -------------------------------------------------------------------------------
  function enable() {
    if (on) return;
    on = true;
    document.documentElement.classList.add('pl-on');
    document.body.classList.add('pl');
    if (!root) build(); else root.hidden = false;
    setTab(tab);
    wireEffects();
    routeMessages();
    renderRail();
    applyOrientation();
    window.dispatchEvent(new Event('resize'));
  }
  function disable() {
    if (!on) return;
    on = false;
    setTicket(false);
    restore();
    document.documentElement.classList.remove('pl-on', 'pl-portrait');
    document.body.classList.remove('pl');
    if (root) root.hidden = true;
    unlock();
    window.dispatchEvent(new Event('resize'));
  }
  function evaluate() {
    const portrait = window.innerHeight > window.innerWidth;
    if (isPhone() && prefs().rotate && !(portrait && orient.dismissedTurn)) enable(); else disable();
    applyOrientation();
  }

  function init() {
    if (!TW.Game) return;
    window.addEventListener('tw:game', onGame);
    window.addEventListener('resize', () => { evaluate(); if (on) root.classList.toggle('rail-off', railHidden()); });
    if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', applyOrientation);
    document.addEventListener('pointerdown', function first() {
      if (!on) return;
      document.removeEventListener('pointerdown', first, true);
      tryLock();
    }, true);
    // Leaving the match (Home, Forfeit, result screen close, any navigation).
    window.addEventListener('pagehide', unlock);
    evaluate();
  }

  TW.PhoneLand = { isPhone, isOn: () => on, setTab, setTicket, orientation: () => ({ ...orient }), _evaluate: evaluate, reducedMotion: () => reduced.matches };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
