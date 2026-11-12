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

  const ic = (name, size = 22) => (TW.icon ? TW.icon(name, { size }) : '');
  const TABS = [
    { key: 'index', label: 'Home', href: '/play', icon: 'home' },
    { key: 'leaderboard', label: 'Ranks', href: '/leaderboard', icon: 'ranks' },
    { key: 'play', raised: true },
    { key: 'discover', label: 'Discover', href: '/play?discover=1', icon: 'search', discover: true },
    { key: 'competitions', label: 'Compete', href: '/competitions', icon: 'flag' },
    { key: 'profile', label: 'Me', href: '/profile', avatar: true },
  ];

  const activePage = document.body.dataset.page || '';

  const nav = document.createElement('nav');
  nav.className = 'bottom-tab-bar';
  nav.id = 'bottom-tab-bar';
  nav.setAttribute('aria-label', 'Main');
  nav.innerHTML = TABS.map((tab) => {
    if (tab.raised) {
      // Play opens the lobby's mode sheet; from any other page it goes to
      // the lobby with the sheet already open.
      return `
        <div class="tab-play-wrap">
          <a href="/play?modes=1" class="tab-play-btn" id="tabPlayBtn" aria-label="Play - choose a mode">${ic('play', 28)}</a>
        </div>
      `;
    }
    const active = tab.key === activePage;
    const iconHtml = tab.avatar ? `<div class="tab-icon" id="tab-avatar" aria-hidden="true"></div>` : `<div class="tab-icon">${ic(tab.icon)}</div>`;
    return `
      <a href="${tab.href}" class="tab-item ${active ? 'active' : ''}" data-tab="${tab.key}" ${active ? 'aria-current="page"' : ''}${tab.discover ? ' data-discover-toggle aria-controls="twDiscover" aria-expanded="false"' : ''}>
        ${iconHtml}
        <span class="tab-label">${tab.label}</span>
      </a>
    `;
  }).join('');

  document.body.appendChild(nav);

  nav.querySelector('#tabPlayBtn').addEventListener('click', (e) => {
    if (TW.openModeSheet) {
      e.preventDefault();
      TW.openModeSheet();
    }
  });

  const player = TW.getPlayer && TW.getPlayer();
  const avatarEl = document.getElementById('tab-avatar');
  if (avatarEl && player?.username) {
    avatarEl.textContent = player.username.charAt(0).toUpperCase();
  }
})();
