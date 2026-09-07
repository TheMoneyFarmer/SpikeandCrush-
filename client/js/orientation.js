'use strict';

// Landscape lock removed - the game screen and every other logged-in page
// now support portrait directly (see css/mobile.css's game-screen portrait
// rules). Kept as a no-op stub rather than deleted because ~20 pages still
// load this file and a few call window.initOrientationLock() right after login.
window.initOrientationLock = function initOrientationLock() {};
