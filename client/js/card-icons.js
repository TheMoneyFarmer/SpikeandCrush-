'use strict';

// SVG icons for every card (sabotage.js `icon` keys) and the fire-gameplay UI
// (crown, heat, lock, search, spike). 24x24 stroke icons, currentColor, no
// emoji anywhere. TW.CardIcons.svg(key, size) returns markup.
window.TW = window.TW || {};

TW.CardIcons = (function () {
  const P = {
    percent: ['M19 5 5 19', 'M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
    spread: ['M4 8h16', 'M4 16h16', 'M8 4 4 8l4 4', 'M16 12l4 4-4 4'],
    slip: ['M3 17c3-6 6-6 9 0s6 6 9 0', 'M3 9h7', 'M14 9h7'],
    squeeze: ['M4 4h16v16H4z', 'M9 4v16', 'M15 4v16', 'M12 9v6'],
    yank: ['M4 12h11', 'M11 8l4 4-4 4', 'M19 5v14'],
    scissors: ['M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M20 4 8.1 15.9', 'M14.5 14.5 20 20', 'M8.1 8.1 12 12'],
    snow: ['M12 2v20', 'M4.9 4.9l14.2 14.2', 'M2 12h20', 'M4.9 19.1 19.1 4.9'],
    one: ['M12 4v16', 'M8 8l4-4', 'M8 20h8'],
    arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
    hourglass: ['M6 2h12', 'M6 22h12', 'M7 2c0 6 10 6 10 10S7 16 7 22', 'M17 2c0 6-10 6-10 10s10 4 10 10'],
    skim: ['M4 14h16', 'M6 14c0 4 3 6 6 6s6-2 6-6', 'M12 3v7', 'M9 7l3 3 3-3'],
    bolt: ['M13 2 3 14h9l-1 8 10-12h-9l1-8z'],
    wave: ['M2 12c2.5-5 5-5 7.5 0s5 5 7.5 0 3-4 5-2'],
    drain: ['M12 3v10', 'M8 9l4 4 4-4', 'M4 17c2 2 4 3 8 3s6-1 8-3'],
    reverse: ['M3 7h13a4 4 0 0 1 0 8H7', 'M7 11l-4 4 4 4'],
    freeze: ['M12 2v20', 'M17 7l-5 5-5-5', 'M17 17l-5-5-5 5'],
    lock: ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 11V7a4 4 0 0 1 8 0v4'],
    wallet: ['M20 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15v12H5a2 2 0 0 1-2-2V6', 'M16 14h.01'],
    mirror: ['M12 3v18', 'M8 7 4 12l4 5', 'M16 7l4 5-4 5'],
    spread2: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
    clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
    fog: ['M4 10h16', 'M2 14h14', 'M6 18h14', 'M8 6h10'],
    panic: ['M3 12h4l3-8 4 16 3-8h4'],
    pause: ['M8 5v14', 'M16 5v14'],
    padlock: ['M5 11h14v10H5z', 'M8 11V8a4 4 0 0 1 8 0v3', 'M12 15v2'],
    warn: ['M12 3 2 20h20z', 'M12 10v4', 'M12 17h.01'],
    ruler: ['M3 17 17 3l4 4L7 21z', 'M7 13l2 2', 'M10 10l2 2', 'M13 7l2 2'],
    thief: ['M3 12c3-3 15-3 18 0', 'M7 12a2 2 0 1 0 0 .01', 'M17 12a2 2 0 1 0 0 .01', 'M8 18c2 1.5 6 1.5 8 0'],
    ghost: ['M5 21V10a7 7 0 0 1 14 0v11l-3-2-2 2-2-2-2 2-2-2z', 'M9 10h.01', 'M15 10h.01'],
    target: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 12h.01'],
    shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
    cleanse: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4'],
    // UI
    crown: ['M3 18h18', 'M3 18 5 7l5 5 2-7 2 7 5-5 2 11'],
    heat: ['M12 22c4 0 7-3 7-7 0-5-5-7-5-12-3 2-5 5-5 8-1-1-2-2-2-4-1 2-2 4-2 7 0 4 3 8 7 8z'],
    search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
    spike: ['M2 18h5l3-12 4 16 3-8h5'],
    dice: ['M4 4h16v16H4z', 'M9 9h.01', 'M15 15h.01', 'M15 9h.01', 'M9 15h.01'],
    up: ['M12 19V5', 'M5 12l7-7 7 7'],
    down: ['M12 5v14', 'M19 12l-7 7-7-7'],
    plus: ['M12 5v14', 'M5 12h14'],
    check: ['M5 12l5 5L20 7'],
  };

  function svg(key, size = 20) {
    const paths = P[key] || P.target;
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
  }

  return { svg, keys: Object.keys(P) };
})();
