'use strict';

// Shared device/orientation detection - used by friends-panel.js (skip the
// auto-restore-open behaviour on mobile) and game.js (mobile-only lot
// stepper buttons). Also stamps mode-desktop/mode-mobile-portrait/
// mode-mobile-landscape on <html> for any CSS that wants to hook into it,
// though most of this site's mobile layout already works via plain
// @media queries in css/mobile.css and doesn't need this.
const Device = {
  isMobile() {
    return /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
  },

  isIOS() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent);
  },

  isAndroid() {
    return /Android/i.test(navigator.userAgent);
  },

  isPortrait() {
    return window.innerHeight > window.innerWidth;
  },

  isLandscape() {
    return window.innerWidth > window.innerHeight;
  },

  getMode() {
    if (!this.isMobile()) return 'desktop';
    return this.isPortrait() ? 'mobile-portrait' : 'mobile-landscape';
  },

  onModeChange(callback) {
    let lastMode = this.getMode();
    const check = () => {
      const mode = this.getMode();
      if (mode !== lastMode) {
        lastMode = mode;
        callback(mode);
      }
    };
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', () => setTimeout(check, 150));
  },

  applyModeClass() {
    const mode = this.getMode();
    document.documentElement.classList.remove('mode-desktop', 'mode-mobile-portrait', 'mode-mobile-landscape');
    document.documentElement.classList.add('mode-' + mode);
  },
};

Device.applyModeClass();
Device.onModeChange(() => Device.applyModeClass());

window.Device = Device;
