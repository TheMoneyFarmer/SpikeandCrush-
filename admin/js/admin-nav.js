'use strict';

window.Admin = window.Admin || {};

(function () {
  const NAV_SECTIONS = [
    { group: 'Dashboard', icon: '📊', items: [
      { key: 'dashboard', label: 'Overview', href: '/dashboard.html' },
      { key: 'realtime', label: 'Real-time Monitor', href: '/realtime.html' },
    ]},
    { group: 'Players', icon: '👥', items: [
      { key: 'players', label: 'All Players', href: '/players.html' },
      { key: 'reports', label: 'Reports', href: '/players.html?tab=reports' },
    ]},
    { group: 'Matches', icon: '⚔️', items: [
      { key: 'matches-live', label: 'Live Matches', href: '/matches.html?tab=live' },
      { key: 'matches-history', label: 'Match History', href: '/matches.html?tab=history' },
      { key: 'matches-flagged', label: 'Flagged Matches', href: '/matches.html?tab=flagged' },
    ]},
    { group: 'Tournaments', icon: '🏆', items: [
      { key: 'tournaments-active', label: 'Active Tournaments', href: '/tournaments.html?tab=active' },
      { key: 'tournaments-create', label: 'Create Tournament', href: '/tournaments.html?tab=create' },
      { key: 'tournaments-history', label: 'Tournament History', href: '/tournaments.html?tab=history' },
      { key: 'tournaments-sponsors', label: 'Sponsors / Prizes', href: '/tournaments.html?tab=sponsors' },
    ]},
    { group: 'Monetisation', icon: '💰', items: [
      { key: 'mon-overview', label: 'Revenue Overview', href: '/monetisation.html?tab=overview' },
      { key: 'mon-transactions', label: 'Coin Transactions', href: '/monetisation.html?tab=transactions' },
      { key: 'mon-battlepass', label: 'Battle Pass', href: '/monetisation.html?tab=battlepass' },
      { key: 'mon-shop', label: 'Cosmetic Shop', href: '/monetisation.html?tab=shop' },
      { key: 'mon-withdrawals', label: 'Withdrawals', href: '/monetisation.html?tab=withdrawals' },
      { key: 'mon-brokers', label: 'Broker Partners', href: '/monetisation.html?tab=brokers' },
      { key: 'mon-coaching', label: 'Coaching Sessions', href: '/monetisation.html?tab=coaching' },
    ]},
    { group: 'Analytics', icon: '📈', items: [
      { key: 'an-players', label: 'Player Analytics', href: '/analytics.html?tab=players' },
      { key: 'an-matches', label: 'Match Analytics', href: '/analytics.html?tab=matches' },
      { key: 'an-revenue', label: 'Revenue Analytics', href: '/analytics.html?tab=revenue' },
      { key: 'an-retention', label: 'Retention Analytics', href: '/analytics.html?tab=retention' },
      { key: 'an-geo', label: 'Geographic Analytics', href: '/analytics.html?tab=geo' },
    ]},
    { group: 'Game Config', icon: '🎮', items: [
      { key: 'cfg-match', label: 'Match Settings', href: '/game-config.html?tab=match' },
      { key: 'cfg-instruments', label: 'Instrument Config', href: '/game-config.html?tab=instruments' },
      { key: 'cfg-cards', label: 'Sabotage Cards', href: '/game-config.html?tab=cards' },
      { key: 'cfg-rating', label: 'War Rating Config', href: '/game-config.html?tab=rating' },
      { key: 'cfg-daily', label: 'Daily Challenges', href: '/game-config.html?tab=daily' },
      { key: 'cfg-async', label: 'Async Daily Setup', href: '/game-config.html?tab=async' },
    ]},
    { group: 'Branding', icon: '🎨', items: [
      { key: 'brand-logo', label: 'Logo and Assets', href: '/branding.html?tab=logo' },
      { key: 'brand-colour', label: 'Colour Theme', href: '/branding.html?tab=colour' },
      { key: 'brand-copy', label: 'UI Text and Copy', href: '/branding.html?tab=copy' },
      { key: 'brand-email', label: 'Email Templates', href: '/branding.html?tab=email' },
      { key: 'brand-social', label: 'Social Media Assets', href: '/branding.html?tab=social' },
    ]},
    { group: 'Communications', icon: '📣', items: [
      { key: 'comm-announcements', label: 'Announcements', href: '/communications.html?tab=announcements' },
      { key: 'comm-push', label: 'Push / In-App Notifications', href: '/communications.html?tab=push' },
      { key: 'comm-email', label: 'Email Campaigns', href: '/communications.html?tab=email' },
      { key: 'comm-direct', label: 'In-Game Messages', href: '/communications.html?tab=direct' },
    ]},
    { group: 'System', icon: '🔧', items: [
      { key: 'sys-health', label: 'Server Health', href: '/system.html?tab=health' },
      { key: 'sys-api', label: 'API Usage', href: '/system.html?tab=api' },
      { key: 'sys-errors', label: 'Error Logs', href: '/system.html?tab=errors' },
      { key: 'sys-db', label: 'Database Stats', href: '/system.html?tab=db' },
    ]},
  ];

  function render() {
    const mount = document.getElementById('adminSidebar');
    if (!mount) return;
    const active = mount.dataset.active || '';
    mount.innerHTML = `
      <div class="admin-sidebar-header">
        <div class="admin-logo"><span class="lg-s">Spike</span> &amp; <span class="lg-c">Crush</span></div>
        <div class="admin-logo-sub">Admin Panel</div>
      </div>
      <nav style="flex:1;padding-bottom:12px;">
        ${NAV_SECTIONS.map((section) => `
          <div class="admin-nav-group">${section.icon} ${section.group}</div>
          ${section.items.map((item) => `
            <a href="${item.href}" class="admin-nav-item ${item.key === active ? 'active' : ''}">${item.label}</a>
          `).join('')}
        `).join('')}
      </nav>
      <div class="admin-sidebar-footer">
        <div class="admin-username" id="admSidebarUsername">—</div>
        <div id="admSidebarLastLogin">Last login: —</div>
        <button class="admin-logout-btn" id="admChangePasswordBtn" style="margin-bottom:6px;">Change Password</button>
        <button class="admin-logout-btn" id="admLogoutBtn">Log out</button>
      </div>
    `;
    mount.querySelector('#admLogoutBtn').addEventListener('click', Admin.logout);
    mount.querySelector('#admChangePasswordBtn').addEventListener('click', Admin.openChangePasswordModal);

    const me = Admin.getMe();
    if (me) {
      mount.querySelector('#admSidebarUsername').textContent = me.username;
      if (me.lastLogin) mount.querySelector('#admSidebarLastLogin').textContent = `Last login: ${Admin.formatDate(me.lastLogin)}`;
    }
  }

  function renderTopbar(title) {
    const mount = document.getElementById('adminTopbar');
    if (!mount) return;
    mount.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;">
        <button class="admin-hamburger" id="admHamburger">☰</button>
        <h1>${title}</h1>
      </div>
      <div class="admin-topbar-right">
        <span id="admClock" class="mono"></span>
        <span><span class="status-dot" id="admStatusDot"></span> <span id="admStatusLabel">All systems normal</span></span>
        <span id="admTopbarUsername"></span>
      </div>
    `;
    const clockEl = mount.querySelector('#admClock');
    const tick = () => { clockEl.textContent = new Date().toLocaleString(); };
    tick();
    setInterval(tick, 1000);
    mount.querySelector('#admHamburger').addEventListener('click', () => {
      document.getElementById('adminSidebar')?.classList.toggle('open');
    });
    const me = Admin.getMe();
    if (me) mount.querySelector('#admTopbarUsername').textContent = me.username;
  }

  Admin.renderNav = render;
  Admin.renderTopbar = renderTopbar;
})();
