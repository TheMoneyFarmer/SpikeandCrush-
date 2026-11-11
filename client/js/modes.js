'use strict';

window.TW = window.TW || {};

// Per-mode match UI (server/config/modeIdentity.js sends state.modeRules):
// the pre-start banner lines, Elimination cut notices and the "Out" view,
// Grand War's half-time checkpoint card, and the result-screen highlights.
// Everything sits in the page layout - never on top of the chart.
TW.Modes = (function () {
  const esc = (s) => TW.escapeHtml(String(s == null ? '' : s));
  const icon = (k, s) => (TW.CardIcons ? TW.CardIcons.svg(k, s) : '');
  let rules = null;
  let you = null;
  let outShown = false;

  function setState(state) {
    rules = state.modeRules || null;
    you = state.you;
    const me = (state.players || []).find((p) => p.id === you);
    if (me && me.spectator && !outShown) showOutBar(me.outRound);
  }

  // Extra rows for the pre-match rules card: what this mode is, how you win,
  // the card slots and anything special (cuts, events, host rules).
  function rulesRows(state) {
    const r = state.modeRules;
    if (!r) return null;
    const rows = [];
    const cards = r.handSize === 0 ? 'Off in this mode' : `${r.handSize} slot${r.handSize === 1 ? '' : 's'}${r.sabotage === false ? ', defense only' : ''}`;
    rows.push(['Cards', cards]);
    rows.push(['Winner', r.winShort || 'Highest equity at zero']);
    if (r.elimination) {
      const notStarted = state.status === 'waiting' || state.status === 'countdown';
      rows.push(['Cuts', r.elimination.active ? `Every 3 minutes from ${fmt(r.elimination.schedule[0] || 180)}` : notStarted ? 'Bottom 20% out every 3 minutes (needs 4+ players at the start)' : 'Off: fewer than 4 players started']);
    }
    if (r.events && r.events.length) rows.push(['Market events', r.events.map((e) => `${e.minute} min`).join(', ')]);
    if (r.checkpointMinute) rows.push(['Half-time', `Standings at ${r.checkpointMinute} min`]);
    if (r.host) rows.push(['House rules', hostSummary(r.host)]);
    return { banner: r.banner || '', displayName: r.displayName, rows };
  }

  function hostSummary(h) {
    const parts = [];
    parts.push(h.cards === false ? 'cards off' : `${h.deckLevel || 'full'} deck`);
    if (h.startingHand) parts.push(`${h.startingHand} starting cards`);
    if (h.eliminationCuts) parts.push('cuts on');
    if (h.flavor && h.flavor !== 'quick') parts.push(`${h.flavor} style`);
    return parts.join(', ');
  }

  const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

  // ---- Elimination ------------------------------------------------------------
  function onWarning(payload) {
    if (TW.Fire && TW.Fire.cutWarning) TW.Fire.cutWarning(payload);
  }

  function onCut(payload) {
    const names = (payload.out || []).map((p) => (p.id === you ? 'you' : p.username));
    const saved = (payload.saved || []).length ? ` Lifeline saved ${payload.saved.map(esc).join(', ')}.` : '';
    TW.showMatchNotification(`Cut ${payload.round}: ${names.length ? `${names.join(', ')} knocked out` : 'nobody knocked out'}. ${payload.remaining} left.${saved}`);
  }

  function onOut(payload) {
    TW.Sound.play('margin_alert');
    showOutBar(payload.round);
  }

  // A bar under the match strip: you are out, the match carries on and you can
  // watch it. Trading is blocked server-side; the buttons lock in game.js.
  function showOutBar(round) {
    outShown = true;
    document.body.classList.add('mode-spectator');
    if (document.getElementById('modeOutBar')) return;
    const strip = document.getElementById('spikeStrip');
    if (!strip) return;
    const bar = document.createElement('div');
    bar.id = 'modeOutBar';
    bar.className = 'mode-out-bar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `${icon('cut', 16)}<span><b>You were cut${round ? ` in round ${round}` : ''}.</b> Your positions were closed at the cut. Keep watching: your final place is set by when you went out.</span><a href="/play" class="mode-out-leave">Leave</a>`;
    strip.insertAdjacentElement('afterend', bar);
  }

  // ---- Grand War half-time ------------------------------------------------------
  function onCheckpoint(payload) {
    const race = document.getElementById('raceList');
    const host = race && race.offsetParent ? race.parentElement : document.getElementById('leaderboardPanel');
    if (!host) return;
    document.getElementById('modeCheckpoint')?.remove();
    const card = document.createElement('div');
    card.id = 'modeCheckpoint';
    card.className = 'mode-checkpoint';
    card.innerHTML = `<div class="mc-head"><b>Half-time · ${payload.minute} min</b><button type="button" class="mc-close" aria-label="Close">&times;</button></div>
      ${payload.crown ? `<div class="mc-crown">${icon('crown', 14)} ${esc(payload.crown)} leads</div>` : ''}
      <ol class="mc-top">${(payload.top || []).map((r) => `<li><span>${esc(r.username)}</span><b class="${r.pnl >= 0 ? 'text-buy' : 'text-sell'}">${TW.formatMoney(r.pnl)}</b></li>`).join('')}</ol>`;
    host.prepend(card);
    card.querySelector('.mc-close').addEventListener('click', () => card.remove());
    setTimeout(() => card.remove(), 15000);
    TW.showMatchNotification(`Half-time: ${payload.crown ? `${payload.crown} leads` : 'standings are in'}`);
  }

  // ---- result screen ------------------------------------------------------------
  function resultHighlights(me, fire) {
    const m = me && me.mode;
    if (!m || !m.highlights || !m.highlights.length) return '';
    const out = [];
    for (const k of m.highlights) {
      if (k === 'fastestWin') out.push(['Fastest win', m.fastestWinSeconds != null ? `${m.fastestWinSeconds}s` : 'No win']);
      else if (k === 'roundsSurvived') out.push(['Cuts survived', m.survived ? `${m.roundsSurvived}, made the final` : `${m.roundsSurvived}${m.cutRound ? `, out in cut ${m.cutRound}` : ''}`]);
      else if (k === 'eventsSurvived') out.push(['Market events', `${m.eventsSurvived || 0} traded through`]);
      else if (k === 'steadyHand') out.push(['Steady Hand', m.steadyHand ? 'Earned' : `Deepest dip ${TW.formatMoney(m.maxDrawdown || 0)}`]);
      else if (k === 'bestStreak' && fire) out.push(['Best streak', String(fire.bestStreak || 0)]);
      else if (k === 'heat' && fire) out.push(['Heat', String(Math.round(fire.heat || 0))]);
      else if (k === 'ghostDelta' && m.ghost) out.push([m.ghost.label || 'Against your ghost', `${m.ghost.delta >= 0 ? '+' : '-'}${TW.formatMoney(Math.abs(m.ghost.delta))}`]);
      else if (k === 'personalBest' && m.personalBest != null) out.push([m.newBest ? 'New personal best' : 'Personal best', TW.formatMoney(m.personalBest)]);
    }
    if (!out.length) return '';
    return `<div class="mode-highlights"><div class="mh-title">${esc(m.displayName || 'This mode')}</div><div class="mh-grid">${out.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>${m.steadyHand ? '<div class="mh-badge">Steady Hand: the smallest dip from your peak among the top three</div>' : ''}</div>`;
  }

  return { setState, rulesRows, onWarning, onCut, onOut, onCheckpoint, resultHighlights };
})();
