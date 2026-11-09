'use strict';

// Checks a player's login token on this server instead of asking Supabase Auth on
// every request and socket connection. Supabase signs tokens with a key pair; the
// public half is published (JWKS), so the signature, expiry, issuer and audience
// can all be checked locally. That takes Supabase Auth off the path of every
// logged-in request: if it slows down or goes down, players already logged in
// keep playing. (The load test took dev's Auth down this way.)
//
// Asks Supabase only when it must: the key can't be fetched, the token uses an
// unknown or shared-secret key, or the email isn't known to be verified yet.
//
// Trade-off: a token from a session that was logged out stays usable until it
// expires (an hour at most), as with any locally checked token. Bans are not
// affected: they're read from the player record on every request.

const crypto = require('crypto');

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_RETRY_MS = 30 * 1000;
const CLOCK_SKEW_SECONDS = 30;
const VERIFIED_CACHE_MS = 10 * 60 * 1000;

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

function createTokenVerifier({ supabaseUrl, supabaseAdmin, fetchImpl = fetch, now = () => Date.now() }) {
  const issuer = `${String(supabaseUrl || '').replace(/\/$/, '')}/auth/v1`;
  let keys = new Map();
  let fetchedAt = 0;
  let lastAttempt = 0;
  let loading = null;
  const verifiedEmail = new Map(); // user id -> time a remote check said confirmed

  async function loadKeys(force = false) {
    const t = now();
    if (!force && keys.size && t - fetchedAt < JWKS_TTL_MS) return;
    if (t - lastAttempt < JWKS_RETRY_MS && keys.size) return;
    if (loading) return loading;
    lastAttempt = t;
    loading = (async () => {
      try {
        const res = await fetchImpl(`${issuer}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`jwks ${res.status}`);
        const next = new Map();
        for (const jwk of (await res.json()).keys || []) {
          if (!jwk.kid || !['ES256', 'RS256'].includes(jwk.alg)) continue;
          next.set(jwk.kid, { alg: jwk.alg, key: crypto.createPublicKey({ key: jwk, format: 'jwk' }) });
        }
        if (next.size) {
          keys = next;
          fetchedAt = now();
        }
      } catch (e) {
        console.warn('[auth] could not load signing keys, asking Supabase per request meanwhile:', e.message);
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  // The token's claims if its signature and dates check out, otherwise null.
  // `undefined` means "can't decide locally" (no key for it).
  async function verifyLocally(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    let header, claims;
    try {
      header = b64json(parts[0]);
      claims = b64json(parts[1]);
    } catch (e) {
      return null;
    }
    if (!['ES256', 'RS256'].includes(header.alg)) return undefined;
    await loadKeys();
    let entry = keys.get(header.kid);
    if (!entry) {
      await loadKeys(true); // keys rotate: fetch once more before giving up
      entry = keys.get(header.kid);
      if (!entry) return undefined;
    }
    if (entry.alg !== header.alg) return null;
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    const ok =
      header.alg === 'ES256'
        ? crypto.verify('sha256', data, { key: entry.key, dsaEncoding: 'ieee-p1363' }, signature)
        : crypto.verify('RSA-SHA256', data, entry.key, signature);
    if (!ok) return null;
    const seconds = now() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audience.includes('authenticated') || claims.role !== 'authenticated') return null;
    if (!(claims.exp > seconds - CLOCK_SKEW_SECONDS) || (claims.nbf && claims.nbf > seconds + CLOCK_SKEW_SECONDS)) return null;
    if (!claims.sub) return null;
    return claims;
  }

  async function remoteUser(token) {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    if (data.user.email_confirmed_at) verifiedEmail.set(data.user.id, now());
    return data.user;
  }

  // Same shape as supabase.auth.getUser's user for the fields this server reads.
  async function getUser(token, { requireVerifiedEmail = false } = {}) {
    const claims = await verifyLocally(token);
    if (claims === null) return null;
    if (claims === undefined) return remoteUser(token);
    const emailKnownVerified =
      claims.user_metadata?.email_verified === true || now() - (verifiedEmail.get(claims.sub) || -Infinity) < VERIFIED_CACHE_MS;
    if (requireVerifiedEmail && !emailKnownVerified) return remoteUser(token);
    return {
      id: claims.sub,
      email: claims.email,
      email_confirmed_at: emailKnownVerified ? new Date(0).toISOString() : null,
      app_metadata: claims.app_metadata || {},
      user_metadata: claims.user_metadata || {},
      locallyVerified: true,
    };
  }

  return { getUser, verifyLocally, loadKeys };
}

module.exports = { createTokenVerifier };
