'use strict';

// Code-side safety for the support assistant. These checks run on every
// message regardless of what the model does, so escalation, PII masking and
// output filtering never depend on the model following its prompt.

const crypto = require('crypto');

// ---- "I want a human" (trigger 1, detected in code, not just by the model) ----
const HUMAN_PATTERNS = [
  /\b(talk|speak|chat|connect|transfer|put)\b[^.?!]{0,40}\b(human|person|people|agent|someone|staff|team member|real person|support team|operator|representative)\b/i,
  /\b(real|live|actual)\s+(person|human|agent|people)\b/i,
  /\bhuman\s+(agent|support|please|pls)\b/i,
  /^\s*(human|agent|operator|representative)\s*[.!?]*\s*$/i,
  /\bnot\s+(a\s+)?(bot|ai|robot)\b/i,
  /\b(want|need|get|give me|request)\s+(an?\s+|to\s+)?(human|agent|real person|person|operator|representative)\b/i,
];
function detectHumanRequest(text) {
  return HUMAN_PATTERNS.some((re) => re.test(String(text || '')));
}

// ---- topics that always go to a human after immediate safe guidance (trigger 4) ----
const TOPICS = [
  {
    topic: 'payment',
    category: 'payment',
    priority: 'high',
    reason: 'Payment or charge dispute',
    re: /\b(charged|charge ?back|double[- ]charged|refund|was billed|billing|payment (failed|went through|issue|problem)|paid but|money (taken|was taken|gone)|stripe receipt)\b|\b(paid|purchase|bought)\b[^.?!]{0,60}\b(no|not|never|didn'?t)\b[^.?!]{0,30}\bcoins?\b|\bcoins?\b[^.?!]{0,40}\b(never arrived|not arrived|didn'?t arrive|missing after (paying|purchase))/i,
  },
  {
    topic: 'ban_appeal',
    category: 'account_login',
    priority: 'high',
    reason: 'Account suspension or ban appeal',
    re: /\b(banned|ban appeal|unban|suspended|suspension|appeal (my|the|a) (ban|suspension)|why (was|am) i (banned|suspended))\b/i,
  },
  {
    topic: 'hacked',
    category: 'account_login',
    priority: 'urgent',
    reason: 'Suspected account compromise',
    re: /\b(hacked|compromised|someone (else )?(logged|got) into|stolen account|account (was )?stolen|unauthori[sz]ed (login|access)|changed my (email|password) without)\b/i,
  },
  {
    topic: 'safety',
    category: 'report_player',
    priority: 'high',
    reason: 'Harassment or safety report',
    re: /\b(harass(ed|ment|ing)?|threat(en|ened|ening|s)?|bully(ing)?|abus(e|ive)|stalk(ing|ed)?|self[- ]harm|suicid|unsafe|grooming)\b/i,
  },
  {
    topic: 'legal_data',
    category: 'account_login',
    priority: 'high',
    reason: 'Legal or data request',
    re: /\b(gdpr|ccpa|data (request|deletion|export|access)|delete (all )?my (data|information|personal)|right to be forgotten|lawyer|legal action|solicitor|sue|subject access)\b/i,
  },
  {
    topic: 'sponsor',
    category: 'sponsor_partner',
    priority: 'normal',
    reason: 'Sponsor or partner business enquiry',
    re: /\b(sponsor(ship|ing)?|partnership|partner with|advertis(e|ing)|business (enquiry|inquiry|proposal)|collab(oration)?|brand deal|affiliate deal)\b/i,
  },
  {
    topic: 'coin_bug',
    category: 'coins_shop',
    priority: 'high',
    reason: 'Bug report with coin impact',
    re: /\b(bug|glitch|broken|error)\b[^.?!]{0,80}\bcoins?\b|\bcoins?\b[^.?!]{0,80}\b(bug|glitch|disappeared|vanished|lost|missing|wrong)\b/i,
  },
];
function detectEscalationTopic(text) {
  const t = String(text || '');
  return TOPICS.find((x) => x.re.test(t)) || null;
}

// ---- repeated question (trigger 3) ----
const STOP = new Set('a an the i my me is are was were be to of and or in on for it this that with do does did why how what when where can cant can\'t you your please pls still again just so but not no yes ok okay hi hello hey'.split(' '));
function keyWords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}
function similarity(a, b) {
  const A = keyWords(a);
  const B = keyWords(b);
  if (A.size < 2 || B.size < 2) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
function questionKey(text) {
  return Array.from(keyWords(text)).sort().slice(0, 10).join(' ');
}

// ---- PII masking for stored user messages ----
function luhnOk(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
function maskPII(text) {
  let masked = false;
  let out = String(text || '');
  // Card numbers: 13-19 digits, optionally grouped by spaces or dashes, Luhn-valid.
  out = out.replace(/(?<![-\w])(?:\d[ -]?){12,18}\d(?![-\w])/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnOk(digits)) return m;
    masked = true;
    return `[card number hidden, ends ${digits.slice(-4)}]`;
  });
  // IBAN-style bank account numbers.
  out = out.replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, (m) => {
    masked = true;
    return `[bank account hidden, ends ${m.replace(/\s/g, '').slice(-4)}]`;
  });
  // Long ID / account numbers (9+ digits in a row that aren't already masked).
  // (Not inside a dash/hex-joined token, so pasted match UUIDs survive intact.)
  out = out.replace(/(?<![-\w])\d{9,}(?![-\w])/g, (m) => {
    masked = true;
    return `[number hidden, ends ${m.slice(-4)}]`;
  });
  // CVV given with a label.
  out = out.replace(/\b(cvv|cvc|security code)\s*[:=]?\s*\d{3,4}\b/gi, (m, label) => {
    masked = true;
    return `${label} [hidden]`;
  });
  return { text: out, masked };
}

// ---- output filter: nothing secret-looking or someone else's email leaves the server ----
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return '';
  return `${user[0]}***@${domain}`;
}
const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic keys
  /\bsk_(live|test)_[A-Za-z0-9]{10,}/g, // secret keys
  /\b(rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g,
  /\bwhsec_[A-Za-z0-9]{10,}/g,
  /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/g, // Resend keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
  /\b(ghp|gho|xox[abp])_[A-Za-z0-9-]{10,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex secrets / hashes
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, // bcrypt hashes
];
function filterOutput(text, { allowedMaskedEmails = [] } = {}) {
  let out = String(text || '');
  let changed = false;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      changed = true;
      return '[removed]';
    });
  }
  // Any full email address except our own contact address is replaced by
  // its masked form; masked forms (t***@x.com) never match this pattern.
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (m) => {
    if (/^hello@spikeandcrush\.com$/i.test(m)) return m;
    if (allowedMaskedEmails.includes(m)) return m;
    changed = true;
    return maskEmail(m);
  });
  // IPv4 addresses.
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, () => {
    changed = true;
    return '[removed]';
  });
  return { text: out, changed };
}

// ---- rate limits (in memory; this server runs as a single process) ----
const RATE = {
  perConversation: { max: 20, windowMs: 10 * 60 * 1000 },
  perDay: { max: 100, windowMs: 24 * 60 * 60 * 1000 },
};
const buckets = new Map(); // key -> array of timestamps
function hit(key, { max, windowMs }, now = Date.now()) {
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}
function checkRateLimit({ conversationId, actorKey }) {
  const now = Date.now();
  // Check both before recording either, so a rejected message doesn't burn quota.
  const convKey = `c:${conversationId}`;
  const dayKey = `d:${actorKey}`;
  const convArr = (buckets.get(convKey) || []).filter((t) => now - t < RATE.perConversation.windowMs);
  const dayArr = (buckets.get(dayKey) || []).filter((t) => now - t < RATE.perDay.windowMs);
  if (conversationId && convArr.length >= RATE.perConversation.max) return { ok: false, scope: 'conversation' };
  if (dayArr.length >= RATE.perDay.max) return { ok: false, scope: 'day' };
  if (conversationId) hit(convKey, RATE.perConversation, now);
  hit(dayKey, RATE.perDay, now);
  return { ok: true };
}
function resetRateLimits() {
  buckets.clear();
}

// Guests are rate limited by IP, stored only as SHA-256 with a salt that
// rotates every UTC day (the salt itself is random per process and never stored).
const SALT_SEED = crypto.randomBytes(32).toString('hex');
function hashIp(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const salt = crypto.createHash('sha256').update(`${SALT_SEED}:${day}`).digest('hex');
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}
function hashGuestToken(token) {
  return crypto.createHash('sha256').update(`support-guest:${token}`).digest('hex');
}

module.exports = {
  detectHumanRequest,
  detectEscalationTopic,
  similarity,
  questionKey,
  maskPII,
  maskEmail,
  filterOutput,
  checkRateLimit,
  resetRateLimits,
  RATE,
  hashIp,
  hashGuestToken,
};
