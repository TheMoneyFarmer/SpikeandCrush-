'use strict';

window.TW = window.TW || {};

TW.Leaderboard = (function () {
  const prevRanks = new Map(); // rowId -> last-seen rank, so we can tell a spike (rank improved) from a crush (rank worsened)

  function render(payload, viewerId) {
    const panel = document.getElementById('leaderboardPanel');
    if (panel) panel.classList.toggle('blurred', Boolean(payload.blurred));

    const tbody = document.getElementById('leaderboardBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    payload.rows.forEach((row) => {
      const tr = document.createElement('tr');
      if (row.id === viewerId) tr.className = 'self-row';
      const pnlClass = row.pnl >= 0 ? 'text-buy' : 'text-sell';
      let badge = '';
      if (row.eliminated) badge = '<span class="player-status-badge eliminated">OUT</span>';
      else if (row.softLocked) badge = '<span class="player-status-badge locked">LOCKED</span>';

      const prevRank = prevRanks.get(row.id);
      let rankClass = '';
      if (prevRank !== undefined && prevRank !== row.rank) {
        rankClass = row.rank < prevRank ? 'text-buy rank-slide-up' : 'text-sell rank-slide-down';
      }
      prevRanks.set(row.id, row.rank);

      tr.innerHTML = `
        <td class="${rankClass}">${row.rank}</td>
        <td>${TW.renderUsername(row)}${badge}</td>
        <td class="${pnlClass} mono">${TW.formatMoney(row.pnl)}</td>
        <td>${row.tradesMade}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // The race: one row per player with a P&L bar, used by the Arena layout on
  // desktop and in the phone Trade view (css/arena.css picks which shows).
  const AVATAR_COLORS = ['#2d7ff9', '#f5b83d', '#6cb2ff', '#b77dff', '#4fe0a6', '#ff8a5c', '#e879b9', '#9cc4ff'];
  function colorFor(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  const TAG = { shield: 'Shield', protected: 'Protected', frozen: 'Frozen', affected: 'Hit', offline: 'Offline', out: 'Out' };

  function renderRace(payload, viewerId) {
    const box = document.getElementById('raceList');
    if (!box) return;
    const rows = payload.rows || [];
    const scale = Math.max(100, ...rows.map((r) => Math.abs(r.pnl)));
    box.innerHTML = rows.map((r) => {
      const name = r.username || '';
      const pct = Math.min(50, (Math.abs(r.pnl) / scale) * 50);
      const tags = [];
      if (r.crown) tags.push('<span class="race-tag tag-crown">Crown</span>');
      if (r.eliminated) tags.push('<span class="race-tag tag-out">Out</span>');
      else if (r.softLocked) tags.push('<span class="race-tag tag-hit">Locked</span>');
      (r.status || []).forEach((s) => { if (TAG[s] && s !== 'out') tags.push(`<span class="race-tag tag-${s}">${TAG[s]}</span>`); });
      return `<div class="race-row${r.id === viewerId ? ' is-you' : ''}">
        <span class="race-rank mono">${r.rank}</span>
        <span class="race-av" style="background:${colorFor(r.id)}" aria-hidden="true">${TW.escapeHtml(name.slice(0, 2).toUpperCase())}</span>
        <span class="race-top"><span class="race-name">${r.id === viewerId ? 'You' : TW.escapeHtml(name)}</span>${tags.join('')}<span class="race-pnl mono ${r.pnl >= 0 ? 'text-buy' : 'text-sell'}">${TW.formatMoney(r.pnl)}</span></span>
        <span class="race-bar" aria-hidden="true"><span class="${r.pnl >= 0 ? 'up' : 'down'}" style="width:${pct.toFixed(1)}%"></span></span>
      </div>`;
    }).join('');
  }

  return { render: (payload, viewerId) => { render(payload, viewerId); renderRace(payload, viewerId); } };
})();
