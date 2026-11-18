'use strict';

// Forwards mail that arrives at hello@ (Resend Receiving) to a real inbox.
// Resend has no forwarding rule of its own: it calls this webhook with
// `email.received` (metadata only), we fetch the body and attachments from the
// Resend API and send a copy to INBOUND_FORWARD_TO, with Reply-To set to the
// original sender so "Reply" in your inbox answers them directly.
//
// Env: RESEND_API_KEY (full access, to read received mail), RESEND_WEBHOOK_SECRET
// (whsec_..., from the webhook in Resend), INBOUND_FORWARD_TO (comma separated).
// The webhook body is verified (Svix HMAC, 5-minute window) before anything
// is fetched, and a forward is keyed by the email id so retries never double.

const crypto = require('crypto');

const API = 'https://api.resend.com';
const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // keep the forward under Resend's 40 MB cap
const TOLERANCE_S = 5 * 60;
const EMAIL_RE = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

// Svix signature check: base64 HMAC-SHA256 of `${id}.${timestamp}.${body}`
// with the decoded secret; the header holds one or more "v1,<sig>".
function verifySignature({ secret, id, timestamp, signature, body, nowS = Math.floor(Date.now() / 1000) }) {
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > TOLERANCE_S) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return String(signature).split(' ').some((part) => {
    const [ver, sig] = part.split(',');
    if (ver !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

// Forward targets, never an address on our own receiving domain (that would
// loop straight back into this webhook).
function forwardTargets(raw = process.env.INBOUND_FORWARD_TO, ownDomain = 'spikeandcrush.com') {
  return String(raw || '').split(',').map((x) => x.trim()).filter((x) => EMAIL_RE.test(x) && !x.toLowerCase().endsWith(`@${ownDomain.toLowerCase()}`));
}

function createInboundForwarder({ fetchImpl = (...a) => fetch(...a), apiKey = () => process.env.RESEND_API_KEY, from = () => process.env.RESEND_FROM_EMAIL || 'Spike & Crush <hello@spikeandcrush.com>', targets = () => forwardTargets(), log = console } = {}) {
  async function api(path) {
    const res = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${apiKey()}` }, signal: AbortSignal.timeout(15000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend ${path.split('/').slice(0, 3).join('/')} ${res.status}: ${json.message || json.name || 'error'}`);
    return json;
  }

  async function attachmentsFor(emailId) {
    const list = await api(`/emails/receiving/${encodeURIComponent(emailId)}/attachments?limit=100`).catch((e) => { log.warn('[inbound] attachments list failed:', e.message); return { data: [] }; });
    const out = [];
    const skipped = [];
    let total = 0;
    for (const a of list.data || []) {
      if (!a.download_url || total + (a.size || 0) > MAX_ATTACH_BYTES) { skipped.push(a.filename || 'attachment'); continue; }
      try {
        const res = await fetchImpl(a.download_url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(String(res.status));
        const buf = Buffer.from(await res.arrayBuffer());
        total += buf.length;
        out.push({ filename: a.filename || 'attachment', content: buf.toString('base64'), ...(a.content_type ? { content_type: a.content_type } : {}), ...(a.content_id ? { content_id: String(a.content_id).replace(/^<|>$/g, '') } : {}) });
      } catch (e) {
        skipped.push(a.filename || 'attachment');
      }
    }
    return { attachments: out, skipped };
  }

  // Forwards one received email by id. Returns { ok, id } or { ok: false, reason }.
  async function forward(emailId) {
    const to = targets();
    if (!apiKey()) return { ok: false, reason: 'RESEND_API_KEY not set' };
    if (!to.length) return { ok: false, reason: 'INBOUND_FORWARD_TO not set' };
    const email = await api(`/emails/receiving/${encodeURIComponent(emailId)}`);
    const { attachments, skipped } = await attachmentsFor(emailId);
    const sender = (email.headers && email.headers.from) || email.from || 'unknown sender';
    const replyTo = (Array.isArray(email.reply_to) && email.reply_to.length ? email.reply_to : [email.from]).filter(Boolean);
    const note = `Forwarded from ${(email.to || []).join(', ') || 'hello@'}. From: ${sender}. Received ${email.created_at || ''}.${skipped.length ? ` Not attached (too large or unavailable, see Resend > Receiving): ${skipped.join(', ')}.` : ''}`;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const body = {
      from: from(),
      to,
      // the original subject, untouched: a reply from the inbox reads "Re: <their subject>"
      subject: String(email.subject || '(no subject)').slice(0, 250),
      ...(replyTo.length ? { reply_to: replyTo } : {}),
      html: `<div style="font:13px Arial,sans-serif;color:#555;border-bottom:1px solid #ddd;padding:0 0 8px;margin:0 0 12px">${esc(note)}</div>${email.html || `<pre style="white-space:pre-wrap;font:14px Arial,sans-serif">${esc(email.text || '')}</pre>`}`,
      text: `${note}\n\n${email.text || ''}`,
      ...(attachments.length ? { attachments } : {}),
    };
    const res = await fetchImpl(`${API}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json', 'Idempotency-Key': `inbound-fwd:${emailId}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend send ${res.status}: ${json.message || json.name || 'error'}`);
    return { ok: true, id: json.id };
  }

  // Express handler; mount with express.raw so the exact body is verified.
  function webhook() {
    return async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const ok = verifySignature({ secret: process.env.RESEND_WEBHOOK_SECRET, id: req.get('svix-id'), timestamp: req.get('svix-timestamp'), signature: req.get('svix-signature'), body: raw });
      if (!ok) return res.status(401).json({ error: 'Bad signature' });
      let event;
      try { event = JSON.parse(raw); } catch (e) { return res.status(400).json({ error: 'Bad JSON' }); }
      if (!event || event.type !== 'email.received' || !event.data || !event.data.email_id) return res.json({ ignored: true });
      try {
        const r = await forward(event.data.email_id);
        if (!r.ok) { log.warn('[inbound] not forwarded:', r.reason); return res.json({ forwarded: false }); }
        return res.json({ forwarded: true });
      } catch (e) {
        log.error('[inbound] forward failed:', e.message);
        return res.status(502).json({ error: 'Forward failed' }); // Resend retries
      }
    };
  }

  return { forward, webhook, api };
}

module.exports = { createInboundForwarder, verifySignature, forwardTargets };
