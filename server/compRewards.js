'use strict';

// Competition winner flow (human in the loop, consent first).
//
// 1. When a money-prize competition settles, its winners are written as
//    Pending review with anti-cheat flags (shown to the admin, never acted on).
// 2. Nothing is emailed until an admin approves. Approval sends a claim email
//    with a single-use link (random token; only its SHA-256 is stored; 14 days).
// 3. The claim page asks: 18 or over, country (checked against the partner's
//    allowed/restricted lists) and a separate, unticked consent to share name,
//    email and the new account number with the partner. Then "Open your prize
//    account" goes through the opaque /go/c/<ref> redirect (IB code added
//    server side, click logged with a hashed IP). The partner disclosure is on
//    the email, the claim page and the terms.
// 4. Statuses move automatically where we can see them (email sent, claimed,
//    link clicked) and by an admin otherwise. A prize request to the partner's
//    IB manager is sent only with consent; WhatsApp is a prepared text only.
// 5. No partner: the winner goes to the Manual payout queue; the email promises
//    nothing beyond the terms. The prize is never paid by this code.

const crypto = require('crypto');
const secrets = require('./listingSecrets');

const DISCLOSURE = 'This is a partner link. Spike & Crush may earn a commission if you open an account. It costs you nothing and does not change your prize.';
const DELIVERY = 'Prizes are credited by the sponsoring partner to an account opened with them. You must be eligible and complete the partner\'s account verification.';
const CONSENT = 'Share my name, email and the account number I create with the sponsoring partner so they can credit my prize.';
const CONSENT_VERSION = 'claim-consent-v1 (2026-11-17)';
const CLAIM_DAYS = 14;
const STATUSES = ['pending_review', 'approved', 'email_sent', 'claimed', 'link_clicked', 'registered', 'verified', 'account_created', 'prize_requested', 'prize_credited', 'closed', 'declined', 'ineligible', 'expired', 'manual_payout'];
const ADMIN_SETTABLE = ['registered', 'verified', 'account_created', 'prize_credited', 'closed', 'declined', 'ineligible', 'expired'];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (amount, currency) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(Number(amount) || 0);
  } catch (e) {
    return `${currency || 'USD'} ${Math.round(Number(amount) || 0)}`;
  }
};

// "1st" / "2nd" / "4th to 10th" with a % share -> [{ rank, amount }].
function prizeTable(pool, breakdown = []) {
  const out = [];
  for (const row of breakdown || []) {
    const nums = String(row.places || '').match(/\d+/g) || [];
    if (!nums.length) continue;
    const from = Number(nums[0]);
    const to = Number(nums[1] || nums[0]);
    const count = to - from + 1;
    const each = Math.floor(((Number(pool) || 0) * (Number(row.share) || 0)) / 100 / count);
    for (let r = from; r <= to; r++) out.push({ rank: r, amount: each });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

function createCompRewards({ client, sendEmail, siteUrl = () => process.env.SITE_URL || 'https://www.spikeandcrush.com', adminEmail = () => process.env.LEADS_NOTIFY_EMAILS || 'hello@spikeandcrush.com' }) {
  const sb = () => client();
  const site = () => String(siteUrl()).replace(/\/$/, '');

  // Winner pipeline steps for the Affiliate dashboard (no player data: a step name only).
  const STEP = { recorded: 'recorded', approved: 'approved', claim_email_sent: 'emailed', claimed_with_consent: 'claimed', link_clicked: 'link_clicked', prize_request_sent: 'prize_requested', prize_request_prepared: 'prize_requested', expired: 'expired', ineligible_country: 'ineligible' };
  async function event(winnerId, actor, kind, detail = {}) {
    await sb().from('comp_winner_events').insert({ winner_id: winnerId, actor, kind, detail });
    const step = kind === 'status_changed' ? detail.to : STEP[kind];
    if (step) {
      try {
        const A = require('./analytics/events').analytics();
        A.track('winner_step', { props: { step: String(step) } });
        if (kind === 'link_clicked') A.track('partner_link_click', { props: { link: 'claim' } });
      } catch (e) { /* best effort */ }
    }
  }

  // ---- 1. winners at settlement ------------------------------------------------

  async function flagsFor(winners, comp) {
    const ids = winners.map((w) => w.player_id).filter(Boolean);
    const flags = Object.fromEntries(winners.map((w) => [w.player_id, []]));
    if (!ids.length) return flags;
    const [{ data: sessions }, { data: players }] = await Promise.all([
      sb().from('sessions').select('player_id, ip, user_agent').in('player_id', ids).limit(5000),
      sb().from('players').select('id, created_at').in('id', ids),
    ]);
    const byIp = {};
    for (const s of sessions || []) if (s.ip) (byIp[s.ip] ||= new Set()).add(s.player_id);
    for (const set of Object.values(byIp)) {
      if (set.size > 1) for (const pid of set) flags[pid].push({ kind: 'shared_ip', detail: `${set.size} winners share an IP address` });
    }
    const startMs = new Date(comp.starts_at).getTime();
    for (const p of players || []) {
      if (new Date(p.created_at).getTime() > startMs - 48 * 3600000) flags[p.id].push({ kind: 'new_account', detail: 'account created within 48 hours of the start' });
    }
    for (const w of winners) if ((w.trade_count || 0) < 5) flags[w.player_id].push({ kind: 'few_trades', detail: `${w.trade_count || 0} trades` });
    for (const w of winners) if (w.status === 'disqualified') flags[w.player_id].push({ kind: 'disqualified', detail: 'account was disqualified' });
    return flags;
  }

  // Idempotent: one row per (competition, rank). ranked = accounts best first.
  async function recordWinners(comp, template, ranked) {
    if (comp.prize_kind !== 'money') return { created: 0, reason: 'not a money competition' };
    const table = prizeTable(template && template.prize_pool_amount, template && template.prize_breakdown);
    if (!table.length) return { created: 0, reason: 'no prize breakdown' };
    const eligible = ranked.filter((a) => a.status !== 'disqualified');
    const rows = table.map((t) => ({ t, acc: eligible[t.rank - 1] })).filter((x) => x.acc);
    const flags = await flagsFor(rows.map((x) => x.acc), comp);
    const partnerId = comp.partner_id || (template && template.partner_id) || null;
    let created = 0;
    for (const { t, acc } of rows) {
      const { data, error } = await sb().from('comp_winners').insert({
        competition_id: comp.id,
        account_id: acc.id,
        player_id: acc.player_id,
        rank: t.rank,
        prize_amount: t.amount,
        prize_currency: (template && template.prize_currency) || comp.prize_currency || 'USD',
        prize_text: money(t.amount, (template && template.prize_currency) || comp.prize_currency),
        partner_id: partnerId,
        status: 'pending_review',
        flags: flags[acc.player_id] || [],
      }).select('id').single();
      if (error) {
        if (error.code === '23505') continue; // already recorded
        throw error;
      }
      await event(data.id, 'system', 'recorded', { rank: t.rank, flags: (flags[acc.player_id] || []).length });
      created++;
    }
    return { created };
  }

  // ---- 2. approval and the claim email -------------------------------------------

  async function partnerOf(w) {
    if (!w.partner_id) return null;
    const { data } = await sb().from('comp_partners').select('*').eq('id', w.partner_id).maybeSingle();
    return data;
  }

  function claimEmail({ username, comp, w, partner, link }) {
    const prop = partner && partner.partner_type === 'prop_firm';
    const named = partner && partner.name_in_terms ? ` The prize is provided by ${partner.name}.` : '';
    const intro = `Congratulations, ${username || 'trader'}. You finished #${w.rank} in ${comp.title} and won ${w.prize_text}.`;
    const how = partner ? `${DELIVERY}${named}` : 'Our team will contact you about your prize as set out in the competition terms.';
    const button = partner ? (prop ? 'Claim your challenge' : 'Claim your prize') : 'See your result';
    const text = `${intro}\n\n${how}\n\n${button}: ${link}\nThis link works once and expires in ${CLAIM_DAYS} days.\n\n${partner ? `${DISCLOSURE}\n\n` : ''}Spike & Crush, hello@spikeandcrush.com`;
    const html = `<div style="background:#07090F;padding:24px;font-family:Inter,Arial,sans-serif;color:#E8ECF4"><div style="max-width:520px;margin:auto;background:#0E1320;border:1px solid #1D2638;border-radius:12px;padding:26px">
<p style="font-family:Rajdhani,Arial,sans-serif;font-size:22px;font-weight:700;margin:0 0 16px"><span style="color:#2EE6A6">Spike</span><span style="color:#9AA4B8">&amp;</span><span style="color:#FF4D5E">Crush</span></p>
<p style="font-size:16px;line-height:1.55">${esc(intro)}</p><p style="font-size:14px;line-height:1.55;color:#C3CBDB">${esc(how)}</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:13px 22px;background:#F5B83D;color:#07090F;border-radius:8px;font-weight:700;text-decoration:none">${esc(button)}</a></p>
<p style="font-size:13px;color:#9AA4B8">This link works once and expires in ${CLAIM_DAYS} days.</p>
${partner ? `<p style="font-size:12px;color:#9AA4B8;border-top:1px solid #1D2638;padding-top:12px">${esc(DISCLOSURE)}</p>` : ''}</div></div>`;
    return { subject: `You won ${w.prize_text} in ${comp.title}`, text, html };
  }

  async function approve(winnerIds, actor) {
    const out = [];
    for (const id of winnerIds) {
      const { data: w } = await sb().from('comp_winners').select('*').eq('id', id).maybeSingle();
      if (!w || w.status !== 'pending_review') {
        out.push({ id, ok: false, reason: 'not pending review' });
        continue;
      }
      const partner = await partnerOf(w);
      const [{ data: comp }, { data: player }] = await Promise.all([
        sb().from('competitions').select('id, title').eq('id', w.competition_id).single(),
        sb().from('players').select('id, username, email').eq('id', w.player_id).maybeSingle(),
      ]);
      const token = crypto.randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + CLAIM_DAYS * 86400000).toISOString();
      await sb().from('comp_winners').update({ status: partner ? 'approved' : 'manual_payout', claim_token_hash: sha256(token), claim_expires_at: expires, updated_at: new Date().toISOString() }).eq('id', id);
      await event(id, actor, 'approved', { partner: Boolean(partner) });
      let sent = false;
      if (player && player.email) {
        try {
          const r = await sendEmail({ to: player.email, idempotencyKey: `claim:${id}`, ...claimEmail({ username: player.username, comp, w, partner, link: `${site()}/claim/${token}` }) });
          sent = Boolean(r && r.id);
        } catch (e) {
          sent = false;
        }
      }
      if (sent) {
        await sb().from('comp_winners').update({ status: partner ? 'email_sent' : 'manual_payout', email_sent_at: new Date().toISOString() }).eq('id', id);
        await event(id, 'system', 'claim_email_sent');
      } else await event(id, 'system', 'claim_email_failed');
      out.push({ id, ok: true, emailed: sent, manual: !partner });
    }
    return out;
  }

  // ---- 3. the claim page -----------------------------------------------------------

  async function byToken(token) {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token || ''))) return { error: 'invalid' };
    const { data: w } = await sb().from('comp_winners').select('*').eq('claim_token_hash', sha256(token)).maybeSingle();
    if (!w) return { error: 'invalid' };
    if (w.data_deleted_at) return { error: 'invalid' };
    if (w.claim_used_at && !['claimed', 'link_clicked'].includes(w.status)) return { error: 'used' };
    if (new Date(w.claim_expires_at).getTime() < Date.now()) {
      if (['approved', 'email_sent'].includes(w.status)) {
        await sb().from('comp_winners').update({ status: 'expired' }).eq('id', w.id);
        await event(w.id, 'system', 'expired');
      }
      return { error: 'expired' };
    }
    return { w };
  }

  async function claimView(token) {
    const r = await byToken(token);
    if (r.error) return r;
    const { w } = r;
    const partner = await partnerOf(w);
    const { data: comp } = await sb().from('competitions').select('title').eq('id', w.competition_id).single();
    return {
      claim: {
        competition: comp && comp.title,
        rank: w.rank,
        prize: w.prize_text,
        partnerType: partner ? partner.partner_type : null,
        partnerName: partner && partner.name_in_terms ? partner.name : null,
        steps: partner ? partner.claim_steps || null : null,
        delivery: partner ? DELIVERY : 'Our team will contact you about your prize as set out in the competition terms.',
        disclosure: partner ? DISCLOSURE : null,
        consentText: CONSENT,
        claimed: ['claimed', 'link_clicked'].includes(w.status),
        manual: !partner,
        button: partner && partner.partner_type === 'prop_firm' ? 'Claim your challenge' : 'Open your prize account',
      },
    };
  }

  // body: { over18: true, country: 'AE', consent: true|false }
  async function submitClaim(token, body = {}, { ipHash = null } = {}) {
    const r = await byToken(token);
    if (r.error) return r;
    const { w } = r;
    const partner = await partnerOf(w);
    if (!partner) return { error: 'manual' };
    if (body.over18 !== true) return { error: 'age', message: 'You must be 18 or over to claim.' };
    const country = String(body.country || '').trim().toUpperCase().slice(0, 2);
    if (!/^[A-Z]{2}$/.test(country)) return { error: 'country', message: 'Choose your country.' };
    const restricted = (partner.restricted_countries || []).map((c) => c.toUpperCase());
    const allowed = (partner.allowed_countries || []).map((c) => c.toUpperCase());
    if (restricted.includes(country) || (allowed.length && !allowed.includes(country))) {
      await sb().from('comp_winners').update({ status: 'ineligible', country, age_confirmed: true, updated_at: new Date().toISOString() }).eq('id', w.id);
      await event(w.id, 'winner', 'ineligible_country', { country });
      return { error: 'ineligible', message: 'Sorry, the sponsoring partner cannot open accounts in your country, so this prize cannot be claimed there. Contact hello@spikeandcrush.com if you think this is wrong.' };
    }
    const consent = body.consent === true;
    const patch = { age_confirmed: true, country, updated_at: new Date().toISOString() };
    if (consent) Object.assign(patch, { status: 'claimed', claim_used_at: new Date().toISOString(), consent_text: `${CONSENT_VERSION}: ${CONSENT}`, consent_at: new Date().toISOString() });
    await sb().from('comp_winners').update(patch).eq('id', w.id);
    await event(w.id, 'winner', consent ? 'claimed_with_consent' : 'claim_without_consent', { country });
    // The button: an opaque reference to this winner, never the partner URL.
    return { ok: true, consent, go: consent ? `/go/c/${token}` : null, message: consent ? null : 'Without your consent we cannot share your details with the partner, so the prize cannot be credited yet. Your claim stays open until it expires.' };
  }

  // The claim button's redirect: partner outbound URL with the code added here.
  async function goTarget(token, { ipHash = null, bot = false } = {}) {
    const r = await byToken(token);
    if (r.error) return { url: `/claim/${encodeURIComponent(token)}` };
    const { w } = r;
    if (!w.consent_at) return { url: `/claim/${encodeURIComponent(token)}` };
    const partner = await partnerOf(w);
    if (!partner || !partner.listing_id) return { url: `/claim/${encodeURIComponent(token)}?note=not-configured` };
    const [{ data: listing }, { data: sec }] = await Promise.all([
      sb().from('competitions').select('slug').eq('id', partner.listing_id).maybeSingle(),
      sb().from('competition_listing_secrets').select('*').eq('competition_id', partner.listing_id).maybeSingle(),
    ]);
    const url = secrets.outboundUrl(sec, { utm: { utm_source: 'spikeandcrush', utm_medium: 'prize_claim', utm_campaign: (listing && listing.slug) || 'claim' } });
    if (!url) return { url: `/claim/${encodeURIComponent(token)}?note=not-configured` };
    if (!bot) {
      if (w.status === 'claimed') await sb().from('comp_winners').update({ status: 'link_clicked', click_ip_hash: ipHash, updated_at: new Date().toISOString() }).eq('id', w.id);
      await event(w.id, 'winner', 'link_clicked', { ip_hash: ipHash });
    }
    return { url };
  }

  // ---- 4. admin actions ---------------------------------------------------------------

  async function setStatus(id, status, actor, { accountNumber } = {}) {
    if (!ADMIN_SETTABLE.includes(status)) throw Object.assign(new Error('That status cannot be set by hand'), { status: 400 });
    const patch = { status, updated_at: new Date().toISOString() };
    if (status === 'account_created' && accountNumber) patch.account_number_enc = secrets.encrypt(String(accountNumber).trim().slice(0, 60));
    await sb().from('comp_winners').update(patch).eq('id', id);
    await event(id, actor, 'status_changed', { to: status });
  }

  function prizeRequestText({ comp, w, player, accountNumber }) {
    return `Prize request from Spike & Crush\n\nCompetition: ${comp.title}\nWinner: ${player.username}${player.email ? ` <${player.email}>` : ''}\nRank: #${w.rank}\nPrize: ${w.prize_text}\nAccount number: ${accountNumber || '(not given)'}\nDate: ${new Date().toISOString().slice(0, 10)}\n\nThe winner agreed to share these details with you so you can credit the prize. Please confirm when it is credited.`;
  }

  // channel 'email' sends (only with consent); 'whatsapp' returns the text to copy.
  async function prizeRequest(id, channel, actor) {
    const { data: w } = await sb().from('comp_winners').select('*').eq('id', id).maybeSingle();
    if (!w) throw Object.assign(new Error('Winner not found'), { status: 404 });
    if (!w.consent_at) throw Object.assign(new Error('The winner has not consented to sharing their details'), { status: 400 });
    const partner = await partnerOf(w);
    if (!partner) throw Object.assign(new Error('No sponsoring partner: use the manual payout queue'), { status: 400 });
    const contact = partner.contact_enc ? JSON.parse(secrets.decrypt(partner.contact_enc) || '{}') : {};
    const [{ data: comp }, { data: player }] = await Promise.all([
      sb().from('competitions').select('title').eq('id', w.competition_id).single(),
      sb().from('players').select('username, email').eq('id', w.player_id).maybeSingle(),
    ]);
    const accountNumber = w.account_number_enc ? secrets.decrypt(w.account_number_enc) : null;
    const text = prizeRequestText({ comp, w, player: player || {}, accountNumber });
    if (channel === 'whatsapp') {
      if (!contact.whatsapp) throw Object.assign(new Error('No WhatsApp number saved for this partner'), { status: 400 });
      await event(id, actor, 'prize_request_prepared', { channel: 'whatsapp' });
      return { channel: 'whatsapp', text, open: `https://wa.me/${String(contact.whatsapp).replace(/[^0-9]/g, '')}?text=${encodeURIComponent(text)}` };
    }
    if (!contact.email) throw Object.assign(new Error('No IB manager email saved for this partner'), { status: 400 });
    const r = await sendEmail({ to: contact.email, idempotencyKey: `prize-request:${id}:${new Date().toISOString().slice(0, 10)}`, subject: `Prize request: ${player && player.username} (${comp.title})`, text, html: `<pre style="font-family:Inter,Arial,sans-serif">${esc(text)}</pre>` });
    if (!r || !r.id) throw Object.assign(new Error('The email provider did not accept the message'), { status: 502 });
    await sb().from('comp_winners').update({ status: 'prize_requested', prize_requested_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
    await event(id, actor, 'prize_request_sent', { channel: 'email' });
    return { channel: 'email', sent: true };
  }

  // Keeps rank and prize for the record; removes personal claim data.
  async function deleteClaimData(id, actor) {
    await sb().from('comp_winners').update({ country: null, age_confirmed: null, consent_text: null, consent_at: null, account_number_enc: null, click_ip_hash: null, claim_token_hash: null, data_deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
    await event(id, actor, 'claim_data_deleted');
  }

  // Reminder to the team when a prize request is not marked credited in time.
  async function remindOverdue() {
    const { data: rows } = await sb().from('comp_winners').select('id, prize_requested_at, partner_id, prize_text, rank').eq('status', 'prize_requested').limit(500);
    const { data: partners } = await sb().from('comp_partners').select('id, name, reminder_days');
    const days = Object.fromEntries((partners || []).map((p) => [p.id, p]));
    const overdue = (rows || []).filter((r) => r.prize_requested_at && Date.now() - new Date(r.prize_requested_at).getTime() > ((days[r.partner_id] && days[r.partner_id].reminder_days) || 5) * 86400000);
    if (!overdue.length) return { overdue: 0 };
    await sendEmail({ to: adminEmail(), idempotencyKey: `prize-overdue:${new Date().toISOString().slice(0, 10)}`, subject: `Prizes not yet credited (${overdue.length})`, text: overdue.map((r) => `- #${r.rank} ${r.prize_text} with ${(days[r.partner_id] && days[r.partner_id].name) || 'partner'}, requested ${r.prize_requested_at.slice(0, 10)}`).join('\n') });
    return { overdue: overdue.length };
  }

  return { recordWinners, approve, claimView, submitClaim, goTarget, setStatus, prizeRequest, deleteClaimData, remindOverdue, claimEmail, prizeRequestText };
}

module.exports = { createCompRewards, prizeTable, DISCLOSURE, DELIVERY, CONSENT, CONSENT_VERSION, STATUSES, ADMIN_SETTABLE, CLAIM_DAYS, sha256 };
