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
    { key: 'tournaments', label: 'Tournaments', href: '/competitions' },
    { key: 'cards', label: 'Cards', href: '/cards' },
    { key: 'shop', label: 'Shop', href: '/shop' },
    { key: 'wallet', label: 'Wallet', href: '/wallet' },
    { key: 'battle-pass', label: 'Battle Pass', href: '/battle-pass' },
    { key: 'coaching', label: 'Coaching', href: '/coaching' },
    { key: 'settings', label: 'Settings', href: '/settings' },
  ];

  // Icon names from js/icons.js.
  const NOTIF_ICON = {
    rank_up: 'trophy',
    comp_started: 'flag',
    comp_ending_soon: 'clock',
    comp_ended: 'trophy',
    comp_loss_limit: 'lock',
    comp_void: 'refresh',
    match_starting: 'clock',
    battlepass_tier: 'star',
    battlepass_premium: 'crown',
    shop_purchase: 'bag',
    coin_purchase: 'coin',
    coaching_booked: 'calendar',
    tournament_advance: 'swords',
    tournament_eliminated: 'close',
    tournament_draw: 'users',
    friend_request: 'users',
    friend_accepted: 'check',
    friend_won_match: 'trophy',
    match_kicked: 'alert',
    match_voided: 'alert',
    match_summary: 'swords',
    invite_declined: 'close',
    invite_expired: 'clock',
    system: 'megaphone',
    tournament_champion: 'crown',
    prize_claim_processing: 'info',
    prize_claim_paid: 'check',
    prize_claim_rejected: 'alert',
  };
  const ic = (name, size = 20) => (TW.icon ? TW.icon(name, { size }) : '');

  // ONE console-style top bar for every page (Nov 2026 redesign): logo, six
  // main links, then coins, bell and an account menu holding everything else.
  // Keeps every id TW.updateHeader() in main.js reads (headerUsername,
  // headerCoinWrap, headerCoinBalance, headerAuthLink, headerTierBadge,
  // headerRating, twNavIdentity, twNavIdentityAvatar, twNavProgressFill,
  // twLogoutBtn) plus the notification/friends ids wired below.
  const MAIN_LINKS = [
    { key: 'home', label: 'Play', href: '/play' },
    { key: 'tournaments', label: 'Compete', href: '/competitions' },
    { key: 'leaderboard', label: 'Ranks', href: '/leaderboard' },
    { key: 'cards', label: 'Cards', href: '/cards' },
    { key: 'shop', label: 'Shop', href: '/shop' },
    { key: 'wallet', label: 'Wallet', href: '/wallet' },
  ];
  const AVATAR_MENU = [
    { key: 'profile', label: 'Profile', href: '/profile', icon: 'user' },
    { key: 'battle-pass', label: 'Battle Pass', href: '/battle-pass', icon: 'star' },
    { key: 'coaching', label: 'Coaching', href: '/coaching', icon: 'calendar' },
    { key: 'settings', label: 'Settings', href: '/settings', icon: 'settings' },
    { key: 'help', label: 'Help', href: '/help', icon: 'help' },
  ];

  function renderConsoleBar(container, active) {
    container.innerHTML = `
      <nav class="cn-bar" aria-label="Main">
        <a href="/play" class="cn-logo" aria-label="Spike and Crush, play"><span class="s">Spike</span><span class="a">&amp;</span><span class="c">Crush</span></a>
        <div class="cn-links">${MAIN_LINKS.map((l) => `<a href="${l.href}" class="cn-link${l.key === active ? ' active' : ''}"${l.key === active ? ' aria-current="page"' : ''}>${l.label}</a>`).join('')}</div>
        <div class="cn-right">
          <a href="/wallet" id="headerCoinWrap" class="cn-coins hidden" aria-label="Coin balance">${ic('coin', 18)}<span id="headerCoinBalance">0</span></a>
          <button type="button" class="cn-icon" id="twNotifBtn" aria-label="Notifications">${ic('bell')}<span id="twNotifBadge" class="cn-dot hidden" aria-hidden="true"></span></button>
          <a href="/?login=required" id="headerAuthLink" class="cn-login hidden">Log in</a>
          <div class="cn-account hidden" id="twNavIdentity">
            <button type="button" class="cn-avatar" id="lbAvatarBtn" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">
              <span id="twNavIdentityAvatar"></span>${ic('chevronDown', 16)}
            </button>
            <div class="cn-menu hidden" id="lbAvatarMenu" role="menu">
              <div class="cn-menu-head">
                <span class="cn-menu-name"><span id="headerUsername"></span><span id="headerTierBadge" class="hidden"></span></span>
                <span class="cn-menu-rating">Rating <span id="headerRating"></span></span>
                <span class="cn-progress"><span id="twNavProgressFill"></span></span>
              </div>
              ${AVATAR_MENU.map((m) => `<a role="menuitem" href="${m.href}"${m.key === active ? ' aria-current="page" class="active"' : ''}>${ic(m.icon, 18)}<span>${m.label}</span></a>`).join('')}
              <button type="button" role="menuitem" id="twFriendsToggleBtn">${ic('users', 18)}<span>Friends</span><span id="twFriendsOnlineBadge" class="tw-friends-online-badge hidden">0</span></button>
              <button type="button" role="menuitem" id="cnMuteBtn"></button>
              <button type="button" role="menuitem" id="twLogoutBtn">${ic('logout', 18)}<span>Log out</span></button>
            </div>
          </div>
          <button type="button" class="cn-icon cn-burger" id="twHamburgerBtn" aria-label="Menu">${ic('menu')}</button>
        </div>
      </nav>
    `;
    const btn = container.querySelector('#lbAvatarBtn');
    const menu = container.querySelector('#lbAvatarMenu');
    const setOpen = (open) => {
      menu.classList.toggle('hidden', !open);
      btn.setAttribute('aria-expanded', String(open));
      if (open) { const first = menu.querySelector('a,button'); if (first) first.focus(); }
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(menu.classList.contains('hidden'));
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.classList.contains('hidden')) { setOpen(false); btn.focus(); }
    });
    // Arrow keys move through the menu (keyboard / controller friendly).
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...menu.querySelectorAll('a,button')];
      const i = items.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
    });
    const muteBtn = container.querySelector('#cnMuteBtn');
    const paintMute = () => {
      const s = TW.Sound ? TW.Sound.getSettings() : { muted: false };
      muteBtn.innerHTML = s.muted ? `${ic('sound', 18)}<span>Unmute sounds</span>` : `${ic('mute', 18)}<span>Mute sounds</span>`;
    };
    paintMute();
    muteBtn.addEventListener('click', () => {
      if (!TW.Sound) return;
      TW.Sound.updateSettings({ muted: !TW.Sound.getSettings().muted });
      paintMute();
    });
  }

  const notifications = [];
  let currentNotifTab = 'new';

  function renderNav() {
    const container = document.getElementById('twNav');
    if (!container) return;
    const active = container.dataset.active || '';
    renderConsoleBar(container, active);
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

  const timeAgo = (at) => (TW.timeAgo ? TW.timeAgo(at) : '');

  function notifItemHtml(n) {
    const icon = `<span class="notif-item-icon">${ic(NOTIF_ICON[n.type] || 'bell', 16)}</span>`;
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
      : `<div class="notif-empty">${currentNotifTab === 'new' ? 'All caught up' : 'No notifications yet'}</div>`;

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
        <span class="toast-icon">${ic('swords', 18)}</span>
        <span class="toast-title">Match Summary — ${TW.escapeHtml(data.mode || '')}</span>
        <button class="toast-close" aria-label="Close">${ic('close', 16)}</button>
      </div>
      <div class="toast-content">
        <div class="toast-row"><span>Your Rank</span><span class="${pnlClass}">${rankLabel}</span></div>
        <div class="toast-row"><span>Your P&amp;L</span><span class="${pnlClass}">${data.yourPnl >= 0 ? '+' : ''}$${Number(data.yourPnl).toLocaleString()}</span></div>
        ${data.winner ? `<div class="toast-row"><span>Winner</span><span class="toast-good">${TW.escapeHtml(data.winner)}</span></div>` : ''}
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
    if (!window.TW || !TW.isLoggedIn || !TW.isLoggedIn()) return;
    if (!TW.connectSocket) return;
    notifInitDone = true;
    loadNotificationHistory();
    const socket = TW.connectSocket();
    socket.on('notification', (payload) => {
      notifications.unshift({ ...payload, id: `live-${Date.now()}-${Math.random().toString(36).slice(2)}`, read: false });
      if (notifications.length > 20) notifications.length = 20;
      updateBadge();
      if (TW.Sound) TW.Sound.play('notification');
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
    // the /api/announcements/active fetch on page load (lobby-home.js) is what
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
        <button type="button" class="tw-account-dropdown-item" id="twDrawerMuteBtn">Mute sounds</button>
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
      drawerMuteBtn.innerHTML = s.muted ? `${ic('sound', 18)} Unmute sounds` : `${ic('mute', 18)} Mute sounds`;
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
