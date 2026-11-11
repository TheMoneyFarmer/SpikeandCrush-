'use strict';

window.TW = window.TW || {};

// Shows a full explanation of a game mode the first 3 times a player clicks
// into it (index.html's #modeQuickBtn etc.), then gets out of the way -
// intercepts the existing click handlers already wired in main.js
// rather than replacing them, so the real match-start logic is untouched.
(function () {
  // Mode intro cards (shown the first 3 times a mode is opened). The facts
  // match server/config/modeIdentity.js and the help page's Game Modes.
  const PRIZES = 'Entry coins from every player go into the prize pool. The platform keeps 15%. The top four share the rest: 50%, 25%, 15% and 10%.';
  const modeData = {
    quickwar: {
      icon: 'swords', name: 'Quick War', tagline: 'The full game. Start here.', color: 'var(--accent)',
      duration: '10 Minutes', players: '2+ Players, no limit', entry: '10 Coins', ranked: 'Yes: War Rating',
      sections: [
        { title: 'How It Works', content: 'Everyone starts with $10,000 of virtual capital and 5 instruments. Buy if you think the price will rise, sell if you think it will fall. Highest equity when the timer hits zero wins.' },
        { title: 'Cards', content: 'You start with 5 cards. Win trades in a row to earn more. Each card is played once and changes something real for its target: a frozen position, a wider spread, a closed trade.' },
        { title: 'The Extras', content: 'The current leader wears the crown. Spike alerts warn you seconds before a big real move. Quick missions pay a few coins. Heat is a separate score and never changes your P&L or rank.' },
        { title: 'Prizes and Rating', content: `${PRIZES} Finishing high gains War Rating; finishing last loses it.` },
      ],
      tips: ['Do not put all your capital on one trade', 'Save a card for the last minute', 'Use a stop loss to protect a winning trade'],
    },
    blitz: {
      icon: 'bolt', name: 'Blitz War', tagline: 'Three minutes on the busiest markets.', color: 'var(--warning)',
      duration: '3 Minutes', players: '2+ Players, no limit', entry: '5 Coins', ranked: 'No',
      sections: [
        { title: 'How It Works', content: 'Same trading as Quick War, but 3 minutes and only the most active markets. The match can flip in the last 30 seconds.' },
        { title: 'Fast Refill', content: 'You start with 5 cards. One winning trade earns a card and two in a row earn two, so play them: a card you still hold at the buzzer is wasted. Heavy (epic and legendary) cards are not used in Blitz.' },
        { title: 'More Spikes', content: 'Spike alerts come more often. The result screen shows your fastest winning trade.' },
      ],
      tips: ['Take profits early', 'Play your cards, do not hoard them', 'Big lots in 3 minutes cut both ways'],
    },
    grandwar: {
      icon: 'crown', name: 'Grand War', tagline: 'Twenty minutes of strategy.', color: 'var(--gold, var(--accent-gold))',
      duration: '20 Minutes', players: '4+ Players, no limit', entry: '25 Coins', ranked: 'Yes: Grand War rating',
      sections: [
        { title: 'Your Hand', content: 'You start with 5 cards and can change them in the lobby before the start.' },
        { title: 'Market Events', content: 'Three events are scheduled near minutes 5, 10 and 15. Each is one of the biggest real moves of that session, from the price data. The direction is never shown in advance.' },
        { title: 'Half-time and Steady Hand', content: 'At minute 10 the half-time card shows the top five. The Steady Hand badge goes to the top-three finisher with the smallest dip from their peak.' },
        { title: 'Prizes and Rating', content: `${PRIZES} Grand War has its own rating.` },
      ],
      tips: ['Have a plan for each event', 'Protect your peak, not just your total', 'Twenty minutes is long: pace yourself'],
    },
    elimination: {
      icon: 'trophy', name: 'Elimination', tagline: 'Survive the cuts.', color: 'var(--accent-red, #ff4d5e)',
      duration: '15 Minutes', players: '4+ for cuts, no limit', entry: '10 Coins', ranked: 'No',
      sections: [
        { title: 'The Cuts', content: 'At 3, 6, 9 and 12 minutes the bottom 20% of the players still in are knocked out, at least one each time. Cuts stop when fewer than 4 players remain.' },
        { title: 'Warnings', content: 'The match strip shows "Cut in 0:30" before each cut. If you are in the group that would go out, you carry a Danger tag.' },
        { title: 'When You Are Cut', content: 'Your open positions close at that moment and you can keep watching. Anyone who survives longer finishes above you.' },
        { title: 'Lifeline', content: 'The Lifeline card (unlocks at level 6) protects you from the next cut, once per match.' },
      ],
      tips: ['Staying out of the bottom matters more than leading', 'Watch the clock before each cut', 'Keep Lifeline for when you are in danger'],
    },
    solo: {
      icon: 'target', name: 'Solo Ranked', tagline: 'Race your own best run.', color: 'var(--info, #4fc3f7)',
      duration: '10 Minutes', players: 'You vs 3 AI traders', entry: 'Free', ranked: 'Yes: Solo rating',
      sections: [
        { title: 'How It Works', content: 'Free and always open. You trade against 3 AI traders with their own personalities, so there is never a wait.' },
        { title: 'Your Ghost', content: 'The match strip shows the ghost of your best Solo run, second by second, and your best result from yesterday to beat.' },
        { title: 'Cards and Missions', content: 'You get 5 cards like every mode and can use them on the AI traders. Missions come as a chain of three: finish one to unlock the next.' },
      ],
      tips: ['Use Solo to learn a new instrument', 'Try to beat yesterday, not just win', 'Your Solo rating is separate from War Rating'],
    },
    async: {
      icon: 'calendar', name: 'Daily Challenge', tagline: 'One market for everyone today.', color: 'var(--accent-red, #ba68c8)',
      duration: '10 Minutes, any time today', players: 'Everyone who enters today', entry: '5 Coins', ranked: 'Daily leaderboard',
      sections: [
        { title: 'How It Works', content: 'Every player trades the exact same 10-minute window of real price data today. No live opponents, no cards: just you and the market.' },
        { title: 'The Ghost', content: 'The match strip shows the ghost of today\'s best run so far. After your run, send a challenge link: your friend plays the same market and races your run.' },
        { title: 'When Results Show', content: 'Play any time before the daily deadline. Then the leaderboard is revealed and the winner announced.' },
      ],
      tips: ['Look at the instruments before you start', 'With no cards, risk management decides it', 'Play early so you are not rushed'],
    },
  };

  // The mode keys main.js calls TW.startModeWithTutorial(...) with - kept
  // here so resetModeTutorials() knows which localStorage counters to clear.
  // #modePrivateBtn isn't included: it opens the house-rules sheet instead.
  const MODE_KEYS = ['quickwar', 'blitz', 'grandwar', 'elimination', 'solo', 'async'];
  const MAX_SHOWN = 3;

  function playsKey(mode) { return `sc_mode_plays_${mode}`; }
  function getPlays(mode) { return parseInt(localStorage.getItem(playsKey(mode)) || '0', 10); }
  function incrementPlays(mode) { localStorage.setItem(playsKey(mode), String(getPlays(mode) + 1)); }

  function showModeCard(mode, onProceed) {
    const data = modeData[mode];
    if (!data) return onProceed();

    const modal = document.createElement('div');
    modal.className = 'mode-card-overlay';
    modal.innerHTML = `
      <div class="mode-card-modal">
        <div class="mode-card-header">
          <div class="mode-card-icon" style="color:${data.color}">${TW.icon ? TW.icon(data.icon, { size: 36 }) : ''}</div>
          <div>
            <h2 class="mode-card-name">${TW.escapeHtml(data.name)}</h2>
            <p class="mode-card-tagline">${TW.escapeHtml(data.tagline)}</p>
          </div>
          <button class="mode-card-close" aria-label="Close">${TW.icon ? TW.icon('close', { size: 18 }) : '×'}</button>
        </div>
        <div class="mode-stats-row" data-tour="mode-intro">
          <div class="mode-stat"><div class="mode-stat-label">Duration</div><div class="mode-stat-value">${TW.escapeHtml(data.duration)}</div></div>
          <div class="mode-stat"><div class="mode-stat-label">Players</div><div class="mode-stat-value">${TW.escapeHtml(data.players)}</div></div>
          <div class="mode-stat"><div class="mode-stat-label">Entry</div><div class="mode-stat-value">${TW.escapeHtml(data.entry)}</div></div>
          <div class="mode-stat"><div class="mode-stat-label">Ranked</div><div class="mode-stat-value">${TW.escapeHtml(data.ranked)}</div></div>
        </div>
        <div class="mode-card-content">
          ${data.sections.map((s) => `
            <div class="mode-section">
              <h4 class="mode-section-title">${TW.escapeHtml(s.title)}</h4>
              <p class="mode-section-body">${TW.escapeHtml(s.content)}</p>
            </div>
          `).join('')}
          <div class="mode-tips">
            <h4 class="mode-section-title">Pro tips</h4>
            ${data.tips.map((tip) => `<div class="mode-tip-item"><span class="mode-tip-bullet" style="color:${data.color}">-</span><span>${TW.escapeHtml(tip)}</span></div>`).join('')}
          </div>
        </div>
        <div class="mode-card-footer">
          <button class="btn-mode-learn-more">Maybe Later</button>
          <button class="btn-mode-play">Play ${TW.escapeHtml(data.name)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const opener = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => {
      modal.remove();
      document.removeEventListener('keydown', onKey);
      if (opener && opener.focus) opener.focus();
    };
    document.addEventListener('keydown', onKey);
    // Start keyboard / controller focus on the main action.
    setTimeout(() => modal.querySelector('.btn-mode-play')?.focus(), 0);
    modal.querySelector('.mode-card-close').addEventListener('click', close);
    modal.querySelector('.btn-mode-learn-more').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('.btn-mode-play').addEventListener('click', () => {
      incrementPlays(mode);
      close();
      onProceed();
    });
  }

  // Called directly from main.js's own mode-button click handlers (see the
  // TW.startModeWithTutorial(...) call site there) rather than intercepting
  // those clicks after the fact - DOM listeners on the same element fire in
  // registration order regardless of capture/bubble, so a separate
  // interceptor script can't reliably beat main.js's own listener to the
  // punch. Calling straight into this from inside that handler sidesteps the
  // ordering problem entirely.
  TW.startModeWithTutorial = (mode, proceed) => {
    if (getPlays(mode) >= MAX_SHOWN) return proceed();
    showModeCard(mode, proceed); // showModeCard's own Play button already calls incrementPlays(mode) before proceed()
  };

  TW.showModeCard = showModeCard;
  TW.resetModeTutorials = () => {
    MODE_KEYS.forEach((mode) => localStorage.removeItem(playsKey(mode)));
  };
})();
