'use strict';

// Part 3: five sample questions to the live support assistant (local server,
// dev database) about playing on a phone and installing the app.
//   BASE=http://localhost:3070 ACCTS=... node scripts/mobile-landscape/kb-questions.js
const accts = require(process.env.ACCTS);
const BASE = process.env.BASE || 'http://localhost:3070';
const QUESTIONS = [
  'How do I play on my phone? The game turned sideways.',
  'Can I turn off the landscape thing on my iPhone?',
  'I pressed buy once and it bought straight away, can it ask me first?',
  'How do I install Spike and Crush on my iPhone home screen?',
  'Is there an Android app I can install?',
];
(async () => {
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: accts[2].username, password: accts[2].password }) })).json();
  const h = { 'content-type': 'application/json', authorization: `Bearer ${login.token}` };
  for (const q of QUESTIONS) {
    // a fresh conversation per question
    const s = await (await fetch(`${BASE}/api/support/session`, { method: 'POST', headers: h, body: '{}' })).json();
    if (s.conversation && s.conversation.id) await fetch(`${BASE}/api/support/conversations/${s.conversation.id}/close`, { method: 'POST', headers: h }).catch(() => {});
    const r = await (await fetch(`${BASE}/api/support/messages`, { method: 'POST', headers: h, body: JSON.stringify({ body: q }) })).json();
    const answer = (r.assistantMessage && r.assistantMessage.body) || (r.reply && r.reply.body) || (r.messages && r.messages.filter((m) => m.role === 'assistant' || m.sender === 'ai').slice(-1)[0]?.body) || JSON.stringify(r).slice(0, 300);
    console.log(`\nQ: ${q}\nA: ${answer}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
