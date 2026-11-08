'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateAvatar } = require('./imageValidation');
const { securityHeaders } = require('./securityHeaders');
const express = require('express');
const compression = require('compression');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // still used for the legacy-account migration path in /api/auth/login
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const db = require('./database');
const { sendEmail, renderTemplate } = require('../admin/lib/email');
const { createGameEngine, tierForRating, TIERS } = require('./gameEngine');
const matchmaking = require('./matchmaking');
const totp = require('./totp');
const sabotage = require('./sabotage');
const instrumentsRegistry = require('./instruments');
const shop = require('./shop');
const battlepass = require('./battlepass');
const tournament = require('./tournament');
const presence = require('./presence');
const { INVITE_REWARD_COINS, INVITE_MAX_PAID } = require('./referralRules');

const PORT = process.env.PORT || 3000;

// Lightweight real error visibility for the admin panel's System > Error Logs
// tab - wraps the console.error calls already scattered through this
// codebase (there's no dedicated error-tracking service wired up) into an
// in-memory ring buffer, rather than building a whole new logging pipeline.
// Not persisted across restarts - see /internal/admin/errors.
const recentErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  recentErrors.push({
    timestamp: new Date().toISOString(),
    message: args.map((a) => (a instanceof Error ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
  });
  if (recentErrors.length > 300) recentErrors.shift();
  originalConsoleError(...args);
};

// Service-role client for all server-side Supabase Auth admin operations
// (create/delete users, verify tokens, generate reset links). Never expose
// this key to the client - only the anon key (client/js/auth.js) goes there.
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
// Password sign-ins get their own throwaway client. Calling signInWithPassword
// on supabaseAdmin stored that player's session on the shared service client,
// so later supabaseAdmin calls (e.g. Storage uploads) ran as that player and
// hit row-level security - and one request's sign-in could leak into another.
function passwordSignIn(credentials) {
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client.auth.signInWithPassword(credentials);
}


// ALLOWED_ORIGIN restricts CORS to the real domain(s) in production - unset
// (dev/local) falls back to wide-open, since local testing hits this from
// whatever port/host is convenient. Accepts a comma-separated list so both
// the apex domain and www can be allowed at once.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
// In production an unset ALLOWED_ORIGIN must not silently mean "any site".
if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
  console.error('[config] ALLOWED_ORIGIN must be set in production - refusing to start.');
  process.exit(1);
}
const corsOrigin = allowedOrigins.length > 0 ? allowedOrigins : '*';

const app = express();
// Railway sits in front of this app as a single reverse proxy hop and sets
// X-Forwarded-For - without telling Express to trust exactly that one hop,
// express-rate-limit refuses to start (it throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// rather than risk keying rate limits off a client-spoofable header).
// Proxies between the visitor and this process: 1 = Railway only. Set TRUST_PROXY_HOPS=2
// when Cloudflare is in front, or every visitor shares Cloudflare's IP in rate limits.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);
app.disable('x-powered-by');
// Security headers on every response, including static files.
app.use(securityHeaders());

// Liveness / readiness for Railway and an uptime monitor (audit item 42).
app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));
app.get('/ready', async (req, res) => {
  if (!db.isConfigured) return res.status(503).json({ ok: false, db: 'not configured' });
  try {
    await db.ping();
    res.json({ ok: true, db: 'ok' });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'unreachable' });
  }
});
const server = http.createServer(app);
// 100 KB message cap (default 1 MB); no client message needs more.
const io = new Server(server, { cors: { origin: corsOrigin }, maxHttpBufferSize: 100 * 1024 });

// Global playerId -> Set<socketId> registry (independent of match sessions) so
// the notification bell works on any page, not just while inside a match.
const playerSockets = new Map();
// Persists every notification (Block 12) in addition to the live push, so the
// bell has real history across reloads/devices, not just whatever arrived
// while the tab was open.
function notifyPlayer(playerId, type, message, extra = {}) {
  const sockets = playerSockets.get(playerId);
  const payload = { type, message, at: new Date().toISOString(), fromPlayerId: extra.fromPlayerId || null, data: extra.data || {} };
  if (sockets) {
    for (const sid of sockets) io.to(sid).emit('notification', payload);
  }
  if (db.isConfigured) {
    db.createNotification({ playerId, type, fromPlayerId: extra.fromPlayerId, data: { message, ...extra.data } }).catch((e) =>
      console.warn('[notifyPlayer] failed to persist notification:', e.message)
    );
  }
}

async function broadcastPresenceToFriends(playerId, presenceData) {
  if (!db.isConfigured) return;
  try {
    const friendIds = await db.listFriendIds(playerId);
    if (!friendIds.length) return;
    const player = await db.getPlayerById(playerId);
    if (!player) return;
    const payload = {
      playerId,
      username: player.username,
      status: presenceData.status,
      matchId: presenceData.matchId,
      lobbyId: presenceData.lobbyId,
      mode: presenceData.mode,
    };
    for (const friendId of friendIds) {
      const sockets = playerSockets.get(friendId);
      if (!sockets) continue;
      for (const sid of sockets) io.to(sid).emit('friend:status_update', payload);
    }
  } catch (e) {
    console.warn('[presence] failed to broadcast to friends:', e.message);
  }
}

function updatePresence(playerId, patch) {
  const updated = presence.setPresence(playerId, patch);
  broadcastPresenceToFriends(playerId, updated);
  if (db.isConfigured) {
    db.upsertPresence({
      playerId,
      status: updated.status,
      currentMatchId: updated.matchId,
      currentLobbyId: updated.lobbyId,
      currentMode: updated.mode,
    }).catch(() => {});
  }
}

// Muteable per spec (Part F) via player.settings.notifyFriendWins === false,
// default on. Fire-and-forget: a friend's win feed is a nice-to-have, never
// worth failing or slowing down match resolution over.
async function notifyFriendsOfWin(playerId, username, modeLabel, pnl, matchId) {
  if (!db.isConfigured) return;
  try {
    const friendIds = await db.listFriendIds(playerId);
    if (!friendIds.length) return;
    for (const friendId of friendIds) {
      const friend = await db.getPlayerById(friendId).catch(() => null);
      if (friend?.settings?.notifyFriendWins === false) continue;
      notifyPlayer(friendId, 'friend_won_match', `${username} just won ${modeLabel}`, {
        fromPlayerId: playerId,
        data: { username, modeLabel, pnl, matchId },
      });
    }
  } catch (e) {
    console.warn('[notifyFriendsOfWin] failed:', e.message);
  }
}

const gameEngine = createGameEngine(io, notifyPlayer, updatePresence, notifyFriendsOfWin);
const { createCompEngine } = require('./compEngine');
const { createLobbyRouter } = require('./lobby');
const compEngine = createCompEngine({ io, notifyPlayer });

// inviteId -> { id, fromPlayerId, fromUsername, fromTier, lobbyId, matchMode,
// instruments, currentPlayers, maxPlayers, targetPlayerId, expiresAt, timer }
const pendingInvites = new Map();
const INVITE_TTL_MS = 60 * 1000;

const AVATAR_DIR = path.join(__dirname, '..', 'client', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
// Avatars are held in memory, validated by their bytes (server/imageValidation.js)
// and written with an extension derived from the detected type - never the
// client's filename or MIME label (audit URGENT 2).
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});
const AVATAR_BUCKET = 'avatars';

function sanitizePlayer(p) {
  const { password_hash, totp_secret, ...rest } = p;
  // tier is stored denormalized but only refreshed after a match ends - always
  // derive it from war_rating here so a fresh/unplayed account isn't stuck at
  // the DB column's default text.
  rest.tier = tierForRating(rest.war_rating);
  return rest;
}

// Attaches the player's equipped cosmetics (shop.js SLOT_BY_TYPE: avatar_frame,
// background, nameplate) to a sanitized player object as equipped_frame /
// equipped_background / equipped_nameplate, so the client can render frames,
// nameplate effects, and profile backgrounds right after login/register/OAuth
// without a second round-trip. Falls back to the free default item id per slot.
async function withEquippedCosmetics(player) {
  const sanitized = sanitizePlayer(player);
  try {
    const equipped = await db.getEquippedCosmetics(player.id);
    const bySlot = {};
    for (const e of equipped) bySlot[e.slot] = e.item_id;
    sanitized.equipped_frame = bySlot.avatar_frame || 'none';
    sanitized.equipped_background = bySlot.background || 'bg_terminal_dark';
    sanitized.equipped_nameplate = bySlot.nameplate || 'name_standard';
  } catch (e) {
    sanitized.equipped_frame = 'none';
    sanitized.equipped_background = 'bg_terminal_dark';
    sanitized.equipped_nameplate = 'name_standard';
  }
  return sanitized;
}

// Verifies a password by actually attempting a Supabase Auth sign-in with it
// (there's no local password hash to compare against anymore - Supabase owns
// the credential). Used anywhere the app previously did
// bcrypt.compare(rawPassword, player.password_hash): edit-profile, account
// deletion, disabling 2FA. Returns true/false, never throws.
async function verifyPasswordViaSupabase(email, password) {
  if (!email || !password) return false;
  const { error } = await passwordSignIn({ email, password });
  return !error;
}

// requireAuth from the migration spec, kept under its original exported name
// (`authenticate`) so the ~60 existing route registrations that already do
// `requireDb, authenticate` don't all need touching. Populates
// req.tokenPlayer with the FULL player row (not just a JWT payload) - every
// existing call site only ever read `.id` (or `.sid`, handled separately),
// so this is a safe superset, not a breaking change to that contract.
// Bans set in the admin panel (players.is_banned / banned_until) were never
// checked by the game server (audit item 26). A ban with no end date is
// permanent; an expired ban no longer applies.
function activeBan(player) {
  if (!player?.is_banned) return null;
  if (player.banned_until && new Date(player.banned_until).getTime() <= Date.now()) return null;
  return { until: player.banned_until || null, reason: player.ban_reason || null };
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const {
      data: { user },
      error,
    } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });

    const player = await db.getPlayerBySupabaseUserId(user.id);
    if (!player) return res.status(401).json({ error: 'Player record not found' });
    const ban = activeBan(player);
    if (ban) return res.status(403).json({ error: 'This account is banned', bannedUntil: ban.until, reason: ban.reason });

    req.user = user;
    req.tokenPlayer = player;
    req.player = player;
    next();
  } catch (e) {
    console.error('[authenticate]', e);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function clientIp(req) {
  // req.ip follows trust proxy. The first X-Forwarded-For entry is whatever the caller sent.
  return String(req.ip || req.socket.remoteAddress || 'unknown').replace('::ffff:', '');
}

// No cookie-parser middleware is installed anywhere in this server (only
// req.headers.cookie is available) - this just reads the one cookie the
// referral system needs. Setting a cookie still works fine via Express's
// built-in res.cookie(), which doesn't require cookie-parser at all.
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function requireDb(req, res, next) {
  if (!db.isConfigured) {
    console.error('[requireDb] blocked a request - SUPABASE_SERVICE_KEY is not set');
    return res.status(503).json({ error: 'This feature is temporarily unavailable. Please try again shortly.' });
  }
  next();
}


app.use(cors({ origin: corsOrigin }));
// Mostly for /api/match/:id/history, which carries several hundred KB of
// price history per instrument - gzip cuts that ~5x on mobile connections.
app.use(compression());
app.use(express.json({ limit: '200kb' }));

// Safe deploys: pause new matches and let live ones finish before a restart
// (see server/deployDrain.js and .github/workflows/safe-deploy.yml).
const { createDeployDrain } = require('./deployDrain');
const deployDrain = createDeployDrain({ gameEngine, io, notifyPlayer });
deployDrain.mount(app);
// index:false - without it, static's default directory-index behavior would
// serve client/index.html for a bare "/" request before the explicit
// app.get('/') route below (landing.html) is ever reached.
// Uploaded avatars: only image files are ever served from /uploads (a file
// uploaded before validation existed can't be served as HTML).
app.use('/uploads', (req, res, next) => (/\.(png|jpe?g|gif|webp)$/i.test(req.path) ? next() : res.status(404).end()));
// Short browser cache (assets aren't fingerprinted yet) + ETag revalidation.
app.use(express.static(path.join(__dirname, '..', 'client'), { index: false, maxAge: '5m', dotfiles: 'ignore' }));

// Clean URL routes for the new pages (kept alongside the original .html
// paths, which existing client-side navigation still uses unchanged).
const CLIENT_DIR = path.join(__dirname, '..', 'client');
app.get('/', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'landing.html')));
app.get('/play', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
app.get('/wallet', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'wallet.html')));
app.get('/cards', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'cards.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'settings.html')));
app.get('/help', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'help.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'privacy.html')));
app.get('/responsible', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'responsible.html')));
app.get('/shop', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'shop.html')));
app.get('/battle-pass', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'battle-pass.html')));
app.get('/async', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'async.html')));
app.get('/replay', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'replay.html')));
app.get('/clip', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'clip.html')));
// The Competition Hub replaced the old "coming soon" bracket page as the
// tournaments destination (tournaments.html is kept for when native brackets
// unlock); old links - landing page, home mode button - land on the hub.
app.get('/tournaments', (req, res) => res.redirect(302, '/competitions'));
app.get('/tournament/:id', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'tournament.html')));
app.get('/competitions', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'competitions.html')));
app.get('/competition/:id', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'competition-play.html')));
app.get('/sponsor', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'sponsor.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'analytics.html')));
app.get('/trading-floor', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'leaderboard.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'profile.html')));
app.get('/profile/:username', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'profile.html')));
app.get('/auth-callback', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'auth-callback.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'reset-password.html')));

// Player invite links: /invite/CODE remembers the inviter for 30 days. Read once,
// when a new account is created. Only ever attaches to a brand-new account.
const INVITE_COOKIE = 'sc_invite';
app.get('/invite/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    if (db.isConfigured && /^[A-Z0-9]{8}$/.test(code) && (await db.getInviterByCode(code))) {
      res.cookie(INVITE_COOKIE, code, { maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax', httpOnly: true, secure: req.secure });
    }
  } catch (e) {
    console.error('[invite link]', e.message);
  }
  res.redirect('/');
});

// Never fatal: a bad or expired invite just means no reward, not a failed signup.
async function attachInvite(req, res, player) {
  const code = getCookie(req, INVITE_COOKIE);
  if (!code || !db.isConfigured) return;
  try {
    const inviterId = await db.getInviterByCode(code);
    if (inviterId && inviterId !== player.id) await db.createPlayerReferral({ inviterId, friendId: player.id });
  } catch (e) {
    console.error('[invite attach]', e.message);
  }
  res.clearCookie(INVITE_COOKIE);
}

// Broker/prop-firm referral links: /r/CODE logs the click, drops a 30-day
// ref_code cookie, then bounces straight to the home page. The cookie is
// read back once, at registration, to attribute the new player to the
// partner (see /api/auth/register below) - it never needs to be read again.
app.get('/r/:code', async (req, res) => {
  const code = req.params.code;
  try {
    if (db.isConfigured) {
      const partner = await db.getReferralPartnerByCode(code);
      if (partner) {
        const ipHash = crypto.createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 16);
        await db.recordReferralClick({ partnerId: partner.id, landingPath: '/', ipHash, userAgent: req.headers['user-agent'] });
        res.cookie('ref_code', code, { maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
      }
    }
  } catch (e) {
    console.error('[referral redirect]', e);
  }
  res.redirect('/');
});

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
// Paid AI calls and spam-prone endpoints get their own, tighter limits (audit item 1).
const supportChatLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many messages - please wait a few minutes.' } });
const supportTicketLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many tickets - please wait before opening another.' } });
const clickLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

// Internal-only bridge for the separate admin panel (port 3003) - secret +
// localhost-gated inside the router itself, see server/internalAdmin.js.
const { createInternalAdminRouter } = require('./internalAdmin');
app.use('/internal/admin', createInternalAdminRouter({ gameEngine, compEngine, io, db, instrumentsRegistry, sabotage, TIERS, recentErrors, notifyPlayer }));

// ---- auth -----------------------------------------------------------------

const DEFAULT_WELCOME_EMAIL_HTML = `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0a0e14;color:#fff;">
    <div style="font-size:22px;font-weight:800;margin-bottom:24px;">
      <span style="color:#008F6A;">S</span><span style="color:#00A87C;">P</span><span style="color:#00C896;">I</span><span style="color:#00E0AA;">K</span><span style="color:#00FF88;">E</span>
      <span style="color:#fff;">&amp;</span>
      <span style="color:#FF4444;">C</span><span style="color:#EE3333;">R</span><span style="color:#DD2222;">U</span><span style="color:#CC1111;">S</span><span style="color:#BB0000;">H</span>
    </div>
    <h2 style="margin:0 0 12px;">Welcome, {{username}}!</h2>
    <p style="color:rgba(255,255,255,.7);line-height:1.6;">
      Your account is live with <strong style="color:#00C896;">{{coins}} coins</strong> to start trading.
      Jump into a Quick War, size up the leaderboard, and see how far you can push your War Rating.
    </p>
    <a href="https://www.spikeandcrush.com/trading-floor" style="display:inline-block;margin-top:16px;padding:12px 28px;background:#00C896;color:#000;font-weight:700;text-decoration:none;border-radius:8px;">
      Enter the Trading Floor
    </a>
    <p style="color:rgba(255,255,255,.35);font-size:12px;margin-top:32px;">
      Spike &amp; Crush is a skill-based competitive trading game using simulated accounts and historical market data. No real money is traded. Not financial advice.
    </p>
  </div>
`;


// Both templates are admin-customizable (Branding > Email Templates in the
// admin panel, ids "welcome" and "coin_purchase") - falls back to the
// hardcoded copy above if nothing's been saved there yet. Fire-and-forget by
// design (never awaited by a caller) and every failure is caught internally
// - a flaky email provider or a broken admin-edited template must never
// fail or delay account creation/purchase confirmation.
async function sendWelcomeEmail(player) {
  if (!player.email) return;
  try {
    const tpl = await db.getEmailTemplate('welcome').catch(() => null);
    const data = { username: player.username, coins: player.coins.toLocaleString() };
    await sendEmail({
      to: player.email,
      subject: renderTemplate(tpl?.subject || 'Welcome to Spike & Crush, {{username}}!', data),
      html: renderTemplate(tpl?.body_html || DEFAULT_WELCOME_EMAIL_HTML, data),
    });
  } catch (e) {
    console.error('[welcome email]', e.message);
  }
}

app.post('/api/auth/register', authLimiter, requireDb, async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email and password are required' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }
    // Letters, numbers and underscores only: names are shown all over the game,
    // so markup characters are never allowed in them (defence in depth, item 34).
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username can only use letters, numbers and underscores' });
    }
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (typeof password !== 'string' || password.length > 200) {
      return res.status(400).json({ error: 'Password is too long' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (await db.getPlayerByUsername(username)) return res.status(409).json({ error: 'Username already taken' });
    if (await db.getPlayerByEmail(email)) return res.status(409).json({ error: 'Email already registered' });

    // email_confirm: true - this prototype has no email-verification flow, so
    // the account must be usable (able to sign in) immediately after
    // registration, same as the old system.
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username },
    });
    if (createErr) return res.status(400).json({ error: createErr.message });

    let player;
    try {
      player = await db.createPlayer({ username, email, supabaseUserId: created.user.id });
    } catch (e) {
      // Roll back the auth user so a DB failure doesn't leave an orphaned,
      // permanently-unusable (email now "taken") Supabase account behind.
      await supabaseAdmin.auth.admin.deleteUser(created.user.id).catch(() => {});
      throw e;
    }

    await attachInvite(req, res, player);

    // Referral attribution: if this browser arrived via a partner's /r/:code
    // link, that route already logged the click and dropped a ref_code
    // cookie - this is the one point a player ID exists to attach it to.
    // Never fatal to registration - a broken/expired code just means no
    // conversion gets recorded, not a failed signup.
    const refCode = getCookie(req, 'ref_code');
    if (refCode && db.isConfigured) {
      try {
        const partner = await db.getReferralPartnerByCode(refCode);
        if (partner) await db.createReferralConversion({ partnerId: partner.id, playerId: player.id });
      } catch (e) {
        console.error('[register] referral conversion failed:', e.message);
      }
    }

    const session = await db.createSession({ playerId: player.id, userAgent: req.headers['user-agent'], ip: clientIp(req) });
    await db.recordLoginEvent({ playerId: player.id, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    await db.recordCoinTransaction({ playerId: player.id, type: 'welcome_bonus', amount: player.coins, balanceAfter: player.coins });
    sendWelcomeEmail(player);

    const { data: signIn, error: signInErr } = await passwordSignIn({ email, password });
    if (signInErr || !signIn.session) {
      console.error('[register] account created but immediate sign-in failed:', signInErr?.message);
      return res.status(500).json({ error: 'Account created but sign-in failed - please log in.' });
    }

    res.json({
      token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
      player: await withEquippedCosmetics(player),
      welcomeBonus: 500,
      sessionId: session.id,
    });
  } catch (e) {
    console.error('[register]', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', authLimiter, requireDb, async (req, res) => {
  try {
    const { username, password, totpCode } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

    let player = await db.getPlayerByUsername(username);
    if (!player) return res.status(401).json({ error: 'Invalid username or password' });

    // Legacy account from before the Supabase Auth migration: verify their
    // original bcrypt password once, then provision and link a real
    // Supabase Auth user for them so they never notice the switch and their
    // stats/coins/history are preserved under the same player row.
    if (!player.supabase_user_id) {
      if (!player.password_hash || !(await bcrypt.compare(password, player.password_hash))) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      if (!player.email) {
        return res.status(401).json({ error: 'Please contact support to migrate this account - no email on file.' });
      }
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: player.email,
        password,
        email_confirm: true,
        user_metadata: { username: player.username },
      });
      if (createErr) {
        console.error('[login] legacy migration failed to create Supabase user:', createErr.message);
        return res.status(500).json({ error: 'Could not migrate your account - please try again.' });
      }
      player = await db.updatePlayer(player.id, { supabase_user_id: created.user.id });
    }

    const { data: signIn, error: signInErr } = await passwordSignIn({ email: player.email, password });
    if (signInErr || !signIn.session) return res.status(401).json({ error: 'Invalid username or password' });
    const ban = activeBan(player);
    if (ban) return res.status(403).json({ error: ban.until ? `This account is banned until ${new Date(ban.until).toUTCString()}` : 'This account is banned', reason: ban.reason });

    if (player.totp_enabled) {
      if (!totpCode) return res.status(401).json({ error: 'Two-factor code required', requiresTotp: true });
      if (!totp.verifyTotp(player.totp_secret, totpCode)) {
        return res.status(401).json({ error: 'Invalid two-factor code', requiresTotp: true });
      }
    }

    const session = await db.createSession({ playerId: player.id, userAgent: req.headers['user-agent'], ip: clientIp(req) });
    await db.recordLoginEvent({ playerId: player.id, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json({
      token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
      player: await withEquippedCosmetics(player),
      sessionId: session.id,
    });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', requireDb, authenticate, async (req, res) => {
  try {
    // Revoke the refresh token application-side (best effort - a prototype-
    // grade action, not a hard security boundary) and drop our own
    // informational session record for the Settings "active sessions" list.
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) await supabaseAdmin.auth.admin.signOut(token).catch(() => {});
    if (req.body?.sessionId) await db.revokeSession(req.body.sessionId, req.tokenPlayer.id).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    console.error('[logout]', e);
    res.status(500).json({ error: 'Could not log out' });
  }
});

// Fresh sanitized player + cosmetics for the current session - used by the
// tutorial system to check tutorial_completed authoritatively rather than
// trusting the localStorage player cache, which predates this column for
// every account that logged in before the tutorial shipped.
app.get('/api/player/me', requireDb, authenticate, async (req, res) => {
  res.json(await withEquippedCosmetics(req.player));
});

app.post('/api/tutorial/complete', requireDb, authenticate, async (req, res) => {
  try {
    const updated = await db.updatePlayer(req.player.id, {
      tutorial_completed: true,
      tutorial_completed_at: new Date().toISOString(),
    });
    res.json({ success: true, player: await withEquippedCosmetics(updated) });
  } catch (e) {
    console.error('[tutorial complete]', e);
    res.status(500).json({ error: 'Could not save tutorial completion' });
  }
});

app.post('/api/auth/reset-password', authLimiter, requireDb, async (req, res) => {
  const { email } = req.body || {};
  if (email) {
    const origin = req.headers.origin || `http://localhost:${PORT}`;
    await supabaseAdmin.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/reset-password` }).catch((e) => {
      console.warn('[reset-password] send failed (not surfaced to caller):', e.message);
    });
  }
  // Always return success - never reveal whether an email exists.
  res.json({ message: 'Reset email sent if found' });
});

// OAuth (Google) sign-ins land here after supabaseClient.auth.getSession()
// resolves client-side. Finds the existing player for this Supabase user, or
// creates one on first sign-in - never overwrites stats for a returning
// OAuth user. Deliberately does NOT use the `authenticate` middleware: that
// middleware 401s when no player record exists yet, which is exactly the
// case this endpoint has to handle (a brand new OAuth user).
app.post('/api/auth/oauth-callback', authLimiter, requireDb, async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing auth token' });
    const {
      data: { user },
      error,
    } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });

    const existing = await db.getPlayerBySupabaseUserId(user.id);
    if (existing) return res.json({ player: await withEquippedCosmetics(existing) });

    const name = req.body?.name || user.user_metadata?.full_name || user.user_metadata?.name;
    const email = user.email;
    let baseUsername = (name || email?.split('@')[0] || 'trader').replace(/[^a-zA-Z0-9]/g, '').slice(0, 15) || 'trader';
    let username = baseUsername;
    let counter = 1;
    while (await db.getPlayerByUsername(username)) {
      username = `${baseUsername}${counter}`;
      counter += 1;
    }

    const player = await db.createPlayer({ username, email, supabaseUserId: user.id });
    await attachInvite(req, res, player);
    const session = await db.createSession({ playerId: player.id, userAgent: req.headers['user-agent'], ip: clientIp(req) });
    await db.recordLoginEvent({ playerId: player.id, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    await db.recordCoinTransaction({ playerId: player.id, type: 'welcome_bonus', amount: player.coins, balanceAfter: player.coins });
    sendWelcomeEmail(player);

    res.json({ player: await withEquippedCosmetics(player), isNew: true, sessionId: session.id });
  } catch (e) {
    console.error('[oauth-callback]', e);
    res.status(500).json({ error: 'Could not complete sign-in' });
  }
});

// The bare spikeandcrush.com is a forwarder that returns 404 for any path, so
// Discord must always send people back to the www host.
const DISCORD_REDIRECT_URI = `${String(process.env.SITE_URL || '').replace(/\/$/, '').replace('://spikeandcrush.com', '://www.spikeandcrush.com')}/api/discord/callback`;
// ---- discord -------------------------------------------------------------------
//
// /api/discord/connect is reached via a plain browser navigation
// (window.location.href from the Connect Discord button), not a fetch() call,
// so it can't carry an Authorization header the way the rest of the API does -
// the token travels as a query param instead and is verified the exact same
// way authenticate() verifies it, just for this one entry point. The real
// authenticate() middleware is intentionally left header-only everywhere else.
// Discord linking (audit item 27). The OAuth `state` is a random single-use
// value held server-side for 10 minutes and bound to the player who asked for
// it; it used to be the player's id (predictable, so anyone could link their
// Discord to someone else's account) and the Supabase access token was passed
// in the page URL (ending up in logs and browser history).
const discordStates = new Map(); // state -> { playerId, expires }
const DISCORD_STATE_TTL_MS = 10 * 60 * 1000;
function takeDiscordState(state) {
  const entry = state ? discordStates.get(state) : null;
  if (entry) discordStates.delete(state);
  for (const [k, v] of discordStates) if (v.expires < Date.now()) discordStates.delete(k);
  return entry && entry.expires > Date.now() ? entry.playerId : null;
}

app.post('/api/discord/connect-url', requireDb, authenticate, (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  discordStates.set(state, { playerId: req.tokenPlayer.id, expires: Date.now() + DISCORD_STATE_TTL_MS });
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.join',
    state,
  });
  res.json({ url: 'https://discord.com/oauth2/authorize?' + params.toString() });
});

// Old entry point (took the access token in the query string): no longer used.
app.get('/api/discord/connect', (req, res) => res.redirect('/settings?discord=error'));

app.get('/api/discord/callback', requireDb, async (req, res) => {
  const { code, state } = req.query;
  const playerId = takeDiscordState(state);
  if (!code || !playerId) return res.redirect('/settings?discord=error');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      signal: AbortSignal.timeout(10000),
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) throw new Error('No access token returned: ' + JSON.stringify(tokenData));

    const userRes = await fetch('https://discord.com/api/users/@me', {
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    const discordUser = await userRes.json();
    if (!discordUser.id) throw new Error('No Discord user id returned: ' + JSON.stringify(discordUser));

    // Adds them to the guild with the Member role pre-set. If they're
    // already a member, Discord's API leaves existing roles untouched here,
    // so the follow-up PUT below re-applies the role explicitly either way.
    const joinRes = await fetch(
      `https://discord.com/api/guilds/${process.env.DISCORD_SERVER_ID}/members/${discordUser.id}`,
      {
      signal: AbortSignal.timeout(10000),
        method: 'PUT',
        headers: {
          Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: accessToken, roles: [process.env.DISCORD_MEMBER_ROLE_ID] }),
      }
    );
    if (!joinRes.ok && joinRes.status !== 204) {
      console.warn('[discord callback] guild join responded', joinRes.status, await joinRes.text().catch(() => ''));
    }

    const roleRes = await fetch(
      `https://discord.com/api/guilds/${process.env.DISCORD_SERVER_ID}/members/${discordUser.id}/roles/${process.env.DISCORD_MEMBER_ROLE_ID}`,
      {
      signal: AbortSignal.timeout(10000), method: 'PUT', headers: { Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN } }
    );
    if (!roleRes.ok && roleRes.status !== 204) {
      console.warn('[discord callback] role assign responded', roleRes.status, await roleRes.text().catch(() => ''));
    }

    if (playerId) {
      await db.updatePlayer(playerId, {
        discord_id: discordUser.id,
        discord_username: discordUser.username,
        discord_joined: true,
      });
    }

    res.redirect('/settings?discord=connected&username=' + encodeURIComponent(discordUser.username || ''));
  } catch (err) {
    console.error('[discord callback]', err.message);
    res.redirect('/settings?discord=error');
  }
});

// ---- match ------------------------------------------------------------------

const MATCHMAKING_BY_MODE = {
  quick: (playerInfo) => matchmaking.quickPlay(gameEngine, playerInfo),
  blitz: (playerInfo) => matchmaking.blitzPlay(gameEngine, playerInfo),
  grand: (playerInfo) => matchmaking.grandPlay(gameEngine, playerInfo),
  solo: (playerInfo, body) => matchmaking.soloPlay(gameEngine, playerInfo, body?.instruments),
  async: (playerInfo) => matchmaking.asyncPlay(gameEngine, playerInfo),
  private: (playerInfo) => matchmaking.createPrivateWar(gameEngine, playerInfo),
};

// ---- match entry fees ---------------------------------------------------------------
// Charge first (unique key per attempt), then seat the player; if seating fails
// or they had already paid for that seat, refund that exact payment. Replaces
// "join, then debit", which let a failed debit leave a player seated unpaid.
async function chargeEntryFee(playerId, entryCoins, dbMatchId = null) {
  if (!(entryCoins > 0)) return { key: null };
  const key = `entry:${playerId}:${crypto.randomUUID()}`;
  await db.debitCoins(playerId, entryCoins, { type: 'match_entry', matchId: dbMatchId, idempotencyKey: key });
  return { key };
}
async function refundEntryFee(playerId, entryCoins, key, dbMatchId = null) {
  if (!key || !(entryCoins > 0)) return;
  try {
    await db.creditCoins(playerId, entryCoins, { type: 'match_refund', matchId: dbMatchId, idempotencyKey: `refund:${key}` });
  } catch (e) {
    console.error('[entry refund] failed for', playerId, key, e.message);
  }
}
function recordEntryPaid(matchId, playerId, key, entryCoins) {
  const seat = gameEngine.getMatch(matchId)?.players?.[playerId];
  if (!seat) return false;
  if (seat.entryPaidKey) return false; // already paid for this seat: caller refunds the new charge
  seat.entryPaidKey = key;
  return true;
}

app.post('/api/match/create', deployDrain.blockNewMatches, requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const mode = MATCHMAKING_BY_MODE[req.body?.mode] ? req.body.mode : 'private';
    const modeConfig = gameEngine.MATCH_MODES[mode];
    const entryCoins = modeConfig ? modeConfig.entryCoins : 0;

    if (entryCoins > 0 && player.coins < entryCoins) {
      return res.status(400).json({ error: `Not enough coins - ${modeConfig.label} costs ${entryCoins} coins` });
    }
    // Private War's 1-coin hosting fee isn't part of modeConfig.entryCoins
    // (that stays 0 so joining friends are never charged) - it's checked
    // here so a coinless player can't open a room they can't pay to start,
    // but actually charged later at match start (see gameEngine.activateMatch).
    if (mode === 'private' && player.coins < gameEngine.PRIVATE_WAR_HOST_FEE) {
      return res.status(400).json({ error: `Not enough coins - hosting a Private War costs ${gameEngine.PRIVATE_WAR_HOST_FEE} coin` });
    }

    if (mode === 'solo' && req.body?.instruments) {
      const invalid = req.body.instruments.filter((s) => !instrumentsRegistry.getInstrument(s));
      if (invalid.length) return res.status(400).json({ error: `Unknown instrument(s): ${invalid.join(', ')}` });
    }

    const playerInfo = {
      id: player.id,
      username: player.username,
      country: player.country,
      war_rating: player.war_rating,
      grand_war_rating: player.grand_war_rating,
      solo_rating: player.solo_rating,
      tier: player.tier,
    };
    let entry;
    try {
      entry = await chargeEntryFee(player.id, entryCoins);
    } catch (e) {
      if (e.code === 'INSUFFICIENT_COINS') return res.status(400).json({ error: `Not enough coins - ${modeConfig.label} costs ${entryCoins} coins` });
      throw e;
    }
    let result;
    try {
      result = await MATCHMAKING_BY_MODE[mode](playerInfo, req.body);
    } catch (e) {
      await refundEntryFee(player.id, entryCoins, entry.key);
      throw e;
    }
    if (!result.success) {
      await refundEntryFee(player.id, entryCoins, entry.key);
      return res.status(400).json(result);
    }
    if (entry.key && !recordEntryPaid(result.matchId, player.id, entry.key, entryCoins)) {
      await refundEntryFee(player.id, entryCoins, entry.key); // already seated and paid
    }
    res.json(result);
  } catch (e) {
    console.error('[match/create]', e);
    res.status(500).json({ error: 'Could not create match' });
  }
});

app.post('/api/match/join', requireDb, authenticate, async (req, res) => {
  try {
    const { roomCode } = req.body || {};
    if (!roomCode) return res.status(400).json({ error: 'roomCode is required' });
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const playerInfo = { id: player.id, username: player.username, war_rating: player.war_rating, tier: player.tier };
    const result = matchmaking.joinByRoomCode(gameEngine, roomCode, playerInfo);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[match/join]', e);
    res.status(500).json({ error: 'Could not join match' });
  }
});

app.get('/api/match/:id', (req, res) => {
  const match = gameEngine.getMatch(req.params.id);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  res.json(gameEngine.buildMatchStatePayloadFor(match, null));
});

app.get('/api/match/:id/history', (req, res) => {
  try {
    const history = gameEngine.getPreMatchHistory(req.params.id);
    if (!history) return res.status(404).json({ error: 'Match not found' });
    res.json(history);
  } catch (e) {
    console.error('[match history]', e);
    res.status(500).json({ error: 'Could not load pre-match history' });
  }
});

// ---- player -----------------------------------------------------------------

app.patch('/api/player/me', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const { currentPassword, username, email, newPassword } = req.body || {};
    if (!currentPassword) return res.status(400).json({ error: 'Current password is required to make changes' });
    if (!(await verifyPasswordViaSupabase(player.email, currentPassword))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const updates = {};

    if (username && username !== player.username) {
      if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(username)) {
        return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
      }
      const existing = await db.getPlayerByUsername(username);
      if (existing && existing.id !== player.id) return res.status(409).json({ error: 'Username already taken' });
      updates.username = username;
    }

    if (email && email !== player.email) {
      const existing = await db.getPlayerByEmail(email);
      if (existing && existing.id !== player.id) return res.status(409).json({ error: 'Email already registered' });
      if (player.supabase_user_id) {
        const { error: emailErr } = await supabaseAdmin.auth.admin.updateUserById(player.supabase_user_id, { email });
        if (emailErr) return res.status(400).json({ error: emailErr.message });
      }
      updates.email = email;
    }

    if (newPassword) {
      if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
      if (player.supabase_user_id) {
        const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(player.supabase_user_id, { password: newPassword });
        if (pwErr) return res.status(400).json({ error: pwErr.message });
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ player: sanitizePlayer(player) });
    }

    const updated = await db.updatePlayer(player.id, updates);
    res.json({ player: sanitizePlayer(updated) });
  } catch (e) {
    console.error('[player/me patch]', e);
    res.status(500).json({ error: 'Could not update profile' });
  }
});

app.delete('/api/player/me', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    // Google sign-ins have no password to check, so they confirm by typing their username.
    const providers = req.user?.app_metadata?.providers || [];
    if (providers.length && !providers.includes('email')) {
      if ((req.body?.password || '').trim() !== player.username) {
        return res.status(401).json({ error: 'Type your exact username to confirm' });
      }
    } else if (!(await verifyPasswordViaSupabase(player.email, req.body?.password || ''))) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    await db.deletePlayer(player.id);
    if (player.supabase_user_id) await supabaseAdmin.auth.admin.deleteUser(player.supabase_user_id).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    console.error('[player/me delete]', e);
    res.status(500).json({ error: 'Could not delete account' });
  }
});

app.get('/api/player/by-username/:username', requireDb, async (req, res) => {
  try {
    const player = await db.getPlayerByUsername(req.params.username);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const [history, bestMatchPnl, tradeStats] = await Promise.all([
      db.getPlayerMatchHistory(player.id, 10),
      db.getBestMatchPnl(player.id),
      db.getPlayerTradeStats(player.id),
    ]);
    const settings = player.settings || {};
    if (settings.showProfile === false) {
      return res.status(403).json({ error: 'This player has made their profile private' });
    }

    let friendStatus = null;
    let mutualFriendCount = 0;
    const viewerId = await optionalViewerId(req);
    if (viewerId && viewerId !== player.id) {
      const friendship = await db.getFriendshipBetween(viewerId, player.id);
      if (!friendship) friendStatus = 'none';
      else if (friendship.status === 'accepted') friendStatus = 'friends';
      else if (friendship.status === 'pending' && friendship.requester_id === viewerId) friendStatus = 'request_sent';
      else if (friendship.status === 'pending') friendStatus = 'request_received';
      else friendStatus = 'none';
      if (friendStatus !== 'friends') {
        const [myFriendIds, theirFriendIds] = await Promise.all([db.listFriendIds(viewerId), db.listFriendIds(player.id)]);
        const theirSet = new Set(theirFriendIds);
        mutualFriendCount = myFriendIds.filter((id) => theirSet.has(id)).length;
      }
    }
    const equipped = await db.getEquippedCosmetics(player.id);
    const equippedBySlot = {};
    for (const e of equipped) equippedBySlot[e.slot] = e.item_id;
    const enrichedHistory = await enrichMatchHistoryWithOpponents(history, player.id);

    res.json({
      player: sanitizePlayer(player),
      winRate:
        player.total_matches > 0
          ? Math.round(((player.wins + (player.draws || 0) * 0.5) / player.total_matches) * 1000) / 10
          : 0,
      favouriteInstrument: tradeStats.favouriteInstrument,
      bestMatchPnl: bestMatchPnl || 0,
      recentMatches: enrichedHistory,
      friendStatus,
      mutualFriendCount,
      presence: presence.getPresence(player.id),
      equippedCosmetics: equippedBySlot,
    });
  } catch (e) {
    console.error('[player by username]', e);
    res.status(500).json({ error: 'Could not load profile' });
  }
});

// ---- settings / avatar --------------------------------------------------------

app.get('/api/player/settings', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    res.json({
      settings: player.settings || {},
      avatarUrl: player.avatar_url,
      country: player.country,
      experienceLevel: player.experience_level || gameEngine.getExperienceLevel(player.total_matches),
    });
  } catch (e) {
    console.error('[settings get]', e);
    res.status(500).json({ error: 'Could not load settings' });
  }
});

// experienceLevel and preferredInstruments are no longer accepted here -
// trading experience is a computed stat based on total_matches (see
// gameEngine.updateExperienceLevel, updated after every match) and the
// preferred-instruments picker was removed from Settings entirely.
app.patch('/api/player/settings', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const { settings, country } = req.body || {};
    const updates = {};
    if (settings && typeof settings === 'object') updates.settings = { ...player.settings, ...settings };
    if (country !== undefined) updates.country = country;

    const updated = await db.updatePlayer(player.id, updates);
    res.json({
      settings: updated.settings,
      avatarUrl: updated.avatar_url,
      country: updated.country,
      experienceLevel: updated.experience_level || gameEngine.getExperienceLevel(updated.total_matches),
    });
  } catch (e) {
    console.error('[settings patch]', e);
    res.status(500).json({ error: 'Could not update settings' });
  }
});

const avatarUploadMw = (req, res, next) =>
  avatarUpload.single('avatar')(req, res, (err) => (err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Avatar must be 2 MB or smaller' : 'Upload failed' }) : next()));
app.post('/api/player/avatar', requireDb, authenticate, avatarUploadMw, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const check = validateAvatar(req.file.buffer);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const filename = `${req.tokenPlayer.id}-${Date.now()}.${check.ext}`;
    let avatarUrl = null;
    // Prefer Supabase Storage (survives redeploys; Railway's disk does not).
    if (db.isConfigured) {
      const { error: upErr } = await supabaseAdmin.storage
        .from(AVATAR_BUCKET)
        .upload(filename, req.file.buffer, { contentType: check.contentType, upsert: false, cacheControl: '31536000' });
      if (!upErr) avatarUrl = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(filename).data.publicUrl;
      else console.warn('[avatar upload] storage unavailable, using local disk:', upErr.message);
    }
    if (!avatarUrl) {
      fs.writeFileSync(path.join(AVATAR_DIR, filename), req.file.buffer);
      avatarUrl = `/uploads/avatars/${filename}`;
    }
    const updated = await db.updatePlayer(req.tokenPlayer.id, { avatar_url: avatarUrl });
    res.json({ avatarUrl: updated.avatar_url });
  } catch (e) {
    console.error('[avatar upload]', e);
    res.status(500).json({ error: 'Could not upload avatar' });
  }
});

// ---- security: sessions / login history / 2FA -----------------------------------

app.get('/api/player/sessions', requireDb, authenticate, async (req, res) => {
  try {
    const sessions = await db.listSessions(req.tokenPlayer.id);
    // Supabase Auth tokens carry no session id of our own to match against
    // anymore, so "current" is a heuristic: sessions are already ordered
    // most-recently-active first, and this endpoint's own request just
    // touched/created one, so the front of the list is a reasonable stand-in.
    res.json({
      sessions: sessions.map((s, i) => ({
        id: s.id,
        userAgent: s.user_agent,
        ip: s.ip,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        current: i === 0,
      })),
    });
  } catch (e) {
    console.error('[sessions list]', e);
    res.status(500).json({ error: 'Could not load sessions' });
  }
});

app.post('/api/player/sessions/:id/revoke', requireDb, authenticate, async (req, res) => {
  try {
    await db.revokeSession(req.params.id, req.tokenPlayer.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[session revoke]', e);
    res.status(500).json({ error: 'Could not revoke session' });
  }
});

app.get('/api/player/login-history', requireDb, authenticate, async (req, res) => {
  try {
    const history = await db.getLoginHistory(req.tokenPlayer.id, 10);
    res.json({ history });
  } catch (e) {
    console.error('[login history]', e);
    res.status(500).json({ error: 'Could not load login history' });
  }
});

app.post('/api/2fa/setup', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const secret = totp.generateSecret();
    await db.updatePlayer(player.id, { totp_secret: secret });
    const uri = totp.buildOtpAuthUri({ secret, accountName: player.username });
    const qrDataUrl = await QRCode.toDataURL(uri);
    res.json({ secret, otpauthUri: uri, qrDataUrl });
  } catch (e) {
    console.error('[2fa setup]', e);
    res.status(500).json({ error: 'Could not start 2FA setup' });
  }
});

app.post('/api/2fa/verify', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player || !player.totp_secret) return res.status(400).json({ error: 'Run 2FA setup first' });
    if (!totp.verifyTotp(player.totp_secret, req.body?.code)) return res.status(400).json({ error: 'Invalid code' });
    await db.updatePlayer(player.id, { totp_enabled: true });
    res.json({ success: true });
  } catch (e) {
    console.error('[2fa verify]', e);
    res.status(500).json({ error: 'Could not verify 2FA code' });
  }
});

app.post('/api/2fa/disable', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (!(await verifyPasswordViaSupabase(player.email, req.body?.password || ''))) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    if (!totp.verifyTotp(player.totp_secret, req.body?.code)) return res.status(400).json({ error: 'Invalid code' });
    await db.updatePlayer(player.id, { totp_enabled: false, totp_secret: null });
    res.json({ success: true });
  } catch (e) {
    console.error('[2fa disable]', e);
    res.status(500).json({ error: 'Could not disable 2FA' });
  }
});

// ---- privacy: block list --------------------------------------------------------

app.get('/api/player/blocks', requireDb, authenticate, async (req, res) => {
  try {
    const blocks = await db.listBlockedPlayers(req.tokenPlayer.id);
    res.json({
      blocks: blocks.map((b) => ({ id: b.blocked_player_id, username: b.players?.username, createdAt: b.created_at })),
    });
  } catch (e) {
    console.error('[blocks list]', e);
    res.status(500).json({ error: 'Could not load block list' });
  }
});

app.post('/api/player/blocks', requireDb, authenticate, async (req, res) => {
  try {
    const target = await db.getPlayerByUsername(req.body?.username || '');
    if (!target) return res.status(404).json({ error: 'Player not found' });
    if (target.id === req.tokenPlayer.id) return res.status(400).json({ error: 'You cannot block yourself' });
    await db.blockPlayer(req.tokenPlayer.id, target.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[block player]', e);
    res.status(500).json({ error: 'Could not block player' });
  }
});

app.delete('/api/player/blocks/:blockedId', requireDb, authenticate, async (req, res) => {
  try {
    await db.unblockPlayer(req.tokenPlayer.id, req.params.blockedId);
    res.json({ success: true });
  } catch (e) {
    console.error('[unblock player]', e);
    res.status(500).json({ error: 'Could not unblock player' });
  }
});

// Generic "get player by id" - registered after every literal /api/player/*
// route above so paths like /api/player/settings never get swallowed by the
// :id wildcard (Express matches routes in registration order, not by
// specificity).
app.get('/api/player/:id', requireDb, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.params.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const [history, bestMatchPnl, tradeStats] = await Promise.all([
      db.getPlayerMatchHistory(req.params.id, 10),
      db.getBestMatchPnl(req.params.id),
      db.getPlayerTradeStats(req.params.id),
    ]);

    // Friend status + mutual-friends social proof (Block 12, Part G) - only
    // meaningful when a logged-in viewer is looking at someone else's profile.
    let friendStatus = null;
    let mutualFriendCount = 0;
    const viewerId = await optionalViewerId(req);
    if (viewerId && viewerId !== req.params.id) {
      const friendship = await db.getFriendshipBetween(viewerId, req.params.id);
      if (!friendship) friendStatus = 'none';
      else if (friendship.status === 'accepted') friendStatus = 'friends';
      else if (friendship.status === 'pending' && friendship.requester_id === viewerId) friendStatus = 'request_sent';
      else if (friendship.status === 'pending') friendStatus = 'request_received';
      else friendStatus = 'none';
      if (friendStatus !== 'friends') {
        const [myFriendIds, theirFriendIds] = await Promise.all([db.listFriendIds(viewerId), db.listFriendIds(req.params.id)]);
        const theirSet = new Set(theirFriendIds);
        mutualFriendCount = myFriendIds.filter((id) => theirSet.has(id)).length;
      }
    }

    const equipped = await db.getEquippedCosmetics(req.params.id);
    const equippedBySlot = {};
    for (const e of equipped) equippedBySlot[e.slot] = e.item_id;
    const enrichedHistory = await enrichMatchHistoryWithOpponents(history, req.params.id);

    res.json({
      player: sanitizePlayer(player),
      winRate:
        player.total_matches > 0
          ? Math.round(((player.wins + (player.draws || 0) * 0.5) / player.total_matches) * 1000) / 10
          : 0,
      favouriteInstrument: tradeStats.favouriteInstrument,
      bestMatchPnl: bestMatchPnl || 0,
      recentMatches: enrichedHistory,
      friendStatus,
      mutualFriendCount,
      presence: presence.getPresence(req.params.id),
      equippedCosmetics: equippedBySlot,
    });
  } catch (e) {
    console.error('[player profile]', e);
    res.status(500).json({ error: 'Could not load profile' });
  }
});

// ---- friends (Block 12) ----------------------------------------------------------

app.get('/api/friends', requireDb, authenticate, async (req, res) => {
  try {
    const friends = await db.listFriends(req.tokenPlayer.id);
    const cosmeticsByPlayer = await db.getEquippedCosmeticsForPlayers(friends.map((f) => f.id));
    const withPresence = friends.map((f) => {
      const p = presence.getPresence(f.id);
      const cosmetics = cosmeticsByPlayer[f.id] || {};
      return {
        id: f.id,
        username: f.username,
        avatarUrl: f.avatar_url,
        warRating: f.war_rating,
        tier: f.tier,
        status: p.status,
        matchId: p.matchId,
        lobbyId: p.lobbyId,
        mode: p.mode,
        lastSeen: p.lastSeen,
        equipped_frame: cosmetics.avatar_frame || 'none',
        equipped_nameplate: cosmetics.nameplate || 'name_standard',
      };
    });
    res.json({ friends: withPresence });
  } catch (e) {
    console.error('[friends list]', e);
    res.status(500).json({ error: 'Could not load friends' });
  }
});

app.get('/api/friends/requests', requireDb, authenticate, async (req, res) => {
  try {
    const [incoming, outgoing] = await Promise.all([db.listIncomingRequests(req.tokenPlayer.id), db.listOutgoingRequests(req.tokenPlayer.id)]);
    res.json({
      incoming: incoming.map((r) => ({ requestId: r.id, playerId: r.requester.id, username: r.requester.username, tier: r.requester.tier, warRating: r.requester.war_rating, createdAt: r.created_at })),
      outgoing: outgoing.map((r) => ({ requestId: r.id, playerId: r.addressee.id, username: r.addressee.username, tier: r.addressee.tier, warRating: r.addressee.war_rating, createdAt: r.created_at })),
    });
  } catch (e) {
    console.error('[friends requests]', e);
    res.status(500).json({ error: 'Could not load friend requests' });
  }
});

app.post('/api/friends/request', requireDb, authenticate, async (req, res) => {
  try {
    const requesterId = req.tokenPlayer.id;
    const targetId = req.body?.targetId;
    if (!targetId || targetId === requesterId) return res.status(400).json({ error: 'Invalid target' });
    const targetPlayer = await db.getPlayerById(targetId);
    if (!targetPlayer || targetPlayer.is_persona) return res.status(404).json({ error: 'Player not found' });
    const existing = await db.getFriendshipBetween(requesterId, targetId);
    if (existing) {
      const msg = existing.status === 'accepted' ? 'Already friends' : existing.status === 'blocked' ? 'Unable to send request' : 'Request already pending';
      return res.status(400).json({ error: msg });
    }
    const requester = await db.getPlayerById(requesterId);
    const row = await db.sendFriendRequest(requesterId, targetId);
    notifyPlayer(targetId, 'friend_request', `${requester.username} sent you a friend request`, {
      fromPlayerId: requesterId,
      data: { requestId: row.id, username: requester.username, tier: requester.tier },
    });
    const targetSockets = playerSockets.get(targetId);
    if (targetSockets) {
      for (const sid of targetSockets) {
        io.to(sid).emit('friend:request_received', { requestId: row.id, fromPlayerId: requesterId, username: requester.username, tier: requester.tier, warRating: requester.war_rating });
      }
    }
    res.json({ success: true, requestId: row.id });
  } catch (e) {
    console.error('[friend request]', e);
    res.status(500).json({ error: 'Could not send request' });
  }
});

// Lightweight post-match "good sportsmanship" signal from the results
// screen - not exposed anywhere else (no public like/dislike counts, no
// leaderboard), just a thumbs up/down tied to a specific match. Personas
// excluded same as friend requests - rating a bot isn't a real signal.
app.post('/api/players/rate', requireDb, authenticate, async (req, res) => {
  try {
    const raterId = req.tokenPlayer.id;
    const { targetId, matchId, rating } = req.body || {};
    if (!targetId || targetId === raterId) return res.status(400).json({ error: 'Invalid target' });
    if (rating !== 'like' && rating !== 'dislike') return res.status(400).json({ error: 'rating must be "like" or "dislike"' });
    const targetPlayer = await db.getPlayerById(targetId);
    if (!targetPlayer || targetPlayer.is_persona) return res.status(404).json({ error: 'Player not found' });
    await db.rateTrader(raterId, targetId, matchId || null, rating);
    res.json({ success: true });
  } catch (e) {
    console.error('[players/rate]', e);
    res.status(500).json({ error: 'Could not submit rating' });
  }
});

app.post('/api/friends/:requestId/accept', requireDb, authenticate, async (req, res) => {
  try {
    const row = await db.acceptFriendRequest(req.params.requestId, req.tokenPlayer.id);
    const accepter = await db.getPlayerById(req.tokenPlayer.id);
    // The acceptor's own 'friend_request' notification for this request is
    // done being actionable - mark it read regardless of whether they
    // accepted from the bell's inline button or the Friends panel directly.
    db.markFriendRequestNotificationRead(req.tokenPlayer.id, req.params.requestId).catch((e) => console.error('[friend accept] could not mark notification read:', e.message));
    notifyPlayer(row.requester_id, 'friend_accepted', `${accepter.username} accepted your friend request`, {
      fromPlayerId: req.tokenPlayer.id,
      data: { username: accepter.username },
    });
    const requesterSockets = playerSockets.get(row.requester_id);
    if (requesterSockets) {
      for (const sid of requesterSockets) io.to(sid).emit('friend:accepted', { playerId: accepter.id, username: accepter.username });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[friend accept]', e);
    res.status(500).json({ error: 'Could not accept request' });
  }
});

app.post('/api/friends/:requestId/decline', requireDb, authenticate, async (req, res) => {
  try {
    await db.declineFriendRequest(req.params.requestId, req.tokenPlayer.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[friend decline]', e);
    res.status(500).json({ error: 'Could not decline request' });
  }
});

app.delete('/api/friends/:friendId', requireDb, authenticate, async (req, res) => {
  try {
    await db.removeFriend(req.tokenPlayer.id, req.params.friendId);
    res.json({ success: true });
  } catch (e) {
    console.error('[friend remove]', e);
    res.status(500).json({ error: 'Could not remove friend' });
  }
});

app.get('/api/players/search', requireDb, authenticate, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ players: [] });
    const results = await db.searchPlayers(q, req.tokenPlayer.id, 10);
    res.json({ players: results.map((p) => ({ id: p.id, username: p.username, avatarUrl: p.avatar_url, warRating: p.war_rating, tier: p.tier })) });
  } catch (e) {
    console.error('[players search]', e);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ---- notifications (Block 12 - persisted history for the bell) -------------------

app.get('/api/notifications', requireDb, authenticate, async (req, res) => {
  try {
    const [list, unreadCount] = await Promise.all([db.listNotifications(req.tokenPlayer.id, 30), db.countUnreadNotifications(req.tokenPlayer.id)]);
    res.json({
      notifications: list.map((n) => ({
        id: n.id,
        type: n.type,
        fromPlayerId: n.from_player_id,
        fromUsername: n.from_player?.username,
        data: n.data,
        read: n.read,
        createdAt: n.created_at,
      })),
      unreadCount,
    });
  } catch (e) {
    console.error('[notifications list]', e);
    res.status(500).json({ error: 'Could not load notifications' });
  }
});

app.post('/api/notifications/read', requireDb, authenticate, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    await db.markNotificationsRead(req.tokenPlayer.id, ids);
    res.json({ success: true });
  } catch (e) {
    console.error('[notifications read]', e);
    res.status(500).json({ error: 'Could not mark notifications read' });
  }
});

app.delete('/api/notifications', requireDb, authenticate, async (req, res) => {
  try {
    await db.deleteAllNotifications(req.tokenPlayer.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[notifications clear]', e);
    res.status(500).json({ error: 'Could not clear notifications' });
  }
});

// ---- cards -----------------------------------------------------------------------

app.get('/api/cards', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const stats = await db.getCardPlayStats(player.id);
    const catalog = sabotage.getCardCatalog();
    const variant = player.wins >= 200 ? 'gold' : player.wins >= 50 ? 'silver' : 'standard';
    const cards = catalog.map((c) => ({
      ...c,
      variant,
      timesPlayed: stats.playedByMe[c.id] || 0,
      timesPlayedAgainstYou: stats.playedAgainstMe[c.id] || 0,
    }));
    const nextUnlock =
      player.wins < 50
        ? { variant: 'silver', winsNeeded: 50 - player.wins }
        : player.wins < 200
        ? { variant: 'gold', winsNeeded: 200 - player.wins }
        : null;
    res.json({ cards, wins: player.wins, currentVariant: variant, nextUnlock });
  } catch (e) {
    console.error('[cards]', e);
    res.status(500).json({ error: 'Could not load cards' });
  }
});

app.get('/api/cards/deck', requireDb, authenticate, async (req, res) => {
  try {
    const deck = await db.getCardDeck(req.tokenPlayer.id);
    res.json({ cardTypes: deck ? deck.card_types : [] });
  } catch (e) {
    console.error('[deck get]', e);
    res.status(500).json({ error: 'Could not load deck' });
  }
});

// ---- lobby loadout panel (Block 12, Part D) --------------------------------------

app.get('/api/loadout/mystats', requireDb, authenticate, async (req, res) => {
  try {
    const playerId = req.tokenPlayer.id;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const season = battlepass.currentSeason();
    const [player, weekStats, tradeStats, bestMatchPnl, winStreak, bpStatus] = await Promise.all([
      db.getPlayerById(playerId),
      db.getPlayerWinRateSince(playerId, weekAgo),
      db.getPlayerTradeStats(playerId),
      db.getBestMatchPnl(playerId),
      db.getPlayerWinStreak(playerId),
      db.ensureBattlePassStatus(playerId, season),
    ]);
    res.json({
      warRating: player.war_rating,
      tier: tierForRating(player.war_rating),
      winRateThisWeek: weekStats.winRate,
      matchesThisWeek: weekStats.matches,
      favouriteInstrument: tradeStats.favouriteInstrument,
      bestMatchPnl: bestMatchPnl || 0,
      winStreak,
      battlePassTier: bpStatus.tier_current,
      battlePassMaxTier: 30,
    });
  } catch (e) {
    console.error('[loadout mystats]', e);
    res.status(500).json({ error: 'Could not load stats' });
  }
});

// ---- shop -------------------------------------------------------------------

app.get('/api/shop/catalog', requireDb, authenticate, async (req, res) => {
  try {
    const [owned, equipped, player] = await Promise.all([
      db.listShopPurchases(req.tokenPlayer.id),
      db.getEquippedCosmetics(req.tokenPlayer.id),
      db.getPlayerById(req.tokenPlayer.id),
    ]);
    const ownedIds = new Set(owned.map((o) => o.item_id));
    const equippedBySlot = {};
    for (const e of equipped) equippedBySlot[e.slot] = e.item_id;

    res.json({
      catalog: shop.getCatalog(),
      ownedItemIds: Array.from(ownedIds),
      equipped: equippedBySlot,
      coins: player.coins,
      tier: tierForRating(player.war_rating),
    });
  } catch (e) {
    console.error('[shop catalog]', e);
    res.status(500).json({ error: 'Could not load shop' });
  }
});

app.post('/api/shop/purchase', requireDb, authenticate, async (req, res) => {
  try {
    const { itemId } = req.body || {};
    const item = shop.findItem(itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item' });

    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (item.requiresTier && tierForRating(player.war_rating) !== item.requiresTier) {
      return res.status(403).json({ error: `Requires ${item.requiresTier} tier` });
    }
    // One atomic call: own once, pay once (a double click can't buy or charge twice).
    const result = await db.shopBuy({ playerId: player.id, itemType: item.type, itemId: item.id, price: item.price });
    if (result?.error === 'already_owned') return res.status(400).json({ error: 'Already owned' });
    if (result?.error === 'insufficient_coins') {
      return res.status(400).json({ error: 'Not enough coins', required: item.price, balance: result.balance });
    }
    if (!result?.ok) throw new Error(result?.error || 'shop_buy failed');
    notifyPlayer(player.id, 'shop_purchase', `Purchased ${item.name}!`);
    res.json({ success: true, item });
  } catch (e) {
    console.error('[shop purchase]', e);
    res.status(500).json({ error: 'Could not complete purchase' });
  }
});

app.post('/api/shop/equip', requireDb, authenticate, async (req, res) => {
  try {
    const { itemId } = req.body || {};
    const item = shop.findItem(itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item' });
    const slot = shop.SLOT_BY_TYPE[item.type];
    if (!slot) return res.status(400).json({ error: 'This item type is not equippable' });

    const owned = await db.listShopPurchases(req.tokenPlayer.id);
    const isFree = item.price === 0;
    if (!isFree && !owned.some((o) => o.item_id === itemId)) return res.status(403).json({ error: 'You do not own this item' });

    await db.equipCosmetic(req.tokenPlayer.id, slot, itemId);
    res.json({ success: true });
  } catch (e) {
    console.error('[shop equip]', e);
    res.status(500).json({ error: 'Could not equip item' });
  }
});

// ---- battle pass ------------------------------------------------------------

async function grantBattlePassXp(playerId, season, xpGained) {
  const before = await db.ensureBattlePassStatus(playerId, season);
  const oldTier = battlepass.tierFromXp(before.xp_current);
  const newXp = before.xp_current + xpGained;
  const newTier = battlepass.tierFromXp(newXp);
  await db.addBattlePassXp(playerId, season, xpGained, newTier);
  if (newTier > oldTier) {
    const track = battlepass.buildTrack(newTier, before.is_premium);
    let tierCoins = 0;
    for (const entry of track) {
      if (entry.tier <= oldTier || entry.tier > newTier) continue;
      if (entry.freeReward?.coins) tierCoins += entry.freeReward.coins;
      if (entry.premiumReward?.coins) tierCoins += entry.premiumReward.coins;
    }
    if (tierCoins > 0) await db.creditCoins(playerId, tierCoins, { type: 'battlepass_tier', idempotencyKey: `bp_tier:${playerId}:${season}:${oldTier}-${newTier}` });
  }
  return newTier;
}

app.get('/api/battlepass/status', requireDb, authenticate, async (req, res) => {
  try {
    const season = battlepass.currentSeason();
    const [status, player, completed, stats] = await Promise.all([
      db.ensureBattlePassStatus(req.tokenPlayer.id, season),
      db.getPlayerById(req.tokenPlayer.id),
      db.listCompletedChallenges(req.tokenPlayer.id, season),
      db.getBattlePassChallengeStats(req.tokenPlayer.id, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
    ]);
    const dailyStats = await db.getBattlePassChallengeStats(req.tokenPlayer.id, new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const completedIds = completed.map((c) => c.challenge_id);
    const dailyIds = new Set(battlepass.DAILY_CHALLENGES.map((c) => c.id));
    const evalDaily = battlepass.evaluateChallenges(dailyStats, completedIds).daily;
    const evalWeekly = battlepass.evaluateChallenges(stats, completedIds).weekly;

    res.json({
      season,
      xp: status.xp_current,
      tier: status.tier_current,
      xpIntoTier: status.xp_current % battlepass.XP_PER_TIER,
      xpPerTier: battlepass.XP_PER_TIER,
      isPremium: status.is_premium,
      expiresAt: status.expires_at,
      coins: player.coins,
      track: battlepass.buildTrack(status.tier_current, status.is_premium),
      dailyChallenges: evalDaily,
      weeklyChallenges: evalWeekly,
    });
  } catch (e) {
    console.error('[battlepass status]', e);
    res.status(500).json({ error: 'Could not load battle pass' });
  }
});

app.post('/api/battlepass/challenge/claim', requireDb, authenticate, async (req, res) => {
  try {
    const { challengeId } = req.body || {};
    const all = [...battlepass.DAILY_CHALLENGES, ...battlepass.WEEKLY_CHALLENGES];
    const challenge = all.find((c) => c.id === challengeId);
    if (!challenge) return res.status(404).json({ error: 'Unknown challenge' });

    const season = battlepass.currentSeason();
    const isDaily = battlepass.DAILY_CHALLENGES.some((c) => c.id === challengeId);
    const sinceIso = isDaily
      ? new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const completed = await db.listCompletedChallenges(req.tokenPlayer.id, season);
    if (completed.some((c) => c.challenge_id === challengeId)) {
      return res.status(400).json({ error: 'Already claimed' });
    }
    const stats = await db.getBattlePassChallengeStats(req.tokenPlayer.id, sinceIso);
    const checker = battlepass.CHALLENGE_CHECKS[challengeId];
    if (!checker || !checker(stats)) {
      return res.status(400).json({ error: 'Challenge not yet completed' });
    }

    await db.recordChallengeCompletion({
      playerId: req.tokenPlayer.id,
      season,
      challengeId,
      challengeType: isDaily ? 'daily' : 'weekly',
      coinsEarned: challenge.coins,
    });
    await db.creditCoins(req.tokenPlayer.id, challenge.coins, { type: 'battlepass_challenge', idempotencyKey: `bp_challenge:${req.tokenPlayer.id}:${season}:${challengeId}:${sinceIso}` });
    const newTier = await grantBattlePassXp(req.tokenPlayer.id, season, Math.round(challenge.coins / 5));
    res.json({ success: true, coinsAwarded: challenge.coins, tier: newTier });
  } catch (e) {
    console.error('[battlepass claim]', e);
    res.status(500).json({ error: 'Could not claim challenge' });
  }
});

// ---- replays / clips --------------------------------------------------------------

app.get('/api/replay/:matchId', requireDb, authenticate, async (req, res) => {
  try {
    const [replay, match] = await Promise.all([db.getReplay(req.params.matchId), db.getMatch(req.params.matchId)]);
    if (!replay || !match) return res.status(404).json({ error: 'Replay not found' });
    const duration =
      match.end_time && match.start_time ? Math.round((new Date(match.end_time) - new Date(match.start_time)) / 1000) : 0;
    res.json({
      matchId: match.id,
      mode: match.mode,
      instruments: match.instruments || [match.instrument_1, match.instrument_2].filter(Boolean),
      startTime: match.start_time,
      endTime: match.end_time,
      duration,
      eventLog: replay.event_log,
      priceData: replay.price_data,
      players: replay.players || [],
      pnlSnapshots: replay.pnl_snapshots || {},
    });
  } catch (e) {
    console.error('[replay get]', e);
    res.status(500).json({ error: 'Could not load replay' });
  }
});

app.post('/api/clip', requireDb, authenticate, async (req, res) => {
  try {
    const { matchId, startSecond, endSecond, caption } = req.body || {};
    const replay = await db.getReplay(matchId);
    if (!replay) return res.status(404).json({ error: 'No replay found for this match' });
    if (!Number.isFinite(startSecond) || !Number.isFinite(endSecond) || endSecond <= startSecond) {
      return res.status(400).json({ error: 'Invalid clip range' });
    }
    const clip = await db.createClip({
      matchId,
      playerId: req.tokenPlayer.id,
      startSecond: Math.round(startSecond),
      endSecond: Math.round(endSecond),
      caption: (caption || '').slice(0, 200),
    });
    res.json({ clip });
  } catch (e) {
    console.error('[clip create]', e);
    res.status(500).json({ error: 'Could not create clip' });
  }
});

app.get('/api/clip/:id', requireDb, authenticate, async (req, res) => {
  try {
    const clip = await db.getClip(req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    const [replay, match] = await Promise.all([db.getReplay(clip.match_id), db.getMatch(clip.match_id)]);
    res.json({
      id: clip.id,
      matchId: clip.match_id,
      startSecond: clip.start_second,
      endSecond: clip.end_second,
      caption: clip.caption,
      shareCount: clip.share_count,
      authorUsername: clip.players?.username,
      mode: match?.mode,
      instruments: match?.instruments,
      matchStartTime: match?.start_time,
      eventLog: replay?.event_log || [],
      priceData: replay?.price_data || {},
    });
  } catch (e) {
    console.error('[clip get]', e);
    res.status(500).json({ error: 'Could not load clip' });
  }
});

app.post('/api/clip/:id/share', requireDb, authenticate, async (req, res) => {
  try {
    await db.incrementClipShareCount(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[clip share]', e);
    res.status(500).json({ error: 'Could not record share' });
  }
});

// ---- competition hub ---------------------------------------------------------------
// Public listings for client/competitions.html: Spike & Crush native events,
// prop-firm challenges (external - entered on the firm's own site) and
// broker-sponsored tournaments. Status is derived from starts_at/ends_at on
// every read so nothing has to flip it on a schedule.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function competitionStatus(c, now = Date.now()) {
  if (now < new Date(c.starts_at).getTime()) return 'upcoming';
  if (now < new Date(c.ends_at).getTime()) return 'active';
  return 'ended';
}

// `status` is the hub's date-based upcoming/active/ended; a voided native
// competition shows as ended. `lifecycle` is the engine's own status.
function competitionSummary(c) {
  const { is_published, click_count, last_tick_at, last_tick_data_time, notices_sent, data_window_start, ...rest } = c;
  return { ...rest, status: c.status === 'void' ? 'ended' : competitionStatus(c), lifecycle: c.status };
}

// compEngine throws errors carrying an HTTP status for anything the player
// did wrong; anything without one is a real server error.
function sendCompError(res, e, label) {
  if (e.status) return res.status(e.status).json({ error: e.message });
  console.error(`[${label}]`, e);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// A malformed id would otherwise surface as a Postgres uuid cast error (500).
function requireCompetitionId(req, res, next) {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Competition not found' });
  next();
}

// ---- micro-cache for public, non-personal JSON endpoints (audit items 19/47/48)
// These answered at 18-46 req/s with multi-second tails because every request
// made several Supabase round trips. Each URL is now computed at most once per
// TTL, and concurrent misses share one in-flight computation (no stampede).
const microCache = new Map(); // url -> { at, status, body }
const microInflight = new Map(); // url -> Promise<{status, body} | null>
function cacheJson(ttlMs) {
  return async (req, res, next) => {
    const key = req.originalUrl;
    const hit = microCache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) {
      res.set('X-Cache', 'HIT');
      return res.status(hit.status).json(hit.body);
    }
    const pending = microInflight.get(key);
    if (pending) {
      const shared = await pending;
      if (shared) {
        res.set('X-Cache', 'SHARED');
        return res.status(shared.status).json(shared.body);
      }
      return next();
    }
    let settle;
    microInflight.set(key, new Promise((r) => { settle = r; }));
    const finish = (val) => { microInflight.delete(key); settle(val); };
    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        microCache.set(key, { at: Date.now(), status: res.statusCode, body });
        if (microCache.size > 500) microCache.delete(microCache.keys().next().value);
        finish({ status: res.statusCode, body });
      } else finish(null);
      res.set('X-Cache', 'MISS');
      return origJson(body);
    };
    res.on('close', () => { if (microInflight.has(key)) finish(null); });
    next();
  };
}

app.get('/api/competitions', cacheJson(10000), requireDb, async (req, res) => {
  try {
    const rows = await db.listPublishedCompetitions();
    res.json({ competitions: rows.map(competitionSummary) });
  } catch (e) {
    console.error('[competitions list]', e);
    res.status(500).json({ error: 'Could not load competitions' });
  }
});

app.get('/api/competitions/:id', requireDb, requireCompetitionId, async (req, res) => {
  try {
    const c = await db.getPublishedCompetition(req.params.id);
    if (!c) return res.status(404).json({ error: 'Competition not found' });
    res.json(competitionSummary(c));
  } catch (e) {
    console.error('[competition detail]', e);
    res.status(500).json({ error: 'Could not load competition' });
  }
});

// Fire-and-forget CTA click counter - never fails the caller.
app.post('/api/competitions/:id/click', clickLimiter, requireDb, requireCompetitionId, async (req, res) => {
  try {
    await db.incrementCompetitionClicks(req.params.id);
  } catch (e) {
    console.error('[competition click]', e.message);
  }
  res.json({ success: true });
});

// Native competitions: one atomic call charges the fee once and creates the
// trading account (comp_enter) - calling it again is a no-op, never a
// second charge.
app.post('/api/competitions/:id/enter', requireDb, requireCompetitionId, authenticate, async (req, res) => {
  try {
    const result = await compEngine.enter(req.params.id, req.tokenPlayer.id);
    res.json({ success: true, ...result, playUrl: `/competition/${req.params.id}` });
  } catch (e) {
    sendCompError(res, e, 'competition enter');
  }
});

// Competition ids the caller has an account in, plus a live summary of each
// one still running (home screen "My Competitions" strip, hub Continue buttons).
app.get('/api/competitions-mine', requireDb, authenticate, async (req, res) => {
  try {
    const accounts = await db.listPlayerCompAccounts(req.tokenPlayer.id);
    const mine = [];
    for (const a of accounts) {
      const c = a.competition;
      if (!c) continue;
      const row = { competitionId: c.id, title: c.title, frequency: c.frequency, status: c.status, startsAt: c.starts_at, endsAt: c.ends_at, equity: Number(a.equity), startingCapital: Number(a.starting_capital), accountStatus: a.status, finalRank: a.final_rank };
      if (c.status === 'active') {
        const lb = await compEngine.getLeaderboard(c.id, req.tokenPlayer.id);
        row.rank = lb.me?.rank || null;
        row.entrants = lb.entrants;
      }
      mine.push(row);
    }
    res.json({ competitions: mine });
  } catch (e) {
    sendCompError(res, e, 'competitions mine');
  }
});

app.get('/api/competitions/:id/account', requireDb, requireCompetitionId, authenticate, async (req, res) => {
  try {
    res.json(await compEngine.getAccountView(req.params.id, req.tokenPlayer.id));
  } catch (e) {
    sendCompError(res, e, 'competition account');
  }
});

app.post('/api/competitions/:id/trade/open', requireDb, requireCompetitionId, authenticate, async (req, res) => {
  try {
    const { symbol, side, lots, stopLoss, takeProfit } = req.body || {};
    res.json({ success: true, ...(await compEngine.openTrade(req.params.id, req.tokenPlayer.id, { symbol, side, lots, stopLoss, takeProfit })) });
  } catch (e) {
    sendCompError(res, e, 'competition trade open');
  }
});

app.post('/api/competitions/:id/trade/close', requireDb, requireCompetitionId, authenticate, async (req, res) => {
  try {
    res.json({ success: true, ...(await compEngine.closeTrade(req.params.id, req.tokenPlayer.id, req.body?.positionId)) });
  } catch (e) {
    sendCompError(res, e, 'competition trade close');
  }
});

app.post('/api/competitions/:id/trade/modify', requireDb, requireCompetitionId, authenticate, async (req, res) => {
  try {
    const { positionId, stopLoss, takeProfit } = req.body || {};
    res.json({ success: true, ...(await compEngine.modifyTrade(req.params.id, req.tokenPlayer.id, positionId, { stopLoss, takeProfit })) });
  } catch (e) {
    sendCompError(res, e, 'competition trade modify');
  }
});

app.get('/api/competitions/:id/leaderboard', requireDb, requireCompetitionId, authenticate, async (req, res) => {
  try {
    res.json(await compEngine.getLeaderboard(req.params.id, req.tokenPlayer.id));
  } catch (e) {
    sendCompError(res, e, 'competition leaderboard');
  }
});

// Competition chart history - only bars up to the competition's current
// market time (never ahead of it), entrants only.
app.get('/api/chart-data/:symbol', requireDb, authenticate, async (req, res) => {
  try {
    const { compId } = req.query;
    if (!compId || !UUID_RE.test(compId)) return res.status(400).json({ error: 'compId is required' });
    res.json(await compEngine.getChartData(compId, req.tokenPlayer.id, req.params.symbol));
  } catch (e) {
    sendCompError(res, e, 'chart data');
  }
});

// ---- tournament unlock gate -------------------------------------------------------
// The tournament system below (create/list/register/play) is fully working
// and pre-dates this gate - this just lets an admin show a "Coming Soon"
// state in front of it (client/tournaments.html) until a target player count
// or a manual toggle turns it on. Public (no auth) since the client checks
// this before it even knows if the visitor is logged in.

app.get('/api/tournaments/status', async (req, res) => {
  try {
    if (!db.isConfigured) return res.json({ enabled: true, unlockAt: null, currentPlayers: 0, targetPlayers: 500 });
    const settings = await db.getAppSettings(['tournaments_enabled', 'tournaments_unlock_at', 'tournaments_unlock_player_target']);
    const currentPlayers = await db.getTotalPlayerCount();
    res.json({
      enabled: Boolean(settings.tournaments_enabled),
      unlockAt: settings.tournaments_unlock_at || null,
      currentPlayers,
      targetPlayers: Number(settings.tournaments_unlock_player_target) || 500,
    });
  } catch (e) {
    console.error('[tournaments status]', e);
    res.json({ enabled: true, unlockAt: null, currentPlayers: 0, targetPlayers: 500 });
  }
});

// ---- tournaments ----------------------------------------------------------------

function tournamentSummary(t, registrationCount) {
  return {
    id: t.id,
    name: t.name,
    bracketSize: t.bracket_size,
    entryCoins: t.entry_coins,
    status: t.status,
    startsAt: t.starts_at,
    prizePoolCoins: t.prize_pool_coins,
    registrationCount: registrationCount ?? undefined,
  };
}

// Lazily closes signup once the bracket fills or the 24h signup window
// expires - there's no cron/scheduler in this app, so any read of a
// 'signup'-status tournament checks and transitions it first.
async function checkAndCloseSignup(t) {
  if (t.status !== 'signup') return t;
  const regs = await db.listTournamentRegistrations(t.id);

  if (tournament.isRegistrationFull(t.bracket_size, regs.length)) {
    const bracketData = tournament.buildBracket(t.bracket_size, regs.map((r) => r.player_id));
    const prizePool = Math.round(t.entry_coins * regs.length * 0.85);
    return db.updateTournament(t.id, { status: 'active', bracket_data: bracketData, prize_pool_coins: prizePool });
  }

  if (Date.now() >= new Date(t.starts_at).getTime()) {
    for (const r of regs) {
      if (t.entry_coins > 0) await db.creditCoins(r.player_id, t.entry_coins, { type: 'tournament_refund', idempotencyKey: `tournament_cancel_refund:${t.id}:${r.player_id}` });
    }
    return db.updateTournament(t.id, { status: 'cancelled' });
  }

  return t;
}

app.post('/api/tournament/create', requireDb, authenticate, async (req, res) => {
  try {
    const { name, bracketSize, entryCoins } = req.body || {};
    if (!tournament.BRACKET_SIZES.includes(bracketSize)) {
      return res.status(400).json({ error: `bracketSize must be one of ${tournament.BRACKET_SIZES.join(', ')}` });
    }
    const t = await db.createTournament({
      name: name || `${bracketSize}-Player Tournament`,
      bracketSize,
      entryCoins: Math.max(0, Number(entryCoins) || 0),
      startsAt: new Date(Date.now() + tournament.SIGNUP_WINDOW_MS).toISOString(),
    });
    res.json({ tournament: tournamentSummary(t, 0) });
  } catch (e) {
    console.error('[tournament create]', e);
    res.status(500).json({ error: 'Could not create tournament' });
  }
});

app.get('/api/tournaments', requireDb, authenticate, async (req, res) => {
  try {
    const list = await db.listTournaments();
    const withCounts = await Promise.all(
      list.map(async (t) => {
        const checked = await checkAndCloseSignup(t);
        const regs = await db.listTournamentRegistrations(checked.id);
        return tournamentSummary(checked, regs.length);
      })
    );
    res.json({ tournaments: withCounts });
  } catch (e) {
    console.error('[tournaments list]', e);
    res.status(500).json({ error: 'Could not load tournaments' });
  }
});

app.get('/api/tournament/:id', requireDb, authenticate, async (req, res) => {
  try {
    let t = await db.getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tournament not found' });
    t = await checkAndCloseSignup(t);
    const regs = await db.listTournamentRegistrations(t.id);
    const myReg = regs.find((r) => r.player_id === req.tokenPlayer.id);

    let myMatchup = null;
    if (myReg && t.bracket_data) {
      const roundData = t.bracket_data.rounds.find((r) => r.round === myReg.current_round);
      myMatchup = roundData?.matchups.find(
        (m) =>
          (m.playerAId === req.tokenPlayer.id || m.playerBId === req.tokenPlayer.id) &&
          m.status !== 'completed' &&
          m.status !== 'bye' &&
          m.status !== 'void'
      ) || null;
    }

    res.json({
      ...tournamentSummary(t, regs.length),
      bracketData: t.bracket_data,
      registrations: regs.map((r) => ({ playerId: r.player_id, username: r.username, seed: r.seed, currentRound: r.current_round, eliminatedAt: r.eliminated_at, finalRank: r.final_rank })),
      isRegistered: !!myReg,
      myMatchup,
    });
  } catch (e) {
    console.error('[tournament get]', e);
    res.status(500).json({ error: 'Could not load tournament' });
  }
});

app.post('/api/tournament/:id/register', requireDb, authenticate, async (req, res) => {
  try {
    let t = await db.getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tournament not found' });
    t = await checkAndCloseSignup(t);
    if (t.status !== 'signup') return res.status(400).json({ error: 'Registration is closed for this tournament' });

    const regs = await db.listTournamentRegistrations(t.id);
    if (regs.some((r) => r.player_id === req.tokenPlayer.id)) return res.status(400).json({ error: 'Already registered' });
    if (regs.length >= t.bracket_size) return res.status(400).json({ error: 'Tournament is full' });

    const player = await db.getPlayerById(req.tokenPlayer.id);
    // Charge with a per-attempt key, then register; the (tournament, player)
    // unique constraint stops a double click registering twice, and the losing
    // attempt's charge is refunded exactly once.
    let entryKey = null;
    if (t.entry_coins > 0) {
      entryKey = `tournament_entry:${t.id}:${player.id}:${crypto.randomUUID()}`;
      try {
        await db.debitCoins(player.id, t.entry_coins, { type: 'tournament_entry', idempotencyKey: entryKey });
      } catch (e) {
        if (e.code === 'INSUFFICIENT_COINS') return res.status(400).json({ error: 'Not enough coins' });
        throw e;
      }
    }
    try {
      await db.registerForTournament({ tournamentId: t.id, playerId: player.id, seed: regs.length + 1 });
    } catch (e) {
      if (entryKey) await db.creditCoins(player.id, t.entry_coins, { type: 'tournament_refund', idempotencyKey: `refund:${entryKey}` }).catch((err) => console.error('[tournament register] refund failed', err.message));
      if (e.code === '23505') return res.status(400).json({ error: 'Already registered' });
      throw e;
    }

    let updated = await db.getTournament(t.id);
    updated = await checkAndCloseSignup(updated);
    res.json({ success: true, tournament: tournamentSummary(updated) });
  } catch (e) {
    console.error('[tournament register]', e);
    res.status(500).json({ error: 'Could not register' });
  }
});

app.post('/api/tournament/:id/play', deployDrain.blockNewMatches, requireDb, authenticate, async (req, res) => {
  try {
    const t = await db.getTournament(req.params.id);
    if (!t || t.status !== 'active') return res.status(400).json({ error: 'Tournament is not active' });

    const myReg = await db.listTournamentRegistrations(t.id).then((regs) => regs.find((r) => r.player_id === req.tokenPlayer.id));
    if (!myReg) return res.status(403).json({ error: 'You are not registered for this tournament' });

    const roundData = t.bracket_data.rounds.find((r) => r.round === myReg.current_round);
    const matchup = roundData?.matchups.find((m) => m.playerAId === req.tokenPlayer.id || m.playerBId === req.tokenPlayer.id);
    if (!matchup) return res.status(400).json({ error: 'No matchup found for you in this round' });
    if (matchup.status === 'waiting') return res.status(400).json({ error: 'Waiting for your opponent to be determined' });
    if (matchup.status === 'completed') return res.status(400).json({ error: 'This matchup is already finished' });
    if (matchup.status === 'void') return res.status(400).json({ error: 'This matchup ended in a draw - both players were eliminated' });
    if (matchup.status === 'bye') return res.status(400).json({ error: 'You advanced on a bye - no match to play this round' });

    if (matchup.matchId) return res.json({ matchId: matchup.matchId });

    const [playerA, playerB] = await Promise.all([db.getPlayerById(matchup.playerAId), db.getPlayerById(matchup.playerBId)]);
    const toPlayerInfo = (p) => ({ id: p.id, username: p.username, country: p.country, war_rating: p.war_rating, tier: tierForRating(p.war_rating) });

    const match = await gameEngine.createMatch('tournament', {
      configOverrides: { tournamentId: t.id, round: myReg.current_round, matchupIndex: matchup.matchup },
    });
    gameEngine.joinMatch(match, toPlayerInfo(playerA));
    gameEngine.joinMatch(match, toPlayerInfo(playerB));

    matchup.matchId = match.id;
    matchup.status = 'in_progress';
    await db.updateTournament(t.id, { bracket_data: t.bracket_data });

    res.json({ matchId: match.id });
  } catch (e) {
    console.error('[tournament play]', e);
    res.status(500).json({ error: 'Could not start tournament match' });
  }
});

// ---- async daily challenge ----------------------------------------------------

app.get('/api/async/today', requireDb, authenticate, async (req, res) => {
  try {
    const modeConfig = gameEngine.MATCH_MODES.async;
    const dailySeed = new Date().toISOString().slice(0, 10);
    const instruments = instrumentsRegistry.selectDailyInstruments(dailySeed, modeConfig.instrumentCount);
    const already = await db.getAsyncResultToday(req.tokenPlayer.id);
    res.json({
      date: dailySeed,
      instruments,
      entryCoins: modeConfig.entryCoins,
      durationSeconds: modeConfig.durationSeconds,
      alreadyPlayed: !!already,
      myResult: already || null,
    });
  } catch (e) {
    console.error('[async today]', e);
    res.status(500).json({ error: 'Could not load today\'s challenge' });
  }
});

app.get('/api/async/leaderboard', requireDb, authenticate, async (req, res) => {
  try {
    const leaderboard = await db.getAsyncLeaderboardToday(50);
    res.json({ leaderboard });
  } catch (e) {
    console.error('[async leaderboard]', e);
    res.status(500).json({ error: 'Could not load leaderboard' });
  }
});

// ---- analytics dashboard (Battle Pass premium) --------------------------------

app.get('/api/analytics', requireDb, authenticate, async (req, res) => {
  try {
    const season = battlepass.currentSeason();
    const status = await db.ensureBattlePassStatus(req.tokenPlayer.id, season);
    if (!status.is_premium) {
      return res.status(403).json({ error: 'Analytics is a Battle Pass Premium feature', requiresPremium: true });
    }
    const playerId = req.tokenPlayer.id;
    const [winRateByInstrument, pnlByMode, timeOfDayHeatmap, cardSuccessRates, pnlTrend] = await Promise.all([
      db.getAnalyticsWinRateByInstrument(playerId),
      db.getAnalyticsPnlByMode(playerId),
      db.getAnalyticsTimeOfDayHeatmap(playerId),
      db.getAnalyticsCardSuccessRates(playerId),
      db.getAnalyticsPnlTrend(playerId, 30),
    ]);
    res.json({ winRateByInstrument, pnlByMode, timeOfDayHeatmap, cardSuccessRates, pnlTrend });
  } catch (e) {
    console.error('[analytics]', e);
    res.status(500).json({ error: 'Could not load analytics' });
  }
});

app.put('/api/cards/deck', requireDb, authenticate, async (req, res) => {
  try {
    const { cardTypes } = req.body || {};
    if (!Array.isArray(cardTypes) || cardTypes.length > 5) {
      return res.status(400).json({ error: 'Deck must be an array of at most 5 card types' });
    }
    const validIds = new Set(sabotage.getCardCatalog().map((c) => c.id));
    if (!cardTypes.every((t) => validIds.has(t))) return res.status(400).json({ error: 'Unknown card type in deck' });
    const deck = await db.saveCardDeck(req.tokenPlayer.id, cardTypes);
    res.json({ cardTypes: deck.card_types });
  } catch (e) {
    console.error('[deck save]', e);
    res.status(500).json({ error: 'Could not save deck' });
  }
});

// ---- wallet -----------------------------------------------------------------------

app.get('/api/wallet', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const [lifetimePnl, todayLoss, coinsBreakdown] = await Promise.all([
      db.getLifetimeMatchPnl(player.id),
      db.getTodayLoss(player.id),
      db.getCoinsBreakdown(player.id),
    ]);
    const nextMidnight = new Date();
    nextMidnight.setHours(24, 0, 0, 0);
    res.json({
      coins: player.coins,
      coinsEarnedTotal: player.coins_earned_total || 0,
      coinsSpentTotal: player.coins_spent_total || 0,
      coinsFromMatches: coinsBreakdown.fromMatches,
      coinsFromPurchases: coinsBreakdown.fromPurchases,
      lifetimeMatchPnl: Math.round(lifetimePnl * 100) / 100,
      dailyLossLimitUsd: player.daily_loss_limit_usd,
      todayLossUsd: Math.round(todayLoss * 100) / 100,
      resetsAtIso: nextMidnight.toISOString(),
    });
  } catch (e) {
    console.error('[wallet]', e);
    res.status(500).json({ error: 'Could not load wallet' });
  }
});

app.get('/api/wallet/transactions', requireDb, authenticate, async (req, res) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const transactions = await db.getCoinTransactions(req.tokenPlayer.id, limit);
    res.json({ transactions });
  } catch (e) {
    console.error('[wallet transactions]', e);
    res.status(500).json({ error: 'Could not load transaction history' });
  }
});

// ---- prize claims (closed) ---------------------------------------------------------
// Coins have no cash value: no coin balance, tournament prize or competition
// prize can be turned into money. The claim endpoint stays only to answer
// old clients with a clear 403; existing prize_claims rows stay for records.
const NO_CASH_VALUE_MESSAGE = 'Coins have no cash value and cannot be withdrawn';

app.get('/api/prize-claims/eligible', requireDb, authenticate, (req, res) => {
  res.json({ wins: [] });
});

app.get('/api/prize-claims/mine', requireDb, authenticate, async (req, res) => {
  try {
    const claims = await db.listPlayerPrizeClaims(req.tokenPlayer.id);
    res.json({ claims });
  } catch (e) {
    console.error('[prize-claims mine]', e);
    res.status(500).json({ error: 'Could not load claim history' });
  }
});

app.post('/api/prize-claims', (req, res) => {
  res.status(403).json({ error: NO_CASH_VALUE_MESSAGE });
});

app.all(['/api/withdraw', '/api/withdrawals', '/api/withdrawal-requests', '/api/wallet/withdraw'], (req, res) => {
  res.status(403).json({ error: NO_CASH_VALUE_MESSAGE });
});

// ---- support: AI agent + human handoff + tickets ----------------------------------
// Everything lives in server/support/ (see support/index.js for the routes,
// the /support socket namespace and the admin bridge).
const { mountSupport } = require('./support');
mountSupport({ app, io, supabaseAdmin, db, notifyPlayer, clientIp, limiters: { message: supportChatLimiter, ticket: supportTicketLimiter } });

app.get('/api/version', (req, res) => {
  res.json({ version: require('../package.json').version });
});

// ---- public client config ----------------------------------------------------------
// Lets the same client bundle run against whichever Supabase project this
// deployment's .env points to (dev vs prod) instead of hardcoding the dev
// project's URL/anon key into auth.js - the anon key is safe to expose
// client-side by design (RLS enforces access, not secrecy of this key).

app.get('/api/config/public', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    devCoinGrantsEnabled: process.env.NODE_ENV !== 'production' && allowedOrigins.length === 0,
  });
});

// ---- lobby + sponsors (server/lobby.js) ------------------------------------------

app.use(
  createLobbyRouter({ db, gameEngine, instrumentsRegistry, playerSockets, competitionSummary, TIERS, authenticate: [requireDb, authenticate], optionalViewerId })
);

// ---- home page stats --------------------------------------------------------------

app.get('/api/stats/home', cacheJson(10000), async (req, res) => {
  try {
    const live = await gameEngine.getHomeStats();
    if (!db.isConfigured) return res.json({ ...live, largestWinToday: 0, coinsWonToday: 0 });
    const [largestWinToday, coinsWonToday] = await Promise.all([db.getLargestWinToday(), db.getCoinsWonToday()]);
    res.json({ ...live, largestWinToday, coinsWonToday });
  } catch (e) {
    console.error('[stats home]', e);
    res.json({ matchesToday: 0, activePlayers: 0, largestWinToday: 0, coinsWonToday: 0 });
  }
});

// Public marketing stats for the landing page (client/landing.html). Distinct
// from /api/stats/home above: activePlayers there only counts players inside
// a live match, but the landing page's hero badge wants everyone currently
// connected to the site (playerSockets, the same in-memory socket registry
// index.js already uses for presence pushes) plus every filled seat in a live
// match, as one number by owner decision, and it also wants a lifetime
// total rather than /api/stats/home's today-scoped coinsWonToday.
app.get('/api/stats/live', cacheJson(10000), async (req, res) => {
  try {
    const activePlayers = playerSockets.size + gameEngine.getFilledSeatsInPlay();
    const { matchesToday } = await gameEngine.getHomeStats();
    if (!db.isConfigured) {
      return res.json({ activePlayers, matchesToday, largestWinToday: 0, totalPrizesDistributed: 0, totalPlayers: 0 });
    }
    // totalPlayers is every account, persona/bot accounts included.
    const [largestWinToday, totalPrizesDistributed, totalPlayers] = await Promise.all([
      db.getLargestWinToday(),
      db.getTotalPrizesDistributed(),
      db.getTotalPlayerCount(),
    ]);
    res.json({ activePlayers, matchesToday, largestWinToday, totalPrizesDistributed, totalPlayers });
  } catch (e) {
    console.error('[stats live]', e);
    res.json({ activePlayers: 0, matchesToday: 0, largestWinToday: 0, totalPrizesDistributed: 0, totalPlayers: 0 });
  }
});

// Written by the admin panel's Communications > Announcements tab
// (admin/routes/communications.js), read on page load so both logged-in and
// anonymous visitors see it - the live socket push (announcement:new) only
// reaches whoever's already connected at broadcast time.
app.get('/api/announcements/active', async (req, res) => {
  if (!db.isConfigured) return res.json([]);
  try {
    res.json(await db.getActiveAnnouncements('home'));
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/promo/active', requireDb, authenticate, async (req, res) => {
  try {
    res.json(await db.getActivePromoPopup());
  } catch (e) {
    res.json(null);
  }
});

app.get('/api/stats/featured-match', (req, res) => {
  const featured = gameEngine.getFeaturedMatch();
  res.json(featured || { matchId: null });
});

// Decorative price ticker for the Trading Floor home screen - not tied to any
// match, so it rotates through each instrument's historical/synthetic day
// data using the current minute as a slowly-advancing cursor.
app.get('/api/stats/ticker', (req, res) => {
  try {
    res.json({ rows: instrumentsRegistry.getTickerSnapshot() });
  } catch (e) {
    console.error('[stats ticker]', e);
    res.json({ rows: [] });
  }
});

app.get('/api/stats/activity', cacheJson(10000), async (req, res) => {
  try {
    if (!db.isConfigured) return res.json({ activity: [] });
    const activity = await db.getRecentActivity(15);
    res.json({ activity });
  } catch (e) {
    console.error('[stats activity]', e);
    res.json({ activity: [] });
  }
});

app.get('/api/stats/hot-streaks', async (req, res) => {
  try {
    if (!db.isConfigured) return res.json({ streaks: [] });
    const streaks = await db.getHotStreaks(5);
    res.json({ streaks });
  } catch (e) {
    console.error('[stats hot-streaks]', e);
    res.json({ streaks: [] });
  }
});

app.get('/api/stats/broker-partners', async (req, res) => {
  try {
    if (!db.isConfigured) return res.json({ partners: [] });
    const partners = await db.listBrokerPartners();
    res.json({ partners: partners.map((p) => ({ id: p.id, name: p.broker_name, logoUrl: p.logo_url, referralUrl: p.referral_url, tier: p.tier })) });
  } catch (e) {
    console.error('[stats broker-partners]', e);
    res.json({ partners: [] });
  }
});

app.get('/api/stats/war-lord-spotlight', async (req, res) => {
  try {
    if (!db.isConfigured) return res.json({ player: null });
    const top = await db.getLeaderboard(1, {});
    const player = top[0] ? { username: top[0].username, warRating: top[0].war_rating, wins: top[0].wins, tier: tierForRating(top[0].war_rating) } : null;
    res.json({ player });
  } catch (e) {
    console.error('[stats war-lord-spotlight]', e);
    res.json({ player: null });
  }
});

async function enrichMatchHistoryWithOpponents(history, excludePlayerId) {
  const matchIds = history.map((m) => m.matches?.id).filter(Boolean);
  const opponentsByMatch = await db.getMatchOpponents(matchIds, excludePlayerId);
  return history.map((m) => ({ ...m, opponents: opponentsByMatch[m.matches?.id] || [] }));
}

// Best-effort viewer identification for endpoints that personalize their
// response when the caller happens to be logged in, but don't require it
// (public leaderboard/profile views). Never rejects the request - any
// failure just means the response comes back unpersonalized.
async function optionalViewerId(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const {
      data: { user },
    } = await supabaseAdmin.auth.getUser(token);
    if (!user) return null;
    const player = await db.getPlayerBySupabaseUserId(user.id);
    return player?.id || null;
  } catch (e) {
    return null;
  }
}

app.get('/api/leaderboard', cacheJson(10000), requireDb, async (req, res) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 10);
    const tierFilter = req.query.tier && req.query.tier !== 'All' ? req.query.tier : null;
    const period = req.query.period === 'week' || req.query.period === 'month' ? req.query.period : 'all';
    const search = req.query.search ? String(req.query.search).slice(0, 40) : null;
    const viewerId = await optionalViewerId(req);

    let rows;
    if (period === 'all') {
      rows = (await db.getLeaderboard(500, { search })).map((r) => ({
        id: r.id,
        username: r.username,
        war_rating: r.war_rating,
        tier: tierForRating(r.war_rating),
        wins: r.wins,
        losses: r.losses,
        draws: r.draws || 0,
        total_matches: r.total_matches,
        metric: r.war_rating,
      }));
    } else {
      const since = new Date();
      if (period === 'week') since.setDate(since.getDate() - 7);
      else since.setMonth(since.getMonth() - 1);
      const periodRows = await db.getPeriodLeaderboard(since.toISOString());
      rows = periodRows
        .filter((r) => !search || r.username.toLowerCase().includes(search.toLowerCase()))
        .map((r) => ({
          id: r.id,
          username: r.username,
          war_rating: r.war_rating,
          tier: tierForRating(r.war_rating),
          wins: null,
          losses: null,
          draws: null,
          total_matches: r.periodMatches,
          metric: Math.round(r.periodPnl * 100) / 100,
        }));
    }

    if (tierFilter) rows = rows.filter((r) => r.tier === tierFilter);
    rows = rows.sort((a, b) => b.metric - a.metric).map((r, i) => ({ ...r, rank: i + 1 }));

    const page = rows.slice(0, limit);
    const viewerRow = viewerId ? rows.find((r) => r.id === viewerId) : null;
    const viewerInPage = viewerRow && page.some((r) => r.id === viewerId);

    const cosmeticsByPlayer = await db.getEquippedCosmeticsForPlayers(
      Array.from(new Set([...page.map((r) => r.id), ...(viewerRow ? [viewerRow.id] : [])]))
    );
    const withCosmetics = (r) => ({
      ...r,
      equipped_nameplate: cosmeticsByPlayer[r.id]?.nameplate || 'name_standard',
      equipped_frame: cosmeticsByPlayer[r.id]?.avatar_frame || 'none',
    });

    res.json({
      leaderboard: page.map(withCosmetics),
      period,
      tiers: TIERS.map((t) => t.name),
      viewerRank: viewerRow && !viewerInPage ? withCosmetics(viewerRow) : null,
    });
  } catch (e) {
    console.error('[leaderboard]', e);
    res.status(500).json({ error: 'Could not load leaderboard' });
  }
});

// ---- invite rewards ---------------------------------------------------------
// A player's own invite link and how it has done. The player id only ever comes
// from the verified session. The reward itself is paid by gameEngine at match end.
app.get('/api/referrals/me', requireDb, authenticate, async (req, res) => {
  try {
    const code = await db.getOrCreateInviteCode(req.tokenPlayer.id);
    const stats = await db.getInviteStats(req.tokenPlayer.id);
    res.json({
      link: `${req.protocol}://${req.get('host')}/invite/${code}`,
      rewardCoins: INVITE_REWARD_COINS,
      maxPaid: INVITE_MAX_PAID,
      paid: stats.paid,
      waiting: stats.waiting,
      coinsEarned: stats.paid * INVITE_REWARD_COINS,
    });
  } catch (e) {
    console.error('[referrals/me]', e);
    res.status(500).json({ error: 'Could not load your invite link' });
  }
});

// Dev-only top-up so testing the game doesn't need real coins. Off in
// production. Grants a fixed amount per call, never a client-supplied number.
const DEV_COIN_GRANT_AMOUNT = 1000;
app.post('/api/dev/add-coins', requireDb, authenticate, async (req, res) => {
  // Prod sets ALLOWED_ORIGIN to lock down CORS; dev leaves it unset. Either signal closes this.
  if (process.env.NODE_ENV === 'production' || allowedOrigins.length > 0) {
    return res.status(403).json({ error: 'Dev coin grants are disabled on this deployment' });
  }
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const updated = await db.creditCoins(player.id, DEV_COIN_GRANT_AMOUNT, { type: 'dev_grant' });
    res.json({ success: true, granted: DEV_COIN_GRANT_AMOUNT, coins: updated.coins });
  } catch (e) {
    console.error('[dev/add-coins]', e);
    res.status(500).json({ error: 'Could not grant coins' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---- socket.io --------------------------------------------------------------

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('unauthorized'));
    const {
      data: { user },
      error,
    } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return next(new Error('unauthorized'));

    const player = await db.getPlayerBySupabaseUserId(user.id);
    if (!player) return next(new Error('unauthorized'));
    if (activeBan(player)) return next(new Error('banned'));

    // socket.data.player keeps the shape every existing handler already
    // expects (`.id`, `.username`) - the extra userId/playerId/username
    // properties below are additive, for anything that wants Supabase's own
    // user id specifically.
    socket.data.player = player;
    socket.userId = user.id;
    socket.playerId = player.id;
    socket.username = player.username;
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

// Per-socket token bucket (audit items 1/10): bursts of 40 events, refilling
// 15/s; sabotage and chat have a tighter 4/s. Over the limit the event is
// dropped and any ack gets an error, so a script can't flood the match loop.
function socketRateLimiter(socket) {
  const buckets = {};
  const LIMITS = { default: { cap: 40, rate: 15 }, 'sabotage:play': { cap: 4, rate: 1 }, 'lobby:chat': { cap: 4, rate: 1 } };
  return ([event, ...args], next) => {
    const lim = LIMITS[event] || LIMITS.default;
    const key = LIMITS[event] ? event : 'default';
    const now = Date.now();
    const b = (buckets[key] ||= { tokens: lim.cap, at: now });
    b.tokens = Math.min(lim.cap, b.tokens + ((now - b.at) / 1000) * lim.rate);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return next();
    }
    const ack = args[args.length - 1];
    if (typeof ack === 'function') ack({ success: false, error: 'Slow down - too many actions' });
  };
}

io.on('connection', (socket) => {
  socket.use(socketRateLimiter(socket));
  const notifyPid = socket.data.player?.id;

  // Long-form competitions: live updates go to comp:{id}:{playerId}, joined
  // only after compEngine confirms this player has an account there.
  socket.on('comp:join', async ({ competitionId } = {}, ack) => {
    const ok = UUID_RE.test(competitionId || '') && (await compEngine.joinRoom(socket, competitionId));
    if (typeof ack === 'function') ack({ ok });
  });
  if (notifyPid) {
    if (!playerSockets.has(notifyPid)) playerSockets.set(notifyPid, new Set());
    playerSockets.get(notifyPid).add(socket.id);

    // A page navigation disconnects the old socket and immediately opens a
    // new one - cancel any pending "went offline" timer so that doesn't
    // flicker a friend's presence, and only stamp 'online' if they were
    // truly offline before (don't clobber in_lobby/in_match on a same-
    // session reconnect, e.g. lobby.html -> game.html).
    presence.cancelScheduledOffline(notifyPid);
    if (presence.getPresence(notifyPid).status === 'offline') {
      updatePresence(notifyPid, { status: 'online', matchId: null, lobbyId: null, mode: null });
    }

    socket.on('disconnect', () => {
      const set = playerSockets.get(notifyPid);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          playerSockets.delete(notifyPid);
          presence.scheduleOffline(notifyPid, () => broadcastPresenceToFriends(notifyPid, presence.getPresence(notifyPid)));
        }
      }
    });
  }

  socket.on('player:join', ({ matchId } = {}, ack) => {
    const result = gameEngine.bindSocket(socket, matchId);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('player:ready', (_data, ack) => {
    const session = gameEngine.getSession(socket.id);
    const result = session
      ? gameEngine.setReady(session.matchId, session.playerId)
      : { success: false, error: 'Not joined to a match' };
    if (typeof ack === 'function') ack(result);
  });

  // Host-only "Start War" - closes a waiting-lobby match (quick/blitz/grand/
  // private) once everyone the host is expecting has joined, filling any
  // remaining seats with AI. See gameEngine.hostStartMatch.
  socket.on('lobby:start_war', (_data, ack) => {
    const session = gameEngine.getSession(socket.id);
    const result = session
      ? gameEngine.hostStartMatch(session.matchId, session.playerId)
      : { success: false, error: 'Not joined to a match' };
    if (typeof ack === 'function') ack(result);
  });

  // "Start now with AI" - lets any player in a waiting lobby stop waiting for
  // more humans and fill the rest with AI immediately instead of riding out
  // the full lobby timer (see the Smart Queue Display in the lobby UI).
  socket.on('player:forceStart', (_data, ack) => {
    const session = gameEngine.getSession(socket.id);
    if (!session) {
      if (typeof ack === 'function') ack({ success: false, error: 'Not joined to a match' });
      return;
    }
    gameEngine.forceStartLobby(session.matchId);
    if (typeof ack === 'function') ack({ success: true });
  });

  socket.on('trade:open', (data, ack) => {
    const session = gameEngine.getSession(socket.id);
    const result = session
      ? gameEngine.openTrade(session.matchId, session.playerId, data || {})
      : { success: false, error: 'Not joined to a match' };
    if (typeof ack === 'function') ack(result);
  });

  socket.on('trade:close', (data, ack) => {
    const session = gameEngine.getSession(socket.id);
    const result = session
      ? gameEngine.closeTrade(session.matchId, session.playerId, data?.positionId)
      : { success: false, error: 'Not joined to a match' };
    if (typeof ack === 'function') ack(result);
  });

  socket.on('trade:close_partial', (data, ack) => {
    const session = gameEngine.getSession(socket.id);
    const result = session
      ? gameEngine.closeTradePartial(session.matchId, session.playerId, data?.positionId, data?.percentage)
      : { success: false, error: 'Not joined to a match' };
    if (typeof ack === 'function') ack(result);
  });

  socket.on('spectate:join', ({ matchId } = {}, ack) => {
    const result = gameEngine.bindSpectator(socket, matchId);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('trade:modify', (data, ack) => {
    const session = gameEngine.getSession(socket.id);
    const result = session
      ? gameEngine.setStopLossTakeProfit(session.matchId, session.playerId, data?.positionId, {
          stopLoss: data?.stopLoss,
          takeProfit: data?.takeProfit,
        })
      : { success: false, error: 'Not joined to a match' };
    if (typeof ack === 'function') ack(result);
  });

  socket.on('sabotage:play', (data, ack) => {
    const session = gameEngine.getSession(socket.id);
    const result = session
      ? gameEngine.playSabotageCard(session.matchId, session.playerId, data?.cardType, {
          targetId: data?.targetId,
          symbol: data?.symbol,
        })
      : { success: false, error: 'Not joined to a match' };
    if (typeof ack === 'function') ack(result);
  });

  // FIX: voluntary leave / "get out after elimination" instead of being
  // stuck spectating - records a forfeited last place immediately, the
  // match keeps running for everyone else.
  socket.on('match:leave', async (data, ack) => {
    const session = gameEngine.getSession(socket.id);
    const result = session
      ? await gameEngine.leaveMatch(session.matchId, session.playerId)
      : { success: false, error: 'Not joined to a match' };
    if (typeof ack === 'function') ack(result);
  });

  socket.on('lobby:chat', (data, ack) => {
    const session = gameEngine.getSession(socket.id);
    const result = session
      ? gameEngine.sendChatMessage(session.matchId, session.playerId, data?.message)
      : { success: false, error: 'Not joined to a match' };
    if (typeof ack === 'function') ack(result);
  });

  socket.on('loadout:select_cards', (data, ack) => {
    const session = gameEngine.getSession(socket.id);
    const result = session
      ? gameEngine.selectLoadoutCards(session.matchId, session.playerId, data?.cardTypes)
      : { success: false, error: 'Not joined to a match' };
    if (typeof ack === 'function') ack(result);
  });

  // ---- friends (Block 12) ----------------------------------------------------

  socket.on('friend:request', async ({ targetId } = {}, ack) => {
    try {
      const requesterId = socket.data.player.id;
      if (!targetId || targetId === requesterId) return ack?.({ success: false, error: 'Invalid target' });
      const existing = await db.getFriendshipBetween(requesterId, targetId);
      if (existing) {
        const msg = existing.status === 'accepted' ? 'Already friends' : existing.status === 'blocked' ? 'Unable to send request' : 'Request already pending';
        return ack?.({ success: false, error: msg });
      }
      const requester = await db.getPlayerById(requesterId);
      const row = await db.sendFriendRequest(requesterId, targetId);
      notifyPlayer(targetId, 'friend_request', `${requester.username} sent you a friend request`, {
        fromPlayerId: requesterId,
        data: { requestId: row.id, username: requester.username, tier: requester.tier },
      });
      const targetSockets = playerSockets.get(targetId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('friend:request_received', { requestId: row.id, fromPlayerId: requesterId, username: requester.username, tier: requester.tier, warRating: requester.war_rating });
        }
      }
      ack?.({ success: true, requestId: row.id });
    } catch (e) {
      console.error('[friend:request]', e);
      ack?.({ success: false, error: 'Could not send request' });
    }
  });

  socket.on('friend:accept', async ({ requestId } = {}, ack) => {
    try {
      const accepterId = socket.data.player.id;
      const row = await db.acceptFriendRequest(requestId, accepterId);
      const accepter = await db.getPlayerById(accepterId);
      db.markFriendRequestNotificationRead(accepterId, requestId).catch((e) => console.error('[friend:accept] could not mark notification read:', e.message));
      notifyPlayer(row.requester_id, 'friend_accepted', `${accepter.username} accepted your friend request`, {
        fromPlayerId: accepterId,
        data: { username: accepter.username },
      });
      const requesterSockets = playerSockets.get(row.requester_id);
      if (requesterSockets) {
        for (const sid of requesterSockets) io.to(sid).emit('friend:accepted', { playerId: accepterId, username: accepter.username });
      }
      ack?.({ success: true });
    } catch (e) {
      console.error('[friend:accept]', e);
      ack?.({ success: false, error: 'Could not accept request' });
    }
  });

  // Decline is silent by design (spec) - no notification back to the requester.
  socket.on('friend:decline', async ({ requestId } = {}, ack) => {
    try {
      await db.declineFriendRequest(requestId, socket.data.player.id);
      ack?.({ success: true });
    } catch (e) {
      console.error('[friend:decline]', e);
      ack?.({ success: false, error: 'Could not decline request' });
    }
  });

  socket.on('friend:remove', async ({ friendId } = {}, ack) => {
    try {
      await db.removeFriend(socket.data.player.id, friendId);
      ack?.({ success: true });
    } catch (e) {
      console.error('[friend:remove]', e);
      ack?.({ success: false, error: 'Could not remove friend' });
    }
  });

  // ---- lobby invites (Block 12) -----------------------------------------------

  socket.on('lobby:invite', async ({ targetIds, matchId } = {}, ack) => {
    try {
      const session = gameEngine.getSession(socket.id);
      if (!session || session.matchId !== matchId) return ack?.({ success: false, error: 'You are not in this lobby' });
      const match = gameEngine.getMatch(matchId);
      if (!match || match.status !== 'waiting') return ack?.({ success: false, error: 'Lobby is not open for invites' });
      const inviter = match.players[session.playerId];
      if (!inviter) return ack?.({ success: false, error: 'Not in this lobby' });

      const sentTo = [];
      for (const targetId of Array.isArray(targetIds) ? targetIds : []) {
        const targetSockets = playerSockets.get(targetId);
        if (!targetSockets || targetSockets.size === 0) continue; // only online friends can be invited

        const inviteId = crypto.randomUUID();
        const invite = {
          id: inviteId,
          fromPlayerId: inviter.id,
          fromUsername: inviter.username,
          fromTier: inviter.tier,
          lobbyId: matchId,
          matchMode: match.config.label || match.mode,
          instruments: match.instruments,
          currentPlayers: Object.keys(match.players).length,
          maxPlayers: match.config.maxPlayers,
          targetPlayerId: targetId,
          expiresAt: Date.now() + INVITE_TTL_MS,
        };
        invite.timer = setTimeout(async () => {
          pendingInvites.delete(inviteId);
          const target = await db.getPlayerById(targetId).catch(() => null);
          notifyPlayer(inviter.id, 'invite_expired', `${target?.username || 'A friend'} did not respond to your invite`);
          const targetNowSockets = playerSockets.get(targetId);
          if (targetNowSockets) for (const sid of targetNowSockets) io.to(sid).emit('lobby:invite_expired', { inviteId });
        }, INVITE_TTL_MS);
        pendingInvites.set(inviteId, invite);

        for (const sid of targetSockets) {
          io.to(sid).emit('lobby:invite_received', { ...invite, timer: undefined });
        }
        sentTo.push(targetId);
      }
      ack?.({ success: true, sentTo });
    } catch (e) {
      console.error('[lobby:invite]', e);
      ack?.({ success: false, error: 'Could not send invite' });
    }
  });

  socket.on('lobby:invite_accept', async ({ inviteId } = {}, ack) => {
    try {
      const invite = pendingInvites.get(inviteId);
      if (!invite) return ack?.({ success: false, error: 'This invite has expired' });
      if (invite.targetPlayerId !== socket.data.player.id) return ack?.({ success: false, error: 'This invite is not for you' });
      clearTimeout(invite.timer);
      pendingInvites.delete(inviteId);

      const match = gameEngine.getMatch(invite.lobbyId);
      if (!match || match.status !== 'waiting') return ack?.({ success: false, error: 'That lobby is no longer open' });

      const player = await db.getPlayerById(socket.data.player.id);
      const entryCoins = match.config.entryCoins || 0;
      if (entryCoins > 0 && player.coins < entryCoins) {
        return ack?.({ success: false, error: `Not enough coins - this lobby costs ${entryCoins} coins to join` });
      }

      const playerInfo = { id: player.id, username: player.username, country: player.country, war_rating: player.war_rating, grand_war_rating: player.grand_war_rating, solo_rating: player.solo_rating, tier: tierForRating(player.war_rating) };
      let entry;
      try {
        entry = await chargeEntryFee(player.id, entryCoins, match.dbMatchId);
      } catch (e) {
        if (e.code === 'INSUFFICIENT_COINS') return ack?.({ success: false, error: `Not enough coins - this lobby costs ${entryCoins} coins to join` });
        throw e;
      }
      const result = gameEngine.joinMatch(match, playerInfo, socket.id);
      if (!result.success) {
        await refundEntryFee(player.id, entryCoins, entry.key, match.dbMatchId);
        return ack?.({ success: false, error: result.error });
      }
      if (entry.key && !recordEntryPaid(match.id, player.id, entry.key, entryCoins)) {
        await refundEntryFee(player.id, entryCoins, entry.key, match.dbMatchId);
      }
      gameEngine.pushSystemFeed(match.id, `${player.username} joined via invite`);

      const inviterSockets = playerSockets.get(invite.fromPlayerId);
      if (inviterSockets) {
        for (const sid of inviterSockets) io.to(sid).emit('lobby:invite_accepted', { inviteId, playerId: player.id, username: player.username });
      }
      ack?.({ success: true, matchId: match.id });
    } catch (e) {
      console.error('[lobby:invite_accept]', e);
      ack?.({ success: false, error: 'Could not join lobby' });
    }
  });

  socket.on('lobby:invite_decline', async ({ inviteId } = {}, ack) => {
    try {
      const invite = pendingInvites.get(inviteId);
      if (invite) {
        clearTimeout(invite.timer);
        pendingInvites.delete(inviteId);
        const decliner = await db.getPlayerById(socket.data.player.id).catch(() => null);
        notifyPlayer(invite.fromPlayerId, 'invite_declined', `${decliner?.username || 'A friend'} declined your invite`);
      }
      ack?.({ success: true });
    } catch (e) {
      console.error('[lobby:invite_decline]', e);
      ack?.({ success: false, error: 'Could not decline invite' });
    }
  });

  socket.on('disconnect', () => {
    gameEngine.handleDisconnect(socket.id);
  });
});

// Catches multer (avatar upload) errors and anything else thrown/passed to
// next() by earlier middleware, so clients always get JSON instead of
// Express's default HTML error page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled route error]', err);
  // err.message is never forwarded raw here - this is the catch-all for
  // whatever wasn't already given its own friendly message by the route
  // that threw it, so it could be anything from a raw Postgres constraint
  // violation to a Multer upload error. err.status (e.g. Multer's 413 for
  // "file too large") is still safe to pass through - it's just a code.
  res.status(err.status || 400).json({ error: 'Something went wrong. Please try again.' });
});

const instrumentReport = instrumentsRegistry.preloadAll();
const realCount = instrumentReport.filter((r) => r.source !== 'synthetic').length;
console.log(`[instruments] loaded ${instrumentReport.length} instruments (${realCount} from real data, ${instrumentReport.length - realCount} synthetic):`);
for (const r of instrumentReport) {
  console.log(`  ${r.symbol.padEnd(8)} ${r.source.padEnd(10)} ${r.points} one-minute data points`);
}

server.listen(PORT, () => {
  console.log(`Spike & Crush server listening on http://localhost:${PORT}`);
  compEngine.start();
  if (!db.isConfigured) {
    console.warn(
      'Running WITHOUT a configured database - accounts, matchmaking persistence and leaderboards are disabled until SUPABASE_SERVICE_KEY is set in .env.'
    );
  }
});
