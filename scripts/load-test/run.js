'use strict';

// Starts its own copy of the server on this machine against the dev database, then
// steps through levels of virtual players and reports what the server could take.
//   node scripts/load-test/accounts.js setup 500
//   node scripts/load-test/run.js 50,100,250,500 [minutesPerLevel]
const { fork, spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, TEST_PORT, assertDev, readAccounts, percentile } = require('./common');

assertDev();
const LEVELS = String(process.argv[2] || '50,100').split(',').map(Number);
const MINUTES = Number(process.argv[3]) || 5;
const WARMUP_MS = 90 * 1000;
const WORKERS = 4;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const REPORT = process.argv[4] || path.join(os.tmpdir(), 'spikecrush-load-test-report.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const accounts = readAccounts();
const now = Date.now() / 1000;
// Every level measures for MINUTES after a warm-up, then the reconnect test.
const NEEDED_SECONDS = LEVELS.reduce((sum, level) => sum + WARMUP_MS / 1000 + (level / WORKERS) * 0.2 + MINUTES * 60, 90);
const expiring = accounts.filter((a) => a.expires - now < NEEDED_SECONDS);
if (accounts.length < Math.max(...LEVELS) || expiring.length) {
  console.error(`Need ${Math.max(...LEVELS)} accounts with fresh logins (have ${accounts.length}, ${expiring.length} expiring). Run accounts.js setup.`);
  process.exit(1);
}

let server;
const opsLines = [];
const errorLines = {};
function startServer() {
  server = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    // Everything is from one address here, so the per-IP limits are lifted.
    env: { ...process.env, PORT: String(TEST_PORT), API_RATE_LIMIT: '100000000', AUTH_RATE_LIMIT: '100000000', NODE_ENV: 'development', ALERT_EMAIL: 'delivered@resend.dev', RESEND_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onLine = (buf) => {
    for (const line of String(buf).split('\n')) {
      if (line.startsWith('[ops] {')) { try { opsLines.push({ at: Date.now(), ...JSON.parse(line.slice(6)) }); } catch (e) { /* partial */ } }
      else if (/error|failed|timeout|ECONN|too many|rate limit/i.test(line) && !line.includes('EMAIL') && !line.includes('[email]')) {
        const key = line.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').replace(/\d+/g, '#').slice(0, 110);
        errorLines[key] = (errorLines[key] || 0) + 1;
      }
    }
  };
  server.stdout.on('data', onLine);
  server.stderr.on('data', onLine);
}

const workers = [];
let samples = {};
let counts = {};
const liveness = {};
function startWorkers() {
  for (let i = 0; i < WORKERS; i++) {
    const w = fork(path.join(__dirname, 'worker.js'), [], { env: { ...process.env, TARGET: BASE } });
    w.on('exit', (code) => { if (code) console.error(`worker ${i} exited with ${code}`); });
    w.on('error', () => {});
    w.on('message', (m) => {
      if (m.type !== 'metrics') return;
      for (const [k, v] of Object.entries(m.samples)) (samples[k] = samples[k] || []).push(...v);
      for (const [k, v] of Object.entries(m.counts)) counts[k] = (counts[k] || 0) + v;
      liveness[i] = { active: m.active, connected: m.connected };
    });
    workers.push(w);
    w.send({ type: 'accounts', accounts: accounts.filter((_, n) => n % WORKERS === i) });
  }
}

let cpu = [];
let rss = [];
let probes = [];
function resetMeasures() { samples = {}; counts = {}; cpu = []; rss = []; probes = []; }
const sampler = setInterval(() => {
  if (!server?.pid) return;
  try {
    const [c, r] = execSync(`ps -o %cpu=,rss= -p ${server.pid}`).toString().trim().split(/\s+/).map(Number);
    cpu.push(c);
    rss.push(r / 1024);
  } catch (e) { /* server gone */ }
  const started = Date.now();
  fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10000) })
    .then(() => probes.push(Date.now() - started))
    .catch(() => probes.push(10000));
}, 2000);

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted[sorted.length - 1] ?? null };
}

function summarise(level, seconds) {
  const out = { level, seconds, latency: {}, counts: { ...counts } };
  for (const [k, v] of Object.entries(samples)) out.latency[k] = stats(v);
  out.cpu = stats(cpu);
  out.rssMb = Math.round(Math.max(0, ...rss));
  out.healthProbe = stats(probes);
  out.connected = Object.values(liveness).reduce((a, w) => a + w.connected, 0);
  out.ops = opsLines[opsLines.length - 1] || null;
  const http = Object.entries(samples).filter(([k]) => k.startsWith('http ')).flatMap(([, v]) => v);
  out.http = stats(http);
  out.rps = Math.round(http.length / seconds);
  out.errorCount = Object.entries(counts).filter(([k]) => k.startsWith('error')).reduce((a, [, n]) => a + n, 0);
  out.errorRatePct = http.length ? Math.round((out.errorCount / http.length) * 1000) / 10 : 0;
  return out;
}

function print(r) {
  const row = (k) => { const l = r.latency[k]; return l ? `${k}: n=${l.n} p50=${l.p50} p95=${l.p95} p99=${l.p99} max=${l.max}` : `${k}: none`; };
  console.log(`\n===== ${r.level} players, ${r.seconds}s measured, ${r.connected} sockets connected =====`);
  console.log(`server cpu p50=${r.cpu.p50}% p95=${r.cpu.p95}%  memory ${r.rssMb} MB  loop p99 ${r.ops?.lagP99Ms ?? '?'} ms  matches ${r.ops?.matches ?? '?'}`);
  console.log(`http ${r.rps}/s p50=${r.http.p50} p95=${r.http.p95} p99=${r.http.p99} | health probe p95=${r.healthProbe.p95} max=${r.healthProbe.max} | errors ${r.errorCount} (${r.errorRatePct}%)`);
  Object.keys(r.latency).filter((k) => !k.startsWith('http ')).sort().forEach((k) => console.log('  ' + row(k)));
  Object.entries(r.latency).filter(([k]) => k.startsWith('http ')).sort((a, b) => (b[1].p95 ?? 0) - (a[1].p95 ?? 0)).slice(0, 6).forEach(([k]) => console.log('  ' + row(k)));
  console.log('  counts:', JSON.stringify(Object.fromEntries(Object.entries(r.counts).filter(([k]) => !k.startsWith('error')))));
  const errs = Object.entries(r.counts).filter(([k]) => k.startsWith('error') || k.startsWith('refused'));
  if (errs.length) console.log('  errors:', JSON.stringify(Object.fromEntries(errs)));
}

async function main() {
  startServer();
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/ready`); if (r.ok) break; } catch (e) { /* starting */ } await sleep(1000); }
  log('server up');
  startWorkers();
  await sleep(1000);
  const results = [];
  for (const level of LEVELS) {
    log(`ramping to ${level} players`);
    workers.forEach((w) => w.send({ type: 'target', count: Math.ceil(level / WORKERS), spawnEveryMs: 200 }));
    await sleep(WARMUP_MS + (level / WORKERS) * 200);
    resetMeasures();
    log(`measuring ${level} players for ${MINUTES} min`);
    const started = Date.now();
    await sleep(MINUTES * 60 * 1000);
    const r = summarise(level, Math.round((Date.now() - started) / 1000));
    print(r);
    results.push(r);
    fs.writeFileSync(REPORT, JSON.stringify({ results, serverErrors: errorLines, ops: opsLines }, null, 1));
  }
  log('reconnect storm: every socket drops and returns at once');
  resetMeasures();
  workers.forEach((w) => w.send({ type: 'storm' }));
  await sleep(60000);
  const storm = summarise(`storm at ${LEVELS[LEVELS.length - 1]}`, 60);
  print(storm);
  results.push(storm);
  console.log('\nserver log lines mentioning errors:');
  Object.entries(errorLines).sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, n]) => console.log(`  ${n}x ${k}`));
  fs.writeFileSync(REPORT, JSON.stringify({ results, serverErrors: errorLines, ops: opsLines }, null, 1));
  log(`report: ${REPORT}`);
  workers.forEach((w) => w.send({ type: 'stop' }));
  clearInterval(sampler);
  await sleep(1500);
  server.kill('SIGKILL');
  process.exit(0);
}
process.on('exit', () => { try { server?.kill('SIGKILL'); } catch (e) { /* gone */ } });
main().catch((e) => { console.error(e); process.exit(1); });
