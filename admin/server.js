'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const express = require('express');
const http = require('http');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const bcrypt = require('bcryptjs');

const { supabase, isConfigured } = require('./lib/supabaseAdmin');
const {
  ADMIN_ROLES, MASTER_ADMIN_EMAIL,
  signAdminToken, signAdminUserToken, seedMasterAdmin,
  requireAdmin, requireSuperAdmin, requirePageAuth,
  logAdminAction, logAdminActivity, recordLoginAttempt, isLockedOut,
  clientIp, ipAllowed, SESSION_HOURS, revokeSessions, JWT_OPTS,
} = require('./lib/auth');
const { securityHeaders } = require('../server/securityHeaders');
const internal = require('./lib/internalGameServer');
const { originLock, startRangeRefresh, visitorIp } = require('../server/originLock');
const { bridgeCallAllowed } = require('../server/bridgeAuth');
const twoFactor = require('./lib/twoFactor');
const QRCode = require('qrcode');

// Railway (and most PaaS hosts) inject PORT and require the service to bind
// to exactly that value - ADMIN_PORT stays as the local-dev override for
// running both servers on one machine (`npm run start:all`), but PORT wins
// whenever the platform sets it.
const ADMIN_PORT = process.env.PORT || process.env.ADMIN_PORT || 3003;

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || !process.env.ADMIN_SECRET) {
  console.error('[admin] ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_SECRET must be set in .env - refusing to start.');
  process.exit(1);
}

const app = express();
// Same reasoning as the game server - Railway is a single reverse-proxy hop
// in front of this service, so express-rate-limit needs trust proxy set to
// use X-Forwarded-For safely.
// Proxies between the visitor and this process: 1 = Railway only. Set TRUST_PROXY_HOPS=2
// when Cloudflare is in front, or every visitor shares Cloudflare's IP in rate limits.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);
const server = http.createServer(app);
// Same-origin only: the panel's own pages are the only legitimate socket client
// (was `origin: true` with credentials, i.e. any site).
const io = new Server(server, { cors: { origin: false } });
// Traffic must come through Cloudflare (see originLock.js). Sockets skip Express, so they need it too.
io.engine.use(originLock());

app.disable('x-powered-by');
app.use(originLock());
startRangeRefresh();
app.use(securityHeaders({ admin: true }));
// Nothing on the admin panel belongs in a search engine.
app.use((req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next(); });
app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));
app.use(express.json({ limit: '200kb' }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => visitorIp(req) });

// ---- auth -------------------------------------------------------------------

// Accepts either the legacy shared ADMIN_USERNAME/ADMIN_PASSWORD pair (kept
// working - existing bookmarked credentials shouldn't break) or an
// admin_users row looked up by email + bcrypt. Either path issues the same
// kind of admin_token cookie, so every existing /api/* route and page guard
// keeps working unchanged regardless of which credential type logged in.
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const identifier = (req.body?.username || req.body?.email || '').trim();
  const { password } = req.body || {};
  const ip = clientIp(req);
  if (!ipAllowed(req)) return res.status(403).json({ error: 'Your IP is not on the admin allowlist' });
  if (!identifier || !password) return res.status(400).json({ error: 'Username/email and password are required' });

  if (await isLockedOut(identifier, ip)) {
    return res.status(429).json({ error: 'Too many failed attempts - locked out for 15 minutes' });
  }

  const safeEqual = (x, y) => {
    const a1 = Buffer.from(String(x)); const b1 = Buffer.from(String(y || ''));
    return a1.length === b1.length && require('crypto').timingSafeEqual(a1, b1);
  };
  // The shared login has no phone attached, so requiring 2FA switches it off.
  const legacyValid = !twoFactor.twoFactorRequired()
    && safeEqual(identifier, process.env.ADMIN_USERNAME) && safeEqual(password, process.env.ADMIN_PASSWORD);
  let adminUser = null;
  let dbValid = false;

  if (!legacyValid && isConfigured) {
    const { data, error: lookupErr } = await supabase.from('admin_users').select('*').eq('email', identifier.toLowerCase()).eq('is_active', true).maybeSingle();
    // A Postgres/RLS error here (e.g. permission denied) previously looked
    // identical to "no such admin" - both just fall through to "Invalid
    // credentials" below with zero clue why. Logging it doesn't change the
    // response (still must not leak whether an email exists), just makes a
    // real connectivity/permissions problem visible in the server logs
    // instead of indistinguishable from a wrong password.
    if (lookupErr) console.error('[admin login] admin_users lookup failed:', lookupErr.message, lookupErr.code || '', lookupErr.hint || '');
    if (data) {
      dbValid = await bcrypt.compare(password, data.password_hash);
      if (dbValid) adminUser = data;
    }
  }

  const valid = legacyValid || dbValid;
  if (!valid) {
    await recordLoginAttempt(identifier, ip, false);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (adminUser) {
    // undefined = the 2FA columns don't exist yet (migration not run).
    if (adminUser.totp_enabled === undefined) {
      if (twoFactor.twoFactorRequired()) return res.status(503).json({ error: 'Two-factor login is not set up on the database yet' });
    } else if (adminUser.totp_enabled) {
      const code = String(req.body?.code || '').trim();
      // Nothing is recorded yet: a success row would reset the lockout count.
      if (!code) return res.status(401).json({ needCode: true, error: 'Enter the 6-digit code from your authenticator app' });
      const check = await acceptCode(adminUser, code);
      if (!check.ok) {
        await recordLoginAttempt(identifier, ip, false);
        return res.status(check.status).json({ needCode: true, error: check.error });
      }
    } else {
      return res.json({ setup2fa: true, setupToken: twoFactor.signSetupToken(adminUser.id) });
    }
  }

  await recordLoginAttempt(identifier, ip, true);
  const payload = await startSession(req, res, adminUser, identifier);
  if (!payload) return res.status(503).json({ error: 'Could not start a session' });
  res.json(payload);
});

// Checks a code and burns its time step, so a code seen once can't be replayed.
async function acceptCode(adminUser, code) {
  if (twoFactor.codeAttemptsBlocked(adminUser.id)) {
    return { ok: false, status: 429, error: 'Too many wrong codes - wait 15 minutes' };
  }
  let step = null;
  try {
    step = twoFactor.matchTotpStep(twoFactor.decryptSecret(adminUser.totp_secret), code);
  } catch (e) {
    console.error('[admin login] 2FA secret could not be read for', adminUser.email, '- was ADMIN_SECRET changed?');
  }
  if (step !== null) {
    const { data: claimed, error } = await supabase.from('admin_users').update({ totp_last_step: step })
      .eq('id', adminUser.id).or(`totp_last_step.is.null,totp_last_step.lt.${step}`).select('id');
    if (error) return { ok: false, status: 503, error: 'Could not check the code - try again' };
    if (claimed && claimed.length) {
      twoFactor.clearCodeFailures(adminUser.id);
      return { ok: true, step };
    }
  }
  twoFactor.noteCodeFailure(adminUser.id);
  return { ok: false, status: 401, error: 'That code is wrong or was already used - wait for the next one' };
}

// Issues the admin_token cookie. Returns the login response, or null if no session row.
async function startSession(req, res, adminUser, identifier) {
  const ip = clientIp(req);
  const email = adminUser ? adminUser.email : identifier;

  // The session row is created first so the token can name it (sid): logout and
  // deactivation revoke that row and the token stops working immediately.
  let lastLogin = null;
  let sid = null;
  if (isConfigured) {
    const { data: prevSession } = await supabase.from('admin_sessions').select('started_at').eq('admin_username', email).order('started_at', { ascending: false }).limit(1).maybeSingle();
    lastLogin = prevSession?.started_at || null;
    const { data: sess, error: sessErr } = await supabase.from('admin_sessions').insert({
      admin_username: email, ip_address: ip, expires_at: new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString(),
    }).select('id').single();
    if (sessErr || !sess) return null;
    sid = sess.id;
    if (adminUser) await supabase.from('admin_users').update({ last_login: new Date().toISOString() }).eq('id', adminUser.id);
  }
  const token = adminUser ? signAdminUserToken(adminUser, sid) : signAdminToken(identifier, sid);
  res.cookie('admin_token', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure || process.env.NODE_ENV === 'production',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });
  await logAdminAction({ adminUsername: email, actionType: 'login', ip });
  await logAdminActivity({ adminId: adminUser?.id || null, adminEmail: email, action: 'LOGIN', ip });

  return {
    success: true,
    username: email,
    lastLogin,
    admin: adminUser ? { id: adminUser.id, email: adminUser.email, name: adminUser.name, role: adminUser.role, is_master: adminUser.is_master } : { email, role: 'super_admin', is_master: false },
  };
}

// First login with a password and no 2FA yet: both endpoints need the setup token
// from that login, and neither touches an account that already has 2FA on.
async function adminForSetup(token) {
  const adminId = twoFactor.readSetupToken(token);
  if (!adminId) return null;
  const { data } = await supabase.from('admin_users').select('*').eq('id', adminId).eq('is_active', true).maybeSingle();
  return data && data.totp_enabled === false ? data : null;
}

app.post('/api/auth/2fa/setup', loginLimiter, async (req, res) => {
  const adminUser = await adminForSetup(req.body?.setupToken);
  if (!adminUser) return res.status(401).json({ error: 'Setup expired - log in again' });
  const secret = twoFactor.generateSecret();
  const { error } = await supabase.from('admin_users').update({ totp_secret: twoFactor.encryptSecret(secret) }).eq('id', adminUser.id).eq('totp_enabled', false);
  if (error) return res.status(503).json({ error: 'Could not start setup - try again' });
  const uri = twoFactor.buildOtpAuthUri({ secret, accountName: adminUser.email, issuer: 'Spike & Crush Admin' });
  res.json({ secret, qr: await QRCode.toDataURL(uri, { width: 240, margin: 2 }) });
});

app.post('/api/auth/2fa/confirm', loginLimiter, async (req, res) => {
  const adminUser = await adminForSetup(req.body?.setupToken);
  if (!adminUser || !adminUser.totp_secret) return res.status(401).json({ error: 'Setup expired - log in again' });
  const check = await acceptCode(adminUser, String(req.body?.code || '').trim());
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  const { error } = await supabase.from('admin_users').update({ totp_enabled: true }).eq('id', adminUser.id);
  if (error) return res.status(503).json({ error: 'Could not turn on two-factor login - try again' });
  await logAdminActivity({ adminId: adminUser.id, adminEmail: adminUser.email, action: 'ADMIN_2FA_ENABLED', ip: clientIp(req) });
  await recordLoginAttempt(adminUser.email, clientIp(req), true);
  const payload = await startSession(req, res, adminUser, adminUser.email);
  if (!payload) return res.status(503).json({ error: 'Could not start a session' });
  res.json(payload);
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = require('./lib/auth').getToken(req);
    const decoded = token ? jwt.verify(token, process.env.ADMIN_SECRET, JWT_OPTS) : null;
    if (decoded?.sid) await revokeSessions({ sid: decoded.sid });
  } catch (e) { /* expired/invalid token: nothing to revoke */ }
  res.clearCookie('admin_token');
  res.json({ success: true });
});

// ---- static + page auth -----------------------------------------------------

// Live support events pushed by the game server (new waiting conversation,
// new message, status change). Same shared secret + localhost rule as the
// game server's own internal bridge; re-broadcast to signed-in admin sockets.
app.post('/internal/support-event', (req, res) => {
  if (!bridgeCallAllowed(req)) return res.status(403).json({ error: 'Forbidden' });
  io.emit('support:event', req.body || {});
  res.json({ ok: true });
});

const PUBLIC_FILES = new Set(['/login.html', '/css/admin-base.css', '/css/admin-components.css', '/favicon.ico']);

app.use((req, res, next) => {
  if (PUBLIC_FILES.has(req.path) || req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/api/')) return next();
  if (req.path === '/' ) return res.redirect('/dashboard.html');
  if (req.path.endsWith('.html')) return requirePageAuth(req, res, next);
  next();
});

// The game site's relative-time helper, so both panels format times the same way.
app.get('/js/time-ago.js', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'js', 'time-ago.js')));
app.get('/js/support-markdown.js', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'js', 'support-markdown.js')));
app.get('/js/form-state.js', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'js', 'form-state.js')));

// Static files: ONLY the browser assets and the top-level .html pages. This
// used to be express.static(__dirname), which served the server's own source
// (lib/auth.js, server.js, routes/*) to anyone - audit URGENT 1.
const STATIC_OPTS = { dotfiles: 'deny', index: false, fallthrough: true };
app.use('/css', express.static(path.join(__dirname, 'css'), STATIC_OPTS));
app.use('/js', express.static(path.join(__dirname, 'js'), STATIC_OPTS));
app.use('/components', express.static(path.join(__dirname, 'components'), STATIC_OPTS));
app.use('/icons', express.static(path.join(__dirname, 'icons'), STATIC_OPTS));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'icons', 'admin.ico')));
app.get(/^\/[a-z0-9-]+\.html$/, (req, res, next) => {
  const file = path.join(__dirname, req.path);
  if (path.dirname(file) !== __dirname) return next();
  res.sendFile(file, (err) => { if (err) next(); });
});

// ---- api routes ---------------------------------------------------------------

app.use('/api', requireAdmin);
// Support agents (role 'support') may use the support inbox and nothing else.
const supportAgentGuard = (req, res, next) => {
  const supportReadsSponsors = req.method === 'GET' && ((req.path.startsWith('/sponsors') && !req.path.startsWith('/sponsors/leads')) || (req.path.startsWith('/listings') && !/\/secrets$/.test(req.path)));
  if (req.admin && req.admin.role === 'support' && !supportReadsSponsors && !(req.baseUrl === '/api' && (req.path.startsWith('/support') || req.path.startsWith('/admins/change-password')))) {
    return res.status(403).json({ error: 'Support agents can only use the Support section' });
  }
  next();
};
app.use('/api', supportAgentGuard);
app.use('/api/dashboard', require('./routes/dashboard')());
app.use('/api/players', require('./routes/players')());
app.use('/api/matches', require('./routes/matches')());
app.use('/api/tournaments', require('./routes/tournaments')());
// Spec path for the test creator is /admin/api/comps/test - same router.
app.use('/api/competitions', require('./routes/competitions')());
app.use('/admin/api/comps', requireAdmin, supportAgentGuard, require('./routes/competitions')());
app.use('/api/monetisation', require('./routes/monetisation')());
app.use('/api/analytics', require('./routes/analytics')());
app.use('/api/config', require('./routes/gameConfig')());
app.use('/api/fire', require('./routes/fire')());
app.use('/api/branding', require('./routes/branding')());
app.use('/api/communications', require('./routes/communications')());
app.use('/api/system', require('./routes/system')());
app.use('/api/admins', require('./routes/adminUsers')());
app.use('/api/partners', require('./routes/partners')());
app.use('/api/support', require('./routes/support')());
app.use('/api/sponsors', require('./routes/sponsors')());
app.use('/api/listings', require('./routes/listings')());

// Anything not matched above (e.g. /lib/auth.js, /server.js) is a 404.
app.use((req, res) => {
  if (req.method === 'GET' && /\btext\/html\b/.test(req.headers.accept || '')) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  return res.status(404).send('Not found');
});

// ---- live socket relay --------------------------------------------------------
// Polls the game server's internal bridge every 5s and re-emits real data to
// admin panel browser clients - see lib/internalGameServer.js. Instant events
// (new registration, match started/ended, payment, ban) are pushed the
// moment the admin API itself performs the relevant write, right below.

io.use(async (socket, next) => {
  try {
    const cookies = (socket.handshake.headers.cookie || '').split(';').reduce((acc, part) => {
      const idx = part.indexOf('=');
      if (idx > -1) acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
      return acc;
    }, {});
    const decoded = jwt.verify(cookies.admin_token, process.env.ADMIN_SECRET, JWT_OPTS);
    if (!ADMIN_ROLES.includes(decoded.role)) throw new Error('not admin');
    if (!(await require('./lib/auth').sessionStillValid(decoded))) throw new Error('session revoked');
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

async function pollAndBroadcast() {
  try {
    const state = await internal.getLiveState();
    io.emit('admin:active_matches', state.activeMatches);
    io.emit('admin:player_count', { websocketConnections: state.websocketConnections });
  } catch (e) {
    // Game server unreachable - stay quiet, the dashboard's own polling fetch
    // will surface "gameServerReachable: false" on its next refresh.
  }
}
setInterval(pollAndBroadcast, 5000);

server.listen(ADMIN_PORT, () => {
  console.log(`Spike & Crush admin panel listening on http://localhost:${ADMIN_PORT}`);
  console.log(`[admin] Supabase ${isConfigured ? 'connected' : 'NOT configured'} - data endpoints ${isConfigured ? 'live' : 'will 503'}`);
  seedMasterAdmin();
});

module.exports = { app, io };
