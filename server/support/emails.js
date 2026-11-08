'use strict';

// Transactional support emails (Resend via admin/lib/email.js's sendEmail).
// Plain, brand colours, HTML + plain-text versions, ticket id in the subject,
// no marketing. SUPPORT_EMAIL_DRY_RUN=1 records payloads in memory and logs
// them instead of sending (used by the automated tests).

const { sendEmail } = require('../../admin/lib/email');

// Links in emails must reach the app itself. The bare spikeandcrush.com is a
// registrar forwarder that drops the path and query (?support=...), so the
// default is the www host the app is served from.
const SITE_URL = (process.env.SUPPORT_SITE_URL || 'https://www.spikeandcrush.com').replace(/\/$/, '');
const sent = []; // dry-run outbox

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ heading, paragraphs, quote, buttonLabel, buttonUrl, ticketRef }) {
  const html = `<!doctype html><html><body style="margin:0;background:#07090F;font-family:Inter,Arial,sans-serif;color:#E8ECF4;">
<div style="max-width:520px;margin:0 auto;padding:32px 24px;">
  <div style="font-family:Rajdhani,Arial,sans-serif;font-weight:700;font-size:20px;letter-spacing:1px;text-transform:uppercase;color:#F5B83D;margin-bottom:20px;">Spike &amp; Crush Support</div>
  <div style="background:#0E1320;border:1px solid #1D2638;border-radius:16px;padding:24px;">
    <h1 style="font-size:18px;margin:0 0 12px;color:#E8ECF4;">${esc(heading)}</h1>
    ${paragraphs.map((p) => `<p style="font-size:14px;line-height:1.55;color:#C9D0DD;margin:0 0 12px;">${esc(p)}</p>`).join('')}
    ${quote ? `<div style="background:#111724;border-left:3px solid #F5B83D;border-radius:8px;padding:12px 14px;margin:12px 0;font-size:14px;line-height:1.55;color:#E8ECF4;white-space:pre-wrap;">${esc(quote)}</div>` : ''}
    ${buttonUrl ? `<a href="${esc(buttonUrl)}" style="display:inline-block;margin-top:8px;background:#F5B83D;color:#07090F;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:12px;font-size:14px;">${esc(buttonLabel)}</a>` : ''}
  </div>
  <p style="font-size:12px;color:#9AA4B8;margin-top:16px;">${ticketRef ? `Ticket ${esc(ticketRef)}. ` : ''}This is a service email about your support request. You do not need to reply to it; the chat on the site is where the conversation continues.</p>
</div></body></html>`;
  const text = [heading, '', ...paragraphs, ...(quote ? ['', quote] : []), ...(buttonUrl ? ['', `${buttonLabel}: ${buttonUrl}`] : []), '', ticketRef ? `Ticket ${ticketRef}.` : '', 'This is a service email about your support request.']
    .filter((l) => l !== undefined)
    .join('\n');
  return { html, text };
}

async function deliver({ to, subject, html, text, kind }) {
  if (!to) return { skipped: true, reason: 'no recipient' };
  if (process.env.SUPPORT_EMAIL_DRY_RUN === '1') {
    const payload = { to, subject, text, kind, at: new Date().toISOString() };
    sent.push(payload);
    console.log('[support email dry-run]', JSON.stringify({ to, subject, kind }));
    return { dryRun: true };
  }
  return sendEmail({ to, subject, html, text });
}

const chatUrl = (conversationId) => `${SITE_URL}/?support=${encodeURIComponent(conversationId)}`;

module.exports = {
  outbox: sent,

  agentReply({ to, ticketRef, agentName, message, conversationId }) {
    const { html, text } = layout({
      heading: 'You have a reply from Spike & Crush support',
      paragraphs: [`${agentName} from the team replied to your support request:`],
      quote: message,
      buttonLabel: 'Open the chat',
      buttonUrl: chatUrl(conversationId),
      ticketRef,
    });
    return deliver({ to, subject: `[${ticketRef || 'Support'}] You have a reply from Spike & Crush support`, html, text, kind: 'agent_reply' });
  },

  resolved({ to, ticketRef, conversationId }) {
    const { html, text } = layout({
      heading: 'Your support request is resolved',
      paragraphs: ['The team marked your support request as resolved. If anything is still wrong, open the chat and write to us within 7 days to reopen it.'],
      buttonLabel: 'Open the chat',
      buttonUrl: chatUrl(conversationId),
      ticketRef,
    });
    return deliver({ to, subject: `[${ticketRef || 'Support'}] Your support request is resolved`, html, text, kind: 'resolved' });
  },

  ticketReceived({ to, ticketRef, subject }) {
    const { html, text } = layout({
      heading: 'We received your message',
      paragraphs: [`Thanks for contacting Spike & Crush. Your ticket "${subject}" is open and the team will reply by email or in the support chat.`],
      ticketRef,
    });
    return deliver({ to, subject: `[${ticketRef}] We received your message`, html, text, kind: 'ticket_received' });
  },

  escalatedToUser({ to, ticketRef, conversationId }) {
    const { html, text } = layout({
      heading: 'A human agent will reply soon',
      paragraphs: ['Your conversation has been passed to the Spike & Crush team. A human agent will reply in the support chat, and we will email you when they do.'],
      buttonLabel: 'Open the chat',
      buttonUrl: chatUrl(conversationId),
      ticketRef,
    });
    return deliver({ to, subject: `[${ticketRef}] A human agent will reply soon`, html, text, kind: 'escalated_user' });
  },

  adminNewWaiting({ to, ticketRef, reason, summary, who, adminUrl }) {
    const { html, text } = layout({
      heading: 'New conversation waiting for a human',
      paragraphs: [`From: ${who}`, `Reason: ${reason || 'not given'}`],
      quote: summary || '(no summary)',
      buttonLabel: 'Open in admin',
      buttonUrl: adminUrl,
      ticketRef,
    });
    return deliver({ to, subject: `[${ticketRef || 'Support'}] Waiting for a human: ${String(reason || '').slice(0, 60)}`, html, text, kind: 'admin_waiting' });
  },
};
