'use strict';

// Reusable floating candlestick background. Any element with
// data-candle-bg (optional value = candle count) gets one on load; or call
// TW.candleBg(el, { count }) directly. Defaults to 14 candles, 8 on phones.
// Pauses while the tab is hidden; static under prefers-reduced-motion (see
// css/candle-bg.css).
(function () {
  window.TW = window.TW || {};

  const isPhone = () => window.matchMedia('(max-width: 1023px)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);

  function candleBg(host, opts = {}) {
    if (!host || host.querySelector(':scope > .candle-bg')) return null;
    const count = opts.count || (isPhone() ? opts.mobileCount || 8 : opts.desktopCount || 14);
    const layer = document.createElement('div');
    layer.className = 'candle-bg';
    layer.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < count; i++) {
      const up = Math.random() < 0.5;
      const total = rand(28, 90);
      const bodyH = total * rand(0.35, 0.7);
      const bodyTop = rand(0.05, 0.95 - bodyH / total) * total;
      const c = document.createElement('span');
      c.className = `cb-candle ${up ? 'cb-up' : 'cb-down'}`;
      // Spread candles evenly across the width with a little jitter.
      c.style.left = `${((i + rand(0.15, 0.85)) / count) * 100}%`;
      c.style.height = `${total}px`;
      c.style.setProperty('--cb-dur', `${rand(40, 90).toFixed(1)}s`);
      c.style.setProperty('--cb-delay', `${(-rand(0, 90)).toFixed(1)}s`);
      c.style.setProperty('--cb-dx', `${rand(-40, 40).toFixed(0)}px`);
      c.style.setProperty('--cb-static-top', `${rand(5, 70).toFixed(0)}%`);
      c.style.opacity = rand(0.25, 0.35).toFixed(2);
      c.innerHTML = `<span class="cb-wick"></span><span class="cb-body" style="top:${bodyTop.toFixed(1)}px;height:${bodyH.toFixed(1)}px"></span>`;
      layer.appendChild(c);
    }
    host.classList.add('candle-bg-host');
    host.prepend(layer);
    return layer;
  }

  function syncPaused() {
    document.querySelectorAll('.candle-bg').forEach((el) => el.classList.toggle('is-paused', document.hidden));
  }
  document.addEventListener('visibilitychange', syncPaused);

  function mountAll() {
    document.querySelectorAll('[data-candle-bg]').forEach((el) => {
      const n = Number(el.dataset.candleBg);
      candleBg(el, n > 0 ? { count: n } : {});
    });
  }

  TW.candleBg = candleBg;
  TW.mountCandleBgs = mountAll;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();
})();
