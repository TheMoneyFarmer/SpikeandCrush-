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
      window.location.href = 'index.html?login=required';
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
    window.location.href = 'index.html';
  };

  TW.escapeHtml = (str) => {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  };

  // ---- theme (dark / midnight / light) --------------------------------
  // The <head> of every page runs a tiny inline script (before any CSS
  // paints) that reads this same localStorage key and stamps data-theme on
  // <html>, so there's no flash of the wrong theme on load - see the
  // <script> right after the viewport meta tag in each HTML file.
  const THEME_KEY = 'sc_theme';
  TW.getTheme = () => {
    try {
      return localStorage.getItem(THEME_KEY) || 'dark';
    } catch (e) {
      return 'dark';
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
    if (window.reinitializeCharts) window.reinitializeCharts();
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

  TW.updateHeader = () => {
    const player = TW.getPlayer();
    const coinWrap = document.getElementById('headerCoinWrap');
    const coinBalance = document.getElementById('headerCoinBalance');
    const ratingEl = document.getElementById('headerRating');
    const nameEl = document.getElementById('headerUsername');
    const authLink = document.getElementById('headerAuthLink');
    const tierBadge = document.getElementById('headerTierBadge');
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
    if (ratingEl) ratingEl.textContent = player ? `${player.war_rating} · ${player.tier}` : '';
    if (nameEl) {
      nameEl.innerHTML = player ? TW.renderUsername(player) : '';
      nameEl.classList.toggle('tw-name-warlord', Boolean(player && player.tier === 'War Lord'));
    }
    if (authLink) authLink.textContent = player ? 'Log out' : 'Log in';
    if (tierBadge) {
      tierBadge.classList.toggle('hidden', !player);
      if (player) {
        tierBadge.textContent = player.tier;
        tierBadge.className = `pill ${TW.tierClass(player.tier)}`;
      }
    }
  };

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

    if (document.body.dataset.page === 'index') initIndexPage();
  });

  // -------------------------------------------------------------- index page

  function initIndexPage() {
    const authSection = document.getElementById('authSection');
    const mainMenu = document.getElementById('mainMenu');

    function refreshVisibility() {
      const logged = Boolean(TW.getPlayer());
      if (authSection) authSection.classList.toggle('hidden', logged);
      if (mainMenu) mainMenu.classList.toggle('hidden', !logged);
    }
    refreshVisibility();

    if (new URLSearchParams(window.location.search).get('login') === 'required') {
      document.getElementById('loginRequiredBanner')?.classList.remove('hidden');
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

    document.getElementById('joinPrivateBtn')?.addEventListener('click', async () => {
      const input = document.getElementById('joinRoomCodeInput');
      const code = (input.value || '').trim();
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
    });

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
