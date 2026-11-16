'use strict';

// Account recovery and password changes (auth-recovery):
//   - one set of password rules for sign-up, reset and change
//   - reset-request limits per email and per IP (env tunable)
//   - "sign out everywhere else": the player's auth_valid_after time plus the
//     session to keep; tokens issued before that time from any other session
//     are refused (login tokens are checked locally, so revoking at Supabase
//     alone would leave them working for up to an hour)
//   - branded emails: reset link and "your password was changed"
// No secret, token or link is ever logged here.

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72; // bcrypt limit used by Supabase Auth

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (pw.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password needs letters and at least one number';
  return null;
}

// ---- reset request limits (in memory, one game server) -------------------------

function createWindowCounter(limit, windowMs) {
  const hits = new Map();
  return {
    // true = allowed (and counted), false = over the limit
    take(key, now = Date.now()) {
      const list = (hits.get(key) || []).filter((t) => t > now - windowMs);
      if (list.length >= limit) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      if (hits.size > 50000) for (const [k, v] of hits) if (!v.some((t) => t > now - windowMs)) hits.delete(k);
      return true;
    },
  };
}

const HOUR = 60 * 60 * 1000;
// Per email AND address (3 an hour): someone requesting links for your email
// from elsewhere cannot use up your own allowance. Per address (10 an hour)
// stops one address spraying many emails; a wide per-email cap (20 an hour)
// slows a spread-out attack.
const perEmailIp = createWindowCounter(Number(process.env.RESET_PER_EMAIL_HOUR) || 3, HOUR);
const perIp = createWindowCounter(Number(process.env.RESET_PER_IP_HOUR) || 10, HOUR);
const perEmailAll = createWindowCounter(Number(process.env.RESET_PER_EMAIL_ALL_HOUR) || 20, HOUR);

function takeResetAllowance(email, ip) {
  const e = String(email || '').trim().toLowerCase();
  if (!perIp.take(`ip:${ip}`)) return false;
  if (!perEmailIp.take(`email:${e}:${ip}`)) return false;
  return perEmailAll.take(`email:${e}`);
}

// ---- token claims and the "signed out everywhere else" check ------------------

function tokenClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch (e) {
    return {};
  }
}

// A token is retired when the player signed out other devices (or changed
// their password) after it was issued, and it belongs to another session.
function tokenRetired(player, token) {
  if (!player || !player.auth_valid_after) return false;
  const after = new Date(player.auth_valid_after).getTime();
  if (!Number.isFinite(after)) return false;
  const c = tokenClaims(token);
  if (player.auth_keep_session && c.session_id && c.session_id === player.auth_keep_session) return false;
  return !(Number(c.iat) * 1000 > after);
}

// ---- emails (Spike & Crush tokens, plain text fallback, no emoji) --------------

const wrap = (inner) => `<!doctype html><html><body style="margin:0;background:#07090F;font-family:Inter,Arial,sans-serif;color:#E8ECF4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07090F;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#0E1320;border:1px solid #1D2638;border-radius:12px;padding:28px">
<tr><td style="font-family:Rajdhani,Arial,sans-serif;font-size:22px;font-weight:700;letter-spacing:.5px;padding-bottom:16px"><span style="color:#2EE6A6">Spike</span><span style="color:#9AA4B8">&amp;</span><span style="color:#FF4D5E">Crush</span></td></tr>
${inner}
<tr><td style="padding-top:20px;border-top:1px solid #1D2638;font-size:12px;color:#9AA4B8">Spike &amp; Crush, hello@spikeandcrush.com</td></tr>
</table></td></tr></table></body></html>`;

function resetEmail({ link, expiresMinutes = 60 }) {
  return {
    subject: 'Reset your Spike & Crush password',
    text: `Someone asked to reset the password for your Spike & Crush account.\n\nChoose a new password here:\n${link}\n\nThis link works once and expires in ${expiresMinutes} minutes.\n\nIf you did not ask for this, ignore this email; your password is unchanged.`,
    html: wrap(`<tr><td style="font-size:16px;line-height:1.55;padding-bottom:18px">Someone asked to reset the password for your Spike &amp; Crush account.</td></tr>
<tr><td style="padding-bottom:18px"><a href="${link}" style="display:inline-block;padding:13px 22px;background:#F5B83D;color:#07090F;border-radius:8px;font-weight:700;text-decoration:none;font-size:15px">Choose a new password</a></td></tr>
<tr><td style="font-size:14px;color:#9AA4B8;line-height:1.55;padding-bottom:8px">This link works once and expires in ${expiresMinutes} minutes.</td></tr>
<tr><td style="font-size:14px;color:#9AA4B8;line-height:1.55;padding-bottom:4px">If you did not ask for this, ignore this email; your password is unchanged.</td></tr>`),
  };
}

function passwordChangedEmail({ username, at = new Date() }) {
  const when = at.toUTCString();
  return {
    subject: 'Your Spike & Crush password was changed',
    text: `Hi ${username || 'there'},\n\nThe password for your Spike & Crush account was changed on ${when}. Other devices were signed out.\n\nNot you? Contact hello@spikeandcrush.com right away.`,
    html: wrap(`<tr><td style="font-size:16px;line-height:1.55;padding-bottom:14px">Hi ${String(username || 'there').replace(/[<>&"]/g, '')},</td></tr>
<tr><td style="font-size:15px;line-height:1.55;padding-bottom:14px">The password for your Spike &amp; Crush account was changed on ${when}. Other devices were signed out.</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#E8ECF4">Not you? Contact <a href="mailto:hello@spikeandcrush.com" style="color:#F5B83D">hello@spikeandcrush.com</a> right away.</td></tr>`),
  };
}

module.exports = { PASSWORD_MIN, PASSWORD_MAX, passwordProblem, createWindowCounter, takeResetAllowance, tokenClaims, tokenRetired, resetEmail, passwordChangedEmail };
