'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateAvatar } = require('./imageValidation');
const { securityHeaders } = require('./securityHeaders');
const seo = require('./seo');
const { TERMS_VERSION } = require('./legal');
const express = require('express');
const compression = require('compression');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // still used for the legacy-account migration path in /api/auth/login
const { createClient } = require('@supabase/supabase-js');
const { createTokenVerifier } = require('./authTokens');
const { createPasswordSignIn, isSignInRateLimited, SignInBusyError, BUSY_MESSAGE: SIGN_IN_BUSY_MESSAGE } = require('./passwordSignIn');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const db = require('./database');
const { sendEmail, renderTemplate } = require('../admin/lib/email');
const emailVerification = require('./emailVerification');
const { createGameEngine, LIVE_MATCH_BUSY_ERROR, tierForRating, TIERS } = require('./gameEngine');
const matchmaking = require('./matchmaking');
const totp = require('./totp');
const sabotage = require('./sabotage');
const instrumentsRegistry = require('./instruments');
const shop = require('./shop');
const battlepass = require('./battlepass');
const progression = require('./progression');
const discover = require('./discover');
const rankSplit = require('./rankSplit');
const cosmetics = require('./cosmetics');
const gameFeel = require('./config/gameFeel');
const modeIdentity = require('./config/modeIdentity');
const tournament = require('./tournament');
const presence = require('./presence');
const friendsHub = require('./friendsHub');
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
  global: { fetch: db.fetchWithTimeout }, // shares the ceiling on database traffic
});
// Login tokens are checked here, not by asking Supabase Auth each time (server/authTokens.js).
const tokens = createTokenVerifier({ supabaseUrl: process.env.SUPABASE_URL, supabaseAdmin });
tokens.loadKeys();
const getAuthUser = async (token) => ({ data: { user: await tokens.getUser(token, { requireVerifiedEmail: EMAIL_VERIFICATION_ON }) }, error: null });

// See server/passwordSignIn.js. Warns the owner when Supabase's limit is being hit.
const passwordSignInFor = createPasswordSignIn({
  createClient,
  url: process.env.SUPABASE_URL,
  serviceKey: process.env.SUPABASE_SERVICE_KEY,
  secretKey: process.env.SUPABASE_SECRET_KEY,
  onRateLimited: () => {
    console.warn('[auth] Supabase is rate limiting sign-ins');
    opsMonitor.alert('sign-ins', 'Players are being refused at login (Supabase rate limit)', {
      fix: 'Set SUPABASE_SECRET_KEY and turn on IP Address Forwarding in Supabase, Authentication > Rate Limits',
    });
  },
});
const passwordSignIn = (credentials, req) => passwordSignInFor(credentials, req ? clientIp(req) : null);


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
// Before everything else: traffic must come through Cloudflare (see originLock.js).
const { originLock, startRangeRefresh, visitorIp } = require('./originLock');
app.use(originLock());
startRangeRefresh();
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
const LOBBY_SWEEP_MS = 30 * 1000;
const MATCH_RECOVERY_SWEEP_MS = 60 * 1000;
const server = http.createServer(app);
// 100 KB message cap (default 1 MB); no client message needs more.
const io = new Server(server, { cors: { origin: corsOrigin }, maxHttpBufferSize: 100 * 1024 });
// Sockets skip Express, so they need the same check.
io.engine.use(originLock());

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
    // Returned so a job telling thousands of players can pace itself.
    return db.createNotification({ playerId, type, fromPlayerId: extra.fromPlayerId, data: { message, ...extra.data } }).catch((e) =>
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
    const visible = friendsHub.visiblePresence(player.settings, presenceData);
    const payload = {
      playerId,
      username: player.username,
      status: visible.status,
      matchId: visible.matchId,
      lobbyId: visible.lobbyId,
      mode: visible.mode,
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

const gameEngine = createGameEngine(io, notifyPlayer, updatePresence, notifyFriendsOfWin, (playerId) => playerSockets.has(playerId));
const { createCompEngine } = require('./compEngine');
const { createLobbyRouter } = require('./lobby');
const turnstile = require('./turnstile');
const { verifyTurnstile } = turnstile;
const { createOpsMonitor } = require('./opsMonitor');
const { createMatchRecovery } = require('./matchRecovery');
const { startRetention } = require('./retention');
const { createMemo } = require('./concurrency');
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
// A rate limit says nothing about the password, so it must not read as "wrong".
async function verifyPasswordViaSupabase(email, password, req) {
  if (!email || !password) return false;
  const { error } = await passwordSignIn({ email, password }, req);
  if (isSignInRateLimited(error)) throw new SignInBusyError();
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

// Password sign-ups must prove they own their email before they can play. Needs
// Resend to send the link, so without a key sign-ups work as they did before.
// EMAIL_VERIFICATION=off is the kill switch if email ever breaks.
const EMAIL_VERIFICATION_ON = process.env.EMAIL_VERIFICATION !== 'off' && Boolean(process.env.RESEND_API_KEY);
if (!EMAIL_VERIFICATION_ON) console.warn('[email verification] OFF: set RESEND_API_KEY to turn it on');
const VERIFY_MESSAGE = 'Please verify your email first. Check your inbox for the link.';
const needsEmailVerification = (user) => EMAIL_VERIFICATION_ON && !user?.email_confirmed_at;
const allowVerificationResend = emailVerification.createResendGuard();

function publicSiteUrl(req) {
  return emailVerification.publicSiteUrl({
    origin: req.headers.origin,
    allowedOrigins,
    siteUrl: process.env.SITE_URL,
    port: PORT,
  });
}

async function sendVerificationEmail(req, { userId, email, username }) {
  const token = emailVerification.createToken({ userId, email }, process.env.SUPABASE_SERVICE_KEY);
  const link = `${publicSiteUrl(req)}/verify-email?token=${encodeURIComponent(token)}`;
  const result = await sendEmail({ to: email, ...emailVerification.verificationEmail({ username, link }) });
  return Boolean(result && result.id);
}

// Frees a username or email held by a sign-up that was never verified, so a
// typo or a stranger using your address can't block you from it for good. The
// new sign-up still has to prove it owns the inbox. A username is only released
// after the 24-hour link has run out; an email can be claimed straight away,
// because only that inbox can finish the new sign-up.
async function releaseUnverifiedSignup(player, { anyAge = false } = {}) {
  if (!EMAIL_VERIFICATION_ON || !player.supabase_user_id) return false;
  const age = Date.now() - Date.parse(player.created_at);
  if (!anyAge && !(age > emailVerification.TOKEN_TTL_MS)) return false;
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(player.supabase_user_id);
  if (error || !data?.user || data.user.email_confirmed_at) return false;
  // Player first: the login can't be deleted while a player row points at it.
  await db.deletePlayer(player.id);
  const { error: deleteErr } = await supabaseAdmin.auth.admin.deleteUser(player.supabase_user_id);
  if (deleteErr) throw deleteErr;
  return true;
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const {
      data: { user },
      error,
    } = await getAuthUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
    if (needsEmailVerification(user)) return res.status(403).json({ error: VERIFY_MESSAGE, needsVerification: true });

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

// A deck that can't be loaded must not stop anyone playing: they get random cards.
async function loadSavedDeck(playerId) {
  try {
    const deck = await db.getCardDeck(playerId);
    return deck?.card_types || [];
  } catch (e) {
    console.error('[deck load]', e.message);
    return [];
  }
}

// The player's standing on the level ladder and the cards they have unlocked
// (server/progression.js): stored XP when the progress table exists, never
// below what their real match history has earned, plus admin grants/revokes.
// Unlocks are earned only by playing - nothing here reads coins or purchases.
async function loadProgression(player) {
  let stored = null;
  let grants = { granted: [], revoked: [] };
  try {
    stored = await db.getProgress(player.id);
    grants = await db.getCardGrants(player.id);
  } catch (e) {
    console.warn('[progression] load failed:', e.message);
  }
  const standing = progression.standing(player, stored);
  return { standing, stored, grants, unlockedCards: progression.unlockedCards(standing, grants), level: standing.level };
}

// Everything a match needs about a player's cards: the saved deck, unlocked
// cards and level. Used by every path into a match.
async function loadCardLoadout(player) {
  const [deck, prog] = await Promise.all([loadSavedDeck(player.id), loadProgression(player)]);
  return { deck: deck.filter((t) => prog.unlockedCards.includes(t)), unlockedCards: prog.unlockedCards, level: prog.level };
}

function clientIp(req) {
  return String(visitorIp(req)).replace('::ffff:', '');
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

// Knows how full this server is, refuses new matches before it falls over, and
// emails the owner when something is wrong (server/opsMonitor.js).
const opsMonitor = createOpsMonitor({
  liveMatches: () => gameEngine.liveMatchCount(),
  connectedSockets: () => io.engine?.clientsCount || 0,
  sendAlert: (subject, details) =>
    sendEmail({
      to: process.env.ALERT_EMAIL || 'hello@spikeandcrush.com',
      subject: `[Spike & Crush] ${subject}`,
      text: JSON.stringify(details, null, 2),
      html: `<pre>${String(JSON.stringify(details, null, 2)).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`,
    }),
});
opsMonitor.start();
const matchRecovery = createMatchRecovery({ db, gameEngine, notifyPlayer });
// index:false - without it, static's default directory-index behavior would
// serve client/index.html for a bare "/" request before the explicit
// app.get('/') route below (landing.html) is ever reached.
// Uploaded avatars: only image files are ever served from /uploads (a file
// uploaded before validation existed can't be served as HTML).
app.use('/uploads', (req, res, next) => (/\.(png|jpe?g|gif|webp)$/i.test(req.path) ? next() : res.status(404).end()));
// Short browser cache (assets aren't fingerprinted yet) + ETag revalidation.
app.use(seo.noindexHeader);
app.get('/sitemap.xml', seo.createSitemap(db));
app.use(express.static(path.join(__dirname, '..', 'client'), { index: false, maxAge: '5m', dotfiles: 'ignore' }));

// Clean URL routes for the new pages (kept alongside the original .html
// paths, which existing client-side navigation still uses unchanged).
const CLIENT_DIR = path.join(__dirname, '..', 'client');
app.get('/', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'landing.html')));
app.get('/play', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
app.get('/wallet', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'wallet.html')));
app.get('/cards', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'cards.html')));
app.get('/challenge/:code', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'challenge.html')));
app.get('/rank', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'rank.html')));
app.get('/discover', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'discover.html')));
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
app.get('/competition/:id', seo.createCompetitionPage(db));
app.get('/contact', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'contact.html')));
app.get('/cookies', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'cookies.html')));
app.get('/thanks/:page(signup|sponsor|contact)', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'thanks.html')));
app.get('/sponsor', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'sponsor.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'analytics.html')));
app.get('/trading-floor', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'leaderboard.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'profile.html')));
app.get('/profile/:username', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'profile.html')));
app.get('/auth-callback', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'auth-callback.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'reset-password.html')));
app.get('/verify-email', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'verify-email.html')));

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

// Keyed on the real visitor, never Cloudflare's address. These are per IP and many
// real players can share one (mobile networks, offices, a family), so the API limit
// is generous: it stops floods, and per-account limits below stop targeted abuse.
const limiterDefaults = { standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => visitorIp(req) };
const API_RATE_LIMIT = Number(process.env.API_RATE_LIMIT) || 1500;
// Served from the micro-cache, so they cost almost nothing and every open lobby polls them.
const CHEAP_PUBLIC_GETS = new Set(['/lobby/stats', '/competitions', '/stats/home', '/stats/live', '/stats/activity', '/leaderboard', '/stats/ticker', '/announcements/active']);
const apiLimiter = rateLimit({ ...limiterDefaults, windowMs: 15 * 60 * 1000, max: API_RATE_LIMIT, skip: (req) => req.method === 'GET' && !req.query.search && CHEAP_PUBLIC_GETS.has(req.path) });
const authLimiter = rateLimit({ ...limiterDefaults, windowMs: 15 * 60 * 1000, max: Number(process.env.AUTH_RATE_LIMIT) || 100 });
// Password guessing against one account from anywhere, however many IPs it uses.
const loginAccountLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode < 400 || res.statusCode === 503, // busy isn't a wrong guess
  keyGenerator: (req) => `login:${String(req.body?.username || '').trim().toLowerCase().slice(0, 64)}`,
  message: { error: 'Too many failed attempts for this account. Please wait a few minutes and try again.' },
});
// Paid AI calls and spam-prone endpoints get their own, tighter limits (audit item 1).
const supportChatLimiter = rateLimit({ ...limiterDefaults, windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many messages - please wait a few minutes.' } });
const supportTicketLimiter = rateLimit({ ...limiterDefaults, windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many tickets - please wait before opening another.' } });
const clickLimiter = rateLimit({ ...limiterDefaults, windowMs: 15 * 60 * 1000, max: 30 });
app.use('/api', apiLimiter);

// Internal-only bridge for the separate admin panel (port 3003) - secret +
// localhost-gated inside the router itself, see server/internalAdmin.js.
const { createInternalAdminRouter } = require('./internalAdmin');
app.use('/internal/admin', createInternalAdminRouter({ gameEngine, compEngine, io, db, instrumentsRegistry, sabotage, TIERS, recentErrors, notifyPlayer }));
// Fire gameplay admin (market curation, Fire monitor, progression, rank split,
// Discover) on the same secret-gated bridge.
const fireAdmin = require('./fireAdmin');
app.use('/internal/admin/fire', require('./bridgeAuth').requireBridgeSecret, fireAdmin.createFireAdminRouter({
  db,
  gameEngine,
  getOnlineSettings: async (ids) => (await discoverRows(ids.slice(0, 5000))).map((p) => p.settings || {}),
}));
fireAdmin.loadConfig(db);
// Monthly season end: exclusive cosmetics for the top finishers (server/seasons.js).
require('./seasons').startSeasonJob(db, notifyPlayer);
// Saved admin Match Settings (game_config 'match_settings') apply at startup
// too, not only after an admin presses Save.
if (db.isConfigured) {
  db.getGameConfig('match_settings')
    .then((rows) => gameEngine.applyConfigOverrides(require('./internalAdmin').sanitizeMatchSettings(rows)))
    .catch((e) => console.warn('[config] match_settings not loaded:', e.message));
}
gameEngine.setFlatAlertHandler(fireAdmin.flatAlertHandler);

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

// Never fatal: a sign-up must not fail over this record.
async function recordTermsAcceptance(player, accepted) {
  if (accepted !== true) return;
  try {
    await db.updatePlayer(player.id, { terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() });
  } catch (e) {
    console.error('[terms record]', e.message);
  }
}

app.post('/api/auth/register', authLimiter, requireDb, async (req, res) => {
  try {
    const { username, email, password, turnstileToken } = req.body || {};
    if (!(await verifyTurnstile(turnstileToken, clientIp(req)))) {
      return res.status(400).json({ error: 'Please complete the check and try again.', turnstile: true });
    }
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

    // Email first: someone retrying their own unverified sign-up then gets their username back too.
    const emailOwner = await db.getPlayerByEmail(email);
    if (emailOwner && !(await releaseUnverifiedSignup(emailOwner, { anyAge: true }))) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const usernameOwner = await db.getPlayerByUsername(username);
    if (usernameOwner && !(await releaseUnverifiedSignup(usernameOwner))) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: !EMAIL_VERIFICATION_ON,
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

    // If the link can't be sent, undo the account: otherwise the player is stuck
    // with a name and email they can't use, and can't tell why.
    if (EMAIL_VERIFICATION_ON && !(await sendVerificationEmail(req, { userId: created.user.id, email, username }))) {
      await db.deletePlayer(player.id).catch(() => {});
      await supabaseAdmin.auth.admin.deleteUser(created.user.id).catch(() => {});
      return res.status(503).json({ error: 'We could not send your verification email. Please try again in a few minutes.' });
    }

    await recordTermsAcceptance(player, req.body?.termsAccepted);
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

    if (EMAIL_VERIFICATION_ON) {
      await db.recordCoinTransaction({ playerId: player.id, type: 'welcome_bonus', amount: player.coins, balanceAfter: player.coins });
      // No session yet: the welcome email and first login come after verifying.
      return res.json({ needsVerification: true, email, username, welcomeBonus: 500 });
    }

    const session = await db.createSession({ playerId: player.id, userAgent: req.headers['user-agent'], ip: clientIp(req) });
    await db.recordLoginEvent({ playerId: player.id, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    await db.recordCoinTransaction({ playerId: player.id, type: 'welcome_bonus', amount: player.coins, balanceAfter: player.coins });
    sendWelcomeEmail(player);

    const { data: signIn, error: signInErr } = await passwordSignIn({ email, password }, req);
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

app.post('/api/auth/login', authLimiter, loginAccountLimiter, requireDb, async (req, res) => {
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

    const { data: signIn, error: signInErr } = await passwordSignIn({ email: player.email, password }, req);
    if (isSignInRateLimited(signInErr)) return res.status(503).json({ error: SIGN_IN_BUSY_MESSAGE, busy: true });
    // Supabase only gets as far as "not confirmed" once the password was right.
    if (signInErr?.code === 'email_not_confirmed' && EMAIL_VERIFICATION_ON) {
      return res.status(403).json({ error: VERIFY_MESSAGE, needsVerification: true, username: player.username });
    }
    if (signInErr || !signIn.session) return res.status(401).json({ error: 'Invalid username or password' });
    if (needsEmailVerification(signIn.user)) {
      await supabaseAdmin.auth.admin.signOut(signIn.session.access_token).catch(() => {});
      return res.status(403).json({ error: VERIFY_MESSAGE, needsVerification: true, username: player.username });
    }
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
  if (typeof email === 'string' && email.length <= 254) {
    // Sent through our own email provider: Supabase's built-in sender only allows
    // a handful of emails an hour across the whole site.
    const redirectTo = `${publicSiteUrl(req)}/reset-password`;
    try {
      const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
      const link = data?.properties?.action_link;
      if (!error && link && process.env.RESEND_API_KEY) {
        const sent = await sendEmail({ to: email, ...emailVerification.passwordResetEmail({ link }) });
        if (!sent?.id) console.warn('[reset-password] email was not accepted by the provider');
      } else if (!error) {
        await supabaseAdmin.auth.resetPasswordForEmail(email, { redirectTo });
      }
      // An error here is usually "no such user", which the caller must never learn.
    } catch (e) {
      console.warn('[reset-password] send failed (not surfaced to caller):', e.message);
    }
  }
  // Always return success - never reveal whether an email exists.
  res.json({ message: 'Reset email sent if found' });
});

app.post('/api/auth/verify-email', authLimiter, requireDb, async (req, res) => {
  try {
    const parsed = emailVerification.readToken(req.body?.token, process.env.SUPABASE_SERVICE_KEY);
    if (parsed?.expired) return res.status(400).json({ error: 'This link has expired', expired: true });
    if (!parsed) return res.status(400).json({ error: 'This link is not valid' });

    const { data, error } = await supabaseAdmin.auth.admin.getUserById(parsed.userId);
    const user = data?.user;
    if (parsed.change) {
      if (error || !user) return res.status(400).json({ error: 'This link is not valid' });
      if (String(user.email).toLowerCase() === parsed.email) return res.json({ verified: true, emailChanged: true });
      const player = await db.getPlayerBySupabaseUserId(user.id);
      const taken = await db.getPlayerByEmail(parsed.email);
      if (!player || (taken && taken.id !== player.id)) return res.status(409).json({ error: 'That email is already in use' });
      const oldEmail = player.email;
      const { error: moveErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { email: parsed.email, email_confirm: true });
      if (moveErr) throw moveErr;
      await db.updatePlayer(player.id, { email: parsed.email });
      if (oldEmail) sendEmail({ to: oldEmail, ...emailVerification.emailChangedNotice({ username: player.username }) }).catch((e) => console.warn('[email change] notice failed:', e.message));
      return res.json({ verified: true, emailChanged: true });
    }
    if (error || !user || String(user.email).toLowerCase() !== parsed.email) {
      return res.status(400).json({ error: 'This link is not valid' });
    }
    if (user.email_confirmed_at) return res.json({ verified: true, alreadyVerified: true });

    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { email_confirm: true });
    if (updateErr) throw updateErr;
    const player = await db.getPlayerBySupabaseUserId(user.id);
    if (player) sendWelcomeEmail(player);
    res.json({ verified: true });
  } catch (e) {
    console.error('[verify-email]', e);
    res.status(500).json({ error: 'Could not verify your email' });
  }
});

// Same reply whatever happens, so this can't be used to find out who has an account.
app.post('/api/auth/resend-verification', authLimiter, requireDb, async (req, res) => {
  try {
    const { email, username } = req.body || {};
    let player = null;
    if (typeof email === 'string' && email) player = await db.getPlayerByEmail(email.trim());
    else if (typeof username === 'string' && username) player = await db.getPlayerByUsername(username.trim());
    if (EMAIL_VERIFICATION_ON && player?.supabase_user_id && allowVerificationResend(player.id)) {
      const { data } = await supabaseAdmin.auth.admin.getUserById(player.supabase_user_id);
      if (data?.user && !data.user.email_confirmed_at) {
        await sendVerificationEmail(req, { userId: data.user.id, email: data.user.email, username: player.username });
      }
    }
  } catch (e) {
    console.error('[resend-verification]', e.message);
  }
  res.json({ message: 'If that account is waiting to be verified, a new link is on its way.' });
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
    } = await getAuthUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });

    const existing = await db.getPlayerBySupabaseUserId(user.id);
    if (existing) return res.json({ player: await withEquippedCosmetics(existing) });
    // Google has already verified its users. An email sign-up made straight
    // against Supabase with the public key must not get a player this way,
    // because that would skip verification.
    if (EMAIL_VERIFICATION_ON && user.app_metadata?.provider === 'email') {
      return res.status(403).json({ error: 'Please sign up on the Spike & Crush site.' });
    }

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
    await recordTermsAcceptance(player, req.body?.termsAccepted);
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
  tournament: (playerInfo) => matchmaking.eliminationPlay(gameEngine, playerInfo),
  blitz: (playerInfo) => matchmaking.blitzPlay(gameEngine, playerInfo),
  grand: (playerInfo) => matchmaking.grandPlay(gameEngine, playerInfo),
  solo: (playerInfo, body) => matchmaking.soloPlay(gameEngine, playerInfo, body?.instruments),
  async: (playerInfo) => matchmaking.asyncPlay(gameEngine, playerInfo),
  private: (playerInfo, body) => matchmaking.createPrivateWar(gameEngine, playerInfo, body?.hostOptions),
};

const MAX_OPEN_MATCHES_PER_PLAYER = 3;

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

app.post('/api/match/create', deployDrain.blockNewMatches, opsMonitor.blockNewMatchesWhenFull, requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (gameEngine.isInLiveMatch(player.id)) return res.status(409).json({ error: LIVE_MATCH_BUSY_ERROR });
    const mode = MATCHMAKING_BY_MODE[req.body?.mode] ? req.body.mode : 'private';
    if (modeIdentity.identity(mode).enabled === false) return res.status(403).json({ error: 'This mode is switched off right now. Try another mode.' });
    const modeConfig = gameEngine.MATCH_MODES[mode];
    const entryCoins = modeConfig ? modeConfig.entryCoins : 0;

    // One waiting room per mode (going back and pressing Play again returns to it),
    // and a small cap overall, so one account can't pile up matches.
    const seated = gameEngine.openMatchesFor(player.id);
    const sameLobby = seated.find((m) => m.status === 'waiting' && m.mode === mode);
    if (sameLobby) return res.json({ success: true, matchId: sameLobby.id, roomCode: sameLobby.roomCode, resumed: true });
    if (seated.length >= MAX_OPEN_MATCHES_PER_PLAYER) {
      return res.status(429).json({ error: 'You already have matches running. Finish or leave one first.' });
    }

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
      const unavailable = req.body.instruments.filter((s) => !instrumentsRegistry.isPlayable(s, 'solo'));
      if (unavailable.length) return res.status(400).json({ error: `Not available right now: ${unavailable.join(', ')}` });
    }

    const playerInfo = {
      id: player.id,
      username: player.username,
      country: player.country,
      war_rating: player.war_rating,
      grand_war_rating: player.grand_war_rating,
      solo_rating: player.solo_rating,
      tier: player.tier,
      ...(await loadCardLoadout(player)),
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
    } else if (entry.key) {
      const dbMatchId = gameEngine.getMatch(result.matchId)?.dbMatchId;
      // Lets a match lost to a crash be refunded. A miss here only affects that refund.
      if (dbMatchId) db.linkEntryToMatch(entry.key, dbMatchId).catch((e) => console.warn('[match/create] entry link failed:', e.message));
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

    const playerInfo = { id: player.id, username: player.username, war_rating: player.war_rating, tier: player.tier, ...(await loadCardLoadout(player)) };
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

// The ghost run a Solo / Daily Challenge / challenge-link match races
// against (per-second P&L), for a page that loads or reconnects mid-match.
app.get('/api/match/:id/ghost', authenticate, (req, res) => {
  const match = gameEngine.getMatch(req.params.id);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (!match.players[req.tokenPlayer.id]) return res.status(403).json({ error: 'Not in this match' });
  res.json(gameEngine.getGhost(req.params.id));
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
    if (!(await verifyPasswordViaSupabase(player.email, currentPassword, req))) {
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

    let pendingEmail = null;
    if (email && email !== player.email) {
      const existing = await db.getPlayerByEmail(email);
      if (existing && existing.id !== player.id) return res.status(409).json({ error: 'Email already registered' });
      if (EMAIL_VERIFICATION_ON && player.supabase_user_id) {
        // Nothing changes until the link in the NEW inbox is clicked, so an account
        // can't be moved to an address nobody controls.
        if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return res.status(400).json({ error: 'Enter a valid email address' });
        }
        if (!allowVerificationResend(`change:${player.id}`)) {
          return res.status(429).json({ error: 'A confirmation email was sent recently. Please check your inbox or try again soon.' });
        }
        const token = emailVerification.createToken({ userId: player.supabase_user_id, email, change: true }, process.env.SUPABASE_SERVICE_KEY);
        const link = `${publicSiteUrl(req)}/verify-email?token=${encodeURIComponent(token)}`;
        const sent = await sendEmail({ to: email, ...emailVerification.emailChangeEmail({ username: player.username, link }) });
        if (!sent?.id) return res.status(502).json({ error: 'Could not send the confirmation email. Please try again.' });
        pendingEmail = email;
      } else if (player.supabase_user_id) {
        const { error: emailErr } = await supabaseAdmin.auth.admin.updateUserById(player.supabase_user_id, { email });
        if (emailErr) return res.status(400).json({ error: emailErr.message });
        updates.email = email;
      } else {
        updates.email = email;
      }
    }

    if (newPassword) {
      if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
      if (player.supabase_user_id) {
        const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(player.supabase_user_id, { password: newPassword });
        if (pwErr) return res.status(400).json({ error: pwErr.message });
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ player: sanitizePlayer(player), pendingEmail });
    }

    const updated = await db.updatePlayer(player.id, updates);
    res.json({ player: sanitizePlayer(updated), pendingEmail });
  } catch (e) {
    if (e.code === 'SIGN_IN_BUSY') return res.status(503).json({ error: e.message, busy: true });
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
    } else if (!(await verifyPasswordViaSupabase(player.email, req.body?.password || '', req))) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    await db.deletePlayer(player.id);
    if (player.supabase_user_id) await supabaseAdmin.auth.admin.deleteUser(player.supabase_user_id).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    if (e.code === 'SIGN_IN_BUSY') return res.status(503).json({ error: e.message, busy: true });
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
      presence: friendsHub.visiblePresence(player.settings, presence.getPresence(player.id)),
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
    if (settings && typeof settings === 'object') {
      // Privacy keys (Discover) only in their allowed values; the legacy
      // showOnline/allowFriends/allowInvites flags are kept in step.
      const PRIVACY_KEYS = ['appearOffline', 'statusVisibility', 'activityVisibility', 'showInDiscover', 'requestsFrom', 'invitesFrom', 'allowJoinFromDiscover'];
      const rest = Object.fromEntries(Object.entries(settings).filter(([k]) => !PRIVACY_KEYS.includes(k)));
      updates.settings = { ...player.settings, ...rest, ...discover.sanitizePrivacyPatch(settings) };
    }
    if (country !== undefined) updates.country = country;

    const updated = await db.updatePlayer(player.id, updates);
    if (updates.settings) {
      discoverRowCache.delete(player.id);
      pushDiscoverPresence(player.id, updated.settings);
    }
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
    if (!(await verifyPasswordViaSupabase(player.email, req.body?.password || '', req))) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    if (!totp.verifyTotp(player.totp_secret, req.body?.code)) return res.status(400).json({ error: 'Invalid code' });
    await db.updatePlayer(player.id, { totp_enabled: false, totp_secret: null });
    res.json({ success: true });
  } catch (e) {
    if (e.code === 'SIGN_IN_BUSY') return res.status(503).json({ error: e.message, busy: true });
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
    await db.removeFriendshipBetween(req.tokenPlayer.id, target.id);
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
      presence: friendsHub.visiblePresence(player.settings, presence.getPresence(req.params.id)),
      equippedCosmetics: equippedBySlot,
    });
  } catch (e) {
    console.error('[player profile]', e);
    res.status(500).json({ error: 'Could not load profile' });
  }
});

// ---- friends (Block 12) ----------------------------------------------------------

// Charges a lobby's entry fee and seats the player, refunding if the seat fails.
async function joinLobbyWithEntryFee(match, playerId, socketId, extra = {}) {
  const player = await db.getPlayerById(playerId);
  const entryCoins = match.config.entryCoins || 0;
  if (entryCoins > 0 && player.coins < entryCoins) {
    return { success: false, error: `Not enough coins - this lobby costs ${entryCoins} coins to join` };
  }

  const playerInfo = { id: player.id, username: player.username, country: player.country, war_rating: player.war_rating, grand_war_rating: player.grand_war_rating, solo_rating: player.solo_rating, tier: tierForRating(player.war_rating) };
  Object.assign(playerInfo, await loadCardLoadout(player), extra.fallbackUp ? { fallbackUp: true } : {});
  let entry;
  try {
    entry = await chargeEntryFee(player.id, entryCoins, match.dbMatchId);
  } catch (e) {
    if (e.code === 'INSUFFICIENT_COINS') return { success: false, error: `Not enough coins - this lobby costs ${entryCoins} coins to join` };
    throw e;
  }
  const result = gameEngine.joinMatch(match, playerInfo, socketId);
  if (!result.success) {
    await refundEntryFee(player.id, entryCoins, entry.key, match.dbMatchId);
    return { success: false, error: result.error };
  }
  if (entry.key && !recordEntryPaid(match.id, player.id, entry.key, entryCoins)) {
    await refundEntryFee(player.id, entryCoins, entry.key, match.dbMatchId);
  }
  return { success: true, player };
}

const friendRequestLimiter = friendsHub.createWindowLimiter({ max: 30, windowMs: 60 * 60 * 1000 });
const strangerInviteLimiter = friendsHub.createWindowLimiter({ max: 20, windowMs: 10 * 60 * 1000 });

// The one path for game invites into a waiting lobby (the lobby screen and
// Rematch both use it): block list, presence, privacy settings, duplicate
// and stranger rate limits, expiry. Returns { sentTo, skipped }.
async function sendLobbyInvites(inviter, match, targetIds) {
  const matchId = match.id;
  const sentTo = [];
  const skipped = [];
  const targets = [...new Set(Array.isArray(targetIds) ? targetIds : [])].filter((id) => id !== inviter.id).slice(0, 8);
  const [friendIds, blocks, targetPlayers] = await Promise.all([
    db.listFriendIds(inviter.id),
    db.listBlockRelationIds(inviter.id),
    db.getPlayersForFriendsPanel(targets),
  ]);
  const targetById = new Map(targetPlayers.map((p) => [p.id, p]));
  for (const targetId of targets) {
    const targetSockets = playerSockets.get(targetId);
    const isFriend = friendIds.includes(targetId);
    const reason = friendsHub.inviteBlockReason({
      isFriend,
      blocked: blocks.has(targetId),
      connected: Boolean(targetSockets && targetSockets.size) && targetById.has(targetId),
      presenceStatus: presence.getPresence(targetId).status,
      settings: targetById.get(targetId)?.settings,
      alreadyInvited: [...pendingInvites.values()].some((i) => i.fromPlayerId === inviter.id && i.targetPlayerId === targetId && i.lobbyId === matchId),
    });
    if (reason) {
      skipped.push({ id: targetId, reason });
      continue;
    }
    if (!isFriend && !strangerInviteLimiter(inviter.id)) {
      skipped.push({ id: targetId, reason: 'too_many' });
      continue;
    }

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
      entryCoins: match.config.entryCoins || 0,
      fromFriend: isFriend,
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
  return { sentTo, skipped };
}


function friendsPanelError(status, message) {
  return Object.assign(new Error(message), { status, friendly: true });
}

// The one path for sending a friend request, from the API or a socket.
async function createFriendRequest(requesterId, targetId) {
  if (!targetId || targetId === requesterId) throw friendsPanelError(400, 'Invalid target');
  const targetPlayer = await db.getPlayerById(targetId);
  if (!targetPlayer || targetPlayer.is_persona) throw friendsPanelError(404, 'Player not found');
  const blocks = await db.listBlockRelationIds(requesterId);
  if (blocks.has(targetId)) throw friendsPanelError(400, 'Unable to send request');
  const existing = await db.getFriendshipBetween(requesterId, targetId);
  if (existing) {
    if (existing.status === 'accepted') throw friendsPanelError(400, 'Already friends');
    if (existing.status === 'blocked') throw friendsPanelError(400, 'Unable to send request');
    throw friendsPanelError(400, existing.requester_id === targetId ? 'They already sent you a request. Accept it under Requests.' : 'Request already sent');
  }
  // Who may send requests: everyone / friends of friends / nobody (Discover privacy).
  const reqPrivacy = discover.privacy(targetPlayer.settings).requestsFrom;
  if (reqPrivacy === 'nobody') throw friendsPanelError(400, "This player isn't accepting friend requests");
  if (reqPrivacy === 'fof') {
    const [mine, theirs] = await Promise.all([db.listFriendIds(requesterId), db.listFriendIds(targetId)]);
    if (!theirs.some((id) => mine.includes(id))) throw friendsPanelError(400, 'This player only accepts requests from friends of friends');
  }
  if (!friendRequestLimiter(requesterId)) throw friendsPanelError(429, 'You have sent a lot of requests. Try again later.');

  const requester = await db.getPlayerById(requesterId);
  const row = await db.sendFriendRequest(requesterId, targetId);
  notifyPlayer(targetId, 'friend_request', `${requester.username} sent you a friend request`, {
    fromPlayerId: requesterId,
    data: { requestId: row.id, username: requester.username, tier: requester.tier },
  });
  for (const sid of playerSockets.get(targetId) || []) {
    io.to(sid).emit('friend:request_received', { requestId: row.id, fromPlayerId: requesterId, username: requester.username, tier: requester.tier });
  }
  return row;
}

// What the panel shows for someone who isn't necessarily a friend. Settings and
// ban fields stay on the server.
function friendsPanelPlayer(p, myId, friendshipRows) {
  const live = friendsHub.visiblePresence(p.settings, presence.getPresence(p.id));
  const { relation, requestId } = friendsHub.relationFor(myId, p.id, friendshipRows);
  return {
    id: p.id,
    username: p.username,
    avatarUrl: p.avatar_url,
    warRating: p.war_rating,
    tier: p.tier,
    country: p.country || null,
    status: live.status,
    relation,
    requestId,
    acceptsFriendRequests: p.settings?.allowFriends !== false,
    acceptsInvites: relation === 'friend' || p.settings?.allowInvites !== false,
  };
}

app.get('/api/friends', requireDb, authenticate, async (req, res) => {
  try {
    const friends = await db.listFriends(req.tokenPlayer.id);
    const cosmeticsByPlayer = await db.getEquippedCosmeticsForPlayers(friends.map((f) => f.id));
    const withPresence = friends.map((f) => {
      const p = friendsHub.visiblePresence(f.settings, presence.getPresence(f.id));
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
      incoming: incoming.map((r) => ({ requestId: r.id, playerId: r.requester.id, username: r.requester.username, tier: r.requester.tier, warRating: r.requester.war_rating, avatarUrl: r.requester.avatar_url, createdAt: r.created_at })),
      outgoing: outgoing.map((r) => ({ requestId: r.id, playerId: r.addressee.id, username: r.addressee.username, tier: r.addressee.tier, warRating: r.addressee.war_rating, avatarUrl: r.addressee.avatar_url, createdAt: r.created_at })),
    });
  } catch (e) {
    console.error('[friends requests]', e);
    res.status(500).json({ error: 'Could not load friend requests' });
  }
});

app.post('/api/friends/request', requireDb, authenticate, async (req, res) => {
  try {
    const row = await createFriendRequest(req.tokenPlayer.id, req.body?.targetId);
    res.json({ success: true, requestId: row.id });
  } catch (e) {
    if (e.friendly) return res.status(e.status).json({ error: e.message });
    console.error('[friend request]', e);
    res.status(500).json({ error: 'Could not send request' });
  }
});

app.delete('/api/friends/requests/:requestId', requireDb, authenticate, async (req, res) => {
  try {
    await db.cancelFriendRequest(req.params.requestId, req.tokenPlayer.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[friend request cancel]', e);
    res.status(500).json({ error: 'Could not cancel request' });
  }
});

// Blocking also ends any friendship or pending request between the two.
app.post('/api/friends/block', requireDb, authenticate, async (req, res) => {
  try {
    const targetId = req.body?.targetId;
    if (!targetId || targetId === req.tokenPlayer.id) return res.status(400).json({ error: 'Invalid target' });
    const target = await db.getPlayerById(targetId);
    if (!target) return res.status(404).json({ error: 'Player not found' });
    await db.blockPlayer(req.tokenPlayer.id, targetId);
    await db.removeFriendshipBetween(req.tokenPlayer.id, targetId);
    res.json({ success: true });
  } catch (e) {
    console.error('[friend block]', e);
    res.status(500).json({ error: 'Could not block player' });
  }
});

// Jump into a friend's open lobby without waiting for an invite.
app.post('/api/friends/:friendId/join', requireDb, authenticate, async (req, res) => {
  try {
    const playerId = req.tokenPlayer.id;
    const friendship = await db.getFriendshipBetween(playerId, req.params.friendId);
    if (!friendship || friendship.status !== 'accepted') return res.status(403).json({ error: 'You can only join friends' });
    const friend = await db.getPlayerById(req.params.friendId);
    const live = friendsHub.visiblePresence(friend?.settings, presence.getPresence(req.params.friendId));
    const match = live.status === 'in_lobby' && live.lobbyId ? gameEngine.getMatch(live.lobbyId) : null;
    if (!match || match.status !== 'waiting') return res.status(400).json({ error: 'That lobby is no longer open' });
    const result = await joinLobbyWithEntryFee(match, playerId);
    if (!result.success) return res.status(400).json({ error: result.error });
    gameEngine.pushSystemFeed(match.id, `${result.player.username} joined a friend`);
    res.json({ success: true, matchId: match.id });
  } catch (e) {
    console.error('[friend join]', e);
    res.status(500).json({ error: 'Could not join lobby' });
  }
});

// Real people connected right now: computer players have no connection, so they
// can never appear here. Only ever a list of who is reachable, never a count.
app.get('/api/players/online', requireDb, authenticate, async (req, res) => {
  try {
    const myId = req.tokenPlayer.id;
    const ids = [...playerSockets.keys()].filter((id) => id !== myId).slice(0, 200);
    const [me, players, rows, blocks] = await Promise.all([
      db.getPlayerById(myId),
      db.getPlayersForFriendsPanel(ids),
      db.listFriendshipRows(myId),
      db.listBlockRelationIds(myId),
    ]);
    const visible = players.filter((p) => !blocks.has(p.id) && !activeBan(p) && p.settings?.showOnline !== false);
    const ranked = friendsHub.rankOnlinePlayers(visible, me).slice(0, 30);
    res.json({
      // The country only orders this list on the server; whether someone is in
      // the same country is never sent (Discover privacy rule).
      players: ranked.map((p) => friendsPanelPlayer(p, myId, rows)),
    });
  } catch (e) {
    console.error('[players online]', e);
    res.status(500).json({ error: 'Could not load players' });
  }
});

// ---- Discover (Part 3B) ------------------------------------------------------------
// Find people to play with right now. Extends the friends system above (same
// friendships, blocks, invites, limits). Never returns any location data.
const discoverRowCache = new Map(); // playerId -> { row, at }
const discoverWatchers = new Map(); // watched playerId -> Set(socketId)
const discoverWatching = new Map(); // socketId -> Set(watched playerIds)
const reportLimiter = friendsHub.createWindowLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

const habitCache = new Map(); // playerId -> { habit, at }
async function playHabits(ids) {
  const now = Date.now();
  const missing = ids.filter((id) => !habitCache.has(id) || now - habitCache.get(id).at > 10 * 60 * 1000);
  if (missing.length) {
    try {
      const got = await db.listPlayHabits(missing);
      for (const [id, h] of got) habitCache.set(id, { habit: h, at: now });
    } catch (e) {
      console.warn('[discover] play habits:', e.message);
    }
  }
  if (habitCache.size > 20000) for (const [k, v] of habitCache) if (now - v.at > 10 * 60 * 1000) habitCache.delete(k);
  return new Map(ids.map((id) => [id, habitCache.get(id) ? habitCache.get(id).habit : { modes: new Set(), hours: new Set() }]));
}

async function discoverRows(ids) {
  const ttl = gameFeel.get().discover.suggestionCacheSeconds * 1000;
  const now = Date.now();
  const missing = ids.filter((id) => !discoverRowCache.has(id) || now - discoverRowCache.get(id).at > ttl);
  for (let i = 0; i < missing.length; i += 300) {
    const batch = await db.getPlayersForFriendsPanel(missing.slice(i, i + 300));
    for (const p of batch) discoverRowCache.set(p.id, { row: p, at: now });
  }
  if (discoverRowCache.size > 20000) for (const [k, v] of discoverRowCache) if (now - v.at > ttl) discoverRowCache.delete(k);
  return ids.map((id) => discoverRowCache.get(id)?.row).filter(Boolean);
}

// Push a watched player's new visible presence to everyone looking at them,
// each seeing only what the privacy rules allow them to see.
async function pushDiscoverPresence(playerId, settingsOverride = null) {
  const watchers = discoverWatchers.get(playerId);
  if (!watchers || !watchers.size) return;
  try {
    const [row] = settingsOverride ? [{ settings: settingsOverride }] : await discoverRows([playerId]);
    if (!row) return;
    const p = presence.getPresence(playerId);
    for (const sid of watchers) {
      const s = io.sockets.sockets.get(sid);
      const viewerId = s && s.data && s.data.player && s.data.player.id;
      if (!viewerId) continue;
      const friendIds = new Set(await db.listFriendIds(viewerId).catch(() => []));
      const rel = discover.relation(viewerId, playerId, { friendIds });
      s.emit('discover:presence', { id: playerId, ...discover.presenceView(p, row.settings, rel) });
    }
  } catch (e) {
    console.warn('[discover] push failed:', e.message);
  }
}
presence.onChange((playerId) => {
  discoverRowCache.delete(playerId);
  pushDiscoverPresence(playerId);
});

function discoverOff(res) {
  if (gameFeel.get().discover.enabled) return false;
  res.status(403).json({ error: 'Discover is switched off right now' });
  return true;
}

// GET /api/discover?section=friends|live|rooms|suggested&page=0&q=&tier=&level=&mode=&played=1
app.get('/api/discover', requireDb, authenticate, async (req, res) => {
  if (discoverOff(res)) return;
  try {
    const myId = req.tokenPlayer.id;
    const section = String(req.query.section || 'live');
    const [me, friendIdList, blocks] = await Promise.all([db.getPlayerById(myId), db.listFriendIds(myId), db.listBlockRelationIds(myId)]);
    const friendIds = new Set(friendIdList);

    if (section === 'rooms') {
      // Public lobbies still open to join (closed once a short game starts).
      const rooms = ['quick', 'blitz', 'grand']
        .flatMap((mode) => gameEngine.listWaitingMatchesByMode(mode))
        .filter((m) => m.status === 'waiting' && !gameEngine.isFull(m))
        .filter((m) => !Object.keys(m.players).some((id) => blocks.has(id)))
        .map((m) => ({ matchId: m.id, mode: m.mode, label: m.config.label, players: Object.values(m.players).length, maxPlayers: m.config.maxPlayers, entryCoins: m.config.entryCoins || 0, lobbyTier: m.lobbyTier || null }));
      return res.json(discover.paginate(rooms, req.query.page));
    }

    let ids;
    if (section === 'friends') ids = friendIdList.filter((id) => playerSockets.has(id));
    else ids = [...playerSockets.keys()].filter((id) => id !== myId);
    const rows = (await discoverRows(ids)).filter((c) => (section === 'friends' ? !blocks.has(c.id) && !activeBan(c) : discover.listable(myId, c, { blocked: blocks })));

    const playedWith = new Set(req.query.played || section === 'suggested' ? await db.listRecentCoPlayers(myId).catch(() => []) : []);
    let list = rows;
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) list = list.filter((c) => c.username.toLowerCase().includes(q));
    if (req.query.tier) list = list.filter((c) => (c.tier || tierForRating(c.war_rating)) === (me.tier || tierForRating(me.war_rating)));
    if (req.query.played) list = list.filter((c) => playedWith.has(c.id));
    if (req.query.mode) list = list.filter((c) => (presence.getPresence(c.id).mode || '') === String(req.query.mode));

    const theirFriends = await db.listFriendIdsForMany(list.slice(0, 400).map((c) => c.id)).catch(() => new Map());
    const mutual = (id) => [...(theirFriends.get(id) || [])].filter((f) => friendIds.has(f)).length;
    if (section === 'suggested') {
      // Same modes and similar hours come from real match history (cached
      // per player for a few minutes; neither is ever shown).
      const pool = list.filter((c) => !friendIds.has(c.id)).slice(0, 400);
      const habits = await playHabits([myId, ...pool.map((c) => c.id)]);
      const mine = habits.get(myId) || { modes: new Set(), hours: new Set() };
      // Hours within one hour either side count as "similar".
      const myHours = new Set([...mine.hours].flatMap((h) => [(h + 23) % 24, h, (h + 1) % 24]));
      const ctx = { me, fofCount: mutual, playedWith, myModes: mine.modes, theirModes: (id) => (habits.get(id) || {}).modes, myHours, theirHours: (id) => (habits.get(id) || {}).hours };
      list = list.filter((c) => !friendIds.has(c.id)).map((c) => ({ c, s: discover.score(c, ctx) })).sort((a, b) => b.s - a.s).map((x) => x.c);
    } else {
      list = friendsHub.rankOnlinePlayers(list, me);
    }
    if (req.query.level) {
      const myLevel = progression.standing(me).level;
      list = list.filter((c) => Math.abs((discoverRowCache.get(c.id)?.level || myLevel) - myLevel) <= 3);
    }
    // Anyone this viewer may not see as online is left out entirely: being in
    // a "live" list would itself reveal that they're online.
    const visible = list
      .map((c) => {
        const rel = discover.relation(myId, c.id, { friendIds, targetFriendIds: theirFriends.get(c.id) });
        return { c, rel, view: discover.presenceView(presence.getPresence(c.id), c.settings, rel) };
      })
      .filter((x) => x.view.state !== 'offline');
    const page = discover.paginate(visible, req.query.page);
    const equippedById = await db.getEquippedCosmeticsForPlayers(page.items.map((x) => x.c.id)).catch(() => ({}));
    const titleOf = (id) => {
      const t = equippedById[id] && equippedById[id].title;
      const it = t && cosmetics.findItem(t);
      return it ? it.name : null;
    };
    page.items = page.items.map(({ c, rel, view }) => discover.row(c, view, { relation: rel, title: titleOf(c.id), mutualFriends: mutual(c.id), canRequest: rel !== 'friend' && discover.canRequest(c.settings, rel), canInvite: discover.canInvite(c.settings, rel) }));
    // An honest empty state: no padding with fake or seeded players.
    page.emptyMessage = page.total ? null : section === 'friends' ? 'None of your friends are online right now.' : 'Not many traders are online right now. Try a ghost challenge or a Solo match.';
    res.json(page);
  } catch (e) {
    console.error('[discover]', e);
    res.status(500).json({ error: 'Could not load Discover' });
  }
});

// Invite to match from Discover: into the inviter's waiting lobby if they're
// in one, otherwise a new Private War room; same invite rules as the lobby.
app.post('/api/discover/invite', requireDb, authenticate, async (req, res) => {
  if (discoverOff(res)) return;
  try {
    const { targetId } = req.body || {};
    const me = await db.getPlayerById(req.tokenPlayer.id);
    const [friendIdList, blocks, [target]] = await Promise.all([db.listFriendIds(me.id), db.listBlockRelationIds(me.id), db.getPlayersForFriendsPanel([targetId])]);
    if (!target || blocks.has(targetId)) return res.status(404).json({ error: 'Player not found' });
    const theirFriends = (await db.listFriendIdsForMany([targetId])).get(targetId);
    const rel = discover.relation(me.id, targetId, { friendIds: new Set(friendIdList), targetFriendIds: theirFriends });
    if (!discover.canInvite(target.settings, rel)) return res.status(403).json({ error: 'This player is not accepting invites from you' });
    const pres = presence.getPresence(me.id);
    let room = pres.status === 'in_lobby' && pres.lobbyId ? gameEngine.getMatch(pres.lobbyId) : null;
    if (!room || room.status !== 'waiting' || !room.players[me.id]) {
      if (gameEngine.isInLiveMatch(me.id)) return res.status(409).json({ error: LIVE_MATCH_BUSY_ERROR });
      const made = await matchmaking.createPrivateWar(gameEngine, { id: me.id, username: me.username, country: me.country, war_rating: me.war_rating, tier: tierForRating(me.war_rating), ...(await loadCardLoadout(me)) });
      if (!made.success) return res.status(400).json(made);
      room = gameEngine.getMatch(made.matchId);
    }
    const { sentTo, skipped } = await sendLobbyInvites(room.players[me.id], room, [targetId]);
    res.json({ matchId: room.id, sent: sentTo.length === 1, reason: skipped[0] ? skipped[0].reason : null });
  } catch (e) {
    console.error('[discover invite]', e);
    res.status(500).json({ error: 'Could not send the invite' });
  }
});

// Join an open public lobby from Discover (closed once the game starts; the
// lobby's own rules - capacity, entry coins, rank split - still apply).
app.post('/api/discover/join', requireDb, authenticate, async (req, res) => {
  if (discoverOff(res)) return;
  try {
    const { lobbyId } = req.body || {};
    const match = gameEngine.getMatch(lobbyId);
    if (!match || match.status !== 'waiting' || !['quick', 'blitz', 'grand'].includes(match.mode)) return res.status(400).json({ error: 'That room is no longer open' });
    const blocks = await db.listBlockRelationIds(req.tokenPlayer.id);
    if (Object.keys(match.players).some((id) => blocks.has(id))) return res.status(400).json({ error: 'That room is no longer open' });
    const result = await joinLobbyWithEntryFee(match, req.tokenPlayer.id);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, matchId: match.id });
  } catch (e) {
    console.error('[discover join]', e);
    res.status(500).json({ error: 'Could not join' });
  }
});

app.get('/api/settings/privacy', requireDb, authenticate, async (req, res) => {
  const player = await db.getPlayerById(req.tokenPlayer.id);
  res.json(discover.privacy(player && player.settings));
});

// Block (the existing friends block) and Report (the existing moderation queue).
app.post('/api/players/report', requireDb, authenticate, async (req, res) => {
  try {
    const { targetId, reason, matchId } = req.body || {};
    const REASONS = ['cheating', 'abusive_name', 'spam', 'harassment', 'underage', 'other'];
    if (!targetId || targetId === req.tokenPlayer.id) return res.status(400).json({ error: 'Invalid player' });
    if (!REASONS.includes(reason)) return res.status(400).json({ error: `reason must be one of ${REASONS.join(', ')}` });
    if (!reportLimiter(req.tokenPlayer.id)) return res.status(429).json({ error: 'Too many reports. Try again later.' });
    await db.createPlayerReport({ reporterId: req.tokenPlayer.id, reportedId: targetId, reason, matchId: matchId || null });
    res.json({ success: true });
  } catch (e) {
    console.error('[report]', e);
    res.status(500).json({ error: 'Could not send the report' });
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
    const q = String(req.query.q || '').trim().slice(0, 30);
    if (q.length < 2) return res.json({ players: [] });
    const myId = req.tokenPlayer.id;
    const [found, rows, blocks] = await Promise.all([
      db.searchPlayers(friendsHub.escapeLikePattern(q), myId, 25),
      db.listFriendshipRows(myId),
      db.listBlockRelationIds(myId),
    ]);
    const visible = found.filter((p) => !blocks.has(p.id) && !activeBan(p));
    res.json({ players: friendsHub.rankSearchResults(visible, q).slice(0, 15).map((p) => friendsPanelPlayer(p, myId, rows)) });
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
    // Fire gameplay: which cards this player has unlocked, and how to unlock
    // the rest (earned by playing only - coins never buy a card).
    const prog = await loadProgression(player);
    const byId = Object.fromEntries(progression.collection(prog.standing, prog.grants).map((c) => [c.id, c]));
    for (const c of cards) Object.assign(c, { unlocked: byId[c.id].unlocked, basic: byId[c.id].basic, unlockText: byId[c.id].unlockText });
    const nextUnlock =
      player.wins < 50
        ? { variant: 'silver', winsNeeded: 50 - player.wins }
        : player.wins < 200
        ? { variant: 'gold', winsNeeded: 200 - player.wins }
        : null;
    res.json({ cards, wins: player.wins, currentVariant: variant, nextUnlock, level: progression.levelInfo(prog.standing.xp), tier: tierForRating(player.war_rating) });
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
    // Shop items, or earned cosmetics (rank items, season rewards - never sold).
    const earnedItem = shop.findItem(itemId) ? null : cosmetics.findItem(itemId);
    const item = shop.findItem(itemId) || earnedItem;
    if (!item) return res.status(404).json({ error: 'Unknown item' });
    const slot = earnedItem ? cosmetics.SLOT_BY_TYPE[item.type] : shop.SLOT_BY_TYPE[item.type];
    if (!slot) return res.status(400).json({ error: 'This item type is not equippable' });

    if (earnedItem) {
      const me = await db.getPlayerById(req.tokenPlayer.id);
      const stored = (await db.listEarnedCosmetics(me.id)).map((r) => r.item_id);
      if (!cosmetics.entitled(tierForRating(me.war_rating), stored).some((i) => i.id === itemId)) return res.status(403).json({ error: 'You have not earned this item yet' });
    } else {
      const owned = await db.listShopPurchases(req.tokenPlayer.id);
      const isFree = item.price === 0;
      if (!isFree && !owned.some((o) => o.item_id === itemId)) return res.status(403).json({ error: 'You do not own this item' });
    }

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
    // The path only: these responses don't vary by query string, and keying on the
    // full URL would let anyone skip the cache by adding ?x=1 to every request.
    const key = req.path;
    const hit = microCache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) {
      res.set('X-Cache', 'HIT');
      return res.status(hit.status).json(hit.body);
    }
    const pending = microInflight.get(key);
    if (pending) {
      // Someone is already refreshing this: never start another. Last good answer
      // straight away if there is one, otherwise wait for theirs.
      if (hit) {
        res.set('X-Cache', 'STALE');
        return res.status(hit.status).json(hit.body);
      }
      const shared = await pending;
      if (shared) {
        res.set('X-Cache', 'SHARED');
        return res.status(shared.status).json(shared.body);
      }
      return res.status(503).json({ error: 'Busy, please try again shortly.' });
    }
    let settle;
    microInflight.set(key, new Promise((r) => { settle = r; }));
    const finish = (val) => { microInflight.delete(key); settle(val); };
    const origJson = res.json.bind(res);
    res.json = (body) => {
      // The refresh failed: keep showing the last good answer.
      if (res.statusCode >= 400 && hit) {
        finish(null);
        res.status(hit.status);
        res.set('X-Cache', 'STALE');
        return origJson(hit.body);
      }
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

    if (matchup.matchId && gameEngine.getMatch(matchup.matchId)) return res.json({ matchId: matchup.matchId });
    if (matchup.matchId) {
      // The round's match isn't on this server. If it finished, the bracket update
      // is on its way; if a crash lost it, the round is played again.
      const row = await db.getMatch(matchup.matchId).catch(() => null);
      if (row && row.status !== 'voided') return res.status(409).json({ error: 'This round was interrupted. You can replay it in a few minutes.' });
      matchup.matchId = null;
      matchup.status = 'ready';
    }

    const [playerA, playerB] = await Promise.all([db.getPlayerById(matchup.playerAId), db.getPlayerById(matchup.playerBId)]);
    const [loadA, loadB] = await Promise.all([loadCardLoadout(playerA), loadCardLoadout(playerB)]);
    const toPlayerInfo = (p) => ({ id: p.id, username: p.username, country: p.country, war_rating: p.war_rating, tier: tierForRating(p.war_rating) });

    const match = await gameEngine.createMatch('tournament', {
      // Bracket rounds keep their original shape: exactly 2 players, no lobby
      // fill, no entry fee. (The 'tournament' key is also the public
      // Elimination mode; with 2 players no cut ever happens.)
      configOverrides: { tournamentId: t.id, round: myReg.current_round, matchupIndex: matchup.matchup, label: 'Tournament round', maxPlayers: 2, idealPlayers: 2, minPlayers: 2, fillMethod: 'none', entryCoins: 0, lobbyTimeoutMs: 0 },
    });
    gameEngine.joinMatch(match, { ...toPlayerInfo(playerA), ...loadA });
    gameEngine.joinMatch(match, { ...toPlayerInfo(playerB), ...loadB });

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

// ---- analytics dashboard --------------------------------------------------------
// Open to everyone while Premium isn't on sale: nobody could unlock it otherwise.

app.get('/api/analytics', requireDb, authenticate, async (req, res) => {
  try {
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
    const owner = await db.getPlayerById(req.tokenPlayer.id);
    const { unlockedCards } = await loadProgression(owner);
    const locked = cardTypes.filter((t) => !unlockedCards.includes(t));
    if (locked.length) return res.status(400).json({ error: `Locked card in deck: ${locked.join(', ')}. Unlock it by playing first.` });
    const deck = await db.saveCardDeck(req.tokenPlayer.id, cardTypes);
    res.json({ cardTypes: deck.card_types });
  } catch (e) {
    console.error('[deck save]', e);
    res.status(500).json({ error: 'Could not save deck' });
  }
});

// ---- fire gameplay: progression, ghost challenges, rematch -------------------------

// Level, XP, rank (rating tier), rank benefits, the next unlocks and the full
// card collection for the profile / rank screen.
// Public card list for the rules page: every card, what it does, its rarity
// and how it unlocks (built from the live deck, never a hand-kept copy).
app.get('/api/cards/catalog', (req, res) => {
  res.json({ cards: progression.collection(progression.standing({})).map(({ id, name, kind, rarity, description, unlockText }) => ({ id, name, kind, rarity, description, unlockText })) });
});

app.get('/api/progression/me', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const prog = await loadProgression(player);
    const collection = progression.collection(prog.standing, prog.grants);
    const next = collection.filter((c) => !c.unlocked && c.unlockRule && c.unlockRule.level).sort((a, b) => a.unlockRule.level - b.unlockRule.level).slice(0, 3);
    res.json({
      level: progression.levelInfo(prog.standing.xp),
      rank: tierForRating(player.war_rating),
      rating: player.war_rating,
      tiers: TIERS.map((t) => ({ name: t.name, min: t.min, max: Number.isFinite(t.max) ? t.max : null })),
      benefits: progression.rankBenefits(),
      bestStreak: prog.stored?.best_streak || 0,
      bestHeat: prog.stored?.best_heat || 0,
      season: { id: progression.season(), xp: prog.stored && prog.stored.season === progression.season() ? prog.stored.season_xp : 0 },
      xpToday: prog.stored && prog.stored.xp_day === new Date().toISOString().slice(0, 10) ? prog.stored.xp_today : 0,
      dailyCap: gameFeel.get().progression.xp.perDayCap,
      nextUnlocks: next.map((c) => ({ id: c.id, name: c.name, icon: c.icon, unlockText: c.unlockText })),
      collection,
      persisted: Boolean(prog.stored),
    });
  } catch (e) {
    console.error('[progression/me]', e);
    res.status(500).json({ error: 'Could not load progression' });
  }
});

// Earned cosmetics and the monthly season (rank page).
app.get('/api/cosmetics/me', requireDb, authenticate, async (req, res) => {
  try {
    const me = await db.getPlayerById(req.tokenPlayer.id);
    const [storedRows, equipped, stored] = await Promise.all([db.listEarnedCosmetics(me.id), db.getEquippedCosmetics(me.id).catch(() => []), db.getProgress(me.id).catch(() => null)]);
    const slots = Object.fromEntries((equipped || []).map((r) => [r.slot, r.item_id]));
    const items = cosmetics.entitled(tierForRating(me.war_rating), storedRows.map((r) => r.item_id)).map((i) => ({ ...i, slot: cosmetics.SLOT_BY_TYPE[i.type], equipped: slots[cosmetics.SLOT_BY_TYPE[i.type]] === i.id }));
    const season = progression.season();
    const seasonXp = stored && stored.season === season ? stored.season_xp : 0;
    const now = new Date();
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    res.json({
      items,
      season: {
        id: season,
        xp: seasonXp,
        rank: cosmetics.seasonRank(seasonXp),
        ranks: cosmetics.SEASON_RANKS,
        daysLeft: Math.ceil((end - now.getTime()) / 86400000),
        rewards: [
          { place: '1st', items: cosmetics.seasonRewardsFor(season, 1).map((i) => i.name) },
          { place: 'Top 10', items: cosmetics.seasonRewardsFor(season, 10).map((i) => i.name) },
          { place: 'Top 100', items: cosmetics.seasonRewardsFor(season, 100).map((i) => i.name) },
        ],
      },
      rankItems: cosmetics.RANK_ITEMS.map((i) => ({ id: i.id, name: i.name, type: i.type, tier: i.tier })),
    });
  } catch (e) {
    console.error('[cosmetics/me]', e);
    res.status(500).json({ error: 'Could not load cosmetics' });
  }
});

const challengeLinks = require('./challenge');

// Creates a share link for the match the player just finished: same
// instruments, seed and start offsets, with their result to beat.
app.post('/api/challenge', requireDb, authenticate, async (req, res) => {
  try {
    if (!gameFeel.get().ghostChallenge.enabled) return res.status(403).json({ error: 'Challenges are switched off' });
    const { matchId } = req.body || {};
    const market = gameEngine.getMatchMarket(matchId);
    if (!market || !market.endPayload) return res.status(400).json({ error: 'That match is not finished or no longer available' });
    if (!market.humanIds.includes(req.tokenPlayer.id)) return res.status(403).json({ error: 'You were not in that match' });
    if (!Object.keys(market.marketStarts).length) return res.status(400).json({ error: 'This match cannot be replayed as a challenge' });
    const mine = market.endPayload.results.find((r) => r.playerId === req.tokenPlayer.id);
    const code = challengeLinks.create({
      creatorId: req.tokenPlayer.id,
      username: mine ? mine.username : 'A trader',
      mode: market.mode,
      instruments: market.instruments.filter((s) => market.marketStarts[s] !== undefined),
      marketSeed: market.marketSeed,
      marketStarts: market.marketStarts,
      durationSeconds: market.durationSeconds,
      pnl: mine ? mine.pnl : 0,
      rank: mine ? mine.rank : null,
      sourceMatchId: matchId,
    });
    const base = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ code, url: `${base.replace(/\/$/, '')}/challenge/${code}`, result: { pnl: mine ? mine.pnl : 0, rank: mine ? mine.rank : null } });
  } catch (e) {
    console.error('[challenge create]', e);
    res.status(500).json({ error: 'Could not create the challenge' });
  }
});

app.get('/api/challenge/:code', (req, res) => {
  const r = challengeLinks.read(req.params.code);
  if (!r.ok) return res.status(r.expired ? 410 : 400).json({ error: r.error });
  const c = r.challenge;
  res.json({ username: c.username, instruments: c.instruments, durationSeconds: c.durationSeconds, pnl: c.pnl, rank: c.rank, expiresAt: c.expiresAt });
});

// Starts the friend's run: a private, unranked match on the exact same market
// (same seed and start offsets, so byte-identical prices), no AI opponents,
// free to play, results never touch ratings or prizes.
app.post('/api/challenge/:code/start', requireDb, authenticate, async (req, res) => {
  try {
    const r = challengeLinks.read(req.params.code);
    if (!r.ok) return res.status(r.expired ? 410 : 400).json({ error: r.error });
    const c = r.challenge;
    if (gameEngine.isInLiveMatch(req.tokenPlayer.id)) return res.status(409).json({ error: LIVE_MATCH_BUSY_ERROR });
    const player = await db.getPlayerById(req.tokenPlayer.id);
    const match = await gameEngine.createMatch('solo', {
      instrumentList: c.instruments,
      marketSeed: c.marketSeed,
      marketStarts: c.marketStarts,
      configOverrides: {
        label: 'Ghost Challenge',
        durationSeconds: c.durationSeconds,
        ranked: false,
        ratingKey: null,
        fillMethod: 'none',
        aiOpponents: 0,
        entryCoins: 0,
        challenge: { username: c.username, pnl: c.pnl, creatorId: c.creatorId, sourceMatchId: c.sourceMatchId },
      },
    });
    const joined = gameEngine.joinMatch(match, { id: player.id, username: player.username, country: player.country, war_rating: player.war_rating, tier: tierForRating(player.war_rating), ...(await loadCardLoadout(player)) });
    if (!joined.success) return res.status(400).json(joined);
    res.json({ matchId: match.id, roomCode: match.roomCode });
  } catch (e) {
    console.error('[challenge start]', e);
    res.status(500).json({ error: 'Could not start the challenge' });
  }
});

// Rank-split empty-lobby fallback (only when the split is on): alone in a
// ranked lobby for rankSplit.emptyLobbyFallbackSeconds -> offer an open lobby
// one tier up (allowed once even when joinUpTiers is 0), or Solo / a ghost
// challenge. No bots are added for this.
function fallbackFor(match, playerId) {
  const cfg = gameFeel.get().rankSplit;
  if (!rankSplit.enabled() || !match || match.status !== 'waiting' || !match.lobbyTier || !match.players[playerId]) return null;
  const humans = Object.values(match.players).filter((p) => !p.isAI);
  const waited = (Date.now() - match.createdAt) / 1000;
  if (humans.length > 1 || waited < cfg.emptyLobbyFallbackSeconds) return { offer: false, waitSeconds: Math.max(0, Math.ceil(cfg.emptyLobbyFallbackSeconds - waited)) };
  const up = rankSplit.tierAbove(match.lobbyTier);
  const room = up
    ? gameEngine.listWaitingMatchesByMode(match.mode).find((m) => m.id !== match.id && m.lobbyTier === up && !gameEngine.isFull(m))
    : null;
  return { offer: true, upTier: room ? { matchId: room.id, tier: rankSplit.tierLabel(up), players: Object.keys(room.players).length } : null, solo: true, ghost: true };
}

app.get('/api/match/:id/fallback', requireDb, authenticate, (req, res) => {
  res.json(fallbackFor(gameEngine.getMatch(req.params.id), req.tokenPlayer.id) || { offer: false });
});

app.post('/api/match/:id/fallback', requireDb, authenticate, async (req, res) => {
  try {
    const current = gameEngine.getMatch(req.params.id);
    const f = fallbackFor(current, req.tokenPlayer.id);
    if (!f || !f.offer || !f.upTier) return res.status(400).json({ error: 'No lobby one tier up is open right now' });
    const target = gameEngine.getMatch(f.upTier.matchId);
    const left = await gameEngine.leaveMatch(current.id, req.tokenPlayer.id);
    if (!left.success) return res.status(400).json(left);
    const result = await joinLobbyWithEntryFee(target, req.tokenPlayer.id, null, { fallbackUp: true });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, matchId: target.id });
  } catch (e) {
    console.error('[rank fallback]', e);
    res.status(500).json({ error: 'Could not move you to that lobby' });
  }
});

// Rematch: a fresh Private War room hosted by the player, with invites sent
// to everyone from the finished match who is still online (the normal lobby
// invite rules apply: blocks, privacy settings, rate limits, expiry).
app.post('/api/match/rematch', requireDb, authenticate, async (req, res) => {
  try {
    const { matchId } = req.body || {};
    const market = gameEngine.getMatchMarket(matchId);
    if (!market || !market.endPayload) return res.status(400).json({ error: 'That match is no longer available for a rematch' });
    if (!market.humanIds.includes(req.tokenPlayer.id)) return res.status(403).json({ error: 'You were not in that match' });
    if (gameEngine.isInLiveMatch(req.tokenPlayer.id)) return res.status(409).json({ error: LIVE_MATCH_BUSY_ERROR });
    const player = await db.getPlayerById(req.tokenPlayer.id);
    const info = { id: player.id, username: player.username, country: player.country, war_rating: player.war_rating, tier: tierForRating(player.war_rating), ...(await loadCardLoadout(player)) };
    const made = await matchmaking.createPrivateWar(gameEngine, info);
    if (!made.success) return res.status(400).json(made);
    const room = gameEngine.getMatch(made.matchId);
    const stillHere = market.humanIds.filter((id) => id !== player.id && playerSockets.has(id));
    const { sentTo, skipped } = stillHere.length ? await sendLobbyInvites(room.players[player.id], room, stillHere) : { sentTo: [], skipped: [] };
    res.json({ matchId: made.matchId, roomCode: made.roomCode, invited: sentTo.length, skipped: skipped.length });
  } catch (e) {
    console.error('[rematch]', e);
    res.status(500).json({ error: 'Could not start a rematch' });
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
mountSupport({ app, io, supabaseAdmin, getAuthUser, db, notifyPlayer, clientIp, limiters: { message: supportChatLimiter, ticket: supportTicketLimiter } });

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
    emailVerification: EMAIL_VERIFICATION_ON,
    turnstileSiteKey: turnstile.isOn() ? turnstile.siteKey() : null,
    analyticsProvider: ['plausible', 'ga4'].includes(process.env.ANALYTICS_PROVIDER) && process.env.ANALYTICS_ID ? process.env.ANALYTICS_PROVIDER : 'none',
    analyticsId: process.env.ANALYTICS_ID || null,
    termsVersion: TERMS_VERSION,
    legalReviewed: process.env.LEGAL_REVIEWED === 'true',
    company: {
      name: process.env.COMPANY_LEGAL_NAME || null,
      address: process.env.COMPANY_ADDRESS || null,
      regNo: process.env.COMPANY_REG_NO || null,
      minimumAge: process.env.MINIMUM_AGE || null,
      governingLaw: process.env.GOVERNING_LAW || null,
    },
  });
});

// ---- lobby + sponsors (server/lobby.js) ------------------------------------------

app.use(
  createLobbyRouter({ db, gameEngine, instrumentsRegistry, playerSockets, competitionSummary, TIERS, authenticate: [requireDb, authenticate], optionalViewerId })
);

// ---- home page stats --------------------------------------------------------------

// Public mode catalog for the lobby cards, Compare modes sheet and How to
// play: identity, best for, win condition, card slots and live seats, with
// the real length and entry from MATCH_MODES (never redefined here).
app.get('/api/modes/catalog', cacheJson(10000), (req, res) => {
  const counts = gameEngine.getModeCounts();
  const modes = modeIdentity.publicCatalog().map((m) => {
    const mm = gameEngine.MATCH_MODES[m.key] || {};
    return { ...m, durationSeconds: mm.durationSeconds || null, entryCoins: mm.entryCoins || 0, minPlayers: m.key === 'tournament' ? modeIdentity.identity('tournament').elimination.minPlayersToStart : mm.minPlayers || 1, live: counts[m.key] || 0 };
  });
  res.json({ modes });
});

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
    } = await getAuthUser(token);
    if (!user) return null;
    const player = await db.getPlayerBySupabaseUserId(user.id);
    return player?.id || null;
  } catch (e) {
    return null;
  }
}

// The board is computed once and shared; each caller's own "your rank" row is added
// per request. (Caching the whole response handed one player's row to everyone.)
const boardMemo = createMemo();
const BOARD_CACHE_MS = 10000;
app.get('/api/leaderboard', requireDb, async (req, res) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 10);
    const tierFilter = req.query.tier && req.query.tier !== 'All' ? req.query.tier : null;
    const period = req.query.period === 'week' || req.query.period === 'month' ? req.query.period : 'all';
    const search = req.query.search ? String(req.query.search).slice(0, 40) : null;
    const viewerId = await optionalViewerId(req);

    const loadRows = async () => {
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
      return rows.sort((a, b) => b.metric - a.metric).map((r, i) => ({ ...r, rank: i + 1 }));
    };
    // Searches are rare and vary, so only the plain boards are shared.
    const rows = search ? await loadRows() : await boardMemo(`${period}:${tierFilter || ''}`, BOARD_CACHE_MS, loadRows);

    const addCosmetics = (list, cosmetics) =>
      list.map((r) => ({
        ...r,
        equipped_nameplate: cosmetics[r.id]?.nameplate || 'name_standard',
        equipped_frame: cosmetics[r.id]?.avatar_frame || 'none',
      }));
    const pageRows = rows.slice(0, limit);
    const loadPage = async () => addCosmetics(pageRows, await db.getEquippedCosmeticsForPlayers(pageRows.map((r) => r.id)));
    const page = search ? await loadPage() : await boardMemo(`page:${period}:${tierFilter || ''}:${limit}`, BOARD_CACHE_MS, loadPage);

    const viewerRow = viewerId ? rows.find((r) => r.id === viewerId) : null;
    const viewerInPage = viewerRow && page.some((r) => r.id === viewerId);
    const viewerRank = viewerRow && !viewerInPage ? addCosmetics([viewerRow], await db.getEquippedCosmeticsForPlayers([viewerRow.id]))[0] : null;

    res.json({ leaderboard: page, period, tiers: TIERS.map((t) => t.name), viewerRank });
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
    } = await getAuthUser(token);
    if (error || !user) return next(new Error('unauthorized'));
    if (needsEmailVerification(user)) return next(new Error('unverified'));

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
    gameEngine.noteSiteConnected(notifyPid);

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
          gameEngine.noteSiteDisconnected(notifyPid);
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

  // Live match card (client/js/live-match.js): the player's current match,
  // readable and forfeitable from any page, without being bound to the match.
  socket.on('match:live', (_data, ack) => {
    if (typeof ack === 'function') ack({ success: true, live: notifyPid ? gameEngine.getLiveMatchStatus(notifyPid) : null });
  });

  socket.on('match:forfeit', async (data, ack) => {
    const result = notifyPid ? await gameEngine.forfeitLiveMatch(notifyPid, data?.matchId) : { success: false, error: 'Not logged in' };
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
      const row = await createFriendRequest(socket.data.player.id, targetId);
      ack?.({ success: true, requestId: row.id });
    } catch (e) {
      if (e.friendly) return ack?.({ success: false, error: e.message });
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

      const { sentTo, skipped } = await sendLobbyInvites(inviter, match, targetIds);
      ack?.({ success: true, sentTo, skipped });
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

      const joined = await joinLobbyWithEntryFee(match, socket.data.player.id, socket.id);
      if (!joined.success) return ack?.({ success: false, error: joined.error });
      const { player } = joined;
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

  // ---- Discover: live presence diffs for the rows a player is looking at ----
  socket.on('discover:watch', ({ ids } = {}) => {
    if (!socket.data.player) return;
    const next = new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string').slice(0, 60));
    for (const id of discoverWatching.get(socket.id) || []) {
      if (next.has(id)) continue;
      const set = discoverWatchers.get(id);
      if (set) {
        set.delete(socket.id);
        if (!set.size) discoverWatchers.delete(id);
      }
    }
    for (const id of next) {
      if (!discoverWatchers.has(id)) discoverWatchers.set(id, new Set());
      discoverWatchers.get(id).add(socket.id);
    }
    discoverWatching.set(socket.id, next);
  });
  // Away = the app is open but hidden; back to online when it's visible again.
  socket.on('presence:heartbeat', ({ visible } = {}) => {
    const id = socket.data.player && socket.data.player.id;
    if (!id) return;
    const cur = presence.getPresence(id);
    if (cur.status === 'in_match' || cur.status === 'in_lobby' || cur.status === 'offline') return;
    const want = visible === false ? 'away' : 'online';
    if (cur.status !== want) updatePresence(id, { status: want });
  });

  socket.on('disconnect', () => {
    gameEngine.handleDisconnect(socket.id);
    for (const id of discoverWatching.get(socket.id) || []) {
      const set = discoverWatchers.get(id);
      if (set) {
        set.delete(socket.id);
        if (!set.size) discoverWatchers.delete(id);
      }
    }
    discoverWatching.delete(socket.id);
  });
});

// Catches multer (avatar upload) errors and anything else thrown/passed to
// next() by earlier middleware, so clients always get JSON instead of
// Express's default HTML error page.
// eslint-disable-next-line no-unused-vars
// Last of all: nothing above matched.
app.use(seo.notFoundHandler);

app.use((err, req, res, next) => {
  console.error('[unhandled route error]', err);
  if (seo.errorPageFor(req, res, err)) return;
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
  startRetention(db);
  setInterval(() => gameEngine.sweepIdleLobbies().catch((e) => console.warn('[lobbies] sweep failed:', e.message)), LOBBY_SWEEP_MS).unref();
  setInterval(() => matchRecovery.sweep(), MATCH_RECOVERY_SWEEP_MS).unref();
  matchRecovery.sweep();
  if (!db.isConfigured) {
    console.warn(
      'Running WITHOUT a configured database - accounts, matchmaking persistence and leaderboards are disabled until SUPABASE_SERVICE_KEY is set in .env.'
    );
  }
});
