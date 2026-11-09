'use strict';

window.TW = window.TW || {};

// Shows a full explanation of a game mode the first 3 times a player clicks
// into it (index.html's #modeQuickBtn etc.), then gets out of the way -
// intercepts the existing click handlers already wired in main.js
// rather than replacing them, so the real match-start logic is untouched.
(function () {
  const modeData = {
    quickwar: {
      icon: 'swords', name: 'Quick War', tagline: 'The standard battle.', color: 'var(--accent)',
      duration: '10 Minutes', players: '2 to 6 Players', entry: '10 Coins', ranked: 'Yes — affects War Rating',
      instruments: '5 Random Instruments', cards: '3 Cards — from your saved deck',
      sections: [
        { title: 'How It Works', content: 'All players start with $10,000 virtual capital. You have 10 minutes to make as much profit as possible by trading any of 5 random instruments. Buy when you think price goes up. Sell when you think price goes down. The player with the highest P&L when the timer hits zero wins.' },
        { title: 'The Sabotage Layer', content: 'Each player gets 3 sabotage cards at the start, from their saved deck if they have one, otherwise at random. You can play each card once. Cards affect opponents - freeze their trading, force close their positions, spike their spreads, or show them fake news. Choose when to play them carefully.' },
        { title: 'How You Win Coins', content: 'Entry coins from every player enter the prize pool. The platform keeps 15%. Winners share the rest, weighted toward the top finishers.' },
        { title: 'War Rating', content: 'Finishing 1st gains rating. Finishing last loses rating. Your rating determines your tier from Recruit to War Lord.' },
      ],
      tips: [
        'Manage your risk - do not use all your capital on one trade',
        'Watch the leaderboard to know when to be aggressive',
        'Save sabotage cards for the last few minutes when it matters most',
        'Use stop losses to protect profits before the timer ends',
      ],
    },
    blitz: {
      icon: 'bolt', name: 'Blitz War', tagline: 'Three minutes of pure chaos.', color: 'var(--warning)',
      duration: '3 Minutes', players: '2 to 6 Players', entry: '5 Coins', ranked: 'No — casual only',
      instruments: '5 Random Instruments', cards: '3 Cards — from your saved deck',
      sections: [
        { title: 'How It Works', content: 'Same as Quick War but 3 minutes only. No time to be patient. No time to wait for the perfect setup. You must act fast. The entire match can flip in the last 30 seconds.' },
        { title: 'Three Cards, Three Minutes', content: 'Each player gets 3 sabotage cards, the same as Quick War, but only 3 minutes to use them. You can play each card once, so every one you hold at the buzzer is wasted.' },
        { title: 'Why Play Blitz', content: 'It is the fastest way to earn coins. A 3-minute match means you can play several Blitz Wars in the time it takes to play one Quick War. Perfect for short sessions or fast action.' },
      ],
      tips: [
        'Move fast - every second counts',
        'Do not hold your sabotage cards too long - unused cards do nothing',
        'Take profits early - do not wait for perfect exits',
        'High leverage is higher risk in 3 minutes',
      ],
    },
    grandwar: {
      icon: 'trophy', name: 'Grand War', tagline: 'The prestige battle.', color: 'var(--gold, var(--accent-gold))',
      duration: '20 Minutes', players: '4 to 8 Players', entry: '25 Coins', ranked: 'Yes — separate Grand War rating',
      instruments: '5 Random Instruments', cards: '5 Cards — you choose your deck',
      sections: [
        { title: 'How It Works', content: 'Grand War is the longest and highest-stakes mode. More players, more time, more sabotage. Your 5 cards start from your saved deck, and you can change them in the lobby. Strategy matters more here than in Quick War.' },
        { title: 'Deck Selection', content: 'Your saved deck loads automatically. You can swap any card in the lobby before the match starts. Different combinations work for different strategies.' },
        { title: 'The Meta Game', content: 'You can see opponents in the pre-match lobby - their tier, favourite instrument, win rate. Use this to decide your card selection and opening strategy.' },
      ],
      tips: [
        'Do not rush in the first 5 minutes - observe opponents',
        'Card selection matters - think about what opponents might bring',
        'Manage stamina - 20 minutes is long, stay focused',
        'The winner is often not the most aggressive player',
      ],
    },
    solo: {
      icon: 'target', name: 'Solo Ranked', tagline: 'You vs the machines.', color: 'var(--info, #4fc3f7)',
      duration: '10 Minutes', players: 'You vs AI Opponents', entry: 'Free', ranked: 'Yes — separate Solo Rating',
      instruments: 'Random', cards: '3 Cards — from your saved deck',
      sections: [
        { title: 'How It Works', content: 'Solo Ranked is free to enter. You play against AI opponents, each with a distinct personality and strategy - some aggressive, some patient, some unpredictable.' },
        { title: 'Why Play Solo', content: 'Practice new instruments without risking coins in a real match. Learn how sabotage cards work against different opponent types. Improve your rating without spending entry fees, any time.' },
        { title: 'Solo Rating', content: 'Solo Ranked has its own rating separate from your main War Rating - a measure of pure trading skill against consistent AI opponents, independent of sabotage strategy.' },
      ],
      tips: [
        'Use Solo Ranked to practice instruments you are not familiar with',
        'Test different sabotage card strategies risk-free',
        'Study AI behaviour - it mirrors real trader archetypes',
        'Your solo rating is a good indicator of your raw trading skill',
      ],
    },
    async: {
      icon: 'calendar', name: 'Async Daily Challenge', tagline: 'Everyone trades the same market.', color: 'var(--accent-red, #ba68c8)',
      duration: '10 Minutes — complete any time today', players: 'Everyone who enters today', entry: '5 Coins', ranked: 'Separate daily leaderboard',
      instruments: '3 Pre-selected — same for everyone', cards: 'None — pure trading skill',
      sections: [
        { title: 'How It Works', content: 'Every day a new 10-minute historical market window is selected. Every player trades the exact same window - same prices, same movements, same opportunities. No real-time opponents, no sabotage. Just you and the market.' },
        { title: 'Why It Is Fair', content: 'Because everyone trades the exact same market data, the only variable is your decision-making. It is the purest measure of trading skill on the platform.' },
        { title: 'When Results Show', content: 'Complete the challenge any time before the daily deadline. Once it passes, the leaderboard is revealed and the daily winner is announced.' },
      ],
      tips: [
        'Check the instruments before entering to prepare your strategy',
        'No sabotage means pure trading - use proper risk management',
        'Complete early so you are not rushed',
        'The daily challenge is the best way to improve your real trading skills',
      ],
    },
  };

  // The mode keys main.js calls TW.startModeWithTutorial(...) with - kept
  // here so resetModeTutorials() knows which localStorage counters to clear.
  // #modePrivateBtn/#modeTournamentBtn aren't included: private opens a
  // create/join flow and tournament navigates away, neither is a "play this
  // mode now" moment a mode card fits.
  const MODE_KEYS = ['quickwar', 'blitz', 'grandwar', 'solo', 'async'];
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
        <div class="mode-stats-row">
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
            ${data.tips.map((tip) => `<div class="mode-tip-item"><span class="mode-tip-bullet" style="color:${data.color}">→</span><span>${TW.escapeHtml(tip)}</span></div>`).join('')}
          </div>
        </div>
        <div class="mode-card-footer">
          <button class="btn-mode-learn-more">Maybe Later</button>
          <button class="btn-mode-play">Play ${TW.escapeHtml(data.name)} →</button>
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
