'use strict';

// Self-injecting bottom tab bar for mobile - included as a single <script>
// tag the same way js/support-widget.js is, rather than requiring a static
// HTML snippet pasted into every page (no shared templating layer exists in
// this codebase). CSS-hidden above 768px (see css/mobile.css) and only
// rendered at all when logged in - a logged-out visitor on e.g. /leaderboard
// gets no tab bar, matching the nav bar's own logged-out state.

(function () {
  if (document.getElementById('bottom-tab-bar')) return;
  if (!window.TW || !TW.isLoggedIn || !TW.isLoggedIn()) return;

  const TABS = [
    { key: 'index', label: 'Home', href: '/play', icon: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' },
    { key: 'leaderboard', label: 'Ranks', href: '/leaderboard', icon: '<path d="M18 20V10M12 20V4M6 20v-6"/>' },
    { key: 'play', raised: true, href: '/play' },
    { key: 'shop', label: 'Shop', href: '/shop', icon: '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>' },
    { key: 'profile', label: 'Me', href: '/profile', avatar: true },
  ];

  const activePage = document.body.dataset.page || '';

  const nav = document.createElement('nav');
  nav.className = 'bottom-tab-bar';
  nav.id = 'bottom-tab-bar';
  nav.innerHTML = TABS.map((tab) => {
    if (tab.raised) {
      return `
        <div class="tab-play-wrap">
          <a href="${tab.href}" class="tab-play-btn" title="Play">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </a>
        </div>
      `;
    }
    const active = tab.key === activePage;
    const iconHtml = tab.avatar
      ? `<div class="tab-icon" id="tab-avatar"></div>`
      : `<div class="tab-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${tab.icon}</svg></div>`;
    return `
      <a href="${tab.href}" class="tab-item ${active ? 'active' : ''}" data-tab="${tab.key}">
        ${iconHtml}
        <span class="tab-label">${tab.label}</span>
      </a>
    `;
  }).join('');

  document.body.appendChild(nav);

  const player = TW.getPlayer && TW.getPlayer();
  const avatarEl = document.getElementById('tab-avatar');
  if (avatarEl && player?.username) {
    avatarEl.textContent = player.username.charAt(0).toUpperCase();
  }
})();
