'use strict';

window.TW = window.TW || {};

// Home-page-only visual enhancements (particle candles, typing tagline, stats
// bar, featured match). Deliberately kept separate from main.js so the
// verified login/register/menu logic in main.js is never touched.
(function () {
  function spawnCandles() {
    const wrap = document.getElementById('twHeroParticles');
    if (!wrap) return;
    for (let i = 0; i < 22; i++) {
      const el = document.createElement('div');
      const isBull = Math.random() < 0.5;
      const color = isBull ? '#00c896' : '#ff4444';
      el.className = `tw-hero-candle ${isBull ? 'tw-candle-up' : 'tw-candle-down'}`;
      const height = 20 + Math.random() * 60;
      el.style.left = `${Math.random() * 100}%`;
      el.style.height = `${height}px`;
      el.style.background = color;
      el.style.setProperty('--candle-color', color);
      el.style.animationDuration = `${14 + Math.random() * 12}s`;
      el.style.animationDelay = `${Math.random() * -20}s`;
      wrap.appendChild(el);
    }
  }

  function typeTagline() {
    const el = document.getElementById('twHeroTagline');
    if (!el) return;
    const text = 'Up. Then not.';
    let i = 0;
    el.textContent = '';
    const caret = document.createElement('span');
    caret.className = 'tw-caret';
    el.appendChild(document.createTextNode(''));
    el.appendChild(caret);

    const timer = setInterval(() => {
      i++;
      el.firstChild.textContent = text.slice(0, i);
      if (i >= text.length) clearInterval(timer);
    }, 45);
  }

  async function loadStatsBar() {
    const el = document.getElementById('twStatsBar');
    if (!el) return;
    try {
      const res = await fetch('/api/stats/home');
      if (!res.ok) throw new Error('stats unavailable');
      const data = await res.json();
      el.innerHTML = `
        <div class="tw-stat-card"><div class="value">${data.matchesToday}</div><div class="label">Matches Today</div></div>
        <div class="tw-stat-card"><div class="value">${data.activePlayers}</div><div class="label">Active Players</div></div>
        <div class="tw-stat-card"><div class="value">${TW.formatMoney(data.largestWinToday)}</div><div class="label">Largest Win Today</div></div>
        <div class="tw-stat-card"><div class="value">🪙 ${data.coinsWonToday}</div><div class="label">Coins Won Today</div></div>
      `;
    } catch (e) {
      el.innerHTML = '';
    }
  }

  async function loadFeaturedMatch() {
    const el = document.getElementById('twFeaturedMatch');
    if (!el) return;
    try {
      const res = await fetch('/api/stats/featured-match');
      if (!res.ok) throw new Error('none');
      const data = await res.json();
      if (!data.matchId) {
        el.classList.add('hidden');
        return;
      }
      el.classList.remove('hidden');
      el.innerHTML = `
        <div>
          <div style="font-weight:700;">🔴 Live War in progress</div>
          <div class="text-secondary" style="font-size:12px;">${data.playerCount} traders · ${data.timeRemainingLabel} left</div>
        </div>
        <a class="btn btn-outline" href="/spectate.html?matchId=${data.matchId}">Watch Live</a>
      `;
    } catch (e) {
      el.classList.add('hidden');
    }
  }

  async function loadTicker() {
    const track = document.getElementById('twTickerTrack');
    if (!track) return;
    try {
      const res = await fetch('/api/stats/ticker');
      const data = await res.json();
      const itemsHtml = data.rows
        .map((r) => {
          const dir = r.changePct > 0 ? 'up' : r.changePct < 0 ? 'down' : '';
          const arrow = r.changePct > 0 ? '▲' : r.changePct < 0 ? '▼' : '·';
          return `<span class="tw-ticker-item"><span class="sym">${r.symbol}</span><span>${r.price}</span><span class="chg ${dir}">${arrow} ${Math.abs(r.changePct)}%</span></span>`;
        })
        .join('');
      // Duplicated once so the CSS -50% translateX loop is seamless.
      track.innerHTML = itemsHtml + itemsHtml;
    } catch (e) {
      track.innerHTML = '';
    }
  }

  async function loadActivityFeed() {
    const el = document.getElementById('activityFeed');
    if (!el) return;
    try {
      const res = await fetch('/api/stats/activity');
      const data = await res.json();
      if (!data.activity.length) {
        el.innerHTML = 'No matches finished yet today.';
        return;
      }
      const modeLabels = { quick: 'Quick War', blitz: 'Blitz War', grand: 'Grand War', solo: 'Solo Ranked', private: 'Private War', async: 'Daily Challenge', tournament: 'Tournament' };
      el.innerHTML = data.activity
        .map((a) => {
          const mins = Math.max(0, Math.round((Date.now() - new Date(a.endTime).getTime()) / 60000));
          const when = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
          return `<div class="tw-activity-row"><span>🏆 <strong>${TW.escapeHtml(a.winnerUsername)}</strong> won a ${modeLabels[a.mode] || a.mode}</span><span>${when}</span></div>`;
        })
        .join('');
    } catch (e) {
      el.innerHTML = 'Could not load activity.';
    }
  }

  async function loadHotStreaks() {
    const el = document.getElementById('hotStreaks');
    if (!el) return;
    try {
      const res = await fetch('/api/stats/hot-streaks');
      const data = await res.json();
      if (!data.streaks.length) {
        el.innerHTML = 'No one is on a streak right now.';
        return;
      }
      el.innerHTML = data.streaks
        .map((s) => `<div class="tw-streak-row"><span>🔥 <strong>${TW.escapeHtml(s.username)}</strong></span><span>${s.streak} wins in a row</span></div>`)
        .join('');
    } catch (e) {
      el.innerHTML = 'Could not load streaks.';
    }
  }

  async function loadWarLordSpotlight() {
    const el = document.getElementById('warLordSpotlight');
    if (!el) return;
    try {
      const res = await fetch('/api/stats/war-lord-spotlight');
      const data = await res.json();
      if (!data.player) {
        el.innerHTML = 'No War Lord has emerged yet.';
        return;
      }
      el.innerHTML = `
        <div class="crown">👑</div>
        <div class="name">${TW.escapeHtml(data.player.username)}</div>
        <div class="meta">${data.player.tier} · ${data.player.warRating} rating · ${data.player.wins} wins</div>
      `;
    } catch (e) {
      el.innerHTML = 'Could not load spotlight.';
    }
  }

  async function loadBrokerPartners() {
    const panel = document.getElementById('brokerPartnersPanel');
    if (!panel) return;
    try {
      const res = await fetch('/api/stats/broker-partners');
      const data = await res.json();
      if (!data.partners.length) return;
      const byTier = { title: [], official: [], featured: [] };
      data.partners.forEach((p) => { (byTier[p.tier] || byTier.featured).push(p); });
      const tierLabels = { title: 'Title Sponsor', official: 'Official Broker Partners', featured: 'Featured Partners' };
      const list = document.getElementById('brokerPartnersList');
      list.innerHTML = Object.entries(byTier)
        .filter(([, partners]) => partners.length)
        .map(
          ([tier, partners]) => `
            <div class="tw-broker-tier" data-tier="${tier}">
              <div class="tw-broker-tier-label">${tierLabels[tier]}</div>
              <div class="tw-broker-row">
                ${partners.map((p) => `<a class="tw-broker-chip" href="${p.referralUrl || '#'}" target="_blank" rel="noopener">${TW.escapeHtml(p.name)}</a>`).join('')}
              </div>
            </div>
          `
        )
        .join('');
      panel.style.display = 'block';
    } catch (e) {
      // Leave hidden - no partners is a valid empty state, not an error worth surfacing.
    }
  }

  async function loadDailyChallengeWidget() {
    const widget = document.getElementById('dailyChallengeWidget');
    if (!widget || !TW.getToken || !TW.getToken()) return;
    try {
      const data = await TW.api('/api/async/today');
      widget.style.display = 'block';
      const meta = document.getElementById('dailyChallengeMeta');
      meta.textContent = data.alreadyPlayed
        ? `You scored ${TW.formatMoney(Number(data.myResult.pnl))} today - come back tomorrow!`
        : `${data.instruments.join(' / ')} · ${Math.floor(data.durationSeconds / 60)} min · ${data.entryCoins} coins`;
      if (data.alreadyPlayed) {
        widget.querySelector('a').textContent = 'View Leaderboard';
      }
    } catch (e) {
      // Not logged in or endpoint unavailable - leave the widget hidden.
    }
  }

  // Admin-authored banner (Communications > Announcements). Dismissal is
  // per-browser/per-announcement via localStorage, not tracked server-side -
  // the `views` counter on the announcements table is a page-load count, not
  // a unique-viewer count.
  async function loadAnnouncementBanner() {
    const el = document.getElementById('twAnnouncementBanner');
    if (!el) return;
    try {
      const res = await fetch('/api/announcements/active');
      const list = await res.json();
      renderAnnouncement(list[0] || null);
    } catch (e) {
      // Not fatal - banner just stays hidden.
    }
  }

  function renderAnnouncement(a) {
    const el = document.getElementById('twAnnouncementBanner');
    if (!el) return;
    if (!a) { el.innerHTML = ''; return; }
    let dismissed = [];
    try { dismissed = JSON.parse(localStorage.getItem('tw_dismissed_announcements') || '[]'); } catch (e) {}
    if (dismissed.includes(a.id)) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="tw-announcement-banner type-${a.type}">
        <span>${TW.escapeHtml ? TW.escapeHtml(a.title) : a.title}${a.message ? ' — ' + (TW.escapeHtml ? TW.escapeHtml(a.message) : a.message) : ''}</span>
        <button class="close-btn" aria-label="Dismiss">&times;</button>
      </div>
    `;
    el.querySelector('.close-btn').addEventListener('click', () => {
      dismissed.push(a.id);
      localStorage.setItem('tw_dismissed_announcements', JSON.stringify(dismissed));
      el.innerHTML = '';
    });
  }
  TW.renderAnnouncement = renderAnnouncement;

  document.addEventListener('DOMContentLoaded', () => {
    spawnCandles();
    loadAnnouncementBanner();
    typeTagline();
    loadStatsBar();
    loadFeaturedMatch();
    loadTicker();
    setInterval(loadTicker, 15000);
    loadActivityFeed();
    loadHotStreaks();
    loadWarLordSpotlight();
    loadDailyChallengeWidget();
    loadBrokerPartners();
    // Ambient loop plays only on the Trading Floor home screen, fading in on
    // load and out on navigation away - autoplay policy means it may not
    // actually start until the visitor's first click/keypress, same as every
    // other sound in the game (see armUnlock in sound.js).
    if (TW.Sound) TW.Sound.startAmbient();
  });
  window.addEventListener('pagehide', () => {
    if (TW.Sound) TW.Sound.stopAmbient();
  });
})();
