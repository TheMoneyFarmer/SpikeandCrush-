'use strict';

// Shared "enter this competition?" confirmation - used by the lobby hero,
// the lobby competitions list and the Competition Hub. Shows the entry fee
// and prize in coins, plus the required no-cash-value line, then calls the
// existing atomic enter endpoint and drops the player into the play screen.
(function () {
  window.TW = window.TW || {};
  const NO_CASH_LINE = 'Coins have no cash value and cannot be withdrawn or exchanged for money.';
  TW.NO_CASH_LINE = NO_CASH_LINE;

  // onConfirm runs while the dialog stays open: the button shows it's working,
  // and a failure shows inside the dialog so trying again is one click.
  function confirmDialog({ title, fee, prizeCoins, onConfirm }) {
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
            <p class="ce-error" role="alert" hidden style="margin:10px 0 0;color:var(--c-crush,#ff4d6a);font-size:13px"></p>
          </div>
          <div class="ce-actions">
            <button type="button" class="ce-btn ce-cancel">Cancel</button>
            <button type="button" class="ce-btn ce-confirm">${fee > 0 ? `Pay ${Number(fee).toLocaleString()} coins and enter` : 'Enter'}</button>
          </div>
        </div>`;
      let busy = false;
      const done = (ok) => {
        if (busy) return;
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
      overlay.querySelector('.ce-confirm').addEventListener('click', async (e) => {
        if (busy) return;
        const btn = e.currentTarget;
        const errEl = overlay.querySelector('.ce-error');
        const F = window.SCForm;
        busy = true;
        errEl.hidden = true;
        if (F) F.setBusy(btn, true, 'Entering…'); else btn.disabled = true;
        try {
          await onConfirm();
          busy = false;
          done(true);
        } catch (err) {
          busy = false;
          if (F) F.setBusy(btn, false); else btn.disabled = false;
          errEl.textContent = F ? F.friendly(err) : (err.message || 'Something went wrong. Try again.');
          errEl.hidden = false;
        }
      });
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
    let playUrl = null;
    const ok = await confirmDialog({
      title: comp.title,
      fee: comp.entryCoins || 0,
      prizeCoins: comp.prizeCoins || 0,
      onConfirm: async () => {
        const result = await TW.api(`/api/competitions/${comp.id}/enter`, { method: 'POST' });
        playUrl = result.playUrl || `/competition/${comp.id}`;
      },
    });
    if (!ok) return false;
    window.location.href = playUrl;
    return true;
  };

  if (!window.SCForm && !document.querySelector('script[src="/js/form-state.js"]')) {
    const fs = document.createElement('script');
    fs.src = '/js/form-state.js';
    document.head.appendChild(fs);
  }
})();
