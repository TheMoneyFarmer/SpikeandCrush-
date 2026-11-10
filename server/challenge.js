'use strict';

// Ghost challenge links (Part 3.5). A link carries everything needed to replay
// the challenger's exact market - instruments, market seed, start offsets,
// match length - plus the result to beat, signed with the server secret so it
// can't be edited (a forged "result to beat" or a different market would fail
// the signature). Self-contained: no table needed, expiry is inside the token.
//
//   /challenge/<payload>.<signature>   payload = base64url(JSON)

const crypto = require('crypto');
const gameFeel = require('./config/gameFeel');

const secret = () => process.env.CHALLENGE_SECRET || process.env.JWT_SECRET || 'dev-only-challenge-secret';
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url').slice(0, 32);

function create({ creatorId, username, mode, instruments, marketSeed, marketStarts, durationSeconds, pnl, rank, sourceMatchId }, nowMs = Date.now()) {
  const days = gameFeel.get().ghostChallenge.expiryDays;
  const body = {
    v: 1,
    c: creatorId,
    u: username,
    mo: mode,
    i: instruments,
    s: marketSeed,
    st: marketStarts,
    d: durationSeconds,
    p: Math.round(pnl * 100) / 100,
    r: rank,
    m: sourceMatchId,
    x: nowMs + days * 86400000,
  };
  const data = b64(JSON.stringify(body));
  return `${data}.${sign(data)}`;
}

// Returns { ok, challenge } or { ok: false, error }.
function read(code, nowMs = Date.now()) {
  if (typeof code !== 'string' || code.length > 4000 || !code.includes('.')) return { ok: false, error: 'Invalid challenge link' };
  const [data, sig] = code.split('.');
  const expected = sign(data);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { ok: false, error: 'Invalid challenge link' };
  let body;
  try {
    body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch (e) {
    return { ok: false, error: 'Invalid challenge link' };
  }
  if (!body || body.v !== 1) return { ok: false, error: 'Invalid challenge link' };
  if (nowMs > body.x) return { ok: false, error: 'This challenge has expired', expired: true };
  return {
    ok: true,
    challenge: {
      creatorId: body.c,
      username: body.u,
      mode: body.mo,
      instruments: body.i,
      marketSeed: body.s,
      marketStarts: body.st || {},
      durationSeconds: body.d,
      pnl: body.p,
      rank: body.r,
      sourceMatchId: body.m,
      expiresAt: new Date(body.x).toISOString(),
    },
  };
}

module.exports = { create, read };
