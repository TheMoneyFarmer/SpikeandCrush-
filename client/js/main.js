'use strict';

window.TW = window.TW || {};

(function () {
  const TOKEN_KEY = 'tw_token';
  const PLAYER_KEY = 'tw_player';

  TW.getToken = () => localStorage.getItem(TOKEN_KEY);
  TW.getPlayer = () => {
    try {
      return JSON.parse(localStorage.getItem(PLAYER_KEY) || 'null');
    } catch (e) {
      return null;
    }
  };
  TW.setSession = (token, player) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(PLAYER_KEY, JSON.stringify(player));
  };
  TW.updatePlayerCache = (player) => {
    localStorage.setItem(PLAYER_KEY, JSON.stringify(player));
  };
  TW.clearSession = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PLAYER_KEY);
  };
  TW.requireAuth = () => {
    if (!TW.getToken()) {
      try {
        localStorage.setItem('tw_redirect_after_login', window.location.href);
      } catch (e) {}
      window.location.href = '/play?login=required';
      return false;
    }
    return true;
  };
  TW.consumePostLoginRedirect = () => {
    let redirect = null;
    try {
      redirect = localStorage.getItem('tw_redirect_after_login');
      localStorage.removeItem('tw_redirect_after_login');
    } catch (e) {}
    return redirect;
  };
  TW.logout = () => {
    TW.clearSession();
    // '/' not 'index.html' - the latter is the literal static file (the
    // old logged-out login screen), which bypasses the server's '/' route
    // that now serves the marketing landing page instead.
    window.location.href = '/';
  };

  TW.escapeHtml = (str) => {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  };

  // /api/discord/connect is a plain navigation, not a fetch(), so it can't
  // carry an Authorization header - the token rides along as a query param
  // instead (see the matching comment on that route in server/index.js).
  TW.connectDiscord = () => {
    if (!TW.getToken()) {
      TW.requireAuth();
      return;
    }
    window.location.href = '/api/discord/connect?token=' + encodeURIComponent(TW.getToken());
  };

  // ---- theme (Default War Room / Midnight / Combat / Light) -----------------
  // The <head> of every page runs a tiny inline script (before any CSS
  // paints) that reads this same localStorage key and stamps data-theme on
  // <html>, so there's no flash of the wrong theme on load - see the
  // <script> right after the viewport meta tag in each HTML file.
  const THEME_KEY = 'sc_theme';
  TW.getTheme = () => {
    try {
      return localStorage.getItem(THEME_KEY) || 'default';
    } catch (e) {
      return 'default';
    }
  };
  TW.setTheme = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {}
    if (TW.getToken()) {
      TW.api('/api/player/settings', { method: 'PATCH', body: { settings: { theme } } }).catch(() => {});
    }
    // Charts read CSS variables (background/grid/candle colors) that only
    // update visually once the browser recomputes styles for the new
    // data-theme attribute - a custom event (rather than calling a specific
    // global function name) lets any page's chart code react independently:
    // game.html's shared TW.Chart module and replay.html's own standalone
    // lightweight-charts instances both listen for this.
    setTimeout(() => window.dispatchEvent(new CustomEvent('sc:theme-change', { detail: { theme } })), 0);
  };

  // ---- cosmetics: avatar frames / nameplate effects / profile backgrounds --
  // Shop item ids (frame_teal_ring, name_matrix_rain, bg_blood_red_market)
  // are turned into CSS class suffixes (teal-ring, matrix-rain,
  // blood-red-market) by stripping the slot prefix and swapping underscores
  // for hyphens - see the .frame-*/.nameplate-*/.profile-bg-* rules in
  // premium.css, which use this exact same naming convention.
  TW.cosmeticSlug = (itemId, prefix) => {
    if (!itemId) return null;
    let s = String(itemId);
    if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
    return s.replace(/_/g, '-');
  };

  const AVATAR_PALETTE = ['#00c896', '#4fc3f7', '#ffd700', '#ff8c00', '#ff4444', '#a78bfa', '#00e0ff'];
  TW.avatarColor = (username) => {
    const s = String(username || '');
    let hash = 0;
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
  };

  // player may be the logged-in session's own player object (equipped_frame/
  // equipped_background/equipped_nameplate, set at login) or another
  // player's public profile data (avatar_frame/background/nameplate, from
  // /api/player/by-username's equippedCosmetics) - both shapes are accepted.
  TW.createAvatar = (player, size = 'md') => {
    const sizes = { sm: 28, md: 36, lg: 48, xl: 64 };
    const px = sizes[size] || sizes.md;
    const frameId = player?.equipped_frame || player?.avatar_frame || 'none';
    const frameClass = frameId === 'none' || frameId === 'frame_none' ? 'frame-none' : `frame-${TW.cosmeticSlug(frameId, 'frame_')}`;
    const initial = (player?.username || '?').charAt(0).toUpperCase();
    const color = TW.avatarColor(player?.username);
    const fontSize = px <= 28 ? 12 : px <= 36 ? 14 : px <= 48 ? 18 : 24;
    return (
      `<span class="tw-avatar-wrap" style="width:${px}px;height:${px}px;">` +
      `<span class="tw-avatar-frame ${frameClass}"></span>` +
      `<span class="tw-avatar-circle" style="width:${px}px;height:${px}px;background:${color};font-size:${fontSize}px;">${TW.escapeHtml(initial)}</span>` +
      `</span>`
    );
  };

  TW.renderUsername = (player, extraAttrs = '') => {
    const nameplateId = player?.equipped_nameplate || player?.nameplate || 'name_standard';
    const cls = `tw-nameplate nameplate-${TW.cosmeticSlug(nameplateId, 'name_')}`;
    return `<span class="${cls}" ${extraAttrs}>${TW.escapeHtml(player?.username || '')}</span>`;
  };

  TW.profileBackgroundClass = (player) => {
    const bgId = player?.equipped_background || player?.background || 'bg_terminal_dark';
    return `profile-bg-${TW.cosmeticSlug(bgId, 'bg_')}`;
  };

  TW.formatMoney = (n) => {
    const num = Number(n) || 0;
    const sign = num < 0 ? '-' : '';
    return `${sign}$${Math.abs(num).toFixed(2).replace(/\d(?=(\d{3})+\.)/g, '$&,')}`;
  };

  TW.tierClass = (tier) => `tier-${String(tier || 'Recruit').replace(/\s+/g, '.')}`;

  // Mirrors server/gameEngine.js's TIERS - kept in sync manually since tier
  // boundaries almost never change and this avoids a round trip just to
  // draw a progress bar.
  const TIER_RANGES = [
    { name: 'Recruit', min: 0, max: 999 },
    { name: 'Trader', min: 1000, max: 1499 },
    { name: 'Broker', min: 1500, max: 1999 },
    { name: 'Analyst', min: 2000, max: 2499 },
    { name: 'Veteran', min: 2500, max: 2999 },
    { name: 'Elite', min: 3000, max: 3499 },
    { name: 'War Lord', min: 3500, max: Infinity },
  ];

  // % progress through the current tier's rating band, for a thin
  // next-tier progress bar. War Lord (no ceiling) always reads as full.
  TW.tierProgressPct = (rating) => {
    const r = Number(rating) || 0;
    const tier = TIER_RANGES.find((t) => r >= t.min && r <= t.max) || TIER_RANGES[0];
    if (!Number.isFinite(tier.max)) return 100;
    return Math.max(0, Math.min(100, ((r - tier.min) / (tier.max - tier.min + 1)) * 100));
  };

  TW.TIER_ICON = {
    Recruit: '🔰',
    Trader: '⚔️',
    Broker: '💼',
    Analyst: '📊',
    Veteran: '🎖️',
    Elite: '💎',
    'War Lord': '👑',
  };

  // The one consistent player-identity format used everywhere a player
  // appears: [Avatar] [Username] [TierIcon] [Rating]. `player` accepts
  // either DB-shaped rows (war_rating) or live match-state rows (warRating);
  // pass opts.rating to force a specific one (e.g. grand_war_rating).
  TW.renderPlayerBadge = (player, opts = {}) => {
    const tier = player?.tier || 'Recruit';
    const icon = TW.TIER_ICON[tier] || '🔰';
    const rating = opts.rating ?? player?.war_rating ?? player?.warRating ?? 0;
    const showAvatar = opts.showAvatar !== false;
    const showRating = opts.showRating !== false;
    return (
      `<span class="tw-player-badge ${opts.extraClass || ''}">` +
      (showAvatar ? TW.createAvatar(player, opts.size || 'sm') : '') +
      `<span class="tw-player-badge-name">${TW.renderUsername(player)}</span>` +
      `<span class="tw-player-badge-tier" title="${TW.escapeHtml(tier)}">${icon}</span>` +
      (showRating ? `<span class="tw-player-badge-rating mono">${Number(rating).toLocaleString()}</span>` : '') +
      `</span>`
    );
  };

  async function api(path, options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const token = TW.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      if (data) Object.assign(err, data); // e.g. requiresTotp, so callers can react without re-parsing
      throw err;
    }
    return data;
  }
  TW.api = api;

  function ensureToastContainer() {
    let el = document.getElementById('twToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'twToast';
      document.body.appendChild(el);
    }
    return el;
  }

  TW.toast = (message, type = 'info') => {
    const container = ensureToastContainer();
    const item = document.createElement('div');
    item.className = `tw-toast-item ${type}`;
    item.textContent = message;
    container.appendChild(item);
    setTimeout(() => item.remove(), 4500);
  };

  // In-match center-screen notifications (sabotage cards, margin warnings,
  // leaderboard overtakes, SL/TP hits) - subtle, auto-dismissing, and never
  // blocks the chart, replacing what used to be full-screen modal overlays.
  // Up to 3 stack at once; the newest sits dead-center and older ones get
  // pushed up and fade toward translucent; the oldest is dropped first.
  const MATCH_NOTIF_MAX = 3;
  const MATCH_NOTIF_SLOT_PX = 42;
  let matchNotifContainer = null;
  let matchNotifQueue = [];

  function repositionMatchNotifs() {
    const total = matchNotifQueue.length;
    matchNotifQueue.forEach((item, i) => {
      const fromNewest = total - 1 - i;
      item.el.style.setProperty('--tw-notif-y', `${-fromNewest * MATCH_NOTIF_SLOT_PX}px`);
      item.el.classList.toggle('tw-notif-stacked', fromNewest > 0);
    });
  }

  TW.showMatchNotification = (text) => {
    if (!matchNotifContainer) {
      matchNotifContainer = document.createElement('div');
      matchNotifContainer.className = 'tw-match-notifications';
      document.body.appendChild(matchNotifContainer);
    }
    const el = document.createElement('div');
    el.className = 'match-notification';
    el.textContent = text;
    matchNotifContainer.appendChild(el);
    const item = { el };
    matchNotifQueue.push(item);
    if (matchNotifQueue.length > MATCH_NOTIF_MAX) {
      matchNotifQueue.shift().el.remove();
    }
    repositionMatchNotifs();
    setTimeout(() => {
      el.remove();
      matchNotifQueue = matchNotifQueue.filter((q) => q !== item);
      repositionMatchNotifs();
    }, 4000);
  };

  TW.updateHeader = () => {
    const player = TW.getPlayer();
    const coinWrap = document.getElementById('headerCoinWrap');
    const coinBalance = document.getElementById('headerCoinBalance');
    const ratingEl = document.getElementById('headerRating');
    const nameEl = document.getElementById('headerUsername');
    const authLink = document.getElementById('headerAuthLink');
    const tierBadge = document.getElementById('headerTierBadge');
    const identity = document.getElementById('twNavIdentity');
    const identityAvatar = document.getElementById('twNavIdentityAvatar');
    const progressFill = document.getElementById('twNavProgressFill');
    if (coinWrap) coinWrap.classList.toggle('hidden', !player);
    if (coinBalance) {
      const prev = Number(coinBalance.dataset.prevCoins || coinBalance.textContent);
      const next = player ? player.coins : '-';
      if (player && Number.isFinite(prev) && player.coins > prev) {
        coinBalance.classList.remove('coin-flash');
        void coinBalance.offsetWidth;
        coinBalance.classList.add('coin-flash');
      }
      coinBalance.textContent = next;
      if (player) coinBalance.dataset.prevCoins = String(player.coins);
    }
    if (ratingEl) ratingEl.textContent = player ? Number(player.war_rating || 0).toLocaleString() : '';
    if (nameEl) {
      nameEl.innerHTML = player ? TW.renderUsername(player) : '';
      nameEl.classList.toggle('tw-name-warlord', Boolean(player && player.tier === 'War Lord'));
    }
    if (identity) identity.classList.toggle('hidden', !player);
    if (identityAvatar) identityAvatar.innerHTML = player ? TW.createAvatar(player, 'sm') : '';
    if (progressFill) progressFill.style.width = player ? `${TW.tierProgressPct(player.war_rating)}%` : '0%';
    if (authLink) authLink.classList.toggle('hidden', Boolean(player));
    document.getElementById('twLogoutBtn')?.classList.toggle('hidden', !player);
    if (tierBadge) {
      tierBadge.classList.toggle('hidden', !player);
      if (player) {
        tierBadge.textContent = TW.TIER_ICON[player.tier] || '🔰';
        tierBadge.title = player.tier;
        tierBadge.className = `tw-nav-tier ${TW.tierClass(player.tier)}`;
      }
    }
  };

  // Admin-managed promotional popup (Communications > Promotional Popup).
  // Fires once per calendar day per popup id - storing the id alongside the
  // date means a newly-published promo shows again immediately even if
  // today's earlier one was already dismissed, without needing a server
  // round trip to know "is this a new promo?".
  const PROMO_DISMISS_KEY = 'sc_promo_dismissed';
  async function checkPromoPopup() {
    if (!TW.getToken || !TW.getToken()) return;
    let popup;
    try {
      popup = await TW.api('/api/promo/active');
    } catch (e) {
      return;
    }
    if (!popup) return;
    let dismissed = null;
    try { dismissed = JSON.parse(localStorage.getItem(PROMO_DISMISS_KEY) || 'null'); } catch (e) {}
    const today = new Date().toISOString().slice(0, 10);
    if (dismissed && dismissed.id === popup.id && dismissed.date === today) return;

    setTimeout(() => {
      const overlay = document.createElement('div');
      overlay.className = 'tw-promo-overlay';
      overlay.innerHTML = `
        <button type="button" class="tw-promo-close" aria-label="Close">&times;</button>
        <div class="tw-promo-image" style="background:linear-gradient(160deg, ${popup.gradient_from} 0%, ${popup.gradient_to} 100%);"></div>
        <div class="tw-promo-panel">
          <div class="tw-promo-headline">${TW.escapeHtml(popup.headline)}</div>
          <div class="tw-promo-subtext">${TW.escapeHtml(popup.subtext)}</div>
          <a class="tw-promo-btn" href="${TW.escapeHtml(popup.button_url)}">${TW.escapeHtml(popup.button_text)}</a>
        </div>
      `;
      const dismiss = () => {
        localStorage.setItem(PROMO_DISMISS_KEY, JSON.stringify({ id: popup.id, date: today }));
        overlay.remove();
      };
      overlay.querySelector('.tw-promo-close').addEventListener('click', dismiss);
      document.body.appendChild(overlay);
    }, 500);
  }

  document.addEventListener('DOMContentLoaded', () => {
    TW.updateHeader();
    // Delegated so it covers buttons rendered later by nav.js/page scripts too.
    document.addEventListener('click', (e) => {
      if (e.target.closest('button, .btn') && window.TW.Sound) TW.Sound.play('buttonClick');
    });
    const authLink = document.getElementById('headerAuthLink');
    authLink?.addEventListener('click', (e) => {
      if (TW.getPlayer()) {
        e.preventDefault();
        TW.logout();
      }
    });

    checkPromoPopup();

    if (document.body.dataset.page === 'index') initIndexPage();
  });

  // -------------------------------------------------------------- index page

  function initIndexPage() {
    const loginHero = document.getElementById('twLoginHero');
    const hubHero = document.getElementById('twHubHero');
    const mainMenu = document.getElementById('mainMenu');
    const marketTickerWrap = document.getElementById('twMarketTickerWrap');

    function refreshVisibility() {
      const logged = Boolean(TW.getPlayer());
      if (loginHero) loginHero.classList.toggle('hidden', logged);
      if (hubHero) hubHero.classList.toggle('hidden', !logged);
      if (mainMenu) mainMenu.classList.toggle('hidden', !logged);
      if (marketTickerWrap) marketTickerWrap.classList.toggle('hidden', !logged);
    }
    refreshVisibility();

    if (new URLSearchParams(window.location.search).get('login') === 'required') {
      document.getElementById('loginRequiredBanner')?.classList.remove('hidden');
    }

    // Invite links generated by lobby.html's "copy link" button look like
    // /play?join=123456 - if we're already logged in, join immediately; if
    // not, stash this exact URL as the post-login redirect (same mechanism
    // TW.requireAuth() uses) so the join fires right after they sign in
    // instead of silently doing nothing once they land on a bare dashboard.
    const joinCode = new URLSearchParams(window.location.search).get('join');
    if (joinCode) {
      if (TW.getToken()) {
        joinByRoomCode(joinCode);
      } else {
        try {
          localStorage.setItem('tw_redirect_after_login', window.location.href);
        } catch (e) {}
      }
    }

    const loginTab = document.getElementById('loginTab');
    const registerTab = document.getElementById('registerTab');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');

    function showLogin() {
      loginForm.classList.remove('hidden');
      registerForm.classList.add('hidden');
      loginTab.classList.add('active');
      registerTab.classList.remove('active');
    }
    function showRegister() {
      registerForm.classList.remove('hidden');
      loginForm.classList.add('hidden');
      registerTab.classList.add('active');
      loginTab.classList.remove('active');
    }
    loginTab?.addEventListener('click', showLogin);
    registerTab?.addEventListener('click', showRegister);
    document.getElementById('registerTabLink')?.addEventListener('click', (e) => { e.preventDefault(); showRegister(); });
    document.getElementById('loginTabLink')?.addEventListener('click', (e) => { e.preventDefault(); showLogin(); });

    loginForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('loginError');
      errEl.textContent = '';
      const username = document.getElementById('loginUsername').value.trim();
      const password = document.getElementById('loginPassword').value;
      const totpInput = document.getElementById('loginTotpCode');
      const totpCode = totpInput && !totpInput.classList.contains('hidden') ? totpInput.value.trim() : undefined;
      try {
        const data = await TW.api('/api/auth/login', { method: 'POST', body: { username, password, totpCode } });
        await TW.establishSession(data.token, data.refresh_token, data.player);
        const redirect = TW.consumePostLoginRedirect();
        if (redirect) {
          window.location.href = redirect;
          return;
        }
        TW.updateHeader();
        refreshVisibility();
        if (TW.refreshHubData) TW.refreshHubData();
        checkPromoPopup();
        TW.toast(`Welcome back, ${data.player.username}`, 'info');
        loadLeaderboardPreview();
      } catch (err) {
        if (err.requiresTotp && totpInput) {
          totpInput.classList.remove('hidden');
          totpInput.focus();
          errEl.textContent = 'Enter your 6-digit authenticator code';
        } else {
          errEl.textContent = err.message;
        }
      }
    });

    registerForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('registerError');
      errEl.textContent = '';
      const username = document.getElementById('registerUsername').value.trim();
      const email = document.getElementById('registerEmail').value.trim();
      const password = document.getElementById('registerPassword').value;
      try {
        const data = await TW.api('/api/auth/register', { method: 'POST', body: { username, email, password } });
        await TW.establishSession(data.token, data.refresh_token, data.player);
        const redirect = TW.consumePostLoginRedirect();
        if (redirect) {
          window.location.href = redirect;
          return;
        }
        TW.updateHeader();
        refreshVisibility();
        if (TW.refreshHubData) TW.refreshHubData();
        checkPromoPopup();
        TW.toast(
          `Welcome to Spike & Crush, ${data.player.username}. Up. Then not. +${data.welcomeBonus} coin welcome bonus`,
          'info'
        );
        loadLeaderboardPreview();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    document.getElementById('googleSignInBtn')?.addEventListener('click', () => TW.loginWithGoogle());
    document.getElementById('appleSignInBtn')?.addEventListener('click', () => TW.loginWithApple());
    document.getElementById('forgotPasswordLink')?.addEventListener('click', (e) => {
      e.preventDefault();
      TW.handleForgotPassword();
    });

    // Wraps each mode's real action with the mode-cards.js "explain this mode
    // the first 3 times" tutorial (see client/js/mode-cards.js) - falls back
    // to the real action directly if that script isn't on the page.
    const withModeTutorial = (mode, action) => (TW.startModeWithTutorial ? TW.startModeWithTutorial(mode, action) : action());
    document.getElementById('modeQuickBtn')?.addEventListener('click', () => withModeTutorial('quickwar', () => startMatch('quick')));
    document.getElementById('modeBlitzBtn')?.addEventListener('click', () => withModeTutorial('blitz', () => startMatch('blitz')));
    document.getElementById('modeGrandBtn')?.addEventListener('click', () => withModeTutorial('grandwar', () => startMatch('grand')));
    document.getElementById('modeSoloBtn')?.addEventListener('click', () => withModeTutorial('solo', () => startMatch('solo')));
    document.getElementById('modeAsyncBtn')?.addEventListener('click', () => withModeTutorial('async', () => { window.location.href = '/async'; }));
    document.getElementById('modePrivateBtn')?.addEventListener('click', () => startMatch('private'));
    document.getElementById('modeTournamentBtn')?.addEventListener('click', () => { window.location.href = '/tournaments'; });

    document.getElementById('joinPrivateBtn')?.addEventListener('click', () => {
      const input = document.getElementById('joinRoomCodeInput');
      joinByRoomCode((input.value || '').trim());
    });

    // Shared by the manual "Join" button above and the ?join= auto-join
    // handled earlier in initIndexPage() - one validation/API/redirect path
    // so an invite link behaves exactly like typing the code in by hand.
    async function joinByRoomCode(code) {
      if (!/^\d{6}$/.test(code)) {
        TW.toast('Enter a valid 6 digit room code', 'warning');
        return;
      }
      try {
        const data = await TW.api('/api/match/join', { method: 'POST', body: { roomCode: code } });
        window.location.href = `lobby.html?matchId=${data.matchId}`;
      } catch (err) {
        TW.toast(err.message, 'danger');
      }
    }

    async function startMatch(mode) {
      try {
        const data = await TW.api('/api/match/create', { method: 'POST', body: { mode } });
        window.location.href = `lobby.html?matchId=${data.matchId}`;
      } catch (err) {
        TW.toast(err.message, 'danger');
      }
    }

    loadLeaderboardPreview();
  }

  async function loadLeaderboardPreview() {
    const body = document.getElementById('leaderboardPreviewBody');
    if (!body) return;
    try {
      const data = await TW.api('/api/leaderboard?limit=10');
      body.innerHTML = '';
      data.leaderboard.forEach((row, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${i + 1}</td>
          <td>${TW.escapeHtml(row.username)}</td>
          <td class="${TW.tierClass(row.tier)}">${TW.escapeHtml(row.tier)}</td>
          <td class="mono">${row.war_rating}</td>
          <td>${row.wins}W / ${row.losses}L</td>
        `;
        body.appendChild(tr);
      });
      if (data.leaderboard.length === 0) {
        body.innerHTML = '<tr><td colspan="5" class="text-secondary">No players yet - be the first to register.</td></tr>';
      }
    } catch (err) {
      body.innerHTML = `<tr><td colspan="5" class="text-secondary">${TW.escapeHtml(err.message)}</td></tr>`;
    }
  }
})();
