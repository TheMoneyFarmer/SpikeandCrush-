'use strict';

window.Admin = window.Admin || {};

(function () {
  const NAV_SECTIONS = [
    { group: 'Overview', icon: 'home', items: [
      { key: 'dashboard', label: 'Overview', href: '/dashboard.html' },
      { key: 'realtime', label: 'Real-time Monitor', href: '/realtime.html' },
    ]},
    { group: 'Players', icon: 'users', items: [
      { key: 'players', label: 'All Players', href: '/players.html' },
      { key: 'reports', label: 'Reports', href: '/players.html?tab=reports' },
    ]},
    { group: 'Matches', icon: 'swords', items: [
      { key: 'matches-live', label: 'Live Matches', href: '/matches.html?tab=live' },
      { key: 'matches-history', label: 'Match History', href: '/matches.html?tab=history' },
      { key: 'matches-flagged', label: 'Flagged Matches', href: '/matches.html?tab=flagged' },
    ]},
    { group: 'Tournaments', icon: 'trophy', items: [
      { key: 'tournaments-active', label: 'Active Tournaments', href: '/tournaments.html?tab=active' },
      { key: 'tournaments-create', label: 'Create Tournament', href: '/tournaments.html?tab=create' },
      { key: 'tournaments-history', label: 'Tournament History', href: '/tournaments.html?tab=history' },
      { key: 'tournaments-sponsors', label: 'Sponsors / Prizes', href: '/tournaments.html?tab=sponsors' },
      { key: 'competitions', label: 'Competitions', href: '/competitions.html' },
      { key: 'listings', label: 'Partner Listings', href: '/listings.html' },
    ]},
    { group: 'Sponsors', icon: 'handshake', items: [
      { key: 'sponsors', label: 'Sponsors', href: '/sponsors.html' },
      { key: 'sponsors-leads', label: 'Partner Requests', href: '/sponsors.html?tab=leads' },
      { key: 'lobby-settings', label: 'Lobby Settings', href: '/sponsors.html?tab=lobby' },
    ]},
    { group: 'Economy', icon: 'coin', items: [
      { key: 'mon-overview', label: 'Revenue Overview', href: '/monetisation.html?tab=overview' },
      { key: 'mon-transactions', label: 'Coin Transactions', href: '/monetisation.html?tab=transactions' },
      { key: 'mon-battlepass', label: 'Battle Pass', href: '/monetisation.html?tab=battlepass' },
      { key: 'mon-shop', label: 'Cosmetic Shop', href: '/monetisation.html?tab=shop' },
      { key: 'mon-withdrawals', label: 'Prize Claims (archive)', href: '/monetisation.html?tab=withdrawals' },
      { key: 'mon-brokers', label: 'Broker Partners', href: '/monetisation.html?tab=brokers' },
      { key: 'mon-partners', label: 'Referral Partners', href: '/partners.html' },
    ]},
    { group: 'Support', icon: 'chat', items: [
      { key: 'support-inbox', label: 'Inbox', href: '/support.html', badge: 'support' },
      { key: 'support-kb', label: 'Knowledge Base', href: '/support-kb.html' },
      { key: 'support-canned', label: 'Canned Responses', href: '/support-canned.html' },
      { key: 'support-analytics', label: 'Support Analytics', href: '/support-analytics.html' },
    ]},
    { group: 'Analytics', icon: 'chart', items: [
      { key: 'an-players', label: 'Player Analytics', href: '/analytics.html?tab=players' },
      { key: 'an-matches', label: 'Match Analytics', href: '/analytics.html?tab=matches' },
      { key: 'an-revenue', label: 'Revenue Analytics', href: '/analytics.html?tab=revenue' },
      { key: 'an-retention', label: 'Retention Analytics', href: '/analytics.html?tab=retention' },
      { key: 'an-geo', label: 'Geographic Analytics', href: '/analytics.html?tab=geo' },
    ]},
    { group: 'Game Config', icon: 'sliders', items: [
      { key: 'cfg-match', label: 'Match Settings', href: '/game-config.html?tab=match' },
      { key: 'cfg-instruments', label: 'Instrument Config', href: '/game-config.html?tab=instruments' },
      { key: 'cfg-cards', label: 'Sabotage Cards', href: '/game-config.html?tab=cards' },
      { key: 'cfg-rating', label: 'War Rating Config', href: '/game-config.html?tab=rating' },
      { key: 'cfg-daily', label: 'Daily Challenges', href: '/game-config.html?tab=daily' },
      { key: 'cfg-async', label: 'Async Daily Setup', href: '/game-config.html?tab=async' },
    ]},
    { group: 'Fire Gameplay', icon: 'flame', items: [
      { key: 'fire-market', label: 'Market Curation', href: '/fire.html?tab=market' },
      { key: 'fire-monitor', label: 'Fire Monitor', href: '/fire.html?tab=monitor' },
      { key: 'fire-settings', label: 'Cards, Heat, Missions', href: '/fire.html?tab=settings' },
      { key: 'fire-progression', label: 'Progression and Unlocks', href: '/fire.html?tab=progression' },
      { key: 'fire-ranksplit', label: 'Rank-Split Lobbies', href: '/fire.html?tab=ranksplit' },
      { key: 'fire-discover', label: 'Discover', href: '/fire.html?tab=discover' },
    ]},
    { group: 'Branding', icon: 'brush', items: [
      { key: 'brand-logo', label: 'Logo and Assets', href: '/branding.html?tab=logo' },
      { key: 'brand-colour', label: 'Colour Theme', href: '/branding.html?tab=colour' },
      { key: 'brand-copy', label: 'UI Text and Copy', href: '/branding.html?tab=copy' },
      { key: 'brand-email', label: 'Email Templates', href: '/branding.html?tab=email' },
      { key: 'brand-social', label: 'Social Media Assets', href: '/branding.html?tab=social' },
    ]},
    { group: 'Communications', icon: 'megaphone', items: [
      { key: 'comm-announcements', label: 'Announcements', href: '/communications.html?tab=announcements' },
      { key: 'comm-push', label: 'Push / In-App Notifications', href: '/communications.html?tab=push' },
      { key: 'comm-email', label: 'Email Campaigns', href: '/communications.html?tab=email' },
      { key: 'comm-direct', label: 'In-Game Messages', href: '/communications.html?tab=direct' },
    ]},
    { group: 'System', icon: 'server', items: [
      { key: 'sys-health', label: 'Server Health', href: '/system.html?tab=health' },
      { key: 'sys-api', label: 'API Usage', href: '/system.html?tab=api' },
      { key: 'sys-errors', label: 'Error Logs', href: '/system.html?tab=errors' },
      { key: 'sys-db', label: 'Database Stats', href: '/system.html?tab=db' },
    ]},
  ];

  // Line icons, 24px grid, drawn in currentColor (no emoji in the UI).
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
    swords: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/>',
    handshake: '<path d="m11 17 2 2a1 1 0 0 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 0 0 3-3l-3.9-3.9a2 2 0 0 0-2.8 0l-.9.9a1 1 0 0 1-3-3l2.8-2.8a3 3 0 0 1 3.6-.4l.4.3a2 2 0 0 0 1.8.3L21 4"/><path d="m21 3 1 11h-2M3 3 2 14l6.5 6.5a1 1 0 0 0 3-3M3 4h8"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1 1.1-1.8 2.5-1.8s2.5.8 2.5 1.8-1.1 1.6-2.5 1.9-2.5.9-2.5 1.9 1.1 1.8 2.5 1.8 2.5-.8 2.5-1.8"/>',
    chat: '<path d="M21 12a8 8 0 0 1-12 7l-6 2 2-6a8 8 0 1 1 16-3z"/>',
    chart: '<path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    flame: '<path d="M12 22c4 0 7-3 7-7 0-5-5-7-5-12-3 2-5 5-5 8-1-1-2-2-2-4-1 2-2 4-2 7 0 4 3 8 7 8z"/>',
    brush: '<path d="m9 11-6 6v4h4l6-6M14 6l4 4M12 8l7-7 4 4-7 7"/>',
    megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1zM17 9a4 4 0 0 1 0 6"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  };
  const svg = (k, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ''}</svg>`;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const OPEN_KEY = 'adm_nav_open';
  const readOpen = () => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); } catch (e) { return {}; } };
  const saveOpen = (o) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(o)); } catch (e) { /* not remembered */ } };

  function render() {
    const mount = document.getElementById('adminSidebar');
    if (!mount) return;
    const active = mount.dataset.active || '';
    const open = readOpen();
    mount.innerHTML = `
      <div class="admin-sidebar-header">
        <a class="admin-logo" href="/dashboard.html"><span class="lg-s">Spike</span>&amp;<span class="lg-c">Crush</span></a>
        <span class="admin-logo-sub">Admin</span>
      </div>
      <label class="adm-nav-search">${svg('search', 14)}<input type="search" id="admNavSearch" placeholder="Search the menu" aria-label="Search the menu" autocomplete="off"><kbd>/</kbd></label>
      <nav class="adm-nav" aria-label="Admin sections">
        ${NAV_SECTIONS.map((section, gi) => {
          const hasActive = section.items.some((i) => i.key === active);
          const isOpen = hasActive || open[section.group] === true || (section.items.length <= 2 && open[section.group] !== false);
          return `<div class="adm-group${isOpen ? ' open' : ''}${hasActive ? ' has-active' : ''}" data-group="${esc(section.group)}">
            <button type="button" class="admin-nav-group" aria-expanded="${isOpen}" aria-controls="admGroup${gi}">${svg(section.icon)}<span>${esc(section.group)}</span><span class="adm-group-badge" data-group-badge="${esc(section.group)}"></span><span class="adm-chev">${svg('chevron', 14)}</span></button>
            <div class="adm-group-items" id="admGroup${gi}">
              ${section.items.map((item) => `<a href="${item.href}" class="admin-nav-item ${item.key === active ? 'active' : ''}" ${item.key === active ? 'aria-current="page"' : ''} data-label="${esc(item.label.toLowerCase())}"><span>${esc(item.label)}</span>${item.badge ? '<span class="sup-badge-nav" id="admSupportBadge" aria-label="conversations waiting for a human"></span>' : ''}${item.key === 'reports' ? '<span class="sup-badge-nav adm-badge-alert" id="admReportsBadge" aria-label="open player reports"></span>' : ''}</a>`).join('')}
            </div>
          </div>`;
        }).join('')}
      </nav>
    `;
    mount.querySelectorAll('.admin-nav-group').forEach((btn) => btn.addEventListener('click', () => {
      const g = btn.closest('.adm-group');
      const now = !g.classList.contains('open');
      g.classList.toggle('open', now);
      btn.setAttribute('aria-expanded', String(now));
      const o = readOpen();
      o[g.dataset.group] = now;
      saveOpen(o);
    }));
    const search = mount.querySelector('#admNavSearch');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      mount.querySelectorAll('.adm-group').forEach((g) => {
        let any = false;
        g.querySelectorAll('.admin-nav-item').forEach((a) => {
          const hit = !q || a.dataset.label.includes(q) || g.dataset.group.toLowerCase().includes(q);
          a.hidden = !hit;
          if (hit) any = true;
        });
        g.hidden = !any;
        g.classList.toggle('searching', Boolean(q));
      });
    });
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const first = [...mount.querySelectorAll('.admin-nav-item')].find((a) => !a.hidden);
      if (first) location.href = first.getAttribute('href');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || '') && !document.activeElement?.isContentEditable) {
        e.preventDefault();
        search.focus();
      }
    });
    mount.querySelector('.adm-group.has-active .admin-nav-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  function renderTopbar(title) {
    const mount = document.getElementById('adminTopbar');
    if (!mount) return;
    const me = Admin.getMe();
    const initials = me && me.username ? me.username.slice(0, 2).toUpperCase() : 'AD';
    mount.innerHTML = `
      <div class="adm-top-left">
        <button class="admin-hamburger" id="admHamburger" aria-label="Open menu">${svg('menu', 20)}</button>
        <h1>${esc(title)}</h1>
        <div class="adm-top-tools" id="admTopTools"></div>
      </div>
      <div class="admin-topbar-right">
        <span class="adm-health"><span class="status-dot" id="admStatusDot"></span><span id="admStatusLabel">All systems normal</span></span>
        <span id="admClock" class="mono adm-clock"></span>
        <div class="adm-account">
          <button type="button" class="adm-avatar" id="admAccountBtn" aria-haspopup="menu" aria-expanded="false" title="Account">${esc(initials)}</button>
          <div class="adm-account-menu" id="admAccountMenu" role="menu" hidden>
            <div class="adm-account-head"><b id="admTopbarUsername">${esc(me ? me.username : '')}</b><span id="admSidebarLastLogin">${me && me.lastLogin ? `Last login ${esc(Admin.formatDate(me.lastLogin))}` : ''}</span></div>
            <button type="button" role="menuitem" id="admChangePasswordBtn">Change password</button>
            <button type="button" role="menuitem" id="admLogoutBtn" class="danger">Log out</button>
          </div>
        </div>
      </div>
    `;
    const clockEl = mount.querySelector('#admClock');
    const tick = () => { clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    tick();
    setInterval(tick, 15000);
    mount.querySelector('#admHamburger').addEventListener('click', () => {
      document.getElementById('adminSidebar')?.classList.toggle('open');
    });
    const btn = mount.querySelector('#admAccountBtn');
    const menu = mount.querySelector('#admAccountMenu');
    const setMenu = (on) => { menu.hidden = !on; btn.setAttribute('aria-expanded', String(on)); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
    document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
    mount.querySelector('#admLogoutBtn').addEventListener('click', Admin.logout);
    mount.querySelector('#admChangePasswordBtn').addEventListener('click', () => { setMenu(false); Admin.openChangePasswordModal(); });
  }

  // Open player reports: a count on the Reports item and its group.
  function refreshReportsBadge() {
    if (!Admin.api) return;
    Admin.api('/players/reports/open').then((rows) => {
      const n = Array.isArray(rows) ? rows.length : 0;
      const el = document.getElementById('admReportsBadge');
      if (el) el.textContent = n > 0 ? String(n) : '';
    }).catch(() => {});
  }

  // Support "waiting for a human" badge: polled every 30s, and refreshed
  // instantly on live support events when the page has the admin socket.
  Admin.setSupportBadge = (n) => {
    const el = document.getElementById('admSupportBadge');
    if (el) el.textContent = n > 0 ? String(n) : '';
    const g = document.querySelector('[data-group-badge="Support"]');
    if (g) g.textContent = n > 0 ? String(n) : '';
  };
  function refreshSupportBadge() {
    if (!Admin.api) return;
    Admin.api('/support/counts').then((c) => Admin.setSupportBadge(c.waiting)).catch(() => {});
  }
  function startSupportBadge() {
    refreshSupportBadge();
    setInterval(refreshSupportBadge, 30000);
    if (Admin.socket && Admin.socket.on) Admin.socket.on('support:event', () => setTimeout(refreshSupportBadge, 300));
  }

  Admin.renderNav = (...args) => {
    render(...args);
    startSupportBadge();
    refreshReportsBadge();
    setInterval(refreshReportsBadge, 60000);
  };
  Admin.navIcon = svg;
  Admin.renderTopbar = renderTopbar;
})();
