'use strict';

// Password logins go through this server, so to Supabase every player appears to
// come from one address, and its limit on that address (about one sign-in every two
// seconds, bursts of 30) would be shared by the whole site. With SUPABASE_SECRET_KEY
// (an sb_secret key) and "IP Address Forwarding" switched on in Supabase, each
// sign-in is counted against the real visitor instead.
//
// Each call gets a throwaway client: signInWithPassword stores a session on the
// client, which on the shared service client made later calls run as that player.

const RETRIES = 2;
const RETRY_BASE_MS = 1000;
const BUSY_MESSAGE = 'Lots of players are logging in right now. Please try again in a moment.';

function isSignInRateLimited(error) {
  return Boolean(error) && (error.status === 429 || error.code === 'over_request_rate_limit');
}

function createPasswordSignIn({ createClient, url, serviceKey, secretKey, onRateLimited, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  function clientFor(visitorIp) {
    const auth = { autoRefreshToken: false, persistSession: false };
    if (secretKey && visitorIp) return createClient(url, secretKey, { auth, global: { headers: { 'sb-forwarded-for': visitorIp } } });
    return createClient(url, serviceKey, { auth });
  }

  return async function passwordSignIn(credentials, visitorIp) {
    let result;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt) await sleep(RETRY_BASE_MS * attempt + Math.random() * RETRY_BASE_MS);
      result = await clientFor(visitorIp).auth.signInWithPassword(credentials);
      if (!isSignInRateLimited(result.error)) return result;
    }
    onRateLimited?.();
    return result;
  };
}

class SignInBusyError extends Error {
  constructor() {
    super(BUSY_MESSAGE);
    this.code = 'SIGN_IN_BUSY';
  }
}

module.exports = { createPasswordSignIn, isSignInRateLimited, SignInBusyError, BUSY_MESSAGE };
