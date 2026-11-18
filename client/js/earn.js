'use strict';

// Earn coins page (server: /api/earn, /api/earn/claim; server/earn.js).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, t) => (window.TW && TW.toast ? TW.toast(m, t) : null);

  function row({ label, meta, coins, progress, action }) {
    const bar = progress ? `<div class="er-bar"><i style="width:${Math.round((progress[0] / progress[1]) * 100)}%"></i></div>` : '';
    return `<div class="er-row"><div class="er-main"><div class="er-label">${esc(label)}</div>${meta ? `<div class="er-meta">${esc(meta)}</div>` : ''}${bar}</div><span class="er-coins">${coins} coins</span>${action || ''}</div>`;
  }
  function action(item, kind) {
    if (item.claimed) return '<span class="er-tag">Collected</span>';
    if (item.claimable) return `<button class="er-btn" type="button" data-kind="${kind}" data-id="${esc(item.id)}">Collect</button>`;
    return '<button class="er-btn" type="button" disabled>Not yet</button>';
  }

  async function claim(kind, id, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await TW.api('/api/earn/claim', { method: 'POST', body: { kind, id } });
      toast(`+${r.coins} coins: ${r.label}`, 'success');
      const p = TW.getPlayer && TW.getPlayer();
      if (p && Number.isFinite(Number(r.balance))) { TW.updatePlayerCache({ ...p, coins: Number(r.balance) }); if (TW.updateHeader) TW.updateHeader(); }
      load();
    } catch (e) {
      toast(e.message || 'Could not collect', 'warning');
      if (btn) btn.disabled = false;
    }
  }

  async function load() {
    if (!(window.TW && TW.getToken && TW.getToken())) { $('erLogin').hidden = false; return; }
    let d;
    try { d = await TW.api('/api/earn'); } catch (e) { $('erTotal').textContent = e.message || 'Could not load rewards'; return; }

    $('erWb').hidden = !d.welcomeBack.open;
    $('erWbText').textContent = `You have been away for ${d.welcomeBack.awayDays} days or more. Here are ${d.welcomeBack.coins} coins to get back in.`;

    const s = d.streak;
    $('erStreak').hidden = false;
    $('erDays').innerHTML = s.rewards.map((c, i) => {
      const n = i + 1;
      const done = s.claimedToday ? n <= s.day : n < s.day;
      const today = !s.claimedToday && n === s.day;
      return `<div class="er-day ${done ? 'done' : ''} ${today ? 'today' : ''}"><span>Day ${n}</span><b>${c}</b></div>`;
    }).join('');
    $('erStreakBtn').disabled = s.claimedToday;
    $('erStreakBtn').textContent = s.claimedToday ? 'Collected today' : `Collect ${s.nextCoins} coins`;
    $('erStreakMsg').textContent = s.claimedToday ? 'Come back tomorrow for the next day.' : `Day ${s.day} of 7`;

    $('erStarterWrap').hidden = false;
    $('erStarter').innerHTML = d.starter.map((t) => row({ label: t.label, coins: t.coins, progress: !t.done && t.progress ? t.progress : null, meta: !t.done && t.progress ? `${t.progress[0]} of ${t.progress[1]}` : '', action: action(t, 'starter') })).join('');

    const a = d.automatic;
    $('erAutoWrap').hidden = false;
    $('erAuto').innerHTML = [
      row({ label: 'First win of the day', meta: a.firstWin.paidToday ? 'Paid today' : 'Finish 1st in any match today (not a solo Private War)', coins: a.firstWin.coins }),
      row({ label: 'Daily Challenge', meta: a.dailyChallenge.paidToday ? 'Paid today' : 'Play today\'s Daily Challenge', coins: a.dailyChallenge.coins }),
      row({ label: `Reach level ${a.levelUp.next}`, meta: `Every new level pays; prestige pays ${a.levelUp.prestigeCoins}`, coins: a.levelUp.coins }),
      row({ label: 'Weekly leaderboard', meta: `Most wins in your tier, Monday to Sunday, at least ${a.weekly.minMatches} matches. Paid every Monday.${a.weekly.lastWeek ? ` You won ${a.weekly.lastWeek.coins} last week.` : ''}`, coins: a.weekly.perTier.join(' / ') }),
    ].join('');

    $('erAchWrap').hidden = false;
    $('erAch').innerHTML = d.achievements.map((t) => row({ label: t.label, coins: t.coins, progress: !t.claimed && t.progress ? t.progress : null, meta: !t.claimed && t.progress ? `${t.progress[0]} of ${t.progress[1]}` : '', action: action(t, 'achievement') })).join('');

    $('erTotal').textContent = d.earnedTotal ? `Earned here so far: ${d.earnedTotal} coins.` : '';
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (b) claim(b.dataset.kind, b.dataset.id, b);
  });
  $('erStreakBtn').addEventListener('click', (e) => claim('streak', null, e.currentTarget));
  $('erWbBtn').addEventListener('click', (e) => claim('welcome_back', null, e.currentTarget));
  load();
})();
