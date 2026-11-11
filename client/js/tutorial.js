'use strict';

window.TW = window.TW || {};

// The walkthrough engine. Tours and their text come from the server
// (GET /api/tours, built from server/config/tours.js plus admin edits); each
// step spotlights a real element through its data-tour anchor and falls back
// to a centred card when that element is not on screen. Progress is per
// account and versioned (POST /api/tours/progress): a tour shows again only
// when its version goes up, and the lobby then shows "What's new" instead of
// the full tour. Skip asks once and records the step it was skipped at.
(function () {
  let running = null;

  function findAnchor(step) {
    if (!step.anchor && !step.target) return null;
    const list = document.querySelectorAll(step.anchor ? `[data-tour="${step.anchor}"]` : step.target);
    for (const el of list) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
    return null;
  }

  class Tutorial {
    constructor(steps, { onFinish = null, label = 'Tour' } = {}) {
      this.steps = steps;
      this.currentStep = 0;
      this.onFinish = onFinish;
      this.label = label;
      this.overlay = null;
      this.spotlight = null;
      this.card = null;
      this._reposition = null;
      this._onKey = null;
    }

    start() {
      if (running) return;
      running = this;
      this.createOverlay();
      this.showStep(0);
    }

    createOverlay() {
      this.overlay = document.createElement('div');
      this.overlay.className = 'tutorial-overlay';
      this.overlay.setAttribute('role', 'dialog');
      this.overlay.setAttribute('aria-modal', 'true');
      this.overlay.setAttribute('aria-label', this.label);
      this.overlay.innerHTML = `
        <div class="tutorial-spotlight"></div>
        <div class="tutorial-card">
          <div class="tutorial-step-number"></div>
          <h3 class="tutorial-title"></h3>
          <p class="tutorial-body"></p>
          <button class="btn-tutorial-next tutorial-cta" type="button" style="display:none;margin-top:10px;width:100%;"></button>
          <div class="tutorial-footer">
            <div class="tutorial-dots"></div>
            <div class="tutorial-buttons">
              <button class="btn-tutorial-skip" type="button">Skip</button>
              <button class="btn-tutorial-back" type="button">Back</button>
              <button class="btn-tutorial-next" type="button">Next</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(this.overlay);
      this.spotlight = this.overlay.querySelector('.tutorial-spotlight');
      this.card = this.overlay.querySelector('.tutorial-card');
      this.card.querySelector('.btn-tutorial-skip').addEventListener('click', () => this.skip());
      this.card.querySelector('.btn-tutorial-back').addEventListener('click', () => this.back());
      this.card.querySelector('.tutorial-footer .btn-tutorial-next').addEventListener('click', () => this.next());
      this.card.querySelector('.tutorial-cta').addEventListener('click', () => {
        const cta = this.steps[this.currentStep].cta;
        this.finish('completed');
        if (cta && cta.click) setTimeout(() => document.querySelector(cta.click)?.click(), 350);
      });
      this._reposition = () => this.place(this.steps[this.currentStep], false);
      window.addEventListener('resize', this._reposition);
      this._onKey = (e) => {
        if (e.key === 'Escape') this.skip();
        else if (e.key === 'ArrowRight') this.next();
        else if (e.key === 'ArrowLeft') this.back();
      };
      document.addEventListener('keydown', this._onKey);
    }

    place(step, scroll) {
      const target = findAnchor(step);
      if (target) {
        if (scroll) target.scrollIntoView({ block: 'center' });
        this.positionSpotlight(target);
        this.positionCard(target);
      } else {
        this.centerCard();
        this.spotlight.style.display = 'none';
      }
    }

    showStep(index) {
      const step = this.steps[index];
      const isLast = index === this.steps.length - 1;
      this.card.querySelector('.tutorial-step-number').textContent = `${this.label} · ${index + 1} of ${this.steps.length}`;
      this.card.querySelector('.tutorial-title').textContent = step.title;
      this.card.querySelector('.tutorial-body').textContent = step.body;
      const cta = this.card.querySelector('.tutorial-cta');
      cta.style.display = step.cta ? 'block' : 'none';
      cta.textContent = step.cta ? step.cta.label : '';
      this.card.querySelector('.btn-tutorial-back').style.visibility = index === 0 ? 'hidden' : 'visible';
      this.card.querySelector('.tutorial-footer .btn-tutorial-next').textContent = isLast ? 'Done' : 'Next';
      this.card.querySelector('.tutorial-dots').innerHTML = this.steps.map((_, i) => `<div class="tutorial-dot ${i === index ? 'active' : ''}"></div>`).join('');
      this.place(step, true);
      setTimeout(() => this.card.querySelector('.tutorial-footer .btn-tutorial-next')?.focus(), 0);
    }

    positionSpotlight(target) {
      const rect = target.getBoundingClientRect();
      const pad = 6;
      Object.assign(this.spotlight.style, { display: 'block', left: `${rect.left - pad}px`, top: `${rect.top - pad}px`, width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px` });
    }

    // Beside the target when there is room, otherwise below or above it,
    // always inside the viewport (phones: full width minus 16px gutters).
    positionCard(target) {
      const rect = target.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const cardWidth = Math.min(320, vw - 32);
      this.card.style.width = `${cardWidth}px`;
      const h = this.card.offsetHeight || 220;
      let left;
      let top;
      if (rect.right + 20 + cardWidth <= vw - 16) { left = rect.right + 20; top = rect.top; }
      else if (rect.left - 20 - cardWidth >= 16) { left = rect.left - 20 - cardWidth; top = rect.top; }
      else {
        left = Math.min(Math.max(16, rect.left), vw - cardWidth - 16);
        top = rect.bottom + 14 + h <= vh - 16 ? rect.bottom + 14 : rect.top - 14 - h;
      }
      this.card.style.left = `${Math.max(16, Math.min(left, vw - cardWidth - 16))}px`;
      this.card.style.top = `${Math.max(16, Math.min(top, vh - h - 16))}px`;
      this.card.style.transform = 'none';
    }

    centerCard() {
      this.card.style.width = `${Math.min(360, window.innerWidth - 32)}px`;
      this.card.style.left = '50%';
      this.card.style.top = '50%';
      this.card.style.transform = 'translate(-50%, -50%)';
    }

    next() {
      if (this.currentStep < this.steps.length - 1) this.showStep(++this.currentStep);
      else this.finish('completed');
    }

    back() {
      if (this.currentStep > 0) this.showStep(--this.currentStep);
    }

    skip() {
      if (this._confirming) return;
      this._confirming = true;
      TW.confirmDialog({ title: 'Skip this tour?', body: 'You can replay it any time from Settings > Help.', confirmLabel: 'Skip' })
        .then((ok) => { this._confirming = false; if (ok) this.finish('skipped'); });
    }

    finish(outcome) {
      if (!this.overlay) return;
      window.removeEventListener('resize', this._reposition);
      document.removeEventListener('keydown', this._onKey);
      const overlay = this.overlay;
      this.overlay = null;
      overlay.style.transition = 'opacity 0.25s';
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 250);
      running = null;
      if (this.onFinish) this.onFinish(outcome, this.currentStep);
    }
  }

  TW.Tutorial = Tutorial;

  // A themed confirm dialog instead of the browser's native confirm().
  TW.confirmDialog = ({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) =>
    new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'tutorial-confirm-overlay';
      overlay.innerHTML = `
        <div class="tutorial-confirm-box" role="alertdialog" aria-modal="true">
          <h3 style="margin:0 0 4px;font-size:16px;">${TW.escapeHtml(title)}</h3>
          <p>${TW.escapeHtml(body)}</p>
          <div class="tutorial-confirm-actions">
            <button class="btn-tutorial-skip" type="button" data-no>${TW.escapeHtml(cancelLabel)}</button>
            <button class="btn-tutorial-next" type="button" data-yes>${TW.escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('[data-no]').addEventListener('click', () => { overlay.remove(); resolve(false); });
      overlay.querySelector('[data-yes]').addEventListener('click', () => { overlay.remove(); resolve(true); });
      overlay.querySelector('[data-yes]').focus();
    });

  // ---- tours with per-account progress ------------------------------------------
  let cache = null;
  function load(force) {
    if (!TW.getToken || !TW.getToken()) return Promise.resolve(null);
    if (!cache || force) cache = TW.api('/api/tours').catch(() => null);
    return cache;
  }

  function due(data, id) {
    const t = data && data.tours[id];
    if (!data || !data.enabled || !t || !t.enabled || !t.steps.length) return false;
    const p = data.progress[id];
    return !p || p.v < t.version;
  }

  async function record(id, outcome, step) {
    try {
      const r = await TW.api('/api/tours/progress', { method: 'POST', body: { tour: id, outcome, step } });
      if (cache && r && r.progress) cache = cache.then((d) => (d ? { ...d, progress: r.progress } : d));
    } catch (e) { /* offline: it shows again next time, which is harmless */ }
  }

  function run(id, data, { onDone, extraLast } = {}) {
    const t = data.tours[id];
    const steps = t.steps.map((s) => ({ ...s }));
    if (extraLast) Object.assign(steps[steps.length - 1], extraLast);
    new Tutorial(steps, {
      label: t.label || 'Tour',
      onFinish: (outcome, step) => {
        record(id, outcome, step);
        if (onDone) onDone(outcome);
      },
    }).start();
    return true;
  }

  async function maybeRun(id, opts = {}) {
    if (running) return false;
    const data = await load();
    if (!data || (!opts.force && !due(data, id))) return false;
    return run(id, data, opts);
  }

  // Lobby: the full tour for someone who never saw one; "What's new" for
  // someone who finished an older lobby tour (or the old tutorial).
  async function lobby({ force = false } = {}) {
    const data = await load();
    if (!data) return false;
    const soloCta = { cta: { label: 'Start a free practice match', click: '#modeSoloBtn' } };
    if (force) return run('lobby', data, { extraLast: soloCta, onDone: () => record('whatsNew', 'completed', null) });
    if (!data.enabled) return false;
    const p = data.progress.lobby;
    if (!p && !data.legacyDone) {
      if (!due(data, 'lobby')) return false;
      return run('lobby', data, { extraLast: soloCta, onDone: () => record('whatsNew', 'completed', null) });
    }
    if (p && p.v >= data.tours.lobby.version) return false;
    if (due(data, 'whatsNew')) return run('whatsNew', data, { onDone: () => record('lobby', 'completed', null) });
    record('lobby', 'completed', null);
    return false;
  }

  // Game page, once the rules card is gone: the first-match tour in the
  // player's first match, later a short intro the first time in each mode.
  async function forMatch(state) {
    const data = await load();
    if (!data || !state) return false;
    if (due(data, 'firstMatch')) return run('firstMatch', data);
    const id = `mode_${state.mode}`;
    if (data.tours[id] && due(data, id)) return run(id, data);
    return false;
  }

  // Results screen after the player's first match.
  async function forResults() {
    return maybeRun('postMatch');
  }

  async function reset() {
    try { await TW.api('/api/tours/reset', { method: 'POST' }); } catch (e) { /* ignore */ }
    cache = null;
    try { localStorage.removeItem('sc_tutorial_done'); } catch (e) { /* storage blocked */ }
  }

  TW.Tours = { load, lobby, forMatch, forResults, maybeRun, reset, isRunning: () => Boolean(running) };
  // Settings > Help > Replay sends the player to the lobby with this flag.
  TW.replayTutorial = () => lobby({ force: true });

  document.addEventListener('DOMContentLoaded', () => {
    if (document.body.dataset.page !== 'index' || !TW.getToken || !TW.getToken()) return;
    const params = new URLSearchParams(window.location.search);
    const replay = params.get('replay_tutorial') === '1';
    if (replay) history.replaceState(null, '', window.location.pathname);
    setTimeout(() => lobby({ force: replay }), replay ? 500 : 1200);
  });
})();
