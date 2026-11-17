'use strict';

// Admin > Competition Winners (admin/routes/compWinners.js).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Admin.escapeHtml(s == null ? '' : String(s));
  const LABEL = { pending_review: 'Pending review', approved: 'Approved', email_sent: 'Email sent', claimed: 'Claimed (consent)', link_clicked: 'Link clicked', registered: 'Registered', verified: 'Verified', account_created: 'Standard account created', prize_requested: 'Prize requested from IB manager', prize_credited: 'Prize credited', closed: 'Closed', declined: 'Declined', ineligible: 'Ineligible', expired: 'Expired', manual_payout: 'Manual payout' };
  let settable = [];
  let partners = [];

  async function load() {
    const q = new URLSearchParams();
    if ($('wnStatus').value) q.set('status', $('wnStatus').value);
    if ($('wnQueue').value) q.set('queue', $('wnQueue').value);
    try {
      const d = await Admin.api(`/rewards/winners?${q}`);
      settable = d.settable;
      if ($('wnStatus').options.length === 1) d.statuses.forEach((s) => $('wnStatus').insertAdjacentHTML('beforeend', `<option value="${s}">${esc(LABEL[s])}</option>`));
      $('wnRows').innerHTML = d.winners.length ? d.winners.map((w) => `<tr data-id="${w.id}" style="cursor:pointer;">
        <td>${w.status === 'pending_review' ? `<input type="checkbox" class="wn-pick" value="${w.id}" aria-label="Select" onclick="event.stopPropagation()" />` : ''}</td>
        <td>${esc(w.competition && w.competition.title)}</td><td>${w.rank}</td><td>${esc(w.player && w.player.username)}${(w.flags || []).map((f) => `<span class="wn-flag">${esc(f.detail)}</span>`).join('')}</td>
        <td>${esc(w.prize_text)}</td><td>${esc((w.partner && w.partner.name) || 'none: manual')}</td><td>${esc(LABEL[w.status])}${w.data_deleted_at ? ' (data deleted)' : ''}</td></tr>`).join('') : '<tr><td colspan="7">No winners yet.</td></tr>';
      $('wnRows').querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => open(tr.dataset.id)));
      $('wnRows').querySelectorAll('.wn-pick').forEach((c) => c.addEventListener('change', pickChanged));
      pickChanged();
    } catch (e) {
      $('wnRows').innerHTML = `<tr><td colspan="7">${esc(e.message)}</td></tr>`;
    }
  }
  function picked() { return [...document.querySelectorAll('.wn-pick:checked')].map((c) => c.value); }
  function pickChanged() { $('wnApprove').disabled = !picked().length; }
  $('wnAll').addEventListener('change', (e) => { document.querySelectorAll('.wn-pick').forEach((c) => { c.checked = e.target.checked; }); pickChanged(); });
  $('wnApprove').addEventListener('click', async () => {
    const ids = picked();
    if (!confirm(`Approve ${ids.length} winner(s) and send their claim emails?`)) return;
    try {
      const r = await Admin.api('/rewards/winners/approve', { method: 'POST', body: { ids } });
      Admin.toast(`${r.results.filter((x) => x.ok).length} approved, ${r.results.filter((x) => x.emailed).length} emailed`, 'success');
      load();
    } catch (e) { Admin.toast(e.message, 'danger'); }
  });

  async function open(id) {
    const { winner: w, events } = await Admin.api(`/rewards/winners/${id}`);
    $('wnDetail').innerHTML = `<h3 style="margin-top:0;">#${w.rank} ${esc(w.player && w.player.username)}</h3>
      <dl><dt>Competition</dt><dd>${esc(w.competition && w.competition.title)}</dd><dt>Prize</dt><dd>${esc(w.prize_text)}</dd><dt>Partner</dt><dd>${esc((w.partner && w.partner.name) || 'none (manual payout)')}</dd>
      <dt>Status</dt><dd>${esc(LABEL[w.status])}</dd><dt>Email sent</dt><dd>${esc(Admin.formatDate(w.email_sent_at))}</dd><dt>Consent</dt><dd>${w.consent_at ? `${esc(Admin.formatDate(w.consent_at))}<br><span class="text-secondary">${esc(w.consent_text)}</span>` : 'not given'}</dd>
      <dt>Country</dt><dd>${esc(w.country || '—')}</dd><dt>Account number</dt><dd>${esc(w.account_number || '—')}</dd>
      <dt>Flags</dt><dd>${(w.flags || []).map((f) => esc(f.detail)).join('<br>') || 'none'}</dd></dl>
      <div class="wn-buttons">
        <select id="wnSet" aria-label="Set status"><option value="">Set status...</option>${settable.map((s) => `<option value="${s}">${esc(LABEL[s])}</option>`).join('')}</select>
        <input id="wnAcct" placeholder="account number (when created)" hidden />
        <button class="btn" id="wnSetBtn">Save status</button>
      </div>
      <div class="wn-buttons">
        <button class="btn" id="wnReqEmail" ${w.consent_at ? '' : 'disabled title="No consent"'}>Send prize request (email)</button>
        <button class="btn" id="wnReqWa" ${w.consent_at ? '' : 'disabled title="No consent"'}>Prepare WhatsApp message</button>
        <button class="btn" id="wnDelete">Delete claim data</button>
      </div>
      <h4>History</h4><ul class="wn-events">${events.map((e) => `<li><span class="text-secondary">${esc(Admin.formatDate(e.created_at))} · ${esc(e.actor)}</span> ${esc(e.kind.replace(/_/g, ' '))}</li>`).join('')}</ul>`;
    $('wnSet').addEventListener('change', () => { $('wnAcct').hidden = $('wnSet').value !== 'account_created'; });
    $('wnSetBtn').addEventListener('click', async () => {
      if (!$('wnSet').value) return;
      try { await Admin.api(`/rewards/winners/${w.id}/status`, { method: 'POST', body: { status: $('wnSet').value, accountNumber: $('wnAcct').value || undefined } }); Admin.toast('Saved', 'success'); open(w.id); load(); } catch (e) { Admin.toast(e.message, 'danger'); }
    });
    $('wnReqEmail').addEventListener('click', async () => {
      if (!confirm('Email the prize request to the partner\'s IB manager?')) return;
      try { await Admin.api(`/rewards/winners/${w.id}/prize-request`, { method: 'POST', body: { channel: 'email' } }); Admin.toast('Prize request sent', 'success'); open(w.id); load(); } catch (e) { Admin.toast(e.message, 'danger'); }
    });
    $('wnReqWa').addEventListener('click', async () => {
      try {
        const r = await Admin.api(`/rewards/winners/${w.id}/prize-request`, { method: 'POST', body: { channel: 'whatsapp' } });
        await navigator.clipboard.writeText(r.text).catch(() => {});
        window.open(r.open, '_blank', 'noopener');
        Admin.toast('Message copied and WhatsApp opened. Send it yourself, then set the status.', 'info');
      } catch (e) { Admin.toast(e.message, 'danger'); }
    });
    $('wnDelete').addEventListener('click', async () => {
      if (!confirm('Delete this winner\'s claim data (country, consent, account number)? Rank and prize stay for the record.')) return;
      await Admin.api(`/rewards/winners/${w.id}/delete-claim-data`, { method: 'POST' });
      Admin.toast('Claim data deleted', 'success'); open(w.id); load();
    });
  }

  async function loadPartners() {
    try {
      const d = await Admin.api('/rewards/partners');
      partners = d.partners;
      $('wnPartners').innerHTML = partners.length ? partners.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.partner_type === 'prop_firm' ? 'Prop firm' : 'Broker'}</td><td>${esc([p.contact.email, p.contact.whatsapp].filter(Boolean).join(' · ') || 'none')}${d.canReveal ? ` <button class="btn btn-sm" data-reveal="${p.id}">Reveal</button>` : ''}</td><td>${esc((p.allowed_countries || []).join(', ') || 'any')}${(p.restricted_countries || []).length ? ` / not ${esc(p.restricted_countries.join(', '))}` : ''}</td><td><button class="btn btn-sm" data-edit="${p.id}">Edit</button></td></tr>`).join('') : '<tr><td colspan="5">No partners yet.</td></tr>';
      $('wnPartners').querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', async () => {
        const r = await Admin.api(`/rewards/partners/${b.dataset.reveal}/contact`);
        alert(`IB manager\nEmail: ${r.contact.email || '-'}\nWhatsApp: ${r.contact.whatsapp || '-'}\nNotes: ${r.contact.notes || '-'}`);
      }));
      $('wnPartners').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const p = partners.find((x) => x.id === b.dataset.edit);
        $('wnPId').value = p.id; $('wnPName').value = p.name; $('wnPType').value = p.partner_type; $('wnPListing').value = p.listing_id || '';
        $('wnPAllowed').value = (p.allowed_countries || []).join(', '); $('wnPRestricted').value = (p.restricted_countries || []).join(', ');
        $('wnPSteps').value = p.claim_steps || ''; $('wnPNamed').value = String(p.name_in_terms); $('wnPDays').value = p.reminder_days || 5;
        $('wnPEmail').value = ''; $('wnPWa').value = '';
      }));
    } catch (e) {
      $('wnPartners').innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`;
    }
  }
  $('wnPReset').addEventListener('click', () => { $('wnPId').value = ''; });
  $('wnPForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('wnPId').value;
    const body = { name: $('wnPName').value, partnerType: $('wnPType').value, listingId: $('wnPListing').value.trim(), allowedCountries: $('wnPAllowed').value, restrictedCountries: $('wnPRestricted').value, claimSteps: $('wnPSteps').value, nameInTerms: $('wnPNamed').value === 'true', reminderDays: $('wnPDays').value };
    if ($('wnPEmail').value.trim() || $('wnPWa').value.trim()) body.contact = { email: $('wnPEmail').value.trim(), whatsapp: $('wnPWa').value.trim() };
    try {
      await Admin.api(id ? `/rewards/partners/${id}` : '/rewards/partners', { method: id ? 'PUT' : 'POST', body });
      Admin.toast('Partner saved', 'success'); $('wnPForm').reset(); $('wnPId').value = ''; loadPartners();
    } catch (err) { Admin.toast(err.message, 'danger'); }
  });

  $('wnStatus').addEventListener('change', load);
  $('wnQueue').addEventListener('change', load);
  $('wnExport').addEventListener('click', () => { window.location.href = '/api/rewards/winners/export.csv'; });
  load();
  loadPartners();
})();
