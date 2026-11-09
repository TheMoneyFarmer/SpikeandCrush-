'use strict';

// Records the status and content type of every public GET path, for a before/after diff.
//   node scripts/check-status.js http://localhost:3080
const BASE = process.argv[2] || 'http://localhost:3000';
const PATHS = [
  '/', '/play', '/wallet', '/cards', '/settings', '/help', '/terms', '/privacy', '/responsible', '/shop', '/battle-pass',
  '/async', '/replay', '/clip', '/tournaments', '/competitions', '/sponsor', '/analytics', '/trading-floor', '/leaderboard',
  '/profile', '/auth-callback', '/reset-password', '/verify-email', '/health', '/ready', '/robots.txt', '/favicon.ico',
  '/favicon.svg', '/apple-touch-icon.png', '/og-image.png', '/api/stats/home', '/api/stats/live', '/api/competitions',
  '/api/leaderboard', '/api/config/public', '/js/main.js', '/css/main.css', '/socket.io/?EIO=4&transport=polling',
  '/invite/AAAAAAAA', '/r/nosuchcode', '/lobby.html', '/game.html', '/landing.html',
];
(async () => {
  for (const p of PATHS) {
    const res = await fetch(BASE + p, { redirect: 'manual', headers: { accept: 'text/html,*/*' } });
    await res.arrayBuffer();
    const type = (res.headers.get('content-type') || '').split(';')[0];
    const loc = res.headers.get('location');
    console.log(`${p} ${res.status} ${type}${loc ? ` -> ${loc}` : ''}`);
  }
})();
