'use strict';

window.TW = window.TW || {};

// Cards, streaks, Heat and missions on the competition play screen. The
// server side is server/compFire.js; this feeds the same card tray, Heat
// meter, target picker (js/sabotage.js) and mission chips (js/fire.js) the
// match screen uses. Targets come from the competition leaderboard and can be
// online or offline.
TW.CompCards = (function () {
  let compId = null;
  let fire = null; // view.fire from GET /api/competitions/:id/account
  let instruments = [];
  let onChange = () => {};

  const panel = () => document.getElementById('compCardsPanel');

  function state() {
    return {
      you: fire.accountId,
      players: [{ id: fire.accountId, cards: fire.cards, streak: fire.streak, heat: fire.heat }],
      cardCatalog: fire.cardCatalog,
      fire: fire.config,
      instruments,
    };
  }

  function init(id, { reload } = {}) {
    compId = id;
    onChange = reload || onChange;
    if (!TW.Sabotage) return;
    TW.Sabotage.setSender(async (type, opts) => {
      try {
        const r = await TW.api(`/api/competitions/${compId}/card`, { method: 'POST', body: { cardType: type, targetAccountId: opts.targetId || undefined, symbol: opts.symbol } });
        if (r && r.feedText) setTimeout(() => TW.toast(r.feedText, 'info'), 300);
        setTimeout(() => onChange(), 400);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });
  }

  // Every account view: the hand, streak, Heat and missions.
  function onView(view) {
    const box = panel();
    if (!view || !view.fire) {
      if (box) box.hidden = true;
      return;
    }
    fire = view.fire;
    instruments = (view.competition && view.competition.instruments) || [];
    if (box) box.hidden = false;
    TW.Sabotage.render(state());
    if (TW.Fire) {
      TW.Fire.setYou(fire.accountId);
      TW.Fire.setIdleText(null);
      TW.Fire.setMissions(fire.missions);
    }
  }

  // Leaderboard rows double as the target list (account ids, tags, crown).
  function onLeaderboard(lb) {
    if (!fire || !lb) return;
    const rows = (lb.leaderboard || []).concat(lb.me && !lb.leaderboard.some((r) => r.isMe) ? [lb.me] : []).map((r) => ({ ...r, status: r.status === 'active' ? r.tags || [] : ['out'] }));
    TW.Sabotage.setLeaderboard(rows);
    if (TW.Fire) TW.Fire.setLeaderboard(rows);
  }

  function bindSocket(socket) {
    const mine = (p) => p && (!p.competitionId || p.competitionId === compId);
    socket.on('comp:cards', (p) => {
      if (!mine(p) || !fire) return;
      Object.assign(fire, { cards: p.cards, streak: p.streak, heat: p.heat, missions: p.missions || fire.missions });
      TW.Sabotage.update(p);
      if (TW.Fire && p.missions) TW.Fire.setMissions(p.missions);
    });
    socket.on('missions:update', (p) => mine(p) && TW.Fire && TW.Fire.setMissions(p.missions));
    socket.on('missions:complete', (p) => mine(p) && TW.Fire && TW.Fire.missionComplete(p));
    socket.on('sabotage:incoming', (p) => {
      if (!mine(p)) return;
      TW.Sabotage.showIncoming(p);
      if (TW.Sound) TW.Sound.play('sabotage_receive');
      onChange();
    });
    socket.on('comp:card_result', (p) => {
      if (mine(p) && p.collected) TW.toast(`Profit Tax collected: +${p.collected}`, 'success');
    });
  }

  return { init, onView, onLeaderboard, bindSocket };
})();
