'use strict';

// Landscape lock for the trading experience - only enforced once logged in
// (the landing page and legal pages never trigger this). Uses TW.isLoggedIn()
// (client/js/main.js) rather than a raw localStorage read so a half-session
// (token with no cached player, or vice versa) is treated as logged out here
// too, consistent with every other login check in the app.

const PORTRAIT_BLOCKED_PAGES = [
  '/trading-floor',
  '/game',
  '/lobby',
  '/wallet',
  '/shop',
  '/leaderboard',
  '/profile',
  '/settings',
  '/tournaments',
  '/play',
];

function isGamePage() {
  const path = window.location.pathname;
  return PORTRAIT_BLOCKED_PAGES.some((p) => path.includes(p));
}

function isLoggedIn() {
  return Boolean(window.TW && TW.isLoggedIn && TW.isLoggedIn());
}

function isMobile() {
  return /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
}

function isPortrait() {
  if (screen.orientation) {
    return screen.orientation.type.startsWith('portrait');
  }
  return window.innerHeight > window.innerWidth;
}

function ensureRotateOverlay() {
  let overlay = document.getElementById('rotate-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'rotate-overlay';
  overlay.innerHTML = `
    <div class="rotate-icon">📱</div>
    <div class="rotate-title">Rotate your device</div>
    <div class="rotate-sub">Spike &amp; Crush is best played in landscape mode. Please rotate your phone to continue.</div>
    <div class="rotate-logo">SPIKE &amp; CRUSH</div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function checkOrientation() {
  if (!isMobile() || !isGamePage() || !isLoggedIn()) {
    document.getElementById('rotate-overlay')?.classList.remove('show');
    return;
  }

  const overlay = ensureRotateOverlay();

  if (isPortrait()) {
    overlay.classList.add('show');
    document.body.style.overflow = 'hidden';
  } else {
    overlay.classList.remove('show');
    document.body.style.overflow = '';
  }
}

// Native screen lock only works on Android Chrome and some PWA contexts -
// the overlay above is the fallback everywhere else (notably iOS Safari).
async function tryLockOrientation() {
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
    }
  } catch (err) {
    // Native lock not supported - overlay fallback handles it.
  }
}

window.addEventListener('orientationchange', () => {
  setTimeout(checkOrientation, 100);
});

window.addEventListener('resize', () => {
  setTimeout(checkOrientation, 100);
});

document.addEventListener('DOMContentLoaded', () => {
  if (isLoggedIn() && isMobile() && isGamePage()) {
    tryLockOrientation();
    checkOrientation();
  }
});

// Called right after a successful login (see js/main.js and landing.html's
// own login/register handlers) so the lock/overlay engage immediately
// instead of waiting for the next page load.
window.initOrientationLock = function initOrientationLock() {
  tryLockOrientation();
  checkOrientation();
};
