'use strict';

window.TW = window.TW || {};

// Lobby mode cards with identity (GET /api/modes/catalog, built from
// server/config/modeIdentity.js): what each mode is, how you win, card slots
// and how many are playing now. Also the Compare modes sheet, the last mode
// you played, "New? Start here" on Quick, and the Private War host sheet.
TW.ModeLobby = (function () {
  const esc = (s) => TW.escapeHtml(String(s == null ? '' : s));
  const LAST_KEY = 'sc_last_mode';
  let catalog = [];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
  };

  const mins = (m) => (m.durationSeconds ? `${Math.round(m.durationSeconds / 60)} min` : '');
  const slots = (m) => (m.cardSlots === 0 ? 'No cards' : `${m.startingHand || m.cardSlots} cards to start${m.sabotage ? '' : ', defense only'}`);

  async function load() {
    try {
      const r = await TW.api('/api/modes/catalog');
      catalog = (r && r.modes) || [];
    } catch (e) {
      catalog = [];
    }
    decorate();
    return catalog;
  }

  function byKey(k) {
    return catalog.find((m) => m.key === k) || null;
  }

  function decorate() {
    const last = store.get(LAST_KEY);
    const player = TW.getPlayer ? TW.getPlayer() : null;
    const isNew = !player || !Number(player.total_matches || 0);
    document.querySelectorAll('.lb-mode[data-mode]').forEach((btn) => {
      const m = byKey(btn.dataset.mode);
      if (!m) return;
      if (m.enabled === false) {
        btn.hidden = true;
        return;
      }
      const name = btn.querySelector('.lb-mode-name');
      if (name) name.textContent = shortName(m);
      let meta = btn.querySelector('.lb-mode-meta');
      if (!meta) {
        meta = document.createElement('span');
        meta.className = 'lb-mode-meta';
        btn.appendChild(meta);
      }
      meta.innerHTML = `<span class="lb-mode-win">${esc(m.winShort)}</span>${m.live ? `<span class="lb-mode-live"><i aria-hidden="true"></i>${m.live} playing</span>` : ''}`;
      btn.title = `${m.displayName}: ${m.identity} Best for: ${m.bestFor}.`;
      btn.setAttribute('aria-label', `${m.displayName}, ${mins(m)}, ${m.winShort}, ${slots(m)}${m.entryCoins ? `, ${m.entryCoins} coins entry` : ''}${m.live ? `, ${m.live} playing now` : ''}`);
      btn.querySelector('.lb-mode-tag')?.remove();
      let tag = null;
      if (isNew && m.key === 'quick') tag = 'New? Start here';
      else if (!isNew && last === m.key) tag = 'Last played';
      btn.classList.toggle('is-suggested', Boolean(tag));
      if (tag) {
        const t = document.createElement('span');
        t.className = 'lb-mode-tag';
        t.textContent = tag;
        btn.appendChild(t);
      }
      if (!btn.dataset.lastBound) {
        btn.dataset.lastBound = '1';
        btn.addEventListener('click', () => store.set(LAST_KEY, btn.dataset.mode));
      }
    });
    addCompareButton();
  }

  function shortName(m) {
    return { quick: 'Quick', blitz: 'Blitz', grand: 'Grand', tournament: 'Elimination', solo: 'Solo', async: 'Daily', private: 'Private' }[m.key] || m.displayName;
  }

  function addCompareButton() {
    // In the mode row itself (the sheet header is hidden on desktop), just
    // before the join-a-room box: visible on desktop and in the phone sheet.
    const modes = document.getElementById('lbModes');
    if (!modes || document.getElementById('lbCompareModes')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'lbCompareModes';
    b.className = 'lb-compare-btn';
    b.setAttribute('data-tour', 'compare-modes');
    b.textContent = 'Compare modes';
    b.addEventListener('click', openCompare);
    modes.insertBefore(b, modes.querySelector('.lb-join'));
  }

  // ---- sheets -----------------------------------------------------------------
  function sheet(title, bodyHtml, { wide = false } = {}) {
    document.getElementById('modeSheet')?.remove();
    const box = document.createElement('div');
    box.id = 'modeSheet';
    box.className = 'mode-sheet';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    box.innerHTML = `<div class="msh-panel${wide ? ' wide' : ''}"><div class="msh-head"><strong>${esc(title)}</strong><button type="button" class="msh-close" aria-label="Close">&times;</button></div><div class="msh-body">${bodyHtml}</div></div>`;
    document.body.appendChild(box);
    const close = () => {
      box.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    box.addEventListener('click', (e) => { if (e.target === box) close(); });
    box.querySelector('.msh-close').addEventListener('click', close);
    box.querySelector('.msh-close').focus();
    return { box, close };
  }

  async function openCompare() {
    if (!catalog.length) await load();
    const rows = catalog.filter((m) => m.enabled !== false);
    const cell = (m) => `<tr>
      <th scope="row"><b>${esc(m.displayName)}</b><span>${esc(m.identity)}</span></th>
      <td data-k="Length">${esc(mins(m))}</td>
      <td data-k="Cards">${esc(slots(m))}${m.startingHand ? `<span>starts with ${m.startingHand}</span>` : ''}</td>
      <td data-k="Win">${esc(m.winCondition || m.winShort)}</td>
      <td data-k="Special">${esc(m.special || '')}</td>
      <td data-k="Best for">${esc(m.bestFor || '')}</td>
      <td data-k="Entry">${m.entryCoins ? `${m.entryCoins} coins` : 'Free'}</td>
    </tr>`;
    sheet('Compare modes', `<p class="msh-note">Every mode uses the same trading rules and the same money maths. What changes is the length, the cards and how you win.</p>
      <div class="msh-table-wrap"><table class="msh-table"><thead><tr><th>Mode</th><th>Length</th><th>Cards</th><th>How you win</th><th>Special</th><th>Best for</th><th>Entry</th></tr></thead><tbody>${rows.map(cell).join('')}</tbody></table></div>
      <a class="msh-link" href="/help#modes">Full guide: How to play each mode</a>`, { wide: true });
  }

  // Private War: the host picks the house rules, then the room opens.
  async function openPrivateSheet(onCreate) {
    if (!catalog.length) await load();
    const m = byKey('private') || {};
    const o = m.hostOptions || { deckLevel: ['basic', 'mid', 'full'], startingHand: [0, 1, 2, 3, 4], flavor: ['quick', 'blitz'] };
    const opt = (list, labels) => list.map((v) => `<option value="${esc(v)}">${esc(labels[v] ?? v)}</option>`).join('');
    const { box, close } = sheet('Host a Private War', `
      <form class="msh-form" id="privateHostForm">
        <label class="msh-row"><span>Cards</span><select name="cards"><option value="true">On</option><option value="false">Off: pure trading</option></select></label>
        <label class="msh-row"><span>Deck level</span><select name="deckLevel">${opt(o.deckLevel, { basic: 'Basic cards only', mid: 'Basic and mid', full: 'Full deck' })}</select></label>
        <label class="msh-row"><span>Starting hand</span><select name="startingHand">${opt(o.startingHand, { 0: 'Mode default', 1: '1 card', 2: '2 cards', 3: '3 cards', 4: '4 cards', 5: '5 cards' })}</select></label>
        <label class="msh-row"><span>Elimination cuts</span><select name="eliminationCuts"><option value="false">Off</option><option value="true">On: bottom 20% out every 3 min (4+ players)</option></select></label>
        <label class="msh-row"><span>Card style</span><select name="flavor">${opt(o.flavor, { quick: 'Quick War', blitz: 'Blitz (fast refill, no heavy cards)' })}</select></label>
        <p class="msh-note">Hosting costs 1 coin, charged only when the match starts. Friends you invite play free. Everyone sees these rules before the start.</p>
        <button type="submit" class="msh-primary">Create room</button>
      </form>`);
    const form = box.querySelector('#privateHostForm');
    const cardsSel = form.elements.cards;
    const sync = () => {
      const off = cardsSel.value === 'false';
      ['deckLevel', 'startingHand', 'flavor'].forEach((n) => { form.elements[n].disabled = off; });
    };
    cardsSel.addEventListener('change', sync);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = form.elements;
      const hostOptions = {
        cards: f.cards.value === 'true',
        deckLevel: f.deckLevel.value,
        startingHand: Number(f.startingHand.value),
        eliminationCuts: f.eliminationCuts.value === 'true',
        flavor: f.flavor.value,
      };
      close();
      onCreate(hostOptions);
    });
  }

  // Walkthrough helper (js/tutorial.js): on phones the mode tiles live in a
  // bottom sheet; open it for a step that points inside it and close it for
  // one that doesn't (or when the tour ends). Returns true if it changed.
  const SHEET_ANCHORS = /^(modes|mode-\w+|compare-modes|join-private)$/;
  TW.revealTourAnchor = (anchor, ending) => {
    const sheet = document.getElementById('lbModes');
    if (!sheet || !TW.openModeSheet) return false;
    const open = document.body.classList.contains('lb-sheet-open');
    const el = anchor ? document.querySelector(`[data-tour="${anchor}"]`) : null;
    const hidden = el && !(el.getBoundingClientRect().width > 0);
    if (!ending && anchor && SHEET_ANCHORS.test(anchor) && sheet.contains(el) && hidden && !open) {
      TW.openModeSheet();
      return true;
    }
    if (open && (ending || !anchor || !SHEET_ANCHORS.test(anchor))) {
      if (TW.closeModeSheet) TW.closeModeSheet();
      return !ending;
    }
    return false;
  };

  return { load, openCompare, openPrivateSheet, byKey, catalog: () => catalog };
})();
