'use strict';

window.TW = window.TW || {};

// First-time guided walkthrough of the Trading Floor (index.html only).
// Fires once per account - server-side `tutorial_completed` on the players
// row is authoritative; localStorage `sc_tutorial_done` is just a same-device
// fast-path so a page reload right after finishing doesn't refetch before
// showing it once more.
(function () {
  const tutorialSteps = [
    {
      target: null,
      title: 'Welcome to Spike & Crush 🎮',
      body: 'You are about to enter the most competitive trading game ever built. Matches last 10 minutes. Sabotage is legal. Mercy is not included. Let us show you around.',
      tip: 'This tutorial takes about 2 minutes. You can skip anytime and replay it from Settings.',
      logo: true,
    },
    {
      target: '.tw-hero-section',
      title: 'This Is Your Trading Floor',
      body: 'Everything starts here. You can see live matches happening right now, the global leaderboard, today\'s Async Challenge, and your War Rating. Think of it as your home base.',
      tip: 'The ticker tape at the top shows real instrument prices updating live.',
    },
    {
      target: '#modeQuickBtn',
      title: 'Enter the War',
      body: 'Click Quick War to jump into a match immediately. It costs 10 coins. You start with 500 coins - enough for 50 free matches. AI opponents fill any empty slots so you never wait long.',
      tip: 'Private War is free - create a room and invite friends with a 6-digit code.',
    },
    {
      target: null,
      title: 'Inside a Match',
      body: 'Once in a match you will see a candlestick chart, buy and sell buttons, your open positions, a live leaderboard of all players, and your sabotage cards. Every decision counts. You have 10 minutes.',
      tip: 'Look for the ? buttons throughout the game screen - click any of them for a quick explanation.',
    },
    {
      target: null,
      title: 'How To Make Money In a Match',
      body: 'Buy when you think price goes up. Sell when you think price goes down. Your profit or loss updates live as price moves. The player with the highest P&L when the timer hits zero wins the prize pool.',
      tip: 'You do not risk real money - you trade with $10,000 virtual capital every match. Only your coins (entry fee) are at stake.',
    },
    {
      target: null,
      title: 'Protect Your Trades',
      body: 'Set a Stop Loss to automatically close a losing trade before it gets worse. Set a Take Profit to lock in gains when price hits your target. You can also drag these lines directly on the chart to adjust them during the match.',
      tip: 'SL in pips = 10 pips means your trade closes if price moves 10 pips against you.',
    },
    {
      target: null,
      title: 'Your Secret Weapons ⚡',
      body: 'Each match you receive random sabotage cards. Use them against opponents to gain an edge. Cards like Force Close shut an opponent\'s best position. News Bomb shows them a fake headline. Spread Spike makes their next trade more expensive.',
      tip: 'You can only use each card once per match. Timing is everything.',
    },
    {
      target: '#headerTierBadge',
      title: 'Your War Rating',
      body: 'Every ranked match affects your War Rating. Finish 1st and gain rating. Finish last and lose rating. Your rating determines your tier - from Recruit all the way to War Lord. Higher tiers unlock better card variants and cosmetics.',
      tip: 'War Lords are the top players on the platform. Reaching War Lord is the ultimate achievement.',
    },
    {
      target: '#headerCoinWrap',
      title: 'Your Coin Balance',
      body: 'Coins are your in-game currency. You earn them by winning matches and completing challenges. You spend them on match entry fees and cosmetics. You can buy more coins anytime from the Wallet page.',
      tip: 'Coins are never lost forever - you always earn them back by winning matches.',
    },
    {
      target: null,
      title: '5 Ways To Play',
      body: 'Quick War is your daily 10-minute battle. Blitz War is 3 minutes of pure chaos. Grand War goes 20 minutes with bigger stakes. Solo Ranked lets you practice against AI. Async Challenge lets you compete any time of day against everyone on the same market.',
      tip: 'Start with Quick War or Solo Ranked to learn the mechanics before playing Grand War.',
    },
    {
      target: '.tw-nav-links a[href="/shop"]',
      title: 'Customize Your Game',
      body: 'The shop lets you buy cosmetics with your coins - avatar frames, animated nameplates, and profile backgrounds. None of these give you a gameplay advantage.',
      tip: 'Earn coins by playing well and you will never need to buy them.',
    },
    {
      target: null,
      title: 'You Are Ready to War ⚔️',
      body: 'That is everything you need to know. Jump into a Quick War right now and put it into practice. Remember - the best traders are not always the ones who make the most money. They are the ones who manage risk, read opponents, and know when to play their sabotage cards.',
      tip: 'You can replay this tutorial anytime from Settings → Help.',
      finalStep: true,
    },
  ];

  const STAIRCASE_LOGO_HTML = `
    <div class="sc-logo" style="justify-content:center;">
      <span class="sc-s1">S</span><span class="sc-p">P</span><span class="sc-i">I</span><span class="sc-k">K</span><span class="sc-e">E</span>
      <span class="sc-amp">&amp;</span>
      <span class="sc-c">C</span><span class="sc-r">R</span><span class="sc-u">U</span><span class="sc-s2">S</span><span class="sc-h">H</span>
    </div>
  `;

  class Tutorial {
    constructor(steps) {
      this.steps = steps;
      this.currentStep = 0;
      this.overlay = null;
      this.spotlight = null;
      this.card = null;
      this._reposition = null;
    }

    start() {
      this.createOverlay();
      this.showStep(0);
    }

    createOverlay() {
      this.overlay = document.createElement('div');
      this.overlay.className = 'tutorial-overlay';
      this.overlay.innerHTML = `
        <div class="tutorial-spotlight"></div>
        <div class="tutorial-card">
          <div class="tutorial-logo-preview hidden"></div>
          <div class="tutorial-step-number"></div>
          <h3 class="tutorial-title"></h3>
          <p class="tutorial-body"></p>
          <div class="tutorial-tip" style="display:none"></div>
          <div class="tutorial-footer">
            <div class="tutorial-dots"></div>
            <div class="tutorial-buttons">
              <button class="btn-tutorial-skip">Skip</button>
              <button class="btn-tutorial-next">Next →</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(this.overlay);
      this.spotlight = this.overlay.querySelector('.tutorial-spotlight');
      this.card = this.overlay.querySelector('.tutorial-card');
      this.card.querySelector('.btn-tutorial-skip').addEventListener('click', () => this.skip());
      this.card.querySelector('.btn-tutorial-next').addEventListener('click', () => this.next());

      this._reposition = () => {
        const step = this.steps[this.currentStep];
        if (step.target) {
          const target = document.querySelector(step.target);
          if (target) { this.positionSpotlight(target); this.positionCard(target); return; }
        }
        this.centerCard();
      };
      window.addEventListener('resize', this._reposition);
    }

    showStep(index) {
      const step = this.steps[index];
      const isLast = index === this.steps.length - 1;

      const logoPreview = this.card.querySelector('.tutorial-logo-preview');
      if (step.logo) { logoPreview.classList.remove('hidden'); logoPreview.innerHTML = STAIRCASE_LOGO_HTML; }
      else { logoPreview.classList.add('hidden'); logoPreview.innerHTML = ''; }

      this.card.querySelector('.tutorial-step-number').textContent = `Step ${index + 1} of ${this.steps.length}`;
      this.card.querySelector('.tutorial-title').textContent = step.title;
      this.card.querySelector('.tutorial-body').textContent = step.body;

      const tipEl = this.card.querySelector('.tutorial-tip');
      if (step.tip) { tipEl.textContent = step.tip; tipEl.style.display = 'block'; }
      else tipEl.style.display = 'none';

      this.card.querySelector('.btn-tutorial-next').textContent = isLast ? 'Start Playing!' : 'Next →';

      const dotsEl = this.card.querySelector('.tutorial-dots');
      dotsEl.innerHTML = this.steps.map((_, i) => `<div class="tutorial-dot ${i === index ? 'active' : ''}"></div>`).join('');

      if (step.target) {
        const target = document.querySelector(step.target);
        if (target) {
          this.positionSpotlight(target);
          this.positionCard(target);
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          this.centerCard();
          this.hideSpotlight();
        }
      } else {
        this.centerCard();
        this.hideSpotlight();
      }
    }

    positionSpotlight(target) {
      const rect = target.getBoundingClientRect();
      const padding = 8;
      this.spotlight.style.display = 'block';
      this.spotlight.style.left = rect.left - padding + 'px';
      this.spotlight.style.top = rect.top - padding + 'px';
      this.spotlight.style.width = rect.width + padding * 2 + 'px';
      this.spotlight.style.height = rect.height + padding * 2 + 'px';
    }

    positionCard(target) {
      const rect = target.getBoundingClientRect();
      const cardWidth = 320;
      const margin = 20;
      let left = rect.right + margin;
      let top = rect.top;

      if (left + cardWidth > window.innerWidth - 20) left = rect.left - cardWidth - margin;
      if (left < 20) left = Math.min(Math.max(20, rect.left), window.innerWidth - cardWidth - 20);

      const cardHeight = this.card.offsetHeight || 300;
      if (top + cardHeight > window.innerHeight - 20) top = window.innerHeight - cardHeight - 20;
      left = Math.max(20, left);
      top = Math.max(20, top);

      this.card.style.left = left + 'px';
      this.card.style.top = top + 'px';
      this.card.style.transform = 'none';
    }

    centerCard() {
      this.card.style.left = '50%';
      this.card.style.top = '50%';
      this.card.style.transform = 'translate(-50%, -50%)';
    }

    hideSpotlight() {
      this.spotlight.style.display = 'none';
    }

    next() {
      if (this.currentStep < this.steps.length - 1) {
        this.currentStep++;
        this.showStep(this.currentStep);
      } else {
        this.complete();
      }
    }

    skip() {
      TW.confirmDialog({
        title: 'Skip the tutorial?',
        body: 'You can replay it from Settings → Help.',
        confirmLabel: 'Skip',
      }).then((confirmed) => { if (confirmed) this.complete(); });
    }

    async complete() {
      try {
        const result = await TW.api('/api/tutorial/complete', { method: 'POST' });
        if (result?.player) TW.updatePlayerCache(result.player);
      } catch (e) {
        // Not fatal for the player's experience - localStorage still marks it
        // done on this device; the DB write will just be missing until they
        // trigger another player-cache refresh.
      }
      try { localStorage.setItem('sc_tutorial_done', 'true'); } catch (e) {}

      window.removeEventListener('resize', this._reposition);
      this.overlay.style.transition = 'opacity 0.3s';
      this.overlay.style.opacity = '0';
      setTimeout(() => this.overlay.remove(), 300);
    }
  }

  TW.Tutorial = Tutorial;
  TW.tutorialSteps = tutorialSteps;

  // Shared by all 4 systems: a themed confirm dialog instead of the browser's
  // native confirm(), which would look jarring against the game's own UI.
  TW.confirmDialog = ({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) =>
    new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'tutorial-confirm-overlay';
      overlay.innerHTML = `
        <div class="tutorial-confirm-box">
          <h3 style="margin:0 0 4px;font-size:16px;">${TW.escapeHtml(title)}</h3>
          <p>${TW.escapeHtml(body)}</p>
          <div class="tutorial-confirm-actions">
            <button class="btn-tutorial-skip" id="tutConfirmCancel">${TW.escapeHtml(cancelLabel)}</button>
            <button class="btn-tutorial-next" id="tutConfirmOk">${TW.escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('#tutConfirmCancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
      overlay.querySelector('#tutConfirmOk').addEventListener('click', () => { overlay.remove(); resolve(true); });
    });

  window.tutorial = new Tutorial(tutorialSteps);

  // Replay entry point for Settings > Help.
  TW.replayTutorial = () => { window.tutorial = new Tutorial(tutorialSteps); window.tutorial.start(); };

  async function checkAndStartTutorial() {
    if (!TW.getToken()) return; // not logged in yet - index.html shows the auth form instead

    // Settings > Help > Replay sends the player here with this param since
    // the tutorial's spotlight targets only exist on this page - bypasses
    // the "already completed" checks entirely.
    const params = new URLSearchParams(window.location.search);
    if (params.get('replay_tutorial') === '1') {
      history.replaceState(null, '', window.location.pathname);
      setTimeout(() => window.tutorial.start(), 500);
      return;
    }

    if (localStorage.getItem('sc_tutorial_done')) return;

    let player = TW.getPlayer();
    // The localStorage cache predates tutorial_completed for any account that
    // logged in before this shipped - refetch fresh rather than trusting it.
    try {
      player = await TW.api('/api/player/me');
      TW.updatePlayerCache(player);
    } catch (e) {
      // Offline or session expired - fall back to whatever's cached rather
      // than blocking the tutorial check entirely.
    }
    if (!player || player.tutorial_completed) {
      if (player?.tutorial_completed) { try { localStorage.setItem('sc_tutorial_done', 'true'); } catch (e) {} }
      return;
    }

    setTimeout(() => window.tutorial.start(), 1000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (document.body.dataset.page === 'index') checkAndStartTutorial();
  });
})();
