'use strict';

window.TW = window.TW || {};

// Global "?" tooltip system. Any element anywhere in the game can opt in
// with <button class="help-btn" data-help="war-rating">?</button> - this
// file only needs to load once (it's added to every page) and delegates the
// click so buttons added dynamically later (e.g. sabotage cards re-rendered
// mid-match) work without re-registering anything.
(function () {
  const esc = (s) => (TW.escapeHtml ? TW.escapeHtml(s) : String(s ?? ''));

  // Sabotage card keys match server/sabotage.js's CARDS object exactly
  // (news_bomb, chart_ghost, ... position_freeze, force_close, capital_drain,
  // mirror_trade) so a "?" button can just use data-help="${card.type}"
  // directly against whatever card the player was actually dealt.
  const helpContent = {
    'war-rating': {
      title: 'War Rating',
      body: 'Your competitive rank. Win ranked matches to increase it. Your rating determines your tier - from Recruit all the way to War Lord. Higher tiers unlock better card variants and cosmetics.',
    },
    coins: {
      title: 'Coins',
      body: 'Your in-game currency. Spend them to enter matches and buy cosmetics. Earn them by winning matches and completing challenges. Buy more from the Wallet page.',
    },
    sl: {
      title: 'Stop Loss',
      body: 'Automatically closes your trade if price moves this many pips against you. Protects you from large losses. Set in pips or at a specific price level. Drag the line on the chart to adjust it mid-trade.',
    },
    tp: {
      title: 'Take Profit',
      body: 'Automatically closes your trade when price reaches your target. Locks in your profit. Set in pips or at a specific price level. Drag the line on the chart to adjust it mid-trade.',
    },
    lots: {
      title: 'Lot Size',
      body: 'How large your position is. Bigger lot sizes mean bigger profits AND bigger losses per pip of movement. Start small until you understand how an instrument moves.',
    },
    spread: {
      title: 'Spread',
      body: 'The difference between buy and sell price. This is the cost of entering a trade - you pay it once, on entry. A tighter spread is cheaper to trade.',
    },
    margin: {
      title: 'Margin Used',
      body: 'How much of your $10,000 virtual capital is tied up as collateral for open positions. If margin used gets too high you risk a margin call, which force-closes positions. Keep it manageable.',
    },
    'battle-pass-xp': {
      title: 'Battle Pass XP',
      body: 'Experience points that advance your Battle Pass tier. Every match gives XP, winning gives a bonus, and completing challenges gives more. Reach the final tier before the season ends for the season reward.',
    },
    'rating-change': {
      title: 'Rating Change',
      body: 'How much your War Rating changed after a match. Better finishes gain more, worse finishes lose more. Draws are handled specially - see the Help page for the exact formula.',
    },
    // ---- sabotage cards (keys match server/sabotage.js CARDS ids exactly) ----
    news_bomb: { title: 'News Bomb', body: "Shows the target player a fake breaking news headline for a short time. They see something that looks real. Their reaction to it is your opening." },
    chart_ghost: { title: 'Chart Ghost', body: "Freezes the target's price display for a few seconds. They can't see live prices while it's active - if they have an open position, they won't know if they're winning or losing." },
    false_signal: { title: 'False Signal', body: "Shows a fake technical signal (like an RSI divergence) on the target's chart. It isn't real - designed to bait them into a bad trade." },
    smoke_screen: { title: 'Smoke Screen', body: 'Blurs the leaderboard for everyone for a short time. Nobody knows who is winning. Effective when you are in last place - it removes the psychological edge of the current leader.' },
    spread_spike: { title: 'Spread Spike', body: 'Temporarily multiplies the spread on one instrument. Anyone entering or exiting that instrument while it is active pays much more than normal. Best played just before an opponent tries to close a big position.' },
    volatility_surge: { title: 'Volatility Surge', body: 'Speeds up price movement on one instrument for everyone. High risk on both sides - positions move faster in both directions and can flip the leaderboard fast.' },
    liquidity_drain: { title: 'Liquidity Drain', body: 'Caps the maximum lot size for everyone on one instrument for a short time. Prevents anyone from building a large position while it is active.' },
    reversal_flash: { title: 'Reversal Flash', body: 'Forces a sharp, brief price reversal on one instrument before it snaps back to the real price. Can trigger tight stop losses. Best played when an opponent\'s stop is close to the current price.' },
    position_freeze: { title: 'Position Freeze', body: 'Prevents the target from opening any new trades for a short time. Best used right when they are about to enter a big position or when the market is moving fast.' },
    force_close: { title: 'Force Close', body: "Force-closes the target's best-performing open position at the current market price. Devastating if they have a large winning trade running." },
    capital_drain: { title: 'Capital Drain', body: 'Deducts virtual capital directly from the target. The psychological impact is often bigger than the actual amount - best used when a player is already losing.' },
    mirror_trade: { title: 'Mirror Trade', body: "Copies your current open position onto the target's account. If you're winning, they gain too - if you're losing, they lose too. Only use it when you're confident in your position." },
  };

  function showHelp(helpKey, triggerElement) {
    const content = helpContent[helpKey];
    if (!content) return;

    document.querySelector('.help-tooltip')?.remove();

    const tooltip = document.createElement('div');
    tooltip.className = 'help-tooltip';
    tooltip.innerHTML = `
      <div class="help-tooltip-title">${esc(content.title)}</div>
      <div class="help-tooltip-body">${esc(content.body)}</div>
    `;
    document.body.appendChild(tooltip);

    const rect = triggerElement.getBoundingClientRect();
    let top = rect.bottom + 8;
    let left = rect.left;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    if (left + tw > window.innerWidth - 16) left = window.innerWidth - tw - 16;
    if (left < 16) left = 16;
    if (top + th > window.innerHeight - 16) top = rect.top - th - 8;
    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';

    setTimeout(() => {
      document.addEventListener('click', function closeTooltip(e) {
        if (!tooltip.contains(e.target) && e.target !== triggerElement) {
          tooltip.remove();
          document.removeEventListener('click', closeTooltip);
        }
      });
    }, 0);
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.help-btn');
    if (!btn) return;
    e.stopPropagation();
    showHelp(btn.dataset.help, btn);
  });

  TW.showHelp = showHelp;
  TW.helpContent = helpContent;
})();
