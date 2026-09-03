'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const express = require('express');
const http = require('http');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const { supabase, isConfigured } = require('./lib/supabaseAdmin');
const { signAdminToken, requireAdmin, requirePageAuth, logAdminAction, recordLoginAttempt, isLockedOut, clientIp, ipAllowed, SESSION_HOURS } = require('./lib/auth');
const internal = require('./lib/internalGameServer');

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
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.use(express.json());

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

// ---- auth -------------------------------------------------------------------

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const ip = clientIp(req);
  if (!ipAllowed(req)) return res.status(403).json({ error: 'Your IP is not on the admin allowlist' });
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  if (await isLockedOut(username)) {
    return res.status(429).json({ error: 'Too many failed attempts - locked out for 15 minutes' });
  }

  const valid = username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD;
  await recordLoginAttempt(username, ip, valid);

  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signAdminToken(username);
  res.cookie('admin_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });

  let lastLogin = null;
  if (isConfigured) {
    const { data: prevSession } = await supabase.from('admin_sessions').select('started_at').eq('admin_username', username).order('started_at', { ascending: false }).limit(1).maybeSingle();
    lastLogin = prevSession?.started_at || null;
    await supabase.from('admin_sessions').insert({
      admin_username: username, ip_address: ip, expires_at: new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString(),
    });
  }
  await logAdminAction({ adminUsername: username, actionType: 'login', ip });
  res.json({ success: true, username, lastLogin });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ success: true });
});

// ---- static + page auth -----------------------------------------------------

const PUBLIC_FILES = new Set(['/login.html', '/css/admin-base.css', '/css/admin-components.css', '/favicon.ico']);

app.use((req, res, next) => {
  if (PUBLIC_FILES.has(req.path) || req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/api/')) return next();
  if (req.path === '/' ) return res.redirect('/dashboard.html');
  if (req.path.endsWith('.html')) return requirePageAuth(req, res, next);
  next();
});

app.use(express.static(path.join(__dirname)));

// ---- api routes ---------------------------------------------------------------

app.use('/api', requireAdmin);
app.use('/api/dashboard', require('./routes/dashboard')());
app.use('/api/players', require('./routes/players')());
app.use('/api/matches', require('./routes/matches')());
app.use('/api/tournaments', require('./routes/tournaments')());
app.use('/api/monetisation', require('./routes/monetisation')());
app.use('/api/analytics', require('./routes/analytics')());
app.use('/api/config', require('./routes/gameConfig')());
app.use('/api/branding', require('./routes/branding')());
app.use('/api/communications', require('./routes/communications')());
app.use('/api/system', require('./routes/system')());

// ---- live socket relay --------------------------------------------------------
// Polls the game server's internal bridge every 5s and re-emits real data to
// admin panel browser clients - see lib/internalGameServer.js. Instant events
// (new registration, match started/ended, payment, ban) are pushed the
// moment the admin API itself performs the relevant write, right below.

io.use((socket, next) => {
  try {
    const cookies = (socket.handshake.headers.cookie || '').split(';').reduce((acc, part) => {
      const idx = part.indexOf('=');
      if (idx > -1) acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
      return acc;
    }, {});
    const decoded = jwt.verify(cookies.admin_token, process.env.ADMIN_SECRET);
    if (decoded.role !== 'admin') throw new Error('not admin');
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
});

module.exports = { app, io };
