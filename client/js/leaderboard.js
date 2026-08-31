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
        <td>${TW.escapeHtml(row.username)}${row.isAI ? ' 🤖' : ''}${badge}</td>
        <td class="${pnlClass} mono">${TW.formatMoney(row.pnl)}</td>
        <td>${row.tradesMade}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  return { render };
})();
