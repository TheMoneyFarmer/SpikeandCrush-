#!/usr/bin/env node
'use strict';

// Production build check (security checklist item 11). Fails (exit 1) when
// anything below would ship to production. No dependencies; reads files only.
//   - source maps (*.map files or sourceMappingURL comments) in served folders
//   - Socket.io / Express debug switches left on
//   - error responses that send a stack trace
//   - dev or test routes not wrapped in a NODE_ENV !== 'production' check
//   - a secret with a hard-coded fallback value in server code
//   - both servers have a catch-all error handler and call the env check

const fs = require('fs');
const path = require('path');

const ROOT = process.env.PROD_CHECK_ROOT || path.join(__dirname, '..');
const SERVED = ['client', 'admin/css', 'admin/js', 'admin/components'];
const SERVER_DIRS = ['server', 'admin'];
const problems = [];
const fail = (msg) => problems.push(msg);

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

// 1. Source maps
for (const dir of SERVED) {
  for (const f of walk(dir)) {
    if (f.endsWith('.map')) fail(`source map would be served: ${f}`);
    if (/\.(js|css)$/.test(f) && /sourceMappingURL=/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))) fail(`sourceMappingURL comment: ${f}`);
  }
}

const serverFiles = SERVER_DIRS.flatMap((d) => walk(d)).filter((f) => f.endsWith('.js') && !f.startsWith('admin/js/'));
for (const f of serverFiles) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  // 2. Debug switches
  if (/new Server\([^)]*debug\s*:\s*true/.test(src)) fail(`socket.io debug on: ${f}`);
  if (/process\.env\.DEBUG\s*=/.test(src)) fail(`sets DEBUG at runtime: ${f}`);
  // 3. Stack traces in responses
  if (/res\.(json|send|status\([^)]*\)\.(json|send))\([^)]*\.stack/.test(src)) fail(`stack trace sent in a response: ${f}`);
  // 4. Dev/test routes must be registered only outside production
  const devRoute = /app\.(get|post|put|patch|delete)\(\s*['"]\/api\/(dev|test|debug)\//g;
  let m;
  while ((m = devRoute.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    if (!/NODE_ENV\s*!==\s*['"]production['"]/.test(before)) fail(`dev/test route registered in production: ${f} (${m[0]})`);
  }
  // 5. Hard-coded secret fallbacks
  const fallback = /process\.env\.[A-Z_]*(SECRET|PASSWORD|TOKEN|_KEY)[A-Z_]*\s*(\|\||\?\?)\s*['"]([^'"]+)['"]/g;
  while ((m = fallback.exec(src))) {
    if (/placeholder/i.test(m[3])) continue;
    fail(`secret with a hard-coded fallback: ${f} (${m[0].split(/\|\||\?\?/)[0].trim()})`);
  }
}

// 6. Catch-all error handler + env check in both servers
for (const [file, name] of [['server/index.js', 'game'], ['admin/server.js', 'admin']]) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (!/app\.use\(\(err, req, res, next\)/.test(src)) fail(`${name} server has no catch-all error handler`);
  if (!new RegExp(`checkEnv\\('${name}'\\)`).test(src)) fail(`${name} server does not run the env check at startup`);
}

if (problems.length) {
  console.log(`[prod-check] FAIL - ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log(`[prod-check] OK - ${serverFiles.length} server files and ${SERVED.length} served folders checked`);
