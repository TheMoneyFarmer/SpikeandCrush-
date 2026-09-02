'use strict';

window.TW = window.TW || {};

// Renders the shared premium nav bar into <div id="twNav" data-active="...">.
// Reuses the original header element ids (headerUsername, headerCoinWrap,
// headerCoinBalance, headerAuthLink) so TW.updateHeader() in main.js keeps
// working unchanged against the new markup.
(function () {
  const NAV_LINKS = [
    { key: 'home', label: 'Home', href: '/' },
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
    tournament_champion: '🏆',
  };

  const notifications = [];
  let unreadCount = 0;

  function renderNav() {
    const container = document.getElementById('twNav');
    if (!container) return;
    const active = container.dataset.active || '';

    const linksHtml = NAV_LINKS.map(
      (l) => `<a href="${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`
    ).join('');

    container.innerHTML = `
      <nav class="tw-navbar">
        <a href="/" class="tw-logo-link">
          <div class="sc-logo-wrapper nav-logo">
            <div class="sc-logo">
              <span class="sc-s1">S</span><span class="sc-p">P</span><span class="sc-i">I</span><span class="sc-k">K</span><span class="sc-e">E</span><span class="sc-amp">&amp;</span><span class="sc-c">C</span><span class="sc-r">R</span><span class="sc-u">U</span><span class="sc-s2">S</span><span class="sc-h">H</span>
            </div>
          </div>
        </a>
        <div class="tw-nav-links">${linksHtml}</div>
        <div class="tw-nav-right">
          <a href="/profile" id="headerUsername" class="text-secondary" style="text-decoration:none;"></a>
          <span id="headerTierBadge" class="pill hidden"></span>
          <button type="button" class="help-btn" data-help="war-rating" title="What is War Rating?">?</button>
          <a href="/wallet" id="headerCoinWrap" class="tw-coin-balance hidden">🪙 <span id="headerCoinBalance">0</span></a>
          <button type="button" class="help-btn" data-help="coins" title="What are coins?">?</button>
          <button type="button" class="tw-nav-icon-btn" id="twMuteBtn" title="Mute sounds">🔊</button>
          <button type="button" class="tw-nav-icon-btn" id="twNotifBtn" title="Notifications" style="position:relative;">🔔<span id="twNotifBadge" class="tw-notif-badge hidden">0</span></button>
          <button type="button" class="tw-nav-icon-btn tw-friends-toggle-btn" id="twFriendsToggleBtn" title="Friends (0)">👥<span id="twFriendsOnlineBadge" class="tw-friends-online-badge hidden">0</span></button>
          <a href="#" id="headerAuthLink" class="btn btn-outline">Log in</a>
          <button type="button" class="tw-nav-icon-btn tw-hamburger" id="twHamburgerBtn" title="Menu">☰</button>
        </div>
      </nav>
    `;

    wireInteractions(container, active);
    if (window.TW.updateHeader) window.TW.updateHeader();
  }

  function wireInteractions(container, active) {
    const muteBtn = container.querySelector('#twMuteBtn');
    function refreshMuteIcon() {
      const s = TW.Sound ? TW.Sound.getSettings() : { muted: false };
      muteBtn.textContent = s.muted ? '🔇' : '🔊';
    }
    if (muteBtn) {
      refreshMuteIcon();
      muteBtn.addEventListener('click', () => {
        const s = TW.Sound.getSettings();
        TW.Sound.updateSettings({ muted: !s.muted });
        refreshMuteIcon();
      });
    }

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

    initNotifications();
  }

  function updateBadge() {
    const badge = document.getElementById('twNotifBadge');
    if (!badge) return;
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
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
    return `<div class="notif-item" data-notif-type="${n.type}">${icon} ${TW.escapeHtml ? TW.escapeHtml(n.message) : n.message}${actionsHtml}</div>`;
  }

  function wireNotifPanelActions(panel) {
    panel.querySelectorAll('[data-accept-req]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await TW.api(`/api/friends/${btn.dataset.acceptReq}/accept`, { method: 'POST' });
          TW.toast('Friend added!', 'info');
          btn.closest('.notif-item').remove();
          if (window.TW && TW.FriendsPanel) TW.FriendsPanel.refresh();
        } catch (e) {
          TW.toast(e.message, 'danger');
        }
      });
    });
    panel.querySelectorAll('[data-decline-req]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await TW.api(`/api/friends/${btn.dataset.declineReq}/decline`, { method: 'POST' });
          btn.closest('.notif-item').remove();
        } catch (e) {
          TW.toast(e.message, 'danger');
        }
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

  function toggleNotifPanel() {
    const existing = document.getElementById('twNotifPanel');
    if (existing) {
      existing.remove();
      return;
    }
    unreadCount = 0;
    updateBadge();
    if (window.TW && TW.api) TW.api('/api/notifications/read', { method: 'POST', body: { all: true } }).catch(() => {});

    const panel = document.createElement('div');
    panel.id = 'twNotifPanel';
    panel.className = 'tw-notif-panel';
    panel.innerHTML = notifications.length ? notifications.map(notifItemHtml).join('') : '<div class="notif-empty">No notifications yet</div>';
    document.body.appendChild(panel);
    wireNotifPanelActions(panel);

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
      // Normalize to the same shape the live 'notification' socket event uses
      // (type/message/at/fromPlayerId/data) so notifItemHtml renders both alike.
      data.notifications.forEach((n) => notifications.push({ type: n.type, message: n.data?.message || '', at: n.createdAt, fromPlayerId: n.fromPlayerId, data: n.data }));
      unreadCount = data.unreadCount;
      updateBadge();
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
      notifications.unshift(payload);
      if (notifications.length > 20) notifications.length = 20;
      unreadCount += 1;
      updateBadge();
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

    const overlay = document.createElement('div');
    overlay.id = 'twNavDrawer';
    overlay.className = 'tw-nav-drawer';
    overlay.innerHTML = `
      <div class="drawer-panel">
        ${NAV_LINKS.map((l) => `<a href="${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`).join('')}
        <a href="/profile">Profile</a>
        <a href="/help">Help</a>
      </div>
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  document.addEventListener('DOMContentLoaded', renderNav);
  TW.renderNav = renderNav;
})();
