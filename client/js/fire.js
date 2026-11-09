'use strict';

window.TW = window.TW || {};

// The match strip (a fixed 32px row above the chart - part of the layout, never
// over the chart), quick missions, and the result-screen extras: Heat, streak,
// missions, XP, level-up and unlocks, Rematch and Challenge a friend.
TW.Fire = (function () {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const icon = (k, s) => (TW.CardIcons ? TW.CardIcons.svg(k, s) : '');
  let you = null;
  let rows = [];
  let missions = [];
  let alertTimer = null;
  let resultTimer = null;
  let mode = 'idle'; // idle | alert | result

  const strip = () => document.getElementById('spikeStrip');

  function setYou(id) {
    you = id;
  }

  // ---- idle strip: crown, rival above you, mission chips ----------------------
  function drawIdle() {
    const el = strip();
    if (!el || mode !== 'idle') return;
    const leader = rows.find((r) => r.crown) || rows[0];
    const mine = rows.find((r) => r.id === you);
    const above = mine ? rows.find((r) => r.rank === mine.rank - 1) : null;
    const chips = missions.map((m) => `<span class="ms-chip${m.done ? ' done' : ''}" title="${TW.escapeHtml(m.label)}">${m.done ? icon('check', 12) : ''}<span>${TW.escapeHtml(m.label)}</span><b>${Math.min(m.progress, m.target)}/${m.target}</b></span>`).join('');
    el.className = 'match-strip';
    el.innerHTML = `
      <span class="ms-crown" title="Current leader">${icon('crown', 14)}<span>${leader ? TW.escapeHtml(leader.username) : '-'}</span></span>
      ${mine && mine.rank === 1 ? '<span class="ms-rival you-lead">You wear the crown</span>' : above ? `<span class="ms-rival">Rival above: <b>${TW.escapeHtml(above.username)}</b> <i class="${above.pnl - mine.pnl > 0 ? 'text-sell' : ''}">${TW.formatMoney(above.pnl - mine.pnl)} ahead</i></span>` : ''}
      <span class="ms-missions">${chips}</span>`;
  }

  function setLeaderboard(newRows) {
    const prevLeader = (rows.find((r) => r.crown) || {}).id;
    rows = newRows || [];
    const lead = rows.find((r) => r.crown);
    if (lead && prevLeader && lead.id !== prevLeader && lead.id === you) TW.Sound.play('crownTaken');
    drawIdle();
  }

  function setMissions(list) {
    missions = list || [];
    drawIdle();
  }

  function missionComplete(payload) {
    TW.Sound.play('missionDone');
    TW.showMatchNotification(`Mission complete: ${payload.mission.label}${payload.coins ? ` (+${payload.coins} coins)` : ''}`);
  }

  // ---- spike alert in the strip -----------------------------------------------
  function spikeAlert(payload) {
    const el = strip();
    if (!el) return;
    mode = 'alert';
    clearInterval(alertTimer);
    clearTimeout(resultTimer);
    let left = Math.max(1, Math.round(payload.inSeconds));
    TW.Sound.play('spikeAlert');
    const draw = () => {
      el.className = `match-strip ms-alert${reduceMotion ? '' : ' ms-pulse'}`;
      el.innerHTML = `<span class="ms-spike">${icon('spike', 16)}<b>Spike incoming</b> in <span class="ms-count">${left}s</span></span><span class="ms-note">Real move from the data. Direction unknown.</span>`;
    };
    draw();
    alertTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(alertTimer);
        el.innerHTML = `<span class="ms-spike">${icon('spike', 16)}<b>Spike now</b></span>`;
        return;
      }
      draw();
    }, 1000);
  }

  function spikeResult(payload) {
    const el = strip();
    if (!el) return;
    clearInterval(alertTimer);
    mode = 'result';
    const pct = Number(payload.movePct) || 0;
    el.className = 'match-strip ms-result';
    el.innerHTML = `<span class="ms-spike">${icon('spike', 16)}<b>Spike ${TW.escapeHtml(payload.symbol)}</b> <span class="${pct >= 0 ? 'text-buy' : 'text-sell'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span></span>`;
    resultTimer = setTimeout(() => {
      mode = 'idle';
      drawIdle();
    }, (payload.showSeconds || 4) * 1000);
  }

  // ---- result screen extras ---------------------------------------------------
  function renderResults(overlay, me, payload) {
    if (!overlay || !me || !me.fire) return;
    const f = me.fire;
    const pr = f.progress || null;
    const panel = document.createElement('div');
    panel.className = 'fire-results';
    const missionsHtml = (f.missions || []).map((m) => `<li class="${m.done ? 'done' : ''}">${m.done ? icon('check', 14) : icon('plus', 14)} ${TW.escapeHtml(m.label)}${m.done && m.coins ? ` <b>+${m.coins} coins</b>` : ''}</li>`).join('');
    const lvl = pr && pr.level;
    const levelUp = pr && pr.levelAfter > pr.levelBefore;
    panel.innerHTML = `
      <div class="fr-stats">
        <div><span class="fr-k">${icon('heat', 14)} Heat</span><strong>${Math.round(f.heat)}</strong></div>
        <div><span class="fr-k">Best streak</span><strong>${f.bestStreak}</strong></div>
        <div><span class="fr-k">Cards earned</span><strong>${f.cardsEarned}</strong></div>
        ${pr ? `<div><span class="fr-k">XP</span><strong>+${pr.xpGained}${pr.capped ? ' (daily cap)' : ''}</strong></div>` : ''}
      </div>
      ${missionsHtml ? `<ul class="fr-missions">${missionsHtml}</ul>` : ''}
      ${lvl ? `<div class="fr-level${levelUp ? ' fr-levelup' : ''}">
        <div class="fr-level-head"><b>Level ${lvl.level}</b>${levelUp ? '<span class="fr-up">Level up</span>' : ''}<span>${lvl.nextLevelXp ? `${lvl.xp - lvl.levelFloor} / ${lvl.nextLevelXp - lvl.levelFloor} XP` : 'Max level'}</span></div>
        <div class="fr-xpbar"><div style="width:${Math.round((lvl.progress || 0) * 100)}%"></div></div>
      </div>` : ''}
      ${pr && pr.unlocked && pr.unlocked.length ? `<div class="fr-unlocks"><b>Unlocked</b>${pr.unlocked.map((c) => `<span class="fr-unlock rarity-${c.rarity}">${icon(c.icon, 16)} ${TW.escapeHtml(c.name)}</span>`).join('')}<a href="/cards">Card collection</a></div>` : ''}
      <p class="fr-note">Heat is a separate score. It never changes P&amp;L, rank, prizes or ratings.</p>`;
    const actions = overlay.querySelector('.end-actions');
    overlay.insertBefore(panel, actions || null);
    if (levelUp) setTimeout(() => TW.Sound.play('levelUp'), 600);
    if (pr && pr.unlocked && pr.unlocked.length) setTimeout(() => TW.Sound.play('cardUnlocked'), levelUp ? 1500 : 600);

    if (actions && payload && payload.matchId) {
      const rematch = document.createElement('button');
      rematch.className = 'btn';
      rematch.type = 'button';
      rematch.textContent = 'Rematch';
      rematch.addEventListener('click', () => doRematch(payload.matchId, rematch));
      const challenge = document.createElement('button');
      challenge.className = 'btn btn-outline';
      challenge.type = 'button';
      challenge.textContent = 'Challenge a friend';
      challenge.addEventListener('click', () => doChallenge(payload.matchId, challenge));
      actions.insertBefore(challenge, actions.firstChild ? actions.firstChild.nextSibling : null);
      actions.insertBefore(rematch, challenge);
    }
  }

  async function doRematch(matchId, btn) {
    btn.disabled = true;
    try {
      const r = await TW.api('/api/match/rematch', { method: 'POST', body: { matchId } });
      if (r.matchId) window.location.href = `/lobby.html?matchId=${r.matchId}`;
    } catch (e) {
      TW.toast(e.message || 'Rematch failed', 'danger');
      btn.disabled = false;
    }
  }

  async function doChallenge(matchId, btn) {
    btn.disabled = true;
    try {
      const r = await TW.api('/api/challenge', { method: 'POST', body: { matchId } });
      const text = `I made ${TW.formatMoney(r.result.pnl)} on this market. Same chart, same seconds. Beat me.`;
      if (navigator.share) {
        await navigator.share({ title: 'Spike & Crush challenge', text, url: r.url }).catch(() => {});
      } else {
        showShare(r.url, text);
      }
    } catch (e) {
      TW.toast(e.message || 'Could not create the challenge', 'danger');
    }
    btn.disabled = false;
  }

  function showShare(url, text) {
    const box = document.createElement('div');
    box.className = 'fire-sheet';
    box.innerHTML = `<div class="fs-panel"><div class="fs-head"><strong>Challenge a friend</strong><button type="button" class="fs-close" aria-label="Close">&times;</button></div>
      <p class="fs-desc">They play the exact same market. The link expires in 7 days.</p>
      <input class="fs-link" readonly value="${TW.escapeHtml(url)}" aria-label="Challenge link" />
      <div class="fs-quick">
        <button type="button" data-copy>Copy link</button>
        <a href="https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}" target="_blank" rel="noopener">WhatsApp</a>
        <a href="https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}" target="_blank" rel="noopener">X</a>
      </div></div>`;
    document.body.appendChild(box);
    box.querySelector('.fs-close').addEventListener('click', () => box.remove());
    box.querySelector('[data-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        TW.toast('Link copied', 'success');
      } catch (e) {
        box.querySelector('.fs-link').select();
      }
    });
  }

  return { setYou, setLeaderboard, setMissions, missionComplete, spikeAlert, spikeResult, renderResults, drawIdle };
})();
