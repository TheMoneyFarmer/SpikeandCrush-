'use strict';

// Profile: showcase (top mastered cards, prestige, season peak), mastery stats
// and the Prestige button (own profile, at the top level only).
window.TW = window.TW || {};
TW.loadEndgame = async function loadEndgame(player, own) {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (!$('egShowcase') || !player || !player.id) return;
  try {
    const sc = await fetch(`/api/player/${encodeURIComponent(player.id)}/showcase`).then((r) => (r.ok ? r.json() : null));
    if (sc) {
      const parts = [];
      parts.push(sc.prestige ? `<strong>Prestige ${sc.prestige}</strong>` : 'No prestige yet');
      if (sc.seasonPeak) parts.push(`${esc(sc.seasonPeak.season)}: level ${sc.seasonPeak.level}${sc.seasonPeak.peakTier ? `, peak ${esc(sc.seasonPeak.peakTier)}` : ''}`);
      parts.push(sc.topMastery.length ? `Top cards: ${sc.topMastery.map((m) => `${esc(m.name)} (mastery ${m.level})`).join(', ')}` : 'No mastered cards yet');
      $('egShowcase').innerHTML = parts.join('<br>');
    }
  } catch (e) { $('egShowcase').textContent = 'Showcase unavailable right now.'; }
  if (!own) { $('egMastery').closest('section').querySelectorAll('h3')[1].hidden = true; $('egMastery').hidden = true; return; }
  try {
    const m = await TW.api('/api/mastery/me');
    $('egMastery').innerHTML = m.cards.length ? `<table class="admin-table" style="width:100%;font-size:13px;"><thead><tr><th style="text-align:left;">Card</th><th>Level</th><th>Uses</th><th>Success</th><th style="text-align:left;">Favourite target</th></tr></thead><tbody>${m.cards.map((c) => `<tr><td>${esc(c.name)}</td><td style="text-align:center;">${c.level} / 5</td><td style="text-align:center;">${c.uses}</td><td style="text-align:center;">${Math.round(c.successRate * 100)}%</td><td>${esc(c.favouriteTarget || '—')}</td></tr>`).join('')}</tbody></table>` : 'Play cards in matches to start building mastery.';
  } catch (e) { $('egMastery').textContent = 'Mastery unavailable right now.'; }
  try {
    const prog = await TW.api('/api/progression/me');
    if (prog.prestige && prog.prestige.canPrestige) {
      $('egPrestige').hidden = false;
      $('egPrestigeBtn').onclick = async () => {
        if (!confirm('Prestige now? Your level restarts at 1. You keep every card, unlock and cosmetic. This cannot be undone.')) return;
        try {
          const r = await TW.api('/api/progression/prestige', { method: 'POST', body: { confirm: true } });
          TW.toast(`Prestige ${r.prestige}! Your level starts again at 1.`, 'info');
          $('egPrestige').hidden = true;
          TW.loadEndgame(player, own);
        } catch (err) { TW.toast(err.message, 'danger'); }
      };
    }
  } catch (e) { /* not signed in */ }
};
