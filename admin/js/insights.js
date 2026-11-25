'use strict';

// Admin Analytics dashboard (admin/routes/insights.js). Every tab is drawn
// from the same shape: tiles, series (SVG lines), tables. State lives in the
// URL so a view can be shared with another admin.
(function () {
  const TABS = [
    ['overview', 'Overview'], ['funnels', 'Funnels'], ['retention', 'Retention'], ['pages', 'Pages'], ['modes', 'Modes'],
    ['social', 'Social and growth'], ['competitions', 'Competitions'], ['sponsors', 'Sponsors'], ['affiliate', 'Affiliate and partner links'],
    ['tech', 'Tech health'], ['support', 'Support and mobile'], ['quality', 'Data quality'],
  ];
  const COLORS = ['#e0533a', '#0b6e70', '#d9a21b', '#4a7fe0'];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const q = new URLSearchParams(location.search);
  const state = {
    tab: TABS.some(([k]) => k === q.get('tab')) ? q.get('tab') : 'overview',
    preset: q.get('preset') || (q.get('from') ? '' : '30'), from: q.get('from') || '', to: q.get('to') || '',
    tz: q.get('tz') === 'utc' ? 'utc' : 'dubai', internal: q.get('internal') === '1',
    device: q.get('device') || '', mode: q.get('mode') || '', country: q.get('country') || '', source: q.get('source') || '', campaign: q.get('campaign') || '', page: q.get('page') || '',
  };

  function params(extra = {}) {
    const p = new URLSearchParams();
    if (state.preset) p.set('preset', state.preset); else { if (state.from) p.set('from', state.from); if (state.to) p.set('to', state.to); }
    p.set('tz', state.tz);
    if (state.internal) p.set('internal', '1');
    for (const k of ['device', 'mode', 'country', 'source', 'campaign', 'page']) if (state[k]) p.set(k, state[k]);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }

  function syncControls() {
    $('axTabs').innerHTML = TABS.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === state.tab}">${esc(label)}</button>`).join('');
    document.querySelectorAll('#axPresets button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset)));
    document.querySelectorAll('#axTz button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tz === state.tz)));
    $('axFrom').value = state.from; $('axTo').value = state.to;
    $('axInternal').checked = state.internal;
    $('axDevice').value = state.device; $('axMode').value = state.mode; $('axCountry').value = state.country; $('axSource').value = state.source; $('axCampaign').value = state.campaign; $('axPage').value = state.page;
    $('axCsv').href = `/api/insights/${state.tab}?${params({ format: 'csv' })}`;
    const url = new URL(location.href);
    url.search = params({ tab: state.tab }).toString();
    history.replaceState(null, '', url);
  }

  function lineChart(s) {
    const W = 760; const H = 200; const P = { l: 36, r: 10, t: 10, b: 24 };
    const all = s.lines.flatMap((l) => l.values);
    const max = Math.max(1, ...all);
    const n = s.x.length;
    const xAt = (i) => P.l + (n <= 1 ? 0 : (i * (W - P.l - P.r)) / (n - 1));
    const yAt = (v) => H - P.b - (v / max) * (H - P.t - P.b);
    const grid = [0, 0.5, 1].map((f) => `<line x1="${P.l}" x2="${W - P.r}" y1="${yAt(max * f)}" y2="${yAt(max * f)}" stroke="rgba(120,72,58,.12)"/><text x="${P.l - 6}" y="${yAt(max * f) + 4}" fill="#7a6a65" font-size="10" text-anchor="end">${Math.round(max * f)}</text>`).join('');
    const ticks = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => n && a.indexOf(v) === i).map((i) => `<text x="${xAt(i)}" y="${H - 6}" fill="#7a6a65" font-size="10" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(s.x[i])}</text>`).join('');
    const paths = s.lines.map((l, k) => `<polyline fill="none" stroke="${COLORS[k % COLORS.length]}" stroke-width="2" stroke-linejoin="round" points="${l.values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ')}"/>`).join('');
    const label = `${s.title}: ${s.lines.map((l) => `${l.name} total ${l.values.reduce((a, v) => a + v, 0)}`).join(', ')}`;
    return `<div class="ax-panel ax-chart"><h2>${esc(s.title)}</h2><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${grid}${paths}${ticks}</svg>
      <div class="ax-legend">${s.lines.map((l, k) => `<span><b style="background:${COLORS[k % COLORS.length]}"></b>${esc(l.name)}</span>`).join('')}</div></div>`;
  }

  function tableHtml(t) {
    if (!t.rows.length) return `<div class="ax-panel"><h2>${esc(t.title)}</h2><div class="ax-empty">No data for this range and these filters.</div></div>`;
    const isNum = t.columns.map((_, i) => t.rows.every((r) => typeof r[i] === 'number' || /^-?[\d.,]+%?$/.test(String(r[i]))));
    const reportCol = t.columns.indexOf('Report');
    const cell = (v, i) => {
      if (i === reportCol) {
        const p = params(); p.delete('preset');
        const range = new URLSearchParams({ tz: state.tz, from: state.from || '', to: state.to || '' });
        if (state.preset) { const days = { today: 0, 7: 6, 30: 29, 90: 89 }[state.preset]; const to = new Date(); const fr = new Date(to.getTime() - days * 86400000); range.set('from', fr.toISOString().slice(0, 10)); range.set('to', to.toISOString().slice(0, 10)); }
        return `<td><a href="/api/sponsors/${esc(v)}/report-full?${range}&format=csv" download>CSV</a> &middot; <a href="/api/sponsors/${esc(v)}/report-full?${range}&format=pdf" download>PDF</a></td>`;
      }
      return `<td class="${isNum[i] ? 'num' : ''}">${esc(v)}</td>`;
    };
    return `<div class="ax-panel ax-table"><h2>${esc(t.title)}</h2><table><thead><tr>${t.columns.map((c, i) => `<th class="${isNum[i] ? 'num' : ''}" scope="col">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  let seq = 0;
  async function load() {
    syncControls();
    const mine = ++seq;
    $('axBody').innerHTML = '<div class="ax-loading">Loading</div>';
    try {
      const d = await Admin.api(`/insights/${state.tab}?${params()}`);
      if (mine !== seq) return;
      const empty = !(d.tiles || []).length && !(d.tables || []).some((t) => t.rows.length);
      const metaLine = `${esc(d.meta.from)} to ${esc(d.meta.to)}, ${esc(d.meta.timezone)}${d.meta.includeInternal ? ', internal traffic included' : ''}`;
      $('axBody').innerHTML = `<p class="ax-sub">${metaLine}</p>`
        + (d.tiles.length ? `<div class="ax-tiles">${d.tiles.map((t) => `<div class="ax-tile ${/^(red|warning)$/.test(t.note) ? t.note : ''}"><span>${esc(t.label)}</span><b>${esc(t.value)}</b>${t.note ? `<i>${esc(t.note)}</i>` : ''}</div>`).join('')}</div>` : '')
        + (d.series || []).map(lineChart).join('')
        + (d.tables || []).map(tableHtml).join('')
        + ((d.notes || []).length ? `<div class="ax-panel">${d.notes.map((n) => `<p class="ax-note">${esc(n)}</p>`).join('')}</div>` : '')
        + (empty ? '<div class="ax-empty">No data for this range and these filters.</div>' : '');
    } catch (e) {
      if (mine === seq) $('axBody').innerHTML = `<div class="ax-error">${esc(e.message)}</div>`;
    }
  }

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('#axTabs [data-tab]');
    if (tab) { state.tab = tab.dataset.tab; return load(); }
    const pre = e.target.closest('#axPresets [data-preset]');
    if (pre) { state.preset = pre.dataset.preset; state.from = ''; state.to = ''; return load(); }
    const tz = e.target.closest('#axTz [data-tz]');
    if (tz) { state.tz = tz.dataset.tz; return load(); }
  });
  ['axFrom', 'axTo'].forEach((id) => $(id).addEventListener('change', () => { state.preset = ''; state.from = $('axFrom').value; state.to = $('axTo').value; if (state.from && state.to) load(); }));
  $('axInternal').addEventListener('change', () => { state.internal = $('axInternal').checked; load(); });
  const fields = { axDevice: 'device', axMode: 'mode', axCountry: 'country', axSource: 'source', axCampaign: 'campaign', axPage: 'page' };
  let t = null;
  for (const [id, key] of Object.entries(fields)) {
    $(id).addEventListener(id === 'axDevice' || id === 'axMode' ? 'change' : 'input', () => {
      state[key] = key === 'country' ? $(id).value.trim().toUpperCase() : $(id).value.trim();
      clearTimeout(t); t = setTimeout(load, 400);
    });
  }
  load();
})();
