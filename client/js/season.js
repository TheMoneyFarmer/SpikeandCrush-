'use strict';

// Season page (server: /api/seasons/current, server/endgame.js).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rewardText = (r) => (r.type === 'coins' ? `${r.amount} coins` : r.name || String(r.id || '').replace(/_/g, ' '));
  function left(ms) {
    if (ms <= 0) return 'ending now';
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    return d ? `${d} days ${h} hours left` : `${h} hours left`;
  }
  async function load() {
    const headers = window.TW && TW.getToken && TW.getToken() ? { Authorization: `Bearer ${TW.getToken()}` } : {};
    const d = await fetch('/api/seasons/current', { headers }).then((r) => r.json()).catch(() => ({ season: null }));
    if (!d.season) {
      $('snName').textContent = 'Season';
      $('snSub').textContent = '';
      $('snNone').hidden = false;
      return;
    }
    const s = d.season;
    $('snName').textContent = s.name;
    const tick = () => { $('snSub').textContent = `${left(Date.parse(s.endsAt) - Date.now())} · ends ${new Date(s.endsAt).toLocaleDateString()}`; };
    tick();
    setInterval(tick, 60000);
    if (d.mine) {
      $('snMine').hidden = false;
      const into = d.mine.xp % s.xpPerLevel;
      $('snLevel').textContent = `Season level ${d.mine.level} of ${s.levels}`;
      $('snXp').textContent = d.mine.level >= s.levels ? 'Max level' : `${into} / ${s.xpPerLevel} XP to the next level`;
      $('snBar').style.width = `${d.mine.level >= s.levels ? 100 : (into / s.xpPerLevel) * 100}%`;
    }
    if (s.featuredCards.length || d.vault.length) {
      $('snFeatured').hidden = false;
      $('snCards').innerHTML = s.featuredCards.map((c) => `<span class="lot-chip" style="min-height:36px;display:inline-flex;align-items:center;">${esc(c.name)}</span>`).join('') || '<span class="text-secondary">None this season</span>';
      $('snVault').textContent = d.vault.length ? `In the Vault: ${d.vault.join(', ').replace(/_/g, ' ')}` : '';
    }
    if (s.track.length) {
      $('snTrackWrap').hidden = false;
      const claimed = new Set((d.mine && d.mine.claimed_levels) || []);
      $('snTrack').innerHTML = s.track.slice().sort((a, b) => a.level - b.level).map((t) => `<li style="display:flex;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid #1D2638;border-radius:8px;${claimed.has(t.level) ? 'border-color:#2EE6A6;' : ''}"><span>Level ${t.level}</span><span>${esc(rewardText(t.reward))}${claimed.has(t.level) ? ' · earned' : ''}</span></li>`).join('');
    }
  }
  load();
})();
