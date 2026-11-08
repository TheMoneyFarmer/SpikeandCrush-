'use strict';
// Sabotage card artwork, drawn to a canvas so it stays sharp and uses real game
// text. Shared by the 3D card showcase and the "How a match works" flight.
// ADD A CARD HERE: id (matches its picture in /assets/showcase), name, effect, icon.
window.SCCardArt = (function () {
  const CARDS = [
    { id: 'chart-ghost', name: 'Chart Ghost', desc: 'Freezes their price display for 10 seconds.', icon: 'eye' },
    { id: 'force-close', name: 'Force Close', desc: 'Closes a rival’s best position at market.', icon: 'lock' },
    { id: 'pip-theft', name: 'Pip Theft', desc: 'Steals 150 from their capital into yours.', icon: 'user' },
    { id: 'margin-call', name: 'Margin Call', desc: 'Force-closes every open position they hold.', icon: 'warn' },
    { id: 'news-bomb', name: 'News Bomb', desc: 'Fake headline in their feed for 15 seconds.', icon: 'news' },
    { id: 'capital-drain', name: 'Capital Drain', desc: 'Takes 200 off a rival’s virtual capital.', icon: 'wallet' },
  ];
  const ICONS = {
    eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
    lock: ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 11V7a4 4 0 0 1 8 0v4'],
    user: ['M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0z', 'M4 21a8 8 0 0 1 16 0'],
    warn: ['M12 3 2 20h20z', 'M12 10v4', 'M12 17h.01'],
    news: ['M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1z', 'M17 9a4 4 0 0 1 0 6'],
    wallet: ['M20 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15v12H5a2 2 0 0 1-2-2V6', 'M16 14h.01'],
  };

  function wrap(ctx, text, x, y, maxW, lh) {
    const words = text.split(' '); let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, y); y += lh; line = w; } else line = t;
    }
    ctx.fillText(line, x, y);
  }
  function candles(ctx, W, seedVal, alpha, yBase, spread) {
    let s = seedVal >>> 0, v = yBase;
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const cw = W / 26;
    for (let i = 0; i < 26; i++) {
      const open = v, close = v + (r() - 0.5) * spread, up = close < open;
      ctx.fillStyle = up ? `rgba(31,211,138,${alpha})` : `rgba(255,77,106,${alpha})`;
      ctx.fillRect(i * cw + cw * 0.46, Math.min(open, close) - spread * 0.25, cw * 0.08, Math.abs(close - open) + spread * 0.5);
      ctx.fillRect(i * cw + cw * 0.2, Math.min(open, close), cw * 0.6, Math.max(3, Math.abs(close - open)));
      v = close;
    }
  }
  function drawFace(canvas, card) {
    const W = canvas.width, H = canvas.height, u = W / 1000, ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#26386a'); g.addColorStop(1, '#141f3c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    candles(ctx, W, card.name.length * 97, 0.42, H * 0.38, H * 0.06);
    ctx.fillStyle = '#ff4d6a'; ctx.fillRect(0, 0, W, 26 * u);

    ctx.fillStyle = 'rgba(255,77,106,.16)';
    ctx.beginPath(); ctx.roundRect(84 * u, 120 * u, 190 * u, 190 * u, 28 * u); ctx.fill();
    ctx.save();
    ctx.translate(84 * u + 35 * u, 120 * u + 35 * u); ctx.scale(5 * u, 5 * u);
    ctx.strokeStyle = '#ff6b84'; ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ICONS[card.icon].forEach((d) => ctx.stroke(new Path2D(d)));
    ctx.restore();

    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(232,238,248,.62)';
    ctx.font = `500 ${40 * u}px Inter, system-ui, sans-serif`;
    ctx.fillText('Sabotage card', 84 * u, H * 0.66);
    ctx.fillStyle = '#f2f5fa';
    ctx.font = `300 ${112 * u}px Inter, system-ui, sans-serif`;
    ctx.fillText(card.name, 84 * u, H * 0.66 + 124 * u);
    ctx.fillStyle = 'rgba(232,238,248,.82)';
    ctx.font = `400 ${46 * u}px Inter, system-ui, sans-serif`;
    wrap(ctx, card.desc, 84 * u, H * 0.66 + 212 * u, W - 168 * u, 62 * u);
  }
  function drawBack(canvas) {
    const W = canvas.width, H = canvas.height, u = W / 1000, ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a2850'; ctx.fillRect(0, 0, W, H);
    candles(ctx, W, 4242, 0.5, H * 0.5, H * 0.075);
    ctx.fillStyle = 'rgba(26,40,80,.55)'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `800 ${122 * u}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = '#1fd38a'; ctx.fillText('Spike', W / 2, H / 2 - 90 * u);
    ctx.font = `300 ${80 * u}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = '#f2f5fa'; ctx.fillText('&', W / 2, H / 2 + 5 * u);
    ctx.font = `800 ${122 * u}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = '#ff4d6a'; ctx.fillText('Crush', W / 2, H / 2 + 100 * u);
  }
  const fontsReady = () => Promise.race([
    Promise.all([document.fonts.load('300 64px Inter'), document.fonts.load('400 32px Inter'), document.fonts.load('800 64px Inter')]),
    new Promise((res) => setTimeout(res, 2500)),
  ]).catch(() => {});
  const byId = (id) => CARDS.find((c) => c.id === id);
  return { CARDS, ICONS, drawFace, drawBack, fontsReady, byId };
})();
