'use strict';

// Startup check for environment variables (security checklist item 2), used by
// the game server and the admin server. In production a missing or placeholder
// REQUIRED variable stops the process with a clear message; RECOMMENDED ones
// only log a warning. Never prints a value: names and lengths only.
// The full list with purposes is in env.example at the repo root.

const crypto = require('crypto');

const PLACEHOLDER = /^(|your[_-]?value.*|changeme|change[_-]?me|placeholder|xxx+|todo|replace[_-]?me|sk_test_placeholder|<.*>)$/i;

const SETS = {
  game: {
    required: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'ALLOWED_ORIGIN'],
    recommended: ['SITE_URL', 'INTERNAL_ADMIN_SECRET', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'IP_HASH_SECRET', 'CHALLENGE_SECRET', 'STATEMENT_SECRET', 'LISTING_SECRETS_KEY', 'DEPLOY_DRAIN_TOKEN'],
  },
  admin: {
    required: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_SECRET'],
    recommended: ['MASTER_ADMIN_PASSWORD', 'INTERNAL_ADMIN_SECRET', 'GAME_SERVER_INTERNAL_URL', 'ADMIN_REQUIRE_2FA', 'LISTING_SECRETS_KEY'],
  },
};

const isPlaceholder = (v) => v === undefined || PLACEHOLDER.test(String(v).trim());

// { missing: [names], weak: [names] } - never values.
function inspect(kind, env = process.env) {
  const set = SETS[kind];
  if (!set) throw new Error(`unknown env set ${kind}`);
  return {
    missing: set.required.filter((n) => isPlaceholder(env[n])),
    weak: set.recommended.filter((n) => isPlaceholder(env[n])),
  };
}

function checkEnv(kind, { env = process.env, exit = (code) => process.exit(code), log = console } = {}) {
  const { missing, weak } = inspect(kind, env);
  const prod = env.NODE_ENV === 'production';
  if (weak.length) log.warn(`[config] ${kind}: not set (optional, features fall back or switch off): ${weak.join(', ')}`);
  if (missing.length) {
    const msg = `[config] ${kind}: required variable(s) missing or still a placeholder: ${missing.join(', ')}. See env.example.`;
    if (prod) {
      log.error(`${msg} Refusing to start in production.`);
      exit(1);
      return false;
    }
    log.warn(`${msg} (development: continuing)`);
  }
  return missing.length === 0;
}

// A signing key for one purpose: the named variable when set, otherwise a key
// derived from the service key (secret, always set in production), never a
// fixed string anyone can read in the source. Development without either gets
// a random per-process key.
const devKeys = {};
function signingSecret(purpose, ...names) {
  for (const n of names) if (!isPlaceholder(process.env[n])) return process.env[n];
  const base = process.env.SUPABASE_SERVICE_KEY;
  if (!isPlaceholder(base)) return crypto.createHmac('sha256', base).update(`spikecrush:${purpose}`).digest('hex');
  return (devKeys[purpose] ||= crypto.randomBytes(32).toString('hex'));
}

module.exports = { checkEnv, inspect, signingSecret, isPlaceholder, SETS };
