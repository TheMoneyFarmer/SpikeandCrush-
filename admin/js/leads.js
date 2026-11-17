'use strict';

// Admin Leads page: tabs by category with counts and a red dot for unread New,
// filters, the lead detail with timeline, status/owner/priority/follow-up/tags,
// notes, Reply (mailto draft), spam, convert to sponsor or partner listing,
// CSV export, pipeline summary and settings. API: admin/routes/leads.js.
(function () {
  const esc = (s) => Admin.escapeHtml(s == null ? '' : String(s));
  const $ = (id) => document.getElementById(id);
  const STATUSES = ['new', 'contacted', 'qualified', 'in_talks', 'won', 'lost', 'spam'];
  const STATUS_LABEL = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', in_talks: 'In talks', won: 'Won', lost: 'Lost', spam: 'Spam' };
  const state = { category: '', me: '', labels: {}, range: null, current: null };

  for (const s of STATUSES) $('ldStatus').insertAdjacentHTML('beforeend', `<option value="${s}">${STATUS_LABEL[s]}</option>`);

  function query() {
    const p = new URLSearchParams();
    if (state.category) p.set('category', state.category);
    for (const [k, id] of [['status', 'ldStatus'], ['priority', 'ldPriority'], ['owner', 'ldOwner'], ['sort', 'ldSort']]) if ($(id).value) p.set(k, $(id).value);
    if ($('ldSearch').value.trim()) p.set('q', $('ldSearch').value.trim());
    if ($('ldOwner').value === 'me') p.set('me', state.me);
    const r = state.range ? new URLSearchParams(state.range.query()) : null;
    if (r) for (const [k, v] of r) p.set(k, v);
    return p.toString();
  }

  async function loadTabs() {
    const c = await Admin.api('/leads/counts');
    state.labels = c.labels;
    const tab = (key, label, n) => `<button class="ld-tab" role="tab" data-cat="${key}" aria-selected="${state.category === key}">${esc(label)} <span class="text-secondary">${n.total}</span>${n.unreadNew ? '<span class="ld-dot" title="Unread new"></span>' : ''}</button>`;
    $('ldTabs').innerHTML = tab('', 'All', c.all) + Object.entries(c.counts).map(([k, n]) => tab(k, c.labels[k], n)).join('');
    $('ldTabs').querySelectorAll('.ld-tab').forEach((b) => b.addEventListener('click', () => { state.category = b.dataset.cat; loadAll(); }));
  }

  async function loadList() {
    const { leads } = await Admin.api(`/leads?${query()}`);
    $('ldRows').innerHTML = leads.length ? leads.map((l) => `<tr class="ld-row ${l.read_at ? '' : 'unread'}" data-id="${l.id}" tabindex="0">
        <td>${esc(Admin.formatDate(l.created_at))}</td>
        <td>${esc(state.labels[l.category] || l.category)}${l.email_status === 'failed' ? ' <span class="ld-warn" title="Notification email failed">email failed</span>' : ''}</td>
        <td>${esc(l.company || l.name || l.email || '—')}</td>
        <td>${esc(STATUS_LABEL[l.status])}${l.priority === 'high' ? ' <span class="ld-warn">high</span>' : ''}</td>
        <td>${esc(l.owner || '—')}</td>
        <td>${l.next_followup_at ? esc(Admin.formatDate(l.next_followup_at)) : '—'}</td></tr>`).join('') : '<tr><td colspan="6">No leads match these filters.</td></tr>';
    $('ldRows').querySelectorAll('.ld-row').forEach((tr) => {
      tr.addEventListener('click', () => openLead(tr.dataset.id));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openLead(tr.dataset.id); });
    });
  }

  async function loadSummary() {
    const s = await Admin.api('/leads/summary');
    const rows = Object.entries(s.table);
    $('ldSummary').innerHTML = `<div style="font-size:13px;margin-bottom:8px;">${s.total} leads · new to won ${s.conversionNewToWonPct}% · average time to first contact ${s.avgHoursToFirstContact == null ? '—' : `${s.avgHoursToFirstContact} h`}</div>
      ${rows.length ? `<div class="admin-table-wrap"><table class="admin-table ld-summary"><thead><tr><th>Category</th>${STATUSES.filter((x) => x !== 'spam').map((x) => `<th>${STATUS_LABEL[x]}</th>`).join('')}</tr></thead><tbody>${rows.map(([cat, t]) => `<tr><td>${esc(state.labels[cat] || cat)}</td>${STATUSES.filter((x) => x !== 'spam').map((x) => `<td>${t[x]}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}`;
  }

  function mailto(lead) {
    const first = (lead.name || '').split(' ')[0] || 'there';
    const body = `Hi ${first},\n\nThanks for getting in touch with Spike & Crush.\n\n\n\nBest regards,\nSpike & Crush\nhello@spikeandcrush.com`;
    return `mailto:${encodeURIComponent(lead.email)}?subject=${encodeURIComponent(`Re: ${lead.company || 'your message'} - Spike & Crush`)}&body=${encodeURIComponent(body)}`;
  }

  async function openLead(id) {
    const d = await Admin.api(`/leads/${id}`);
    const l = d.lead;
    state.current = l;
    history.replaceState(null, '', `#${l.id}`);
    const extras = Object.entries(l.extras || {}).filter(([, v]) => v !== null && v !== '');
    const kv = [['Category', d.label], ['Name', l.name], ['Company', l.company], ['Role', l.role], ['Email', l.email], ['Phone', l.phone], ['Country', l.country], ['Website', l.website], ['Form', l.source_form], ['Received', Admin.formatDate(l.created_at)], ['Consent', l.consent_text ? `${l.consent_text} (${Admin.formatDate(l.consent_at)})` : '—'], ['Notification', l.email_status], ...extras.map(([k, v]) => [k, v])];
    const timeline = [...d.events.map((e) => ({ at: e.created_at, text: `${e.kind.replace(/_/g, ' ')}${e.detail && e.detail.to !== undefined ? `: ${JSON.stringify(e.detail.to)}` : ''}`, who: e.actor })), ...d.notes.map((n) => ({ at: n.created_at, text: n.note, who: n.author, note: true }))].sort((a, b) => (a.at < b.at ? -1 : 1));
    const conv = l.converted_to || {};
    $('ldDetail').innerHTML = `
      <h3 style="margin-top:0;">${esc(l.company || l.name || l.email || 'Lead')}</h3>
      ${l.email_status === 'failed' ? '<p class="ld-warn">The notification email for this lead failed. The lead is safe here.</p>' : ''}
      <dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd style="margin:0;">${k === 'Website' && v ? `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>` : esc(v || '—')}</dd>`).join('')}</dl>
      ${l.message ? `<div class="ld-msg">${esc(l.message)}</div>` : ''}
      <div class="ld-actions">
        <label>Status<select id="ldfStatus">${STATUSES.map((s) => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></label>
        <label>Priority<select id="ldfPriority">${['low', 'normal', 'high'].map((p) => `<option ${p === l.priority ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        <label>Owner<input id="ldfOwner" value="${esc(l.owner || '')}" placeholder="email of the owner" /></label>
        <label>Next follow-up<input id="ldfFollow" type="datetime-local" value="${l.next_followup_at ? new Date(new Date(l.next_followup_at) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}" /></label>
        <label style="grid-column:1/-1;">Tags (comma separated)<input id="ldfTags" value="${esc((l.tags || []).join(', '))}" /></label>
        <label style="grid-column:1/-1;" id="ldfLostWrap" ${l.status === 'lost' ? '' : 'hidden'}>Why lost<input id="ldfLost" value="${esc(l.lost_reason || '')}" /></label>
      </div>
      <div class="ld-buttons">
        <button class="btn btn-primary" id="ldfSave">Save</button>
        <button class="btn" id="ldfMine">Assign to me</button>
        ${l.email ? `<a class="btn" href="${mailto(l)}" id="ldfReply">Reply</a>` : ''}
        <button class="btn" id="ldfSpam">Mark spam</button>
        <button class="btn" id="ldfSponsor" ${conv.sponsor ? 'disabled' : ''}>${conv.sponsor ? 'Sponsor created' : 'Create sponsor account'}</button>
        <button class="btn" id="ldfListing" ${conv.listing ? 'disabled' : ''}>${conv.listing ? 'Listing created' : 'Create partner listing'}</button>
      </div>
      <h4>Timeline</h4>
      <ul class="ld-timeline">${timeline.map((t) => `<li><span class="text-secondary">${esc(Admin.formatDate(t.at))} · ${esc(t.who)}</span><br>${t.note ? `<strong>Note:</strong> ` : ''}${esc(t.text)}</li>`).join('')}</ul>
      <label for="ldfNote" style="display:block;margin-top:10px;">Add a note</label>
      <textarea id="ldfNote" rows="3" style="width:100%;"></textarea>
      <div class="ld-buttons"><button class="btn" id="ldfAddNote">Add note</button></div>`;

    $('ldfStatus').addEventListener('change', () => { $('ldfLostWrap').hidden = $('ldfStatus').value !== 'lost'; });
    $('ldfSave').addEventListener('click', () => save({
      status: $('ldfStatus').value, priority: $('ldfPriority').value, owner: $('ldfOwner').value.trim(),
      next_followup_at: $('ldfFollow').value ? new Date($('ldfFollow').value).toISOString() : null,
      tags: $('ldfTags').value, lost_reason: $('ldfLost').value,
    }));
    $('ldfMine').addEventListener('click', () => save({ owner: state.me }));
    $('ldfSpam').addEventListener('click', () => { if (confirm('Mark this lead as spam?')) save({ status: 'spam' }); });
    $('ldfAddNote').addEventListener('click', async () => {
      const note = $('ldfNote').value.trim();
      if (!note) return;
      await Admin.api(`/leads/${l.id}/notes`, { method: 'POST', body: { note } });
      openLead(l.id);
    });
    $('ldfSponsor').addEventListener('click', () => convertSponsor(l));
    $('ldfListing').addEventListener('click', () => convertListing(l));
  }

  async function save(patch) {
    try {
      await Admin.api(`/leads/${state.current.id}`, { method: 'PATCH', body: patch });
      Admin.toast('Saved', 'success');
      await Promise.all([openLead(state.current.id), loadList(), loadTabs(), loadSummary()]);
    } catch (e) { Admin.toast(e.message, 'danger'); }
  }

  // Convert: the existing sponsor and listing editors' own routes create a
  // draft from the lead (their validation and audit apply), then link back.
  async function convertSponsor(l) {
    if (!confirm(`Create a draft sponsor for ${l.company || l.name}?`)) return;
    try {
      const r = await Admin.api('/sponsors', { method: 'POST', body: { name: l.company || l.name, contactName: l.name || '', contactEmail: l.email || '', linkUrl: l.website || '', status: 'draft', notes: `From lead ${l.id}` } });
      await Admin.api(`/leads/${l.id}`, { method: 'PATCH', body: { converted_to: { sponsor: r.sponsor.id }, status: l.status === 'new' ? 'qualified' : l.status } });
      Admin.toast('Draft sponsor created. Finish it under Sponsors.', 'success');
      openLead(l.id);
    } catch (e) { Admin.toast(e.message, 'danger'); }
  }
  async function convertListing(l) {
    const type = { partner_broker: 'broker', partner_prop_firm: 'prop' }[l.category] || 'sponsored';
    if (!confirm(`Create a draft ${type === 'prop' ? 'prop firm' : type} listing for ${l.company || l.name}?`)) return;
    try {
      const r = await Admin.api('/listings', { method: 'POST', body: { type, organizerName: l.company || l.name, title: `${l.company || l.name} competition`, status: 'draft' } });
      await Admin.api(`/leads/${l.id}`, { method: 'PATCH', body: { converted_to: { listing: r.listing.id } } });
      Admin.toast('Draft listing created. Finish it under Partner Listings.', 'success');
      openLead(l.id);
    } catch (e) { Admin.toast(`Could not create the listing: ${e.message}`, 'danger'); }
  }

  async function loadSettings() {
    const s = await Admin.api('/leads/settings');
    $('ldDefault').textContent = s.defaultRecipients;
    const routing = s.settings.routing || {};
    $('ldRouting').innerHTML = s.categories.map((c) => `<label for="ldr-${c}">${esc(s.labels[c])}</label><input id="ldr-${c}" data-cat="${c}" value="${esc(routing[c] || '')}" />`).join('');
    $('ldReplyTime').value = s.settings.reply_time || '';
    $('ldStaleDays').value = s.settings.stale_days || 3;
    $('ldCaptcha').value = String(Boolean(s.settings.captcha));
  }
  $('ldSettingsBtn').addEventListener('click', async () => { $('ldSettings').hidden = !$('ldSettings').hidden; if (!$('ldSettings').hidden) await loadSettings(); });
  $('ldSaveSettings').addEventListener('click', async () => {
    const routing = {};
    $('ldRouting').querySelectorAll('input').forEach((i) => { routing[i.dataset.cat] = i.value; });
    try {
      await Admin.api('/leads/settings', { method: 'PUT', body: { routing, reply_time: $('ldReplyTime').value, stale_days: $('ldStaleDays').value, captcha: $('ldCaptcha').value === 'true' } });
      Admin.toast('Settings saved', 'success');
    } catch (e) { Admin.toast(e.message, 'danger'); }
  });
  $('ldExport').addEventListener('click', () => { window.location.href = `/api/leads/export.csv?${query()}`; });

  let searchTimer = null;
  $('ldSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 300); });
  for (const id of ['ldStatus', 'ldPriority', 'ldOwner', 'ldSort']) $(id).addEventListener('change', loadList);

  async function loadAll() {
    try {
      await loadTabs();
      await Promise.all([loadList(), loadSummary()]);
    } catch (e) {
      $('ldRows').innerHTML = `<tr><td colspan="6">${esc(e.message)}</td></tr>`;
    }
  }

  (async () => {
    try { state.me = (await Admin.api('/leads/whoami')).owner; } catch (e) { /* not fatal */ }
    state.range = await Admin.DateRange.mount($('ldRange'), { defaultPreset: '90d', onChange: () => loadList() });
    await loadAll();
    const hash = location.hash.slice(1);
    if (/^[0-9a-f-]{36}$/i.test(hash)) openLead(hash).catch(() => {});
  })();
})();
