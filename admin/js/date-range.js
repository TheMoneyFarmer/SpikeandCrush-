'use strict';

// Shared report date range control: presets, custom from/to with time, the
// admin's own time zone, and "compare with the previous period". The choice
// is remembered per admin on the server (/api/prefs), with this
// browser's copy used only until that answers.
//
//   const range = await Admin.DateRange.mount(container, { onChange });
//   range.query()   -> "preset=30d&tz=Asia%2FDubai&compare=1" (append to API calls)
//   range.state     -> { preset, from, to, tz, compare }
//   range.label()   -> "Last 30 days" / "1 Nov 09:00 – 3 Nov" for headings and file names
(function () {
  window.Admin = window.Admin || {};
  const PRESETS = [
    ['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['14d', 'Last 14 days'], ['30d', 'Last 30 days'],
    ['90d', 'Last 90 days'], ['this_month', 'This month'], ['last_month', 'Last month'], ['ytd', 'Year to date'], ['custom', 'Custom'],
  ];
  const LS_KEY = 'adm_range';
  const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeLocal(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* not remembered here */ }
  }

  async function mount(container, { onChange, defaultPreset = '7d' } = {}) {
    const state = { preset: defaultPreset, from: null, to: null, tz: browserTz(), compare: true, ...(readLocal() || {}) };
    try {
      const p = await Admin.api('/prefs');
      if (p && p.range) Object.assign(state, p.range, { tz: p.range.tz || state.tz });
    } catch (e) { /* defaults */ }
    if (!PRESETS.some(([k]) => k === state.preset)) state.preset = defaultPreset;

    container.innerHTML = `
      <div class="dr" role="group" aria-label="Report date range">
        <label class="ov-select"><span class="sr-only">Date range</span><select class="dr-preset">${PRESETS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <span class="dr-custom" hidden>
          <label><span class="sr-only">From</span><input type="datetime-local" class="dr-from" /></label>
          <span class="dr-dash" aria-hidden="true">to</span>
          <label><span class="sr-only">To</span><input type="datetime-local" class="dr-to" /></label>
          <button type="button" class="btn btn-sm dr-apply">Apply</button>
        </span>
        <label class="dr-compare"><input type="checkbox" class="dr-cmp" /> Compare</label>
        <span class="dr-tz" title="Ranges use your time zone">${esc(state.tz)}</span>
      </div>`;
    const $ = (sel) => container.querySelector(sel);
    const sel = $('.dr-preset');
    const custom = $('.dr-custom');
    const toLocal = (v) => (v ? String(v).slice(0, 16) : '');
    sel.value = state.preset;
    $('.dr-cmp').checked = state.compare !== false;
    $('.dr-from').value = toLocal(state.from);
    $('.dr-to').value = toLocal(state.to);
    custom.hidden = state.preset !== 'custom';

    async function changed() {
      writeLocal(state);
      Admin.api('/prefs', { method: 'PUT', body: { range: state } }).catch(() => {});
      if (onChange) onChange(api);
    }
    sel.addEventListener('change', () => {
      state.preset = sel.value;
      custom.hidden = state.preset !== 'custom';
      if (state.preset === 'custom') {
        if (!$('.dr-from').value) {
          const d = new Date(Date.now() - 6 * 86400000);
          $('.dr-from').value = `${d.toLocaleDateString('en-CA')}T00:00`;
        }
        if (!$('.dr-to').value) $('.dr-to').value = `${new Date().toLocaleDateString('en-CA')}T23:59`;
        $('.dr-from').focus();
        return;
      }
      changed();
    });
    $('.dr-apply').addEventListener('click', () => {
      const f = $('.dr-from').value;
      const t = $('.dr-to').value;
      if (!f || !t) return Admin.toast('Choose both dates', 'warning');
      if (t <= f) return Admin.toast('The end must be after the start', 'warning');
      state.from = f;
      state.to = t;
      changed();
    });
    $('.dr-cmp').addEventListener('change', (e) => { state.compare = e.target.checked; changed(); });

    const api = {
      state,
      query() {
        const q = new URLSearchParams({ preset: state.preset, tz: state.tz, compare: state.compare === false ? '0' : '1' });
        if (state.preset === 'custom') {
          if (state.from) q.set('from', state.from);
          if (state.to) q.set('to', state.to);
        }
        return q.toString();
      },
      label() {
        if (state.preset !== 'custom') return (PRESETS.find(([k]) => k === state.preset) || [])[1] || state.preset;
        const f = (v) => (v ? new Date(v).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
        return `${f(state.from)} – ${f(state.to)}`;
      },
      fileTag() {
        return state.preset === 'custom' ? `${String(state.from || '').slice(0, 10)}_${String(state.to || '').slice(0, 10)}` : state.preset;
      },
    };
    return api;
  }

  Admin.DateRange = { mount, PRESETS };
})();
