'use strict';
// Live candle chart used as key art behind a hero band (console redesign).
// Usage: <section data-hero-chart> ... </section>. Decorative only
// (aria-hidden). Draws to one canvas, ~1 new candle per second, pauses when
// the tab is hidden, and draws a single still frame for reduced motion.
(function () {
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function mount(host) {
    if (host.querySelector('.hero-chart')) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'hero-chart';
    canvas.setAttribute('aria-hidden', 'true');
    host.prepend(canvas);
    const ctx = canvas.getContext('2d');
    let seed = 1337;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const candles = [];
    let p = 100;
    const push = () => {
      const o = p, c = o + (rand() - 0.48) * 2.2;
      candles.push({ o, c, h: Math.max(o, c) + rand() * 0.9, l: Math.min(o, c) - rand() * 0.9 });
      p = c;
      if (candles.length > 300) candles.shift();
    };
    for (let i = 0; i < 140; i++) push();

    let W = 0, H = 0;
    function size() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.max(1, W * dpr); canvas.height = Math.max(1, H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function draw() {
      if (!W || !H) return;
      const cw = Math.max(9, W / 70), n = Math.ceil(W / cw) + 1;
      const vis = candles.slice(-n);
      const hi = Math.max(...vis.map((v) => v.h)), lo = Math.min(...vis.map((v) => v.l));
      const pad = H * 0.14;
      const y = (v) => pad + (1 - (v - lo) / (hi - lo || 1)) * (H - pad * 2);
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(229,229,229,.05)'; ctx.lineWidth = 1;
      for (let i = 1; i < 5; i++) { const gy = (H / 5) * i; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
      vis.forEach((cd, i) => {
        const x = W - (vis.length - i) * cw, up = cd.c >= cd.o;
        ctx.strokeStyle = ctx.fillStyle = up ? 'rgba(31,211,138,.8)' : 'rgba(255,61,92,.8)';
        ctx.beginPath(); ctx.moveTo(x + cw / 2, y(cd.h)); ctx.lineTo(x + cw / 2, y(cd.l)); ctx.stroke();
        ctx.fillRect(x + cw * 0.18, Math.min(y(cd.o), y(cd.c)), cw * 0.64, Math.max(1.5, Math.abs(y(cd.c) - y(cd.o))));
      });
      const ly = y(vis[vis.length - 1].c);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,.3)';
      ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(W, ly); ctx.stroke(); ctx.setLineDash([]);
    }
    size(); draw();
    window.addEventListener('resize', () => { size(); draw(); });
    if (REDUCED) return;
    setInterval(() => { if (!document.hidden) { push(); draw(); } }, 1000);
  }

  function init() { document.querySelectorAll('[data-hero-chart]').forEach(mount); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.TW = window.TW || {};
  window.TW.heroChart = mount;
})();
