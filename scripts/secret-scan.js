#!/usr/bin/env node
'use strict';

// Secret scanner (security checklist item 17). No dependencies.
//   node scripts/secret-scan.js            scan the whole git history (every added line)
//   node scripts/secret-scan.js --staged   scan only what is staged (pre-commit hook)
//   node scripts/secret-scan.js --tree     scan the current tracked files
// Exits 1 when a finding is not on the allowlist. Prints the rule, file and
// commit, plus the value's first 6 characters and length - never the value.
//
// Allowlist: known-safe matches (fake keys in tests, the public anon key, which
// is meant to be in the browser). Add an entry only with a reason.

const { execFileSync } = require('child_process');

const RULES = {
  stripe_live: /sk_live_[0-9A-Za-z]{16,}/g,
  stripe_test: /sk_test_[0-9A-Za-z]{16,}/g,
  stripe_webhook: /whsec_[0-9A-Za-z]{16,}/g,
  anthropic: /sk-ant-[A-Za-z0-9_-]{30,}/g,
  resend: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}/g,
  supabase_secret: /sb_secret_[A-Za-z0-9_-]{20,}/g,
  jwt: /eyJhbGciOi[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  github: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  discord_bot: /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}\b/g,
  private_key: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  aws: /\bAKIA[0-9A-Z]{16}\b/g,
  env_fallback: /process\.env\.[A-Z_]*(?:SECRET|PASSWORD|KEY|TOKEN)[A-Z_]*\s*(?:\|\||\?\?)\s*['"][^'"]{8,}['"]/g,
  assigned_secret: /(?:password|secret|api_?key|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/gi,
};

// [rule, file regex, reason]
const ALLOW = [
  ['stripe_live', /^test\//, 'fake key in a redaction test'],
  ['anthropic', /^test\//, 'fake key in a redaction test'],
  ['jwt', /^test\//, 'fake token in a redaction test'],
  ['assigned_secret', /^test\//, 'fixed test secrets for unit tests'],
  ['env_fallback', /^test\//, 'planted fake in the scanner\'s own test'],
  ['assigned_secret', /^scripts\/(load-test|admin-records|fire)\//, 'local test fixtures'],
  // Old master admin password fallback, removed 2026-11-08 (audit U1b). It stays
  // in history; the owner must have rotated MASTER_ADMIN_PASSWORD on Railway.
  ['env_fallback', /^admin\/lib\/auth\.js$/, 'removed fallback, password rotated by owner'],
];

// The anon key is public by design (sent to every browser); only flag a JWT
// whose role is not "anon".
function isPublicAnonJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.role === 'anon';
  } catch (e) {
    return false;
  }
}

function scanLines(lines, emit) {
  let commit = null;
  let file = null;
  for (const line of lines) {
    if (line.startsWith('COMMIT ')) { commit = line.slice(7); continue; }
    if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
    if (line.startsWith('+++') || !line.startsWith('+')) continue;
    for (const [rule, re] of Object.entries(RULES)) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const value = m[0];
        if (rule === 'jwt' && isPublicAnonJwt(value)) continue;
        if (rule !== 'env_fallback' && /process\.env|placeholder|your_value|example|changeme/i.test(value)) continue;
        if (rule === 'env_fallback' && /placeholder|dev-only/i.test(value)) continue;
        if (ALLOW.some(([r, f]) => r === rule && f.test(file || ''))) continue;
        emit({ rule, file, commit, start: value.slice(0, 6), length: value.length });
      }
    }
  }
}

function main() {
  const mode = process.argv.includes('--staged') ? 'staged' : process.argv.includes('--tree') ? 'tree' : 'history';
  let text;
  if (mode === 'staged') text = execFileSync('git', ['diff', '--cached', '-U0', '--no-color'], { maxBuffer: 1 << 28 }).toString();
  else if (mode === 'tree') {
    const files = execFileSync('git', ['ls-files'], { maxBuffer: 1 << 26 }).toString().split('\n').filter(Boolean);
    text = files.map((f) => {
      try { return `+++ b/${f}\n` + require('fs').readFileSync(f, 'utf8').split('\n').map((l) => `+${l}`).join('\n'); } catch (e) { return ''; }
    }).join('\n');
  } else text = execFileSync('git', ['log', '--all', '-p', '--no-color', '--format=COMMIT %h'], { maxBuffer: 1 << 30 }).toString();

  const seen = new Set();
  const findings = [];
  scanLines(text.split('\n'), (f) => {
    const key = `${f.rule}|${f.file}|${f.start}|${f.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  });
  console.log(`[secret-scan] mode=${mode} findings=${findings.length}`);
  for (const f of findings) console.log(`  ${f.rule.padEnd(16)} ${f.file}${f.commit ? ` @${f.commit}` : ''}  ${f.start}... (${f.length} chars)`);
  process.exit(findings.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { scanLines, RULES, isPublicAnonJwt };
