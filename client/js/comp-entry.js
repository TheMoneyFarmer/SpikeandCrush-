'use strict';

// Shared "enter this competition?" confirmation - used by the lobby hero,
// the lobby competitions list and the Competition Hub. Shows the entry fee
// and prize in coins, plus the required no-cash-value line, then calls the
// existing atomic enter endpoint and drops the player into the play screen.
(function () {
  window.TW = window.TW || {};
  const NO_CASH_LINE = 'Coins have no cash value and cannot be withdrawn or exchanged for money.';
  TW.NO_CASH_LINE = NO_CASH_LINE;

  function confirmDialog({ title, fee, prizeCoins }) {
    return new Promise((resolve) => {
      const esc = TW.escapeHtml;
      const prev = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'ce-overlay';
      overlay.innerHTML = `
        <div class="ce-dialog" role="dialog" aria-modal="true" aria-labelledby="ceTitle" aria-describedby="ceBody">
          <h2 class="ce-title" id="ceTitle">Enter ${esc(title)}?</h2>
          <div class="ce-body" id="ceBody">
            <div class="ce-row"><span>Entry</span><strong>${fee > 0 ? `${Number(fee).toLocaleString()} coins` : 'Free'}</strong></div>
            <div class="ce-row"><span>Prize pool</span><strong>${Number(prizeCoins || 0).toLocaleString()} coins</strong></div>
            <p class="ce-note">${fee > 0 ? 'The entry fee is charged once. Entering again just takes you back to your account.' : 'Entering again just takes you back to your account.'}</p>
            <p class="ce-legal">${NO_CASH_LINE}</p>
          </div>
          <div class="ce-actions">
            <button type="button" class="ce-btn ce-cancel">Cancel</button>
            <button type="button" class="ce-btn ce-confirm">${fee > 0 ? `Pay ${Number(fee).toLocaleString()} coins and enter` : 'Enter'}</button>
          </div>
        </div>`;
      const done = (ok) => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        prev?.focus?.();
        resolve(ok);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') done(false);
        if (e.key === 'Tab') {
          const items = overlay.querySelectorAll('button');
          const first = items[0];
          const last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
      overlay.querySelector('.ce-cancel').addEventListener('click', () => done(false));
      overlay.querySelector('.ce-confirm').addEventListener('click', () => done(true));
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      overlay.querySelector('.ce-confirm').focus();
    });
  }

  // comp: { id, title, entryCoins, prizeCoins }. Resolves true once
  // navigation to the play screen has started.
  TW.enterCompetition = async (comp) => {
    if (!TW.isLoggedIn || !TW.isLoggedIn()) {
      TW.requireAuth?.();
      return false;
    }
    const ok = await confirmDialog({ title: comp.title, fee: comp.entryCoins || 0, prizeCoins: comp.prizeCoins || 0 });
    if (!ok) return false;
    try {
      const result = await TW.api(`/api/competitions/${comp.id}/enter`, { method: 'POST' });
      window.location.href = result.playUrl || `/competition/${comp.id}`;
      return true;
    } catch (e) {
      TW.toast(e.message, 'danger');
      return false;
    }
  };
})();
