'use strict';

// Waitlist emails, in the same plain style as server/emailVerification.js.
// The sponsor line (email_footer slot) is one "Presented by" sentence, never
// a claim about who funds a prize.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function footer(sponsorName) {
  if (!sponsorName) return { html: '', text: '' };
  return {
    html: `<p style="color:#8090a8;font-size:12px">Presented by ${esc(sponsorName)}.</p>`,
    text: `\n\nPresented by ${sponsorName}.`,
  };
}

function waitlistConfirmEmail({ username, title, hook, rhythm, link, sponsorName }) {
  const f = footer(sponsorName);
  return {
    subject: `You're on the list for the ${title}`,
    text: `Hi ${username},\n\nYou're on the list for the ${title}. ${hook}\n\n${rhythm}. We'll email you once when it opens. Entry is free.\n\nSee the details: ${link}\n\nYou can leave the list from that page at any time.${f.text}`,
    html: `<p>Hi ${esc(username)},</p>
<p>You're on the list for the <strong>${esc(title)}</strong>. ${esc(hook)}</p>
<p>${esc(rhythm)}. We'll email you once when it opens. Entry is free.</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;background:#1fd38a;color:#14213d;border-radius:8px;font-weight:700;text-decoration:none">See the details</a></p>
<p>You can leave the list from that page at any time.</p>${f.html}`,
  };
}

function waitlistOpenEmail({ username, title, hook, link, sponsorName }) {
  const f = footer(sponsorName);
  return {
    subject: `The ${title} is open`,
    text: `Hi ${username},\n\nThe ${title} is open. ${hook}\n\nEntry is free: ${link}${f.text}`,
    html: `<p>Hi ${esc(username)},</p>
<p>The <strong>${esc(title)}</strong> is open. ${esc(hook)}</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;background:#1fd38a;color:#14213d;border-radius:8px;font-weight:700;text-decoration:none">Enter for free</a></p>${f.html}`,
  };
}

// A discontinued format (Weekly, Monthly) was closed and the entry refunded.
function closedEmail({ username, name, coins }) {
  return {
    subject: `The ${name} has been closed`,
    text: `Hi ${username},\n\nThe ${name} has been closed and your ${coins} coins are back in your balance.\n\nThe Daily Open and the Weekend Open are coming soon. Both are free to enter.`,
    html: `<p>Hi ${esc(username)},</p>
<p>The <strong>${esc(name)}</strong> has been closed and your ${esc(coins)} coins are back in your balance.</p>
<p>The Daily Open and the Weekend Open are coming soon. Both are free to enter.</p>`,
  };
}

module.exports = { waitlistConfirmEmail, waitlistOpenEmail, closedEmail };
