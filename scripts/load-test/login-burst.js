'use strict';

// Does the login route survive many players logging in at once? All of them reach
// Supabase from the server's one address, which is what a launch looks like.
//   node scripts/load-test/login-burst.js <how many> <per second>
const { spawn } = require('child_process');
const { ROOT, assertDev, readAccounts, percentile } = require('./common');

assertDev();
const COUNT = Number(process.argv[2]) || 60;
const PER_SECOND = Number(process.argv[3]) || 10;
const PORT = 3061;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const accounts = readAccounts().slice(0, COUNT);
  const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), AUTH_RATE_LIMIT: '100000000', API_RATE_LIMIT: '100000000', NODE_ENV: 'development' }, stdio: 'ignore' });
  process.on('exit', () => server.kill('SIGKILL'));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/ready`)).ok) break; } catch (e) { /* starting */ } await sleep(1000); }
  const results = [];
  const jobs = accounts.map(async (a, i) => {
    await sleep((i / PER_SECOND) * 1000);
    const started = Date.now();
    const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: a.username, password: a.password }), signal: AbortSignal.timeout(30000) }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    results.push({ status: r ? r.status : 0, ms: Date.now() - started, error: body.error });
  });
  await Promise.all(jobs);
  const by = {};
  results.forEach((r) => { const k = `${r.status}${r.error ? ' ' + r.error.slice(0, 60) : ''}`; by[k] = (by[k] || 0) + 1; });
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`${COUNT} logins at ${PER_SECOND}/s: p50=${percentile(ms, 0.5)}ms p95=${percentile(ms, 0.95)}ms`);
  console.log(JSON.stringify(by, null, 1));
  process.exit(0);
})();
