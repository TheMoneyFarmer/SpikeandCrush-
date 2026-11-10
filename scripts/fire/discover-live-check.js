'use strict';
// Live two-account Discover check against a running dev server: firetest2
// connects a socket (is online), firetest1 looks it up; then firetest2 turns
// on Appear offline and must vanish from firetest1's lists within seconds;
// then status "friends only" hides it from a stranger. Responses are grepped
// for any location field. Restores firetest2's settings at the end.
const { io } = require('socket.io-client');
const BASE = process.env.SHOT_BASE || 'http://localhost:3091';
const PASS = process.env.SHOT_PASS;
const j = async (path, opts = {}, tok) => {
  const r = await fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), raw: '' };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const a = (await j('/api/auth/login', { method: 'POST', body: { username: 'firetest1', password: PASS } })).body;
  const b = (await j('/api/auth/login', { method: 'POST', body: { username: 'firetest2', password: PASS } })).body;
  const sockA = io(BASE, { auth: { token: a.token }, transports: ['websocket'] });
  const sockB = io(BASE, { auth: { token: b.token }, transports: ['websocket'] });
  const pushes = [];
  sockA.on('discover:presence', (p) => pushes.push({ at: Date.now(), ...p }));
  await sleep(1500);
  const find = async () => {
    const r = await j('/api/discover?section=live&q=firetest2', {}, a.token);
    return { found: (r.body.items || []).find((x) => x.username === 'firetest2') || null, raw: JSON.stringify(r.body) };
  };
  const out = {};
  const first = await find();
  out.visibleWhenOnline = Boolean(first.found);
  out.row = first.found;
  if (first.found) sockA.emit('discover:watch', { ids: [first.found.id] });
  await sleep(300);
  const t0 = Date.now();
  await j('/api/player/settings', { method: 'PATCH', body: { settings: { appearOffline: true } } }, b.token);
  await sleep(1500);
  const hidden = await find();
  out.goneAfterAppearOffline = !hidden.found;
  out.pushReceived = pushes.find((p) => p.state === 'offline');
  out.pushLatencyMs = out.pushReceived ? out.pushReceived.at - t0 : null;
  await j('/api/player/settings', { method: 'PATCH', body: { settings: { appearOffline: false, statusVisibility: 'friends' } } }, b.token);
  await sleep(800);
  const friendsOnly = await find();
  out.strangerSeesFriendsOnlyAs = friendsOnly.found ? friendsOnly.found.state : 'not listed';
  await j('/api/player/settings', { method: 'PATCH', body: { settings: { appearOffline: false, statusVisibility: 'everyone' } } }, b.token);
  await sleep(800);
  out.backAfterRestore = Boolean((await find()).found);
  const all = [first.raw, hidden.raw, friendsOnly.raw, JSON.stringify(pushes)].join('');
  out.locationFieldsInPayloads = (all.match(/"(country|city|region|lat|lon|sameCountry|distance)"/gi) || []).length;
  console.log(JSON.stringify(out, null, 2));
  sockA.close();
  sockB.close();
  const ok = out.visibleWhenOnline && out.goneAfterAppearOffline && out.pushReceived && out.strangerSeesFriendsOnlyAs === 'not listed' && out.backAfterRestore && out.locationFieldsInPayloads === 0;
  console.log(ok ? 'PASS discover live privacy' : 'FAIL discover live privacy');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
