'use strict';

// Limits on every email either server sends (security pass A4.2), checked in
// sendEmail so no route can forget them:
//   - per recipient: EMAIL_PER_RECIPIENT_HOUR (default 8) an hour, so no form
//     or button can be used to flood someone's inbox from our domain.
//     Our own addresses (@spikeandcrush.com) are exempt.
//   - per day: EMAIL_DAILY_CAP (default 3000) per server, with an alert at 80%
//     and at the cap. Alerts themselves always go through.
// Counts are in memory per server process: a restart clears them, which is
// fine for a flood guard.

const crypto = require('crypto');

const HOUR_MS = 60 * 60 * 1000;
const OWN_DOMAIN = /@spikeandcrush\.com$/i;

function createEmailGuard({
  perRecipientHour = Number(process.env.EMAIL_PER_RECIPIENT_HOUR) || 8,
  dailyCap = Number(process.env.EMAIL_DAILY_CAP) || 3000,
  now = () => Date.now(),
} = {}) {
  const perRecipient = new Map(); // hashed address -> [timestamps]
  let day = null;
  let sentToday = 0;
  const alerted = new Set();

  const hash = (addr) => crypto.createHash('sha256').update(String(addr).trim().toLowerCase()).digest('hex').slice(0, 24);
  const recipients = (to) => (Array.isArray(to) ? to : String(to || '').split(',')).map((s) => s.trim()).filter(Boolean);

  function rollDay() {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      sentToday = 0;
      alerted.clear();
    }
  }

  // { ok: true, alert?: 80 | 100 } or { ok: false, reason: 'daily_cap' | 'recipient_hourly' }
  function check(to, { isAlert = false } = {}) {
    rollDay();
    if (isAlert) return { ok: true };
    if (sentToday >= dailyCap) return { ok: false, reason: 'daily_cap' };
    const cutoff = now() - HOUR_MS;
    for (const addr of recipients(to)) {
      if (OWN_DOMAIN.test(addr)) continue;
      const list = (perRecipient.get(hash(addr)) || []).filter((t) => t > cutoff);
      perRecipient.set(hash(addr), list);
      if (list.length >= perRecipientHour) return { ok: false, reason: 'recipient_hourly' };
    }
    return { ok: true };
  }

  // Call after a send is accepted. Returns an alert level to send, if one is due.
  function record(to) {
    rollDay();
    sentToday++;
    for (const addr of recipients(to)) {
      if (OWN_DOMAIN.test(addr)) continue;
      const list = perRecipient.get(hash(addr)) || [];
      list.push(now());
      perRecipient.set(hash(addr), list);
    }
    if (perRecipient.size > 100000) perRecipient.clear();
    for (const level of [80, 100]) {
      if ((sentToday / dailyCap) * 100 >= level && !alerted.has(level)) {
        alerted.add(level);
        return level;
      }
    }
    return null;
  }

  return { check, record, stats: () => ({ day, sentToday, dailyCap, perRecipientHour }) };
}

module.exports = { createEmailGuard };
