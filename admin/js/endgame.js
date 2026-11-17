'use strict';

// Admin > Seasons and Balance (admin/routes/endgame.js).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Admin.escapeHtml(s == null ? '' : String(s));
  const pct = (v) => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`);
  const loaded = {};

  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    for (const t of ['balance', 'config', 'seasons', 'twists']) $(`tab-${t}`).hidden = t !== b.dataset.tab;
    if (!loaded[b.dataset.tab]) { loaded[b.dataset.tab] = true; ({ balance: loadBalance, config: loadConfig, seasons: loadSeasons, twists: loadTwists })[b.dataset.tab](); }
  }));

  async function loadBalance() {
    loaded.balance = true;
    const q = new URLSearchParams({ days: $('bDays').value });
    if ($('bMode').value.trim()) q.set('mode', $('bMode').value.trim());
    if ($('bBracket').value) q.set('bracket', $('bBracket').value);
    try {
      const d = await Admin.api(`/endgame/balance?${q}`);
      $('bNote').textContent = `Average win rate when played: ${pct(d.averageWinRatePlayed)}. "Too strong" = 10 points above that with at least ${d.minSample} plays; "never picked" = under 2% pick rate with at least ${d.minSample} holds.`;
      $('bRows').innerHTML = d.rows.length ? d.rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.held}</td><td>${r.played}</td><td>${pct(r.pickRate)}</td><td>${pct(r.winRatePlayed)}</td><td>${pct(r.winRateUnplayed)}</td><td>${r.rankSwing == null ? '—' : r.rankSwing.toFixed(2)}</td><td>${r.flags.map((f) => `<span class="eg-flag">${esc(f.replace('_', ' '))}</span>`).join(' ')}</td></tr>`).join('') : '<tr><td colspan="8">No data yet: numbers build up nightly from played matches.</td></tr>';
    } catch (e) { $('bRows').innerHTML = `<tr><td colspan="8">${esc(e.message)}</td></tr>`; }
  }
  ['Recruit', 'Trader', 'Broker', 'Analyst', 'Veteran', 'Elite', 'War Lord'].forEach((t) => $('bBracket').insertAdjacentHTML('beforeend', `<option>${t}</option>`));
  for (const id of ['bDays', 'bBracket']) $(id).addEventListener('change', loadBalance);
  $('bMode').addEventListener('change', loadBalance);
  $('bRun').addEventListener('click', async () => { try { const r = await Admin.api('/endgame/balance/run', { method: 'POST', body: {} }); Admin.toast(`Rebuilt ${r.day}: ${r.rows} rows`, 'success'); loadBalance(); } catch (e) { Admin.toast(e.message, 'danger'); } });

  async function loadConfig() {
    const d = await Admin.api('/endgame/card-config');
    const active = d.versions.find((v) => v.active);
    const cur = (active && active.params.durations) || {};
    $('cRows').innerHTML = d.cards.filter((c) => c.bounds).map((c) => `<tr><td>${esc(c.name)}</td><td>${c.defaultDuration}s</td><td>${c.bounds.min}-${c.bounds.max}s</td><td><input type="number" data-card="${c.id}" min="${c.bounds.min}" max="${c.bounds.max}" value="${cur[c.id] ?? ''}" placeholder="${c.defaultDuration}" style="width:90px;" /></td></tr>`).join('');
    $('cVersions').innerHTML = d.versions.map((v) => `<tr><td>#${v.id}${v.active ? ' (active)' : ''}</td><td>${esc(Admin.formatDate(v.created_at))}</td><td>${esc(v.created_by)}</td><td>${esc(v.note || '')}</td><td>${esc(Object.entries(v.params.durations || {}).map(([k, x]) => `${k}=${x}s`).join(', ') || 'defaults')}</td><td>${v.active ? '' : `<button class="btn btn-sm" data-activate="${v.id}">Roll back to this</button>`}</td></tr>`).join('') || '<tr><td colspan="6">No versions yet: every card uses its default.</td></tr>';
    $('cVersions').querySelectorAll('[data-activate]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Make version #${b.dataset.activate} active again?`)) return;
      try { await Admin.api(`/endgame/card-config/${b.dataset.activate}/activate`, { method: 'POST', body: {} }); Admin.toast('Rolled back', 'success'); loadConfig(); } catch (e) { Admin.toast(e.message, 'danger'); }
    }));
  }
  $('cSave').addEventListener('click', async () => {
    const durations = {};
    document.querySelectorAll('#cRows input[data-card]').forEach((i) => { if (i.value !== '') durations[i.dataset.card] = Number(i.value); });
    try { await Admin.api('/endgame/card-config', { method: 'POST', body: { params: { durations }, note: $('cNote').value } }); Admin.toast('Saved. Live within a minute.', 'success'); $('cNote').value = ''; loadConfig(); } catch (e) { Admin.toast(e.message, 'danger'); }
  });

  let seasons = [];
  const toLocal = (iso) => (iso ? new Date(new Date(iso) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  async function loadSeasons() {
    try {
      const d = await Admin.api('/endgame/seasons');
      seasons = d.seasons;
      $('sRows').innerHTML = seasons.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(new Date(s.starts_at).toLocaleDateString())} to ${esc(new Date(s.ends_at).toLocaleDateString())}</td><td>${esc(s.state === 'archived' ? 'archived' : s.liveState)}</td><td>${esc((s.featured_cards || []).join(', ') || '—')}</td><td>${s.state === 'archived' ? '' : `<button class="btn btn-sm" data-edit="${s.id}">Edit</button> <button class="btn btn-sm" data-end="${s.id}">End now</button>`}</td></tr>`).join('') || '<tr><td colspan="5">No seasons yet.</td></tr>';
      $('sRows').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const s = seasons.find((x) => x.id === b.dataset.edit);
        $('sFormTitle').textContent = `Edit ${s.name}`;
        $('sId').value = s.id; $('sName').value = s.name; $('sTheme').value = s.theme || ''; $('sStart').value = toLocal(s.starts_at); $('sEnd').value = toLocal(s.ends_at);
        $('sFeatured').value = (s.featured_cards || []).join(', '); $('sReset').value = s.soft_reset_pct; $('sTrack').value = JSON.stringify(s.track || []); $('sPeak').value = JSON.stringify(s.peak_rewards || []);
      }));
      $('sRows').querySelectorAll('[data-end]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('End this season now? Peak rewards and the soft rank reset run once for every player. This cannot be undone.')) return;
        try { const r = await Admin.api(`/endgame/seasons/${b.dataset.end}/end`, { method: 'POST', body: {} }); Admin.toast(`Ended: ${r.reset} players reset, ${r.rewarded} peak rewards`, 'success'); loadSeasons(); } catch (e) { Admin.toast(e.message, 'danger'); }
      }));
    } catch (e) { $('sRows').innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`; }
  }
  $('sNew').addEventListener('click', () => { $('sId').value = ''; $('sFormTitle').textContent = 'New season'; });
  $('sForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    let track; let peak;
    try { track = JSON.parse($('sTrack').value || '[]'); peak = JSON.parse($('sPeak').value || '[]'); } catch (err) { return Admin.toast('The rewards must be valid JSON', 'danger'); }
    const body = { name: $('sName').value, theme: $('sTheme').value, startsAt: new Date($('sStart').value).toISOString(), endsAt: $('sEnd').value ? new Date($('sEnd').value).toISOString() : undefined, featuredCards: $('sFeatured').value, softResetPct: Number($('sReset').value), track, peakRewards: peak };
    const id = $('sId').value;
    try { await Admin.api(id ? `/endgame/seasons/${id}` : '/endgame/seasons', { method: id ? 'PUT' : 'POST', body }); Admin.toast('Season saved', 'success'); $('sForm').reset(); $('sId').value = ''; loadSeasons(); } catch (err) { Admin.toast(err.message, 'danger'); }
  });

  let library = [];
  async function loadTwists() {
    try {
      const d = await Admin.api('/endgame/twists');
      library = d.library;
      if (!$('tKey').options.length) {
        library.forEach((t) => $('tKey').insertAdjacentHTML('beforeend', `<option value="${t.key}">${esc(t.name)}</option>`));
        const setParam = () => { const t = library.find((x) => x.key === $('tKey').value); $('tValLabel').textContent = `${t.param} (${t.min} to ${t.max})`; $('tVal').min = t.min; $('tVal').max = t.max; $('tVal').value = t.default; $('tVal').disabled = t.min === t.max; };
        $('tKey').addEventListener('change', setParam);
        setParam();
      }
      const nameOf = Object.fromEntries(library.map((t) => [t.key, t.name]));
      $('tRows').innerHTML = d.twists.map((t) => `<tr><td>${esc(nameOf[t.twist_key] || t.twist_key)}</td><td>${esc(JSON.stringify(t.params))}</td><td>${esc(new Date(t.starts_at).toLocaleString())} to ${esc(new Date(t.ends_at).toLocaleString())}</td><td>${esc((t.modes || []).join(', ') || 'all')}</td><td>${t.include_ranked ? 'yes' : 'no'}</td><td><button class="btn btn-sm" data-toggle="${t.id}">${t.enabled ? 'Turn off' : 'Turn on'}</button></td></tr>`).join('') || '<tr><td colspan="6">No twists scheduled.</td></tr>';
      $('tRows').querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => { await Admin.api(`/endgame/twists/${b.dataset.toggle}/toggle`, { method: 'POST', body: {} }); loadTwists(); }));
    } catch (e) { $('tRows').innerHTML = `<tr><td colspan="6">${esc(e.message)}</td></tr>`; }
  }
  $('tForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = library.find((x) => x.key === $('tKey').value);
    try {
      await Admin.api('/endgame/twists', { method: 'POST', body: { key: t.key, params: { [t.param]: Number($('tVal').value) }, startsAt: new Date($('tStart').value).toISOString(), endsAt: $('tEnd').value ? new Date($('tEnd').value).toISOString() : undefined, modes: $('tModes').value, includeRanked: $('tRanked').checked } });
      Admin.toast('Twist scheduled', 'success'); loadTwists();
    } catch (err) { Admin.toast(err.message, 'danger'); }
  });

  loadBalance();
})();
