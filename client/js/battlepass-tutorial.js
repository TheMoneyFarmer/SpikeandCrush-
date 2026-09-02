'use strict';

window.TW = window.TW || {};

// Step-by-step popup shown the first time a player visits battle-pass.html.
// Purely a localStorage flag (sc_battlepass_tutorial_done) - unlike the main
// tutorial this isn't tracked server-side, since it's a one-page explainer
// rather than an onboarding gate tied to the account.
(function () {
  const battlePassSteps = [
    {
      icon: '🎫',
      title: 'What Is the Battle Pass?',
      body: 'The Battle Pass is a monthly subscription. It gives you access to a premium reward track with exclusive cosmetics, extra coins every tier, and a season-long progression system on top of normal match rewards.',
      visual: 'Free Track: coins + basic rewards, earned by anyone.\nPremium Track: exclusive cosmetics + bigger coin rewards, unlocked by subscribing.',
    },
    {
      icon: '⚖️',
      title: 'Free Track vs Premium Track',
      body: 'Everyone has access to the Free Track - it gives you coins and basic rewards as you play. The Premium Track unlocks when you subscribe and gives you much more: exclusive cosmetics, bigger coin rewards, and seasonal items that can\'t be earned any other way.',
      visual: 'Both tracks progress together as you earn XP - premium just unlocks a second row of rewards at every tier.',
    },
    {
      icon: '⚡',
      title: 'How to Earn XP',
      body: 'Every match you complete gives you XP. Winning gives a bonus on top. Completing daily and weekly challenges gives additional XP. The more you play, the faster you progress through the tiers.',
      visual: 'Match played → +10 XP\nMatch won → +20 XP bonus\nChallenge completed → varies',
    },
    {
      icon: '📅',
      title: 'Daily Challenges',
      body: 'A new set of daily challenges appears every day. Complete them before they expire to earn extra XP and coins. Examples: win 2 Quick War matches, use a specific sabotage card, trade a specific instrument in any match. Simple and achievable every day.',
      visual: '"Win 2 Quick War matches" · "Trade XAUUSD in any match" · "Use a targeted sabotage card"',
    },
    {
      icon: '📆',
      title: 'Weekly Challenges',
      body: 'Weekly challenges are harder than daily ones but give bigger rewards. Examples: finish top 2 in a Grand War, complete the Async Challenge several times in a week, win without using any sabotage cards. These reward consistent, skilled play.',
      visual: '"Top 2 in a Grand War" · "5 Async Challenges this week" · "Win with no cards played"',
    },
    {
      icon: '🏁',
      title: 'When the Season Ends',
      body: 'Each Battle Pass season lasts a fixed number of days. When it ends, progress resets and a new season begins with new cosmetics and challenges. Any rewards you already earned are kept permanently.',
      visual: 'Season ends → new season starts with fresh cosmetics/challenges → past rewards stay in your inventory',
    },
  ];

  class BattlePassTutorial {
    constructor(steps) {
      this.steps = steps;
      this.currentStep = 0;
      this.modal = null;
    }

    checkAndStart() {
      if (localStorage.getItem('sc_battlepass_tutorial_done')) return;
      setTimeout(() => this.start(), 500);
    }

    start() {
      this.modal = document.createElement('div');
      this.modal.className = 'bp-tutorial-overlay';
      this.modal.innerHTML = `
        <div class="bp-tutorial-modal">
          <div class="bp-tutorial-icon"></div>
          <div class="bp-tutorial-step-label"></div>
          <h3 class="bp-tutorial-title"></h3>
          <p class="bp-tutorial-body"></p>
          <div class="bp-tutorial-visual"></div>
          <div class="bp-tutorial-dots"></div>
          <div class="bp-tutorial-footer"></div>
        </div>
      `;
      document.body.appendChild(this.modal);
      this.show(0);
    }

    show(index) {
      this.currentStep = index;
      const step = this.steps[index];
      const isFirst = index === 0;
      const isLast = index === this.steps.length - 1;

      this.modal.querySelector('.bp-tutorial-icon').textContent = step.icon;
      this.modal.querySelector('.bp-tutorial-step-label').textContent = `Step ${index + 1} of ${this.steps.length}`;
      this.modal.querySelector('.bp-tutorial-title').textContent = step.title;
      this.modal.querySelector('.bp-tutorial-body').textContent = step.body;
      this.modal.querySelector('.bp-tutorial-visual').textContent = step.visual;
      this.modal.querySelector('.bp-tutorial-dots').innerHTML = this.steps
        .map((_, i) => `<div class="tutorial-dot ${i === index ? 'active' : ''}"></div>`)
        .join('');

      const footer = this.modal.querySelector('.bp-tutorial-footer');
      if (isLast) {
        footer.innerHTML = `
          <button class="btn-tutorial-skip" id="bpStartFree">Start with Free</button>
          <button class="btn-tutorial-next" id="bpSubscribe">Subscribe →</button>
        `;
        footer.querySelector('#bpStartFree').addEventListener('click', () => this.complete());
        footer.querySelector('#bpSubscribe').addEventListener('click', () => {
          this.complete();
          document.getElementById('subscribeBtn')?.click();
        });
      } else {
        footer.innerHTML = `
          ${isFirst ? '' : '<button class="btn-tutorial-skip" id="bpPrev">← Previous</button>'}
          <button class="btn-tutorial-skip" id="bpSkip">Skip</button>
          <button class="btn-tutorial-next" id="bpNext">Next →</button>
        `;
        footer.querySelector('#bpPrev')?.addEventListener('click', () => this.show(index - 1));
        footer.querySelector('#bpSkip').addEventListener('click', () => this.complete());
        footer.querySelector('#bpNext').addEventListener('click', () => this.show(index + 1));
      }
    }

    complete() {
      localStorage.setItem('sc_battlepass_tutorial_done', 'true');
      this.modal?.remove();
    }
  }

  TW.BattlePassTutorial = BattlePassTutorial;
  TW.replayBattlePassTutorial = () => {
    localStorage.removeItem('sc_battlepass_tutorial_done');
    new BattlePassTutorial(battlePassSteps).start();
  };

  document.addEventListener('DOMContentLoaded', () => {
    if (document.body.dataset.page !== 'battle-pass') return;
    new BattlePassTutorial(battlePassSteps).checkAndStart();
  });
})();
