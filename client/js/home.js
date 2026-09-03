'use strict';

window.TW = window.TW || {};

// Home-page-only visual enhancements (particle candles, typing tagline, stats
// bar, featured match). Deliberately kept separate from main.js so the
// verified login/register/menu logic in main.js is never touched.
(function () {
  function spawnCandles(wrapId = 'twHeroParticles') {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    for (let i = 0; i < 22; i++) {
      const el = document.createElement('div');
      const isBull = Math.random() < 0.5;
      const color = isBull ? '#00c896' : '#ff4444';
      el.className = `tw-hero-candle ${isBull ? 'tw-candle-up' : 'tw-candle-down'}`;
      const height = 20 + Math.random() * 60;
      el.style.left = `${Math.random() * 100}%`;
      el.style.height = `${height}px`;
      el.style.background = color;
      el.style.setProperty('--candle-color', color);
      el.style.animationDuration = `${14 + Math.random() * 12}s`;
      el.style.animationDelay = `${Math.random() * -20}s`;
      wrap.appendChild(el);
    }
  }

  function typeTagline() {
    const el = document.getElementById('twHeroTagline');
    if (!el) return;
    const text = 'Up. Then not.';
    let i = 0;
    el.textContent = '';
    const caret = document.createElement('span');
    caret.className = 'tw-caret';
    el.appendChild(document.createTextNode(''));
    el.appendChild(caret);

    const timer = setInterval(() => {
      i++;
      el.firstChild.textContent = text.slice(0, i);
      if (i >= text.length) clearInterval(timer);
    }, 45);
  }

  // Splits the login hero's headline into per-word spans with a staggered
  // blur/slide-in (see .tw-login-headline .word in premium.css) instead of
  // the plain static text it had before.
  function revealLoginHeadline() {
    const el = document.getElementById('twLoginHeadline');
    if (!el || el.dataset.revealed) return;
    el.dataset.revealed = 'true';
    const html = el.innerHTML;
    const parts = html.split(/(\s+|<br\s*\/?>)/i);
    el.innerHTML = '';
    let wordIndex = 0;
    parts.forEach((part) => {
      if (!part.trim()) {
        el.appendChild(document.createTextNode(' '));
      } else if (part.toLowerCase().startsWith('<br')) {
        el.appendChild(document.createElement('br'));
      } else {
        const span = document.createElement('span');
        span.className = 'word';
        span.textContent = part;
        span.style.animationDelay = `${wordIndex * 0.09}s`;
        wordIndex++;
        el.appendChild(span);
      }
    });
  }

  // Decorative, theme-aware candlestick chart drawn behind a hero section -
  // reads --buy/--sell so it matches whichever of the 4 themes is active,
  // same pattern js/chart.js uses for the real trading chart. Purely
  // ambient: no real market data, just a slow drifting scroll. Shared by
  // both the logged-out login hero (#loginChartCanvas) and the logged-in
  // Trading Floor hub hero (#hubChartCanvas) so they get the same
  // background treatment - only one of those two sections is ever visible
  // at a time, so only one of the two calls below actually starts drawing.
  function drawChartCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    // Skip entirely if the section this canvas lives in is currently
    // hidden (main.js has already applied .hidden to whichever hero isn't
    // active by this point) - an animation loop here would just spin on a
    // 0x0 canvas.
    if (!canvas || canvas.closest('.hidden')) return;
    const ctx = canvas.getContext('2d');
    let candles = [];
    let offset = 0;
    let frame = 0;

    function seed(count, startPrice, volatility) {
      const out = [];
      let price = startPrice;
      for (let i = 0; i < count; i++) {
        const open = price;
        const close = open + (Math.random() - 0.48) * volatility;
        const high = Math.max(open, close) + Math.random() * volatility * 0.5;
        const low = Math.min(open, close) - Math.random() * volatility * 0.5;
        out.push({ open, high, low, close });
        price = close;
      }
      return out;
    }
    candles = seed(120, 100, 3);

    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
    resize();
    window.addEventListener('resize', resize);

    function draw() {
      const w = canvas.width;
      const h = canvas.height;
      if (!w || !h) {
        requestAnimationFrame(draw);
        return;
      }
      ctx.clearRect(0, 0, w, h);
      const style = getComputedStyle(document.documentElement);
      const upColor = style.getPropertyValue('--buy').trim() || '#00c896';
      const downColor = style.getPropertyValue('--sell').trim() || '#ff4444';
      const candleWidth = Math.max(6, w / 60);
      const padding = h * 0.12;
      const chartH = h - padding * 2;

      const startIdx = Math.floor(offset / candleWidth) % candles.length;
      const visibleCount = Math.ceil(w / candleWidth) + 2;
      const visible = [];
      for (let i = 0; i < visibleCount; i++) visible.push(candles[(startIdx + i) % candles.length]);

      const prices = visible.flatMap((c) => [c.high, c.low]);
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      const range = maxP - minP || 1;
      const priceToY = (p) => padding + (1 - (p - minP) / range) * chartH;

      visible.forEach((candle, i) => {
        const x = i * candleWidth - (offset % candleWidth);
        const isUp = candle.close >= candle.open;
        ctx.strokeStyle = isUp ? upColor : downColor;
        ctx.fillStyle = isUp ? upColor : downColor;
        ctx.globalAlpha = 0.6;
        const openY = priceToY(candle.open);
        const closeY = priceToY(candle.close);
        const highY = priceToY(candle.high);
        const lowY = priceToY(candle.low);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + candleWidth / 2, highY);
        ctx.lineTo(x + candleWidth / 2, lowY);
        ctx.stroke();
        const cw = candleWidth * 0.6;
        const cx = x + (candleWidth - cw) / 2;
        ctx.fillRect(cx, Math.min(openY, closeY), cw, Math.max(Math.abs(closeY - openY), 1));
        ctx.globalAlpha = 1;
      });

      offset += 0.3;
      frame++;
      if (frame % 90 === 0) {
        const last = candles[candles.length - 1];
        const move = (Math.random() - 0.48) * 3;
        const open = last.close;
        const close = open + move;
        candles.push({ open, close, high: Math.max(open, close) + Math.random(), low: Math.min(open, close) - Math.random() });
        if (candles.length > 200) candles.shift();
      }
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  }

  // Populates every stats-bar element that exists on the page (the logged-in
  // hub hero's #twStatsBar and/or the logged-out login hero's
  // #twLoginStatsBar - only one is ever visible at a time, but both get the
  // same real numbers if present) from a single shared fetch.
  async function loadStatsBar() {
    const targets = ['twStatsBar', 'twLoginStatsBar'].map((id) => document.getElementById(id)).filter(Boolean);
    if (!targets.length) return;
    try {
      const res = await fetch('/api/stats/home');
      if (!res.ok) throw new Error('stats unavailable');
      const data = await res.json();
      const html = `
        <div class="tw-stat-card"><div class="value">${data.matchesToday}</div><div class="label">Matches Today</div></div>
        <div class="tw-stat-card"><div class="value">${data.activePlayers}</div><div class="label">Active Players</div></div>
        <div class="tw-stat-card"><div class="value">${TW.formatMoney(data.largestWinToday)}</div><div class="label">Largest Win Today</div></div>
        <div class="tw-stat-card"><div class="value">🪙 ${data.coinsWonToday}</div><div class="label">Coins Won Today</div></div>
      `;
      targets.forEach((el) => { el.innerHTML = html; });
    } catch (e) {
      targets.forEach((el) => { el.innerHTML = ''; });
    }
  }

  async function loadFeaturedMatch() {
    const el = document.getElementById('twFeaturedMatch');
    if (!el) return;
    try {
      const res = await fetch('/api/stats/featured-match');
      if (!res.ok) throw new Error('none');
      const data = await res.json();
      if (!data.matchId) {
        el.classList.add('hidden');
        return;
      }
      el.classList.remove('hidden');
      el.innerHTML = `
        <div>
          <div style="font-weight:700;">🔴 Live War in progress</div>
          <div class="text-secondary" style="font-size:12px;">${data.playerCount} traders · ${data.timeRemainingLabel} left</div>
        </div>
        <a class="btn btn-outline" href="/spectate.html?matchId=${data.matchId}">Watch Live</a>
      `;
    } catch (e) {
      el.classList.add('hidden');
    }
  }

  async function loadTicker() {
    const track = document.getElementById('twTickerTrack');
    if (!track) return;
    try {
      const res = await fetch('/api/stats/ticker');
      const data = await res.json();
      const itemsHtml = data.rows
        .map((r) => {
          const dir = r.changePct > 0 ? 'up' : r.changePct < 0 ? 'down' : '';
          const arrow = r.changePct > 0 ? '▲' : r.changePct < 0 ? '▼' : '·';
          return `<span class="tw-ticker-item"><span class="sym">${r.symbol}</span><span>${r.price}</span><span class="chg ${dir}">${arrow} ${Math.abs(r.changePct)}%</span></span>`;
        })
        .join('');
      // Duplicated once so the CSS -50% translateX loop is seamless.
      track.innerHTML = itemsHtml + itemsHtml;
    } catch (e) {
      track.innerHTML = '';
    }
  }

  async function loadActivityFeed() {
    const el = document.getElementById('activityFeed');
    if (!el) return;
    try {
      const res = await fetch('/api/stats/activity');
      const data = await res.json();
      if (!data.activity.length) {
        el.innerHTML = 'No matches finished yet today.';
        return;
      }
      const modeLabels = { quick: 'Quick War', blitz: 'Blitz War', grand: 'Grand War', solo: 'Solo Ranked', private: 'Private War', async: 'Daily Challenge', tournament: 'Tournament' };
      el.innerHTML = data.activity
        .map((a) => {
          const mins = Math.max(0, Math.round((Date.now() - new Date(a.endTime).getTime()) / 60000));
          const when = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
          return `<div class="tw-activity-row"><span>🏆 <strong>${TW.escapeHtml(a.winnerUsername)}</strong> won a ${modeLabels[a.mode] || a.mode}</span><span>${when}</span></div>`;
        })
        .join('');
    } catch (e) {
      el.innerHTML = 'Could not load activity.';
    }
  }

  async function loadHotStreaks() {
    const el = document.getElementById('hotStreaks');
    if (!el) return;
    try {
      const res = await fetch('/api/stats/hot-streaks');
      const data = await res.json();
      if (!data.streaks.length) {
        el.innerHTML = 'No one is on a streak right now.';
        return;
      }
      el.innerHTML = data.streaks
        .map((s) => `<div class="tw-streak-row"><span>🔥 <strong>${TW.escapeHtml(s.username)}</strong></span><span>${s.streak} wins in a row</span></div>`)
        .join('');
    } catch (e) {
      el.innerHTML = 'Could not load streaks.';
    }
  }

  async function loadWarLordSpotlight() {
    const el = document.getElementById('warLordSpotlight');
    if (!el) return;
    try {
      const res = await fetch('/api/stats/war-lord-spotlight');
      const data = await res.json();
      if (!data.player) {
        el.innerHTML = 'No War Lord has emerged yet.';
        return;
      }
      el.innerHTML = `
        <div class="crown">👑</div>
        <div class="name">${TW.escapeHtml(data.player.username)}</div>
        <div class="meta">${data.player.tier} · ${data.player.warRating} rating · ${data.player.wins} wins</div>
      `;
    } catch (e) {
      el.innerHTML = 'Could not load spotlight.';
    }
  }

  // Renders broker partners as small interactive cards inside the hub's
  // left column (#twHubLeft, alongside the tournament/battle-pass/shop/daily
  // cards) instead of a separate chip-list panel at the bottom of the page -
  // same hover-lift language as the other hub cards, plus a tier-coloured
  // border and a slow shimmer sweep so the title sponsor in particular reads
  // as a premium placement rather than a plain logo chip.
  async function loadBrokerPartners() {
    const container = document.getElementById('twHubPartnerCards');
    const label = document.getElementById('twPartnersLabel');
    if (!container) return;
    try {
      const res = await fetch('/api/stats/broker-partners');
      const data = await res.json();
      if (!data.partners.length) return;
      const tierMeta = {
        title: { label: 'TITLE SPONSOR', cls: 'tier-title' },
        official: { label: 'OFFICIAL PARTNER', cls: 'tier-official' },
        featured: { label: 'FEATURED', cls: 'tier-featured' },
      };
      const sortOrder = { title: 0, official: 1, featured: 2 };
      const sorted = [...data.partners].sort((a, b) => (sortOrder[a.tier] ?? 3) - (sortOrder[b.tier] ?? 3));
      container.innerHTML = sorted
        .map((p) => {
          const meta = tierMeta[p.tier] || tierMeta.featured;
          const logo = p.logoUrl
            ? `<img class="tw-partner-logo" src="${p.logoUrl}" alt="" />`
            : `<div class="tw-partner-logo tw-partner-logo-fallback">${TW.escapeHtml((p.name || '?')[0].toUpperCase())}</div>`;
          return `
            <a class="tw-partner-card ${meta.cls}" href="${p.referralUrl || '#'}" target="_blank" rel="noopener" title="${TW.escapeHtml(p.name)}">
              <span class="tw-partner-shine"></span>
              <span class="tw-corner-badge badge-partner">${meta.label}</span>
              ${logo}
              <div class="tw-partner-name">${TW.escapeHtml(p.name)}</div>
            </a>
          `;
        })
        .join('');
      label?.classList.remove('hidden');
    } catch (e) {
      // Leave empty - no partners is a valid empty state, not an error worth surfacing.
    }
  }

  // ---- left-column hub cards (Trading Floor home redesign) ------------------

  async function loadTournamentCard() {
    const el = document.getElementById('twHubTournamentCard');
    if (!el || !TW.getToken || !TW.getToken()) return;
    try {
      const data = await TW.api('/api/tournaments');
      const t = (data.tournaments || []).find((x) => x.status === 'active') || (data.tournaments || []).find((x) => x.status === 'signup');
      if (!t) return;
      el.classList.remove('hidden');
      const live = t.status === 'active';
      el.innerHTML = `
        <span class="tw-corner-badge ${live ? 'badge-live' : 'badge-hot'}">${live ? 'LIVE' : 'OPEN'}</span>
        <div class="tw-hub-card-icon">🏆</div>
        <div class="tw-hub-card-title">${TW.escapeHtml(t.name)}</div>
        <div class="tw-hub-card-meta">🪙 ${t.prizePoolCoins.toLocaleString()} prize pool</div>
      `;
      el.onclick = () => { window.location.href = `/tournament?id=${t.id}`; };
    } catch (e) {
      // Not logged in or none running - card stays hidden.
    }
  }

  async function loadBattlePassCard() {
    const el = document.getElementById('twHubBattlePassCard');
    if (!el || !TW.getToken || !TW.getToken()) return;
    try {
      const data = await TW.api('/api/battlepass/status');
      el.classList.remove('hidden');
      const daysLeft = Math.max(0, Math.ceil((new Date(data.expiresAt).getTime() - Date.now()) / 86400000));
      const pct = Math.round((data.xpIntoTier / data.xpPerTier) * 100);
      el.innerHTML = `
        <div class="tw-hub-card-icon">🎖️</div>
        <div class="tw-hub-card-title">TIER ${data.tier} · ${daysLeft}d left</div>
        <div class="tw-progress-bar"><div class="tw-progress-fill" style="width:${pct}%;"></div></div>
      `;
      el.onclick = () => { window.location.href = '/battle-pass'; };
    } catch (e) {
      // Not logged in - card stays hidden.
    }
  }

  async function loadShopCard() {
    const el = document.getElementById('twHubShopCard');
    if (!el || !TW.getToken || !TW.getToken()) return;
    try {
      const data = await TW.api('/api/shop/catalog');
      const all = [
        ...(data.catalog.avatarFrames || []),
        ...(data.catalog.profileBackgrounds || []),
        ...(data.catalog.nameplateEffects || []),
      ].filter((i) => i.price > 0);
      if (!all.length) return;
      const featured = all[Math.floor(Math.random() * all.length)];
      el.classList.remove('hidden');
      el.innerHTML = `
        <div class="tw-hub-card-icon">🛒</div>
        <div class="tw-hub-card-title">${TW.escapeHtml(featured.name)}</div>
        <div class="tw-hub-card-meta">🪙 ${featured.price.toLocaleString()}</div>
      `;
      el.onclick = () => { window.location.href = '/shop'; };
    } catch (e) {
      // Not logged in - card stays hidden.
    }
  }

  async function loadDailyChallengeCard() {
    const el = document.getElementById('twHubDailyCard');
    if (!el || !TW.getToken || !TW.getToken()) return;
    try {
      const data = await TW.api('/api/async/today');
      el.classList.remove('hidden');
      el.innerHTML = `
        <span class="tw-corner-badge badge-free">FREE</span>
        <div class="tw-hub-card-icon">📅</div>
        <div class="tw-hub-card-title">DAILY CHALLENGE</div>
        <div class="tw-hub-card-meta">${TW.escapeHtml(data.instruments.join(' / '))}</div>
        <div class="tw-hub-card-meta">${data.alreadyPlayed ? `Scored ${TW.formatMoney(Number(data.myResult.pnl))}` : `🪙 ${data.entryCoins} to enter`}</div>
      `;
      el.onclick = () => { window.location.href = '/async'; };
    } catch (e) {
      // Not logged in or endpoint unavailable - card stays hidden.
    }
  }

  // Bottom-center scrolling activity ticker - reuses the same real data as
  // the (non-scrolling) Recent Activity panel and the announcement banner,
  // just reformatted into one continuously-scrolling strip.
  async function loadHubActivityTicker() {
    const track = document.getElementById('twHubTickerTrack');
    if (!track) return;
    try {
      const [activityRes, announcementsRes] = await Promise.all([
        fetch('/api/stats/activity'),
        fetch('/api/announcements/active'),
      ]);
      const activity = (await activityRes.json()).activity || [];
      const announcements = announcementsRes.ok ? await announcementsRes.json() : [];
      const modeLabels = { quick: 'Quick War', blitz: 'Blitz War', grand: 'Grand War', solo: 'Solo Ranked', private: 'Private War', async: 'Daily Challenge', tournament: 'Tournament' };
      const items = [
        ...activity.slice(0, 8).map((a) => `🏆 ${TW.escapeHtml(a.winnerUsername)} just won a ${modeLabels[a.mode] || a.mode}${a.pnl ? ` (+${TW.formatMoney(a.pnl)})` : ''}`),
        ...announcements.slice(0, 3).map((a) => `📣 ${TW.escapeHtml(a.title)}`),
      ];
      if (!items.length) { track.parentElement?.classList.add('hidden'); return; }
      const html = items.map((t) => `<span class="tw-hub-ticker-item">${t}</span>`).join('');
      track.innerHTML = html + html;
      track.parentElement?.classList.remove('hidden');
    } catch (e) {
      track.parentElement?.classList.add('hidden');
    }
  }

  // Center-column player identity summary - reads the already-cached player
  // (set at login) rather than an extra fetch, since nothing here needs to
  // be fresher than what's already in localStorage.
  function loadHubIdentity() {
    const el = document.getElementById('twHubIdentity');
    if (!el) return;
    const player = TW.getPlayer();
    if (!player) return;
    const winRate = player.total_matches ? Math.round((player.wins / player.total_matches) * 100) : 0;
    el.innerHTML = `
      ${TW.createAvatar(player, 'xl')}
      <div class="tw-hub-identity-meta">
        <div class="tw-hub-identity-name">${TW.renderUsername(player)}</div>
        <div class="tw-player-badge-tier" style="font-size:16px;" title="${TW.escapeHtml(player.tier)}">${TW.TIER_ICON[player.tier] || '🔰'} ${TW.escapeHtml(player.tier)} · ${Number(player.war_rating || 0).toLocaleString()}</div>
        <div class="tw-hub-identity-stats">
          <span>${player.wins || 0}W / ${player.losses || 0}L</span>
          <span>${winRate}% win rate</span>
          <span>🪙 ${Number(player.coins || 0).toLocaleString()}</span>
        </div>
      </div>
    `;
  }

  async function loadAppVersion() {
    const el = document.getElementById('twAppVersion');
    if (!el) return;
    try {
      const res = await fetch('/api/version');
      const data = await res.json();
      el.textContent = `v${data.version}`;
    } catch (e) {
      // Not critical - leave blank.
    }
  }

  // Admin-authored banner (Communications > Announcements). Dismissal is
  // per-browser/per-announcement via localStorage, not tracked server-side -
  // the `views` counter on the announcements table is a page-load count, not
  // a unique-viewer count.
  async function loadAnnouncementBanner() {
    const el = document.getElementById('twAnnouncementBanner');
    if (!el) return;
    try {
      const res = await fetch('/api/announcements/active');
      const list = await res.json();
      renderAnnouncement(list[0] || null);
    } catch (e) {
      // Not fatal - banner just stays hidden.
    }
  }

  function renderAnnouncement(a) {
    const el = document.getElementById('twAnnouncementBanner');
    if (!el) return;
    if (!a) { el.innerHTML = ''; return; }
    let dismissed = [];
    try { dismissed = JSON.parse(localStorage.getItem('tw_dismissed_announcements') || '[]'); } catch (e) {}
    if (dismissed.includes(a.id)) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="tw-announcement-banner type-${a.type}">
        <span>${TW.escapeHtml ? TW.escapeHtml(a.title) : a.title}${a.message ? ' — ' + (TW.escapeHtml ? TW.escapeHtml(a.message) : a.message) : ''}</span>
        <button class="close-btn" aria-label="Dismiss">&times;</button>
      </div>
    `;
    el.querySelector('.close-btn').addEventListener('click', () => {
      dismissed.push(a.id);
      localStorage.setItem('tw_dismissed_announcements', JSON.stringify(dismissed));
      el.innerHTML = '';
    });
  }
  TW.renderAnnouncement = renderAnnouncement;

  // Exposed so main.js's login handler can populate the hub cards
  // immediately after login, without needing a full page reload.
  TW.refreshHubData = () => {
    loadHubIdentity();
    loadTournamentCard();
    loadBattlePassCard();
    loadShopCard();
    loadDailyChallengeCard();
  };

  document.addEventListener('DOMContentLoaded', () => {
    spawnCandles('twHeroParticles');
    spawnCandles('twLoginHeroParticles');
    loadAppVersion();
    loadAnnouncementBanner();
    typeTagline();
    revealLoginHeadline();
    drawChartCanvas('loginChartCanvas');
    drawChartCanvas('hubChartCanvas');
    loadStatsBar();
    loadFeaturedMatch();
    loadTicker();
    setInterval(loadTicker, 15000);
    loadActivityFeed();
    loadHotStreaks();
    loadWarLordSpotlight();
    loadBrokerPartners();
    loadHubIdentity();
    loadTournamentCard();
    loadBattlePassCard();
    loadShopCard();
    loadDailyChallengeCard();
    loadHubActivityTicker();
    setInterval(loadHubActivityTicker, 60000);
    document.getElementById('twHubStartBtn')?.addEventListener('click', () => {
      document.getElementById('modeQuickBtn')?.click();
    });
    // Ambient loop plays only on the Trading Floor home screen, fading in on
    // load and out on navigation away - autoplay policy means it may not
    // actually start until the visitor's first click/keypress, same as every
    // other sound in the game (see armUnlock in sound.js).
    if (TW.Sound) TW.Sound.startAmbient();
  });
  window.addEventListener('pagehide', () => {
    if (TW.Sound) TW.Sound.stopAmbient();
  });
})();
