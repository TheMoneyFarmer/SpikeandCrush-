'use strict';

// The lobby (/play, index.html): ticker, brand band stats, sponsor strip,
// player card, featured competition hero, mode strip / mobile mode sheet,
// competitions list, leaderboard and activity feed. Desktop and mobile are
// the same markup and the same data (/api/lobby/stats is the one stats
// source); css/lobby-home.css decides the layout. Every module has a
// loading skeleton, an empty state, an error state with retry and a normal
// state. Every prize and win is shown in coins - coins have no cash value.
(function () {
  window.TW = window.TW || {};

  const $ = (id) => document.getElementById(id);
  const esc = (s) => TW.escapeHtml(s);
  const ic = (name, size = 20) => TW.icon(name, { size });
  const fmt = (n) => Number(n || 0).toLocaleString();
  const coinsHtml = (n, cls = '') => `<span class="lb-coin-amt ${cls}">${ic('coin', 16)}<span>${fmt(n)}</span><span class="lb-coin-unit">coins</span></span>`;

  const STATS_REFRESH_MS = 15000;
  const SLOW_REFRESH_MS = 60000;
  // (competition names come from the server: Daily Open, Weekend Open)
  const MODE_LABEL = { quick: 'Quick War', blitz: 'Blitz War', grand: 'Grand War', solo: 'Solo Ranked', private: 'Private War', async: 'Daily Challenge', tournament: 'Tournament' };

  const state = {
    stats: null,
    lastPrices: new Map(),
    mine: new Set(),
    featured: null,
    templates: null,
    impressionsSent: new Set(),
  };

  function errorBox(message, retryId) {
    return `<div class="lb-state lb-error" role="alert">${ic('alert', 18)}<span>${esc(message)}</span><button type="button" class="lb-btn lb-btn-dark lb-retry" id="${retryId}">${ic('refresh', 16)}<span>Retry</span></button></div>`;
  }
  const emptyBox = (html) => `<div class="lb-state lb-empty">${html}</div>`;

  function span(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
    return `${m}m ${String(sec).padStart(2, '0')}s`;
  }
  const shortSpan = (ms) => span(ms).split(' ').slice(0, 2).join(' ');

  function prizeCoins(c) {
    if (Number(c.prize_pool_coins) > 0) return Number(c.prize_pool_coins);
    return (Array.isArray(c.prize_payouts) ? c.prize_payouts : []).reduce((s, p) => s + (Number(p.coins) || 0), 0);
  }

  // ---- 1. ticker ----------------------------------------------------------------

  function renderTicker(rows, failed) {
    const track = $('lbTickerTrack');
    if (!track) return;
    if (rows) rows.forEach((r) => state.lastPrices.set(r.symbol, { ...r, stale: false }));
    if (failed) state.lastPrices.forEach((v) => { v.stale = true; });
    const items = Array.from(state.lastPrices.values());
    if (!items.length) {
      track.innerHTML = `<span class="lb-tick lb-tick-stale">Prices unavailable right now</span>`;
      track.classList.remove('is-scrolling');
      return;
    }
    const html = items
      .map((r) => {
        const dir = r.changePct > 0 ? 'up' : r.changePct < 0 ? 'down' : 'flat';
        const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
        return `<span class="lb-tick ${r.stale ? 'lb-tick-stale' : ''}"><span class="sym">${esc(r.symbol)}</span><span class="px">${esc(Number(r.price).toLocaleString(undefined, { maximumFractionDigits: 5 }))}</span><span class="chg ${dir}">${arrow}${arrow ? ' ' : ''}${Math.abs(r.changePct).toFixed(2)}%</span></span>`;
      })
      .join('');
    // Second copy (aria-hidden) makes the -50% scroll loop seamless.
    track.innerHTML = `<span class="lb-tick-set">${html}</span><span class="lb-tick-set" aria-hidden="true">${html}</span>`;
    track.classList.add('is-scrolling');
  }

  // ---- 3. brand band stats -------------------------------------------------------

  function renderStats(stats) {
    const el = $('lbStats');
    if (!el) return;
    const allZero = !stats.matchesToday && !stats.activePlayers && !stats.largestWinCoins && !stats.coinsWonToday;
    if (allZero) {
      el.innerHTML = `<div class="lb-stats-empty">${ic('flag', 18)}<span>${esc(stats.emptyMessage || 'Season 1 is live. Be one of the first traders on the board.')}</span></div>`;
      return;
    }
    // Short labels replace the full ones on phones so nothing is clipped.
    const tile = (label, short, value) =>
      `<div class="lb-stat"><div class="lb-stat-label"><span class="lb-full">${label}</span><span class="lb-short" aria-hidden="true">${short}</span></div><div class="lb-stat-value">${value}</div></div>`;
    el.innerHTML = [
      tile('Matches today', 'Matches', fmt(stats.matchesToday)),
      tile('Active players', 'Players', fmt(stats.activePlayers)),
      tile('Largest win today', 'Top win', coinsHtml(stats.largestWinCoins, 'gold')),
      tile('Coins won today', 'Won today', coinsHtml(stats.coinsWonToday, 'gold')),
    ].join('');
  }

  // ---- 4. sponsors -------------------------------------------------------------------

  // The strip is the lobby_strip sponsor slot (js/sponsor-slots.js): the
  // server picks the sponsors; the section shows only when there are some.
  let sponsorsScanned = false;
  function renderSponsors() {
    const wrap = $('lbSponsors');
    if (sponsorsScanned) return;
    sponsorsScanned = true;
    if (!wrap || !window.TW || !TW.SponsorSlots) return;
    TW.SponsorSlots.scan(wrap).then(() => wrap.classList.toggle('hidden', $('lbSponsorLogos').hidden));
  }

  // ---- 5a. player card + mobile profile row --------------------------------------------

  function ring(pct, inner) {
    const r = 44;
    const c = 2 * Math.PI * r;
    return `<span class="lb-ring">
      <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="${r}" class="lb-ring-track"/><circle cx="50" cy="50" r="${r}" class="lb-ring-fill" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(1)}"/></svg>
      <span class="lb-ring-avatar">${inner}</span></span>`;
  }

  function renderPlayer(me) {
    const card = $('lbPlayer');
    const cached = TW.getPlayer() || {};
    const p = me || {
      username: cached.username,
      tier: cached.tier || 'Recruit',
      rating: Number(cached.war_rating || 0),
      progressPct: TW.tierProgressPct ? TW.tierProgressPct(cached.war_rating) : 0,
      nextTier: null,
      totalMatches: cached.total_matches || 0,
      winRate: cached.total_matches ? Math.round(((cached.wins || 0) / cached.total_matches) * 100) : null,
      streak: null,
      coins: cached.coins || 0,
    };
    const avatarPlayer = { ...cached, username: p.username };
    const played = p.totalMatches > 0;
    if (card) {
      card.innerHTML = `
        <div class="lb-player-top">
          ${ring(p.progressPct || 0, TW.createAvatar(avatarPlayer, 'xl'))}
          <div class="lb-player-id">
            <div class="lb-handle">${TW.renderUsername(avatarPlayer)}</div>
            ${TW.tierBadge(p.tier)}
          </div>
        </div>
        <div class="lb-progress-block">
          <div class="lb-progress-label"><span>Progress to ${esc(p.nextTier || 'top tier')}</span><span>${p.progressPct || 0}%</span></div>
          <div class="lb-progress" role="progressbar" aria-label="Progress to next tier" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.progressPct || 0}"><span style="width:${p.progressPct || 0}%"></span></div>
        </div>
        <div class="lb-player-tiles">
          <div class="lb-tile"><div class="lb-stat-label">Rating</div><div class="lb-tile-value">${played ? fmt(p.rating) : '—'}</div></div>
          <div class="lb-tile"><div class="lb-stat-label">Win rate</div><div class="lb-tile-value">${played && p.winRate !== null ? `${p.winRate}%` : '—'}</div></div>
          <div class="lb-tile"><div class="lb-stat-label">Streak</div><div class="lb-tile-value">${played && p.streak !== null && p.streak !== undefined ? p.streak : '—'}</div></div>
        </div>
        <a class="lb-btn lb-btn-dark lb-btn-block" href="/profile">${ic('user', 18)}<span>View profile</span></a>`;
    }
    const row = $('lbMProfile');
    if (row) {
      row.innerHTML = `
        <a class="lb-mp-avatar" href="/profile" aria-label="Your profile">${TW.createAvatar(avatarPlayer, 'lg')}</a>
        <div class="lb-mp-meta">
          <div class="lb-mp-handle">${TW.renderUsername(avatarPlayer)}</div>
          <div class="lb-mp-tier">${TW.tierBadge(p.tier)}<span class="lb-progress lb-progress-sm"><span style="width:${p.progressPct || 0}%"></span></span></div>
        </div>
        <a class="lb-coins" href="/wallet" aria-label="${fmt(p.coins)} coins">${ic('coin', 16)}<span>${fmt(p.coins)}</span></a>
        <button type="button" class="lb-icon-btn" id="lbMDiscover" data-discover-toggle aria-controls="twDiscover" aria-expanded="false" aria-label="Discover players">${ic('search')}</button>
        <button type="button" class="lb-icon-btn" id="lbMBell" aria-label="Notifications">${ic('bell')}<span class="lb-unread-dot hidden" id="lbMBellDot" aria-hidden="true"></span></button>`;
      $('lbMBell').addEventListener('click', (e) => {
        e.stopPropagation();
        $('twNotifBtn')?.click();
      });
      syncBellDot();
    }
  }

  // The mobile bell mirrors the top bar's unread state.
  function syncBellDot() {
    const badge = $('twNotifBadge');
    const dot = $('lbMBellDot');
    if (dot && badge) dot.classList.toggle('hidden', badge.classList.contains('hidden'));
  }

  async function loadPlayer() {
    renderPlayer(null);
    try {
      renderPlayer(await TW.api('/api/lobby/me'));
    } catch (e) {
      // Cached player from login stays on screen.
    }
  }

  // ---- 5b. hero ---------------------------------------------------------------------

  let countdownTimer = null;
  let lastAnnounced = '';

  // The hero features our own competition: the Daily Open on weekdays, the
  // Weekend Open at weekends. Coming soon until live data exists; the only
  // actions are Notify me and Details (no Enter, no coin figures).
  function renderHero(_unused, failed) {
    const el = $('lbHeroInner');
    if (!el) return;
    clearInterval(countdownTimer);
    if (failed && !state.templates) {
      el.innerHTML = errorBox('Could not load the featured competition.', 'lbHeroRetry');
      $('lbHeroRetry').addEventListener('click', loadCompetitions);
      return;
    }
    const list = state.templates || [];
    if (!list.length) {
      el.innerHTML = `
        <div class="lb-hero-empty">
          <div class="lb-label">Competitions</div>
          <div class="lb-hero-title lb-hero-title-sm">Free competitions with money prizes are coming soon.</div>
          <a class="lb-link-gold" href="/competitions">See the competitions ${ic('arrowRight', 16)}</a>
          <div class="lb-hero-actions"><button type="button" class="lb-btn lb-btn-outline" id="lbHeroQuick">${ic('bolt', 18)}<span>Quick play · ${quickMinutes()} min</span></button></div>
        </div>`;
      $('lbHeroQuick').addEventListener('click', () => $('modeQuickBtn')?.click());
      return;
    }
    const weekend = [0, 6].includes(new Date().getDay());
    const t = list.find((x) => x.key === (weekend ? 'weekend' : 'daily')) || list[0];
    const waiting = t.waitlist.count ? Number(t.waitlist.count).toLocaleString('en-US') : 'Be first';
    el.innerHTML = `
      <div class="lb-hero-top">
        <span class="lb-soon">Coming soon</span>
        <span class="lb-label">${esc(t.scheduleText)}${t.marketsLabel ? ` · weekend markets: ${esc(t.marketsLabel)}` : ''}</span>
      </div>
      <h1 class="lb-hero-title">${esc(t.title)}</h1>
      <div class="lb-presented" data-slot="competition_card" data-target="${esc(t.sponsorTarget)}" data-variant="line" hidden></div>
      <div class="lb-hero-nums">
        <div><div class="lb-stat-label">Prize</div><div class="lb-hero-num gold">${esc(t.prize.amount || t.prize.label)}</div></div>
        <div><div class="lb-stat-label">Entry</div><div class="lb-hero-num">Free</div></div>
        <div><div class="lb-stat-label">Waiting</div><div class="lb-hero-num">${esc(waiting)}</div></div>
      </div>
      <div class="lb-hero-actions">
        ${t.waitlist.joined
          ? `<button type="button" class="lb-btn lb-btn-outline lb-btn-xl" id="lbHeroNotify" data-leave="${esc(t.key)}">${ic('check', 20)}<span>You're on the list</span></button>`
          : `<button type="button" class="lb-btn lb-btn-gold lb-btn-xl" id="lbHeroNotify" data-join="${esc(t.key)}">${ic('bell', 20)}<span>Notify me</span></button>`}
        <a class="lb-btn lb-btn-outline lb-btn-lg" href="${esc(t.detailUrl)}">Details</a>
        <button type="button" class="lb-btn lb-btn-outline lb-btn-lg" id="lbHeroQuick">${ic('bolt', 18)}<span>Quick play · ${quickMinutes()} min</span></button>
      </div>`;
    if (window.TW && TW.SponsorSlots) TW.SponsorSlots.scan(el);
    $('lbHeroQuick').addEventListener('click', () => $('modeQuickBtn')?.click());
    $('lbCountdownLive').textContent = `${t.title}: coming soon`;
  }

  function quickMinutes() {
    const quick = state.stats?.modes?.find((m) => m.key === 'quick');
    return quick ? Math.round(quick.durationSeconds / 60) : 10;
  }

  // ---- mode strip / mobile mode sheet -------------------------------------------------

  function renderModes(modes) {
    // One icon per mode so the tiles read at a glance.
    const MODE_ICON = { quick: 'swords', blitz: 'bolt', grand: 'crown', solo: 'target', async: 'clock', private: 'lock', tournament: 'trophy' };
    document.querySelectorAll('.lb-mode').forEach((btn) => {
      const el = btn.querySelector('.lb-mode-ic');
      if (el) el.innerHTML = ic(MODE_ICON[btn.dataset.mode] || 'bolt', 22);
    });
    (modes || []).forEach((m) => {
      const el = document.querySelector(`[data-dur="${m.key}"]`);
      if (el) el.textContent = `${Math.round(m.durationSeconds / 60)} min`;
      const btn = document.querySelector(`.lb-mode[data-mode="${m.key}"]`);
      if (btn) btn.setAttribute('aria-label', `${m.label}, ${Math.round(m.durationSeconds / 60)} minutes${m.entryCoins ? `, ${m.entryCoins} coins entry` : ''}`);
    });
  }

  function setSheet(open) {
    document.body.classList.toggle('lb-sheet-open', open);
    $('lbSheetBackdrop')?.classList.toggle('hidden', !open);
    if (open) $('modeQuickBtn')?.focus();
  }
  TW.openModeSheet = () => setSheet(true);
  TW.closeModeSheet = () => setSheet(false);

  // ---- 5c. competitions list ------------------------------------------------------------

  async function loadMine() {
    if (!TW.isLoggedIn()) return;
    try {
      const { competitions = [] } = await TW.api('/api/competitions-mine');
      state.mine = new Set(competitions.map((m) => m.competitionId));
    } catch (e) {
      // Not fatal - rows just show Enter instead of Continue.
    }
  }

  let compWired = false;
  function wireComps() {
    if (compWired || !window.TW || !TW.CompTemplates) return;
    compWired = true;
    const root = document.getElementById('lbMain') || document.body;
    TW.CompTemplates.wire(root, loadCompetitions);
  }

  async function loadCompetitions() {
    wireComps();
    const list = $('lbCompList');
    try {
      const [tpl, mineRes] = await Promise.all([
        TW.CompTemplates.fetchTemplates(),
        TW.isLoggedIn() ? TW.api('/api/competitions-mine').catch(() => ({ competitions: [] })) : Promise.resolve({ competitions: [] }),
      ]);
      state.templates = (tpl.templates || []).filter((t) => t.prize && t.prize.kind !== 'coins');
      renderHero();
      if (!list) return;
      // Runs the player already entered before the change: they can carry on.
      const entered = (mineRes.competitions || []).filter((m) => m.status !== 'ended' && m.lifecycle !== 'void' && m.status !== 'void');
      const rows = state.templates.map((t) => `
          <div class="lb-comp-row">
            <div class="lb-comp-name">
              <span class="lb-comp-title">${esc(t.title)}</span>
              <span class="lb-comp-sub">Coming soon · ${esc(t.scheduleText)}${t.waitlist.count ? ` · ${fmt(t.waitlist.count)} waiting` : ''}</span>
            </div>
            <div class="lb-comp-prize">
              <span class="lb-comp-pool gold">${esc(t.prize.amount || t.prize.label)}</span>
              <span class="lb-comp-entry">free entry</span>
            </div>
            ${t.waitlist.joined
              ? `<button type="button" class="lb-btn lb-btn-dark lb-comp-btn" data-leave="${esc(t.key)}" aria-label="You're on the list for ${esc(t.title)}. Leave the list">On the list</button>`
              : `<button type="button" class="lb-btn lb-btn-dark lb-comp-btn" data-join="${esc(t.key)}" aria-label="Notify me when ${esc(t.title)} opens">Notify me</button>`}
          </div>`);
      for (const m of entered) {
        rows.push(`
          <div class="lb-comp-row">
            <div class="lb-comp-name">
              <span class="lb-comp-title">${esc(m.title || 'Your competition')}</span>
              <span class="lb-comp-sub">You entered this run</span>
            </div>
            <div class="lb-comp-prize"></div>
            <a class="lb-btn lb-btn-gold lb-comp-btn" href="/competition/${esc(m.competitionId)}">Continue</a>
          </div>`);
      }
      list.innerHTML = rows.join('') || emptyBox(`<span>Free competitions are coming soon.</span><a class="lb-link-gold" href="/competitions">See the competitions ${ic('arrowRight', 16)}</a>`);
    } catch (e) {
      if (list) {
        list.innerHTML = errorBox('Could not load competitions.', 'lbCompRetry');
        $('lbCompRetry').addEventListener('click', loadCompetitions);
      }
      renderHero(null, true);
    }
  }

  // ---- 6a. leaderboard ---------------------------------------------------------------

  async function loadBoard() {
    const el = $('lbBoard');
    if (!el) return;
    try {
      const data = await TW.api('/api/leaderboard?limit=10');
      const rows = data.leaderboard || [];
      const me = TW.getPlayer();
      if (!rows.length) {
        el.innerHTML = emptyBox(`${ic('trophy', 22)}<span>No one on the board yet. Play a match to take rank 1.</span>`);
        return;
      }
      const podium = rows.slice(0, 3);
      const order = [1, 0, 2].filter((i) => podium[i]);
      const podiumHtml = order
        .map((i) => {
          const r = podium[i];
          return `<div class="lb-pod lb-pod-${i + 1} ${me && r.id === me.id ? 'is-me' : ''}">
            ${TW.createAvatar(r, i === 0 ? 'lg' : 'md')}
            <div class="lb-pod-name">${TW.renderUsername(r)}</div>
            <div class="lb-pod-score">${fmt(r.metric)}</div>
            <div class="lb-pod-step">${i + 1}</div>
          </div>`;
        })
        .join('');
      const row = (r, extra = '') => `
        <li class="lb-board-row ${extra}">
          <span class="lb-board-rank">${r.rank}</span>
          ${TW.createAvatar(r, 'sm')}
          <span class="lb-board-name">${TW.renderUsername(r)}</span>
          ${TW.tierBadge(r.tier)}
          <span class="lb-board-score">${fmt(r.metric)}</span>
        </li>`;
      const rest = rows.slice(3).map((r) => row(r, me && r.id === me.id ? 'is-me' : '')).join('');
      const you = data.viewerRank
        ? row(data.viewerRank, 'is-me is-you')
        : me && !rows.some((r) => r.id === me.id)
        ? `<li class="lb-board-row is-me is-you"><span class="lb-board-rank">—</span>${TW.createAvatar(me, 'sm')}<span class="lb-board-name">You</span><span class="lb-board-score lb-muted">Play a ranked match to get a rank</span></li>`
        : '';
      el.innerHTML = `
        <div class="lb-podium">${podiumHtml}</div>
        <div class="lb-board-head"><span>Rank</span><span>Player</span><span>Rating</span></div>
        <ol class="lb-board-list">${rest}${you}</ol>`;
    } catch (e) {
      el.innerHTML = errorBox('Could not load the leaderboard.', 'lbBoardRetry');
      $('lbBoardRetry').addEventListener('click', loadBoard);
    }
  }

  // ---- 6b. activity feed --------------------------------------------------------------

  async function loadFeed() {
    const el = $('lbFeed');
    if (!el) return;
    try {
      const res = await fetch('/api/stats/activity');
      if (!res.ok) throw new Error('bad');
      const { activity = [] } = await res.json();
      if (!activity.length) {
        el.innerHTML = emptyBox(`${ic('megaphone', 22)}<span>Nothing yet. Matches, wins and competition results will show here.</span>`);
        return;
      }
      el.innerHTML = `<ul class="lb-feed-list">${activity
        .map((a) => {
          const what =
            a.kind === 'competition'
              ? `won <strong>${esc(a.competitionTitle)}</strong>${a.prizeCoins ? ` · ${coinsHtml(a.prizeCoins, 'gold')}` : ''}`
              : `won a ${esc(MODE_LABEL[a.mode] || a.mode)}`;
          return `<li class="lb-feed-row"><span class="lb-feed-ic ${a.kind === 'competition' ? 'gold' : ''}">${ic(a.kind === 'competition' ? 'crown' : 'trophy', 18)}</span><span class="lb-feed-text"><strong>${esc(a.winnerUsername)}</strong> ${what}</span><time class="lb-feed-time" datetime="${esc(a.endTime || '')}">${esc(TW.timeAgo(a.endTime))}</time></li>`;
        })
        .join('')}</ul>`;
    } catch (e) {
      el.innerHTML = errorBox('Could not load activity.', 'lbFeedRetry');
      $('lbFeedRetry').addEventListener('click', loadFeed);
    }
  }

  // ---- stats (ticker + brand band + sponsors + hero) ---------------------------------

  let statsFailures = 0;
  async function loadStats(force) {
    try {
      const res = await fetch(`/api/lobby/stats${force ? `?t=${Date.now()}` : ''}`);
      if (!res.ok) throw new Error(`stats ${res.status}`);
      const stats = await res.json();
      statsFailures = 0;
      state.stats = stats;
      renderTicker(stats.ticker, false);
      renderStats(stats);
      renderSponsors();
      renderModes(stats.modes);
      state.featured = stats.featured;
    } catch (e) {
      statsFailures++;
      renderTicker(null, true);
      if (!state.stats) {
        $('lbStats').innerHTML = errorBox('Could not load today’s stats.', 'lbStatsRetry');
        $('lbStatsRetry').addEventListener('click', () => loadStats(true));
        renderModes(null);
      }
    }
  }

  // ---- announcement banner (Communications > Announcements) -------------------------

  function renderAnnouncement(a) {
    const el = $('twAnnouncementBanner');
    if (!el) return;
    if (!a) { el.innerHTML = ''; return; }
    let dismissed = [];
    try { dismissed = JSON.parse(localStorage.getItem('tw_dismissed_announcements') || '[]'); } catch (e) {}
    if (dismissed.includes(a.id)) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="tw-announcement-banner type-${esc(a.type)}"><span>${esc(a.title)}${a.message ? ` — ${esc(a.message)}` : ''}</span><button class="close-btn" aria-label="Dismiss">${ic('close', 16)}</button></div>`;
    el.querySelector('.close-btn').addEventListener('click', () => {
      dismissed.push(a.id);
      try { localStorage.setItem('tw_dismissed_announcements', JSON.stringify(dismissed)); } catch (e) {}
      el.innerHTML = '';
    });
  }
  TW.renderAnnouncement = renderAnnouncement;

  async function loadAnnouncement() {
    try {
      const res = await fetch('/api/announcements/active');
      const list = await res.json();
      renderAnnouncement(list[0] || null);
    } catch (e) {
      // Banner just stays hidden.
    }
  }

  // main.js's login handler calls this after an in-page login.
  TW.refreshHubData = () => {
    loadPlayer();
    loadCompetitions();
    loadBoard();
  };

  document.addEventListener('DOMContentLoaded', () => {
    if (!TW.isLoggedIn()) return; // main.js redirects to the landing page
    $('lbSheetClose').innerHTML = ic('close', 20);
    renderModes(null);
    loadStats();
    loadPlayer();
    loadCompetitions();
    loadBoard();
    loadFeed();
    loadAnnouncement();
    setInterval(() => { if (!document.hidden) loadStats(); }, STATS_REFRESH_MS);
    setInterval(() => {
      if (document.hidden) return;
      loadCompetitions();
      loadBoard();
      loadFeed();
    }, SLOW_REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStats(); });

    $('lbSheetBackdrop').addEventListener('click', () => setSheet(false));
    $('lbSheetClose').addEventListener('click', () => setSheet(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSheet(false); });
    // Mode buttons close the sheet before their own handlers (main.js) run.
    document.querySelectorAll('.lb-mode').forEach((b) => b.addEventListener('click', () => setSheet(false)));
    if (new URLSearchParams(location.search).get('modes') === '1') setSheet(true);

    const badge = $('twNotifBadge');
    if (badge) new MutationObserver(syncBellDot).observe(badge, { attributes: true, attributeFilter: ['class'] });

    if (TW.Sound) TW.Sound.startAmbient();
  });
  window.addEventListener('pagehide', () => {
    if (TW.Sound) TW.Sound.stopAmbient();
  });
})();
