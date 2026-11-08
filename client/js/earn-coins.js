// Shown when a player tries to buy coins or Premium. Nothing is on sale right
// now, so this explains that and offers their invite link instead.
(function () {
  const TW = window.TW;
  const STYLE = `
    .ec-overlay { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(4, 8, 16, 0.72); }
    .ec-modal { width: 100%; max-width: 440px; max-height: calc(100vh - 32px); overflow-y: auto; padding: 24px; border-radius: 16px; background: var(--surface, #12192b); border: 1px solid var(--border, #2a3550); color: var(--text-primary, #fff); }
    .ec-modal h2 { margin: 0 32px 8px 0; font-size: 20px; }
    .ec-modal p { margin: 0 0 12px; font-size: 14px; line-height: 1.5; color: var(--text-secondary, #aab4c8); }
    .ec-close { float: right; display: flex; padding: 6px; background: none; border: 0; border-radius: 8px; color: var(--text-secondary, #aab4c8); cursor: pointer; }
    .ec-link { display: flex; gap: 8px; margin: 14px 0; }
    .ec-link input { flex: 1 1 auto; width: auto; min-width: 0; padding: 10px 12px; border-radius: 10px; font-size: 13px; background: var(--surface-2, #1a2338); border: 1px solid var(--border, #2a3550); color: inherit; }
    .ec-link .btn { flex: 0 0 auto; width: auto !important; min-width: 0; padding-left: 18px; padding-right: 18px; }
    .ec-stats { font-size: 13px; color: var(--text-secondary, #aab4c8); }
    .ec-fine { margin: 12px 0 0 !important; font-size: 12px !important; }
  `;
  const CLOSE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function open() {
    if (document.querySelector('.ec-overlay')) return;
    if (!document.getElementById('ecStyle')) {
      const style = document.createElement('style');
      style.id = 'ecStyle';
      style.textContent = STYLE;
      document.head.appendChild(style);
    }
    const before = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'ec-overlay';
    overlay.innerHTML = `
      <div class="ec-modal" role="dialog" aria-modal="true" aria-labelledby="ecTitle">
        <button class="ec-close" id="ecClose" aria-label="Close">${CLOSE_ICON}</button>
        <h2 id="ecTitle">Earn coins by inviting friends</h2>
        <p>Coins and Premium aren't on sale right now, and no payment has been taken. Invite friends instead and earn coins for free.</p>
        <div id="ecBody"><p>Loading your invite link...</p></div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (before && before.focus) before.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const closeBtn = overlay.querySelector('#ecClose');
    closeBtn.addEventListener('click', close);
    closeBtn.focus();

    const body = overlay.querySelector('#ecBody');
    TW.api('/api/referrals/me').then((d) => {
      body.innerHTML = `
        <p>You get <strong>${d.rewardCoins} coins</strong> for each friend who signs up with your link and finishes a match against other real players.</p>
        <div class="ec-link">
          <input id="ecLink" readonly aria-label="Your invite link" />
          <button class="btn btn-primary" id="ecCopy">Copy</button>
        </div>
        <div class="ec-stats">${d.paid} of ${d.maxPaid} paid invites, ${d.waiting} waiting. ${d.coinsEarned} coins earned so far.</div>
        <p class="ec-fine">Coins have no cash value and cannot be withdrawn or exchanged for money.</p>`;
      const input = body.querySelector('#ecLink');
      input.value = d.link;
      input.addEventListener('focus', () => input.select());
      body.querySelector('#ecCopy').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(d.link);
          TW.toast('Invite link copied', 'info');
        } catch (e) {
          input.focus();
          TW.toast('Press copy on your keyboard to copy the link', 'info');
        }
      });
    }).catch(() => {
      body.innerHTML = `<p>We couldn't load your invite link just now. You can find it on the Wallet page, so please try again in a moment.</p>`;
    });
  }

  TW.earnCoins = { open };
})();
