'use strict';

window.TW = window.TW || {};

// Renders the shared premium nav bar into <div id="twNav" data-active="...">.
// Reuses the original header element ids (headerUsername, headerCoinWrap,
// headerCoinBalance, headerAuthLink) so TW.updateHeader() in main.js keeps
// working unchanged against the new markup.
(function () {
  const NAV_LINKS = [
    { key: 'home', label: 'Home', href: '/play' },
    { key: 'leaderboard', label: 'Leaderboard', href: '/leaderboard' },
    { key: 'cards', label: 'Cards', href: '/cards' },
    { key: 'shop', label: 'Shop', href: '/shop' },
    { key: 'wallet', label: 'Wallet', href: '/wallet' },
    { key: 'battle-pass', label: 'Battle Pass', href: '/battle-pass' },
    { key: 'coaching', label: 'Coaching', href: '/coaching' },
    { key: 'settings', label: 'Settings', href: '/settings' },
  ];

  const NOTIF_ICON = {
    rank_up: '🏆',
    match_starting: '⏱️',
    battlepass_tier: '🎖️',
    battlepass_premium: '👑',
    shop_purchase: '🛒',
    coin_purchase: '🪙',
    coaching_booked: '🎓',
    tournament_advance: '⚔️',
    tournament_eliminated: '💀',
    tournament_draw: '🤝',
    friend_request: '👥',
    friend_accepted: '✅',
    friend_won_match: '🏆',
    match_kicked: '🚫',
    match_voided: '⚠️',
    match_summary: '⚔️',
    invite_declined: '❌',
    invite_expired: '⏰',
    system: '📢',
    tournament_champion: '🏆',
    prize_claim_processing: '💰',
    prize_claim_paid: '💸',
    prize_claim_rejected: '⚠️',
  };

  const notifications = [];
  let currentNotifTab = 'new';

  function renderNav() {
    const container = document.getElementById('twNav');
    if (!container) return;
    const active = container.dataset.active || '';

    const linksHtml = NAV_LINKS.map(
      (l) => `<a href="${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`
    ).join('');

    // Persistent 3-zone header (identity / coins / icon-only actions) - full
    // page navigation lives entirely in the ☰ drawer now, so this bar never
    // wraps to a second row and never changes shape between pages.
    container.innerHTML = `
      <nav class="tw-navbar">
        <a href="/play" class="tw-logo-link">
          <div class="sc-logo-wrapper nav-logo">
            <div class="sc-logo">
              <span class="sc-s1">S</span><span class="sc-p">P</span><span class="sc-i">I</span><span class="sc-k">K</span><span class="sc-e">E</span><span class="sc-amp">&amp;</span><span class="sc-c">C</span><span class="sc-r">R</span><span class="sc-u">U</span><span class="sc-s2">S</span><span class="sc-h">H</span>
            </div>
          </div>
        </a>

        <div class="tw-nav-links">${linksHtml}</div>

        <a href="/profile" class="tw-nav-identity hidden" id="twNavIdentity">
          <span id="twNavIdentityAvatar"></span>
          <span class="tw-nav-identity-meta">
            <span class="tw-nav-identity-top">
              <span id="headerUsername" class="tw-account-name"></span>
              <span id="headerTierBadge" class="tw-nav-tier hidden"></span>
              <span id="headerRating" class="tw-player-badge-rating mono"></span>
            </span>
            <span class="tw-nav-progress"><span class="tw-nav-progress-fill" id="twNavProgressFill"></span></span>
          </span>
        </a>

        <div class="tw-nav-spacer"></div>

        <a href="/wallet" id="headerCoinWrap" class="tw-coin-balance hidden">🪙 <span id="headerCoinBalance">0</span></a>

        <div class="tw-nav-right">
          <button type="button" class="tw-nav-icon-btn" id="twNotifBtn" title="Notifications" style="position:relative;">🔔<span id="twNotifBadge" class="tw-notif-badge hidden">0</span></button>
          <button type="button" class="tw-nav-icon-btn tw-friends-toggle-btn" id="twFriendsToggleBtn" title="Friends (0)">👥<span id="twFriendsOnlineBadge" class="tw-friends-online-badge hidden">0</span></button>
          <a href="#" id="headerAuthLink" class="tw-nav-icon-btn tw-login-icon-link hidden" title="Log in">🔑</a>
          <button type="button" class="tw-nav-icon-btn tw-logout-icon-btn hidden" id="twLogoutBtn" title="Log out">🚪</button>
          <button type="button" class="tw-nav-icon-btn tw-hamburger" id="twHamburgerBtn" title="Menu">☰</button>
        </div>
      </nav>
    `;

    wireInteractions(container, active);
    if (window.TW.updateHeader) window.TW.updateHeader();
  }

  function wireInteractions(container, active) {
    const notifBtn = container.querySelector('#twNotifBtn');
    if (notifBtn) {
      notifBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNotifPanel(notifBtn);
      });
    }

    const hamburgerBtn = container.querySelector('#twHamburgerBtn');
    if (hamburgerBtn) {
      hamburgerBtn.addEventListener('click', () => openDrawer(active));
    }

    const logoutBtn = container.querySelector('#twLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => TW.logout());
    }

    initNotifications();
  }

  function unreadCount() {
    return notifications.filter((n) => !n.read).length;
  }

  function updateBadge() {
    const badge = document.getElementById('twNotifBadge');
    if (!badge) return;
    const count = unreadCount();
    if (count > 0) {
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function timeAgo(at) {
    if (!at) return '';
    const diffMs = Date.now() - new Date(at).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function notifItemHtml(n) {
    const icon = NOTIF_ICON[n.type] || '🔔';
    let actionsHtml = '';
    if (n.type === 'friend_request' && n.data?.requestId) {
      actionsHtml = `
        <div style="margin-top:6px;display:flex;gap:6px;">
          <button class="btn btn-primary" data-accept-req="${n.data.requestId}" style="font-size:11px;padding:4px 10px;">Accept</button>
          <button class="btn btn-outline" data-decline-req="${n.data.requestId}" style="font-size:11px;padding:4px 10px;">Decline</button>
        </div>
      `;
    } else if (n.type === 'friend_won_match' && n.data?.matchId) {
      actionsHtml = `<a href="/replay?match=${n.data.matchId}" style="font-size:11px;">Watch Replay</a>`;
    } else if (n.type === 'friend_accepted' && n.fromPlayerId) {
      actionsHtml = `<a href="/profile/${encodeURIComponent(n.data?.username || '')}" style="font-size:11px;">View Profile</a>`;
    }
    return `
      <div class="notif-item ${n.read ? '' : 'unread'}" data-notif-type="${n.type}" data-id="${n.id}">
        ${icon} ${TW.escapeHtml ? TW.escapeHtml(n.message) : n.message}
        ${actionsHtml}
        <div class="notif-item-time">${timeAgo(n.at)}</div>
      </div>
    `;
  }

  function renderNotifList() {
    const list = document.getElementById('twNotifList');
    if (!list) return;
    const filtered = currentNotifTab === 'new' ? notifications.filter((n) => !n.read) : notifications;
    list.innerHTML = filtered.length
      ? filtered.map(notifItemHtml).join('')
      : `<div class="notif-empty">${currentNotifTab === 'new' ? '✅ All caught up!' : 'No notifications yet'}</div>`;

    const count = unreadCount();
    const countEl = document.getElementById('twNotifNewCount');
    if (countEl) {
      countEl.textContent = count;
      countEl.style.display = count > 0 ? 'inline-flex' : 'none';
    }
    wireNotifPanelActions(list);
  }

  function switchNotifTab(tab) {
    currentNotifTab = tab;
    document.querySelectorAll('.tw-notif-panel .notif-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    renderNotifList();
  }

  async function markOneRead(id) {
    const n = notifications.find((x) => x.id === id);
    if (!n || n.read) return;
    n.read = true;
    renderNotifList();
    updateBadge();
    // Synthetic ids (live socket pushes not yet reconciled against the DB
    // row's real id) have nothing to mark server-side - the next full
    // history load will pick up their real read state.
    if (typeof id === 'string' && id.startsWith('live-')) return;
    try {
      await TW.api('/api/notifications/read', { method: 'POST', body: { ids: [id] } });
    } catch (e) { /* local state already updated - not fatal */ }
  }

  async function markAllRead() {
    notifications.forEach((n) => { n.read = true; });
    renderNotifList();
    updateBadge();
    try {
      await TW.api('/api/notifications/read', { method: 'POST', body: {} });
    } catch (e) { /* local state already updated - not fatal */ }
  }

  async function clearAllNotifications() {
    notifications.length = 0;
    renderNotifList();
    updateBadge();
    try {
      await TW.api('/api/notifications', { method: 'DELETE' });
    } catch (e) {
      TW.toast(e.message, 'danger');
    }
  }

  function wireNotifPanelActions(panel) {
    panel.querySelectorAll('[data-accept-req]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await TW.api(`/api/friends/${btn.dataset.acceptReq}/accept`, { method: 'POST' });
          TW.toast('Friend added!', 'info');
          btn.closest('.notif-item')?.remove();
          if (window.TW && TW.FriendsPanel) TW.FriendsPanel.refresh();
        } catch (e2) {
          TW.toast(e2.message, 'danger');
        }
      });
    });
    panel.querySelectorAll('[data-decline-req]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await TW.api(`/api/friends/${btn.dataset.declineReq}/decline`, { method: 'POST' });
          btn.closest('.notif-item')?.remove();
        } catch (e2) {
          TW.toast(e2.message, 'danger');
        }
      });
    });
    // Clicking anywhere else on an item (not a button/link inside it) just
    // marks it read - there's no per-type navigation target for most
    // notification kinds in this app beyond the explicit links above.
    panel.querySelectorAll('.notif-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('a')) return;
        markOneRead(el.dataset.id);
      });
    });
  }

  // FIX: rich bottom-right summary toast for a player who left a match
  // early - separate from the plain-text notification bell entry. Slides
  // up, auto-dismisses in 15s (progress bar), or closes on click.
  function showMatchSummaryToast(data) {
    document.querySelectorAll('.match-summary-toast').forEach((el) => el.remove());

    const toast = document.createElement('div');
    toast.className = 'match-summary-toast';
    const rankLabel = data.leftEarly ? `#${data.yourRank} (Left early)` : `#${data.yourRank}`;
    const pnlClass = data.yourPnl >= 0 ? 'toast-good' : 'toast-bad';
    const ratingClass = data.ratingChange >= 0 ? 'toast-good' : 'toast-bad';
    toast.innerHTML = `
      <div class="toast-header">
        <span class="toast-icon">⚔️</span>
        <span class="toast-title">Match Summary — ${TW.escapeHtml(data.mode || '')}</span>
        <button class="toast-close">✕</button>
      </div>
      <div class="toast-content">
        <div class="toast-row"><span>Your Rank</span><span class="${pnlClass}">${rankLabel}</span></div>
        <div class="toast-row"><span>Your P&amp;L</span><span class="${pnlClass}">${data.yourPnl >= 0 ? '+' : ''}$${Number(data.yourPnl).toLocaleString()}</span></div>
        ${data.winner ? `<div class="toast-row"><span>Winner</span><span class="toast-good">${TW.escapeHtml(data.winner)} ${data.winnerPnl >= 0 ? '+' : ''}$${Number(data.winnerPnl).toLocaleString()}</span></div>` : ''}
        <div class="toast-row"><span>Rating Change</span><span class="${ratingClass}">${data.ratingChange >= 0 ? '+' : ''}${data.ratingChange} → ${data.newRating}</span></div>
      </div>
      ${data.matchId ? `<button class="toast-replay-btn">View Replay</button>` : ''}
      <div class="toast-progress"><div class="toast-progress-fill"></div></div>
    `;
    document.body.appendChild(toast);

    const dismiss = () => toast.remove();
    toast.querySelector('.toast-close').addEventListener('click', dismiss);
    toast.querySelector('.toast-replay-btn')?.addEventListener('click', () => {
      window.location.href = `/replay?match=${data.matchId}`;
    });
    setTimeout(dismiss, 15000);
  }

  // Opening the bell used to immediately mark everything read (a blanket
  // "all:true" call) - that made a New/All split meaningless, since by the
  // time you could look at "New" it was already empty. Reading now happens
  // per-item (click a notification, or Mark all read) instead.
  function toggleNotifPanel() {
    const existing = document.getElementById('twNotifPanel');
    if (existing) {
      existing.remove();
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'twNotifPanel';
    panel.className = 'tw-notif-panel';
    panel.innerHTML = `
      <div class="notif-header">
        <span class="notif-header-title">Notifications</span>
        <div class="notif-header-actions">
          <button type="button" id="twNotifMarkAllBtn">Mark all read</button>
          <button type="button" id="twNotifClearAllBtn">Clear all</button>
        </div>
      </div>
      <div class="notif-tabs">
        <button type="button" class="notif-tab active" data-tab="new">New <span class="notif-tab-count" id="twNotifNewCount">0</span></button>
        <button type="button" class="notif-tab" data-tab="all">All</button>
      </div>
      <div class="notif-list" id="twNotifList"></div>
    `;
    document.body.appendChild(panel);
    currentNotifTab = 'new';
    renderNotifList();

    panel.querySelectorAll('.notif-tab').forEach((tab) => tab.addEventListener('click', (e) => { e.stopPropagation(); switchNotifTab(tab.dataset.tab); }));
    document.getElementById('twNotifMarkAllBtn').addEventListener('click', (e) => { e.stopPropagation(); markAllRead(); });
    document.getElementById('twNotifClearAllBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Clear all notifications? This cannot be undone.')) clearAllNotifications();
    });

    const close = (e) => {
      if (!panel.contains(e.target) && e.target.id !== 'twNotifBtn') {
        panel.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  async function loadNotificationHistory() {
    try {
      const data = await TW.api('/api/notifications');
      notifications.length = 0;
      data.notifications.forEach((n) => notifications.push({ id: n.id, type: n.type, message: n.data?.message || '', at: n.createdAt, fromPlayerId: n.fromPlayerId, data: n.data, read: n.read }));
      updateBadge();
      if (document.getElementById('twNotifPanel')) renderNotifList();
    } catch (e) {
      // Not fatal - bell just starts empty until a live notification arrives.
    }
  }

  let notifInitDone = false;
  function initNotifications() {
    if (notifInitDone) return;
    if (!window.TW || !TW.getToken || !TW.getToken()) return;
    if (!TW.connectSocket) return;
    notifInitDone = true;
    loadNotificationHistory();
    const socket = TW.connectSocket();
    socket.on('notification', (payload) => {
      notifications.unshift({ ...payload, id: `live-${Date.now()}-${Math.random().toString(36).slice(2)}`, read: false });
      if (notifications.length > 20) notifications.length = 20;
      updateBadge();
      if (document.getElementById('twNotifPanel')) renderNotifList();
      // FIX: match summary gets its own rich bottom-right toast (rank/P&L/
      // winner/rating) on top of the normal bell entry - reaches the player
      // wherever they are, including a match they've already re-joined,
      // since this is the same global notification pipe as every other type.
      if (payload.type === 'match_summary' && payload.data) showMatchSummaryToast(payload.data);
      else TW.toast(payload.message, 'info');
      if (window.TW && TW.Lottie) {
        if (payload.type === 'rank_up') TW.Lottie.play('rankup');
        else if (payload.type === 'battlepass_tier') TW.Lottie.play('battlepass');
        else if (payload.type === 'tournament_champion') TW.Lottie.play('win');
      }
    });
    // Instant admin broadcast (Communications > Announcements > Broadcast Now).
    // Only reaches logged-in visitors already connected at broadcast time -
    // the /api/announcements/active fetch on page load (home.js) is what
    // covers anonymous visitors and anyone who loads the page later.
    socket.on('announcement:new', (payload) => {
      if (window.TW && TW.renderAnnouncement) TW.renderAnnouncement(payload);
      else TW.toast(`${payload.title}${payload.message ? ' — ' + payload.message : ''}`, payload.type === 'warning' ? 'warning' : 'info');
    });
  }

  function openDrawer(active) {
    const existing = document.getElementById('twNavDrawer');
    if (existing) existing.remove();

    const loggedIn = Boolean(TW.getPlayer());
    const overlay = document.createElement('div');
    overlay.id = 'twNavDrawer';
    overlay.className = 'tw-nav-drawer';
    overlay.innerHTML = `
      <div class="drawer-panel">
        ${NAV_LINKS.map((l) => `<a href="${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`).join('')}
        <a href="/profile">Profile</a>
        <a href="/help">Help</a>
        <div class="tw-account-dropdown-divider"></div>
        <button type="button" class="tw-account-dropdown-item" id="twDrawerMuteBtn">🔊 Mute sounds</button>
        <a href="#" id="twDrawerAuthLink" class="tw-account-dropdown-item tw-logout-item">${loggedIn ? 'Log out' : 'Log in'}</a>
      </div>
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);

    const drawerMuteBtn = overlay.querySelector('#twDrawerMuteBtn');
    const refreshDrawerMuteIcon = () => {
      const s = TW.Sound ? TW.Sound.getSettings() : { muted: false };
      drawerMuteBtn.textContent = s.muted ? '🔇 Unmute sounds' : '🔊 Mute sounds';
    };
    refreshDrawerMuteIcon();
    drawerMuteBtn.addEventListener('click', () => {
      const s = TW.Sound.getSettings();
      TW.Sound.updateSettings({ muted: !s.muted });
      refreshDrawerMuteIcon();
    });

    overlay.querySelector('#twDrawerAuthLink').addEventListener('click', (e) => {
      if (TW.getPlayer()) {
        e.preventDefault();
        overlay.remove();
        TW.logout();
      } else {
        overlay.remove();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', renderNav);
  TW.renderNav = renderNav;
})();
