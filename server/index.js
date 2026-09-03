'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // still used for the legacy-account migration path in /api/auth/login
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const Stripe = require('stripe');

const db = require('./database');
const { createGameEngine, tierForRating, TIERS } = require('./gameEngine');
const matchmaking = require('./matchmaking');
const totp = require('./totp');
const sabotage = require('./sabotage');
const instrumentsRegistry = require('./instruments');
const shop = require('./shop');
const battlepass = require('./battlepass');
const coaching = require('./coaching');
const tournament = require('./tournament');
const presence = require('./presence');

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
const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'your_value');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// ALLOWED_ORIGIN restricts CORS to the real domain(s) in production - unset
// (dev/local) falls back to wide-open, since local testing hits this from
// whatever port/host is convenient. Accepts a comma-separated list so both
// the apex domain and www can be allowed at once.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const corsOrigin = allowedOrigins.length > 0 ? allowedOrigins : '*';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin } });

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
      notifyPlayer(friendId, 'friend_won_match', `${username} just won ${modeLabel} ${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}`, {
        fromPlayerId: playerId,
        data: { username, modeLabel, pnl, matchId },
      });
    }
  } catch (e) {
    console.warn('[notifyFriendsOfWin] failed:', e.message);
  }
}

const gameEngine = createGameEngine(io, notifyPlayer, updatePresence, notifyFriendsOfWin);

// inviteId -> { id, fromPlayerId, fromUsername, fromTier, lobbyId, matchMode,
// instruments, currentPlayers, maxPlayers, targetPlayerId, expiresAt, timer }
const pendingInvites = new Map();
const INVITE_TTL_MS = 60 * 1000;

const AVATAR_DIR = path.join(__dirname, '..', 'client', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${req.tokenPlayer.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB per FIX 6 spec
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

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
  const { error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
  return !error;
}

// requireAuth from the migration spec, kept under its original exported name
// (`authenticate`) so the ~60 existing route registrations that already do
// `requireDb, authenticate` don't all need touching. Populates
// req.tokenPlayer with the FULL player row (not just a JWT payload) - every
// existing call site only ever read `.id` (or `.sid`, handled separately),
// so this is a safe superset, not a breaking change to that contract.
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
  const forwarded = req.headers['x-forwarded-for'];
  return (forwarded ? forwarded.split(',')[0].trim() : null) || req.socket.remoteAddress || 'unknown';
}

function requireDb(req, res, next) {
  if (!db.isConfigured) {
    return res.status(503).json({ error: 'Database not configured - add SUPABASE_SERVICE_KEY to .env' });
  }
  next();
}

// Stripe needs the raw request body to verify webhook signatures, so this
// route must be registered before the global express.json() body parser.
const stripeWebhookConfigured = Boolean(process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_WEBHOOK_SECRET !== 'your_value');

app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  // Every coin/battle-pass/coaching credit below is driven by this event, so
  // an unsigned body must never be trusted - fail closed (503) rather than
  // fall back to trusting arbitrary JSON when the secret isn't configured
  // yet. Get the real secret from the Stripe dashboard before going live.
  if (!stripeWebhookConfigured) {
    console.error('[stripe webhook] rejected: STRIPE_WEBHOOK_SECRET is not configured');
    return res.status(503).json({ error: 'Stripe webhook is not configured' });
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[stripe webhook] signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.metadata?.type === 'battlepass') {
      try {
        await db.setBattlePassPremium(session.metadata.playerId, session.metadata.season, {
          stripeSubscriptionId: session.subscription,
          expiresAt: battlepass.seasonExpiry(),
        });
        notifyPlayer(session.metadata.playerId, 'battlepass_premium', 'Battle Pass Premium activated!');
      } catch (e) {
        console.error('[stripe webhook] failed to activate battle pass:', e.message);
      }
    } else if (session.metadata?.type === 'coaching') {
      try {
        const row = await db.updateCoachingSession(session.metadata.sessionId, { status: 'scheduled' });
        notifyPlayer(row.student_id, 'coaching_booked', 'Your coaching session is confirmed!');
        notifyPlayer(row.coach_id, 'coaching_booked', 'You have a new coaching session booked!');
      } catch (e) {
        console.error('[stripe webhook] failed to confirm coaching session:', e.message);
      }
    } else {
      try {
        await db.completeCoinPurchase(session.id);
        if (session.metadata?.playerId) {
          notifyPlayer(session.metadata.playerId, 'coin_purchase', `${session.metadata.coins || ''} coins added to your wallet!`);
        }
      } catch (e) {
        console.error('[stripe webhook] failed to complete purchase:', e.message);
      }
    }
  }
  res.json({ received: true });
});

app.use(cors({ origin: corsOrigin }));
app.use(express.json());
// index:false - without it, static's default directory-index behavior would
// serve client/index.html for a bare "/" request before the explicit
// app.get('/') route below (landing.html) is ever reached.
app.use(express.static(path.join(__dirname, '..', 'client'), { index: false }));

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
app.get('/coaching', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'coaching.html')));
app.get('/async', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'async.html')));
app.get('/replay', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'replay.html')));
app.get('/clip', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'clip.html')));
app.get('/tournaments', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'tournaments.html')));
app.get('/tournament/:id', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'tournament.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'analytics.html')));
app.get('/trading-floor', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'leaderboard.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'profile.html')));
app.get('/profile/:username', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'profile.html')));
app.get('/auth-callback', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'auth-callback.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'reset-password.html')));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

// Internal-only bridge for the separate admin panel (port 3003) - secret +
// localhost-gated inside the router itself, see server/internalAdmin.js.
const { createInternalAdminRouter } = require('./internalAdmin');
app.use('/internal/admin', createInternalAdminRouter({ gameEngine, io, db, instrumentsRegistry, sabotage, TIERS, recentErrors }));

// ---- auth -----------------------------------------------------------------

app.post('/api/auth/register', authLimiter, requireDb, async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email and password are required' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters' });
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

    const session = await db.createSession({ playerId: player.id, userAgent: req.headers['user-agent'], ip: clientIp(req) });
    await db.recordLoginEvent({ playerId: player.id, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    await db.recordCoinTransaction({ playerId: player.id, type: 'welcome_bonus', amount: player.coins, balanceAfter: player.coins });

    const { data: signIn, error: signInErr } = await supabaseAdmin.auth.signInWithPassword({ email, password });
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

    const { data: signIn, error: signInErr } = await supabaseAdmin.auth.signInWithPassword({ email: player.email, password });
    if (signInErr || !signIn.session) return res.status(401).json({ error: 'Invalid username or password' });

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

// OAuth (Google/Apple) sign-ins land here after supabaseClient.auth.getSession()
// resolves client-side. Finds the existing player for this Supabase user, or
// creates one on first sign-in - never overwrites stats for a returning
// OAuth user. Deliberately does NOT use the `authenticate` middleware: that
// middleware 401s when no player record exists yet, which is exactly the
// case this endpoint has to handle (a brand new OAuth user).
app.post('/api/auth/oauth-callback', requireDb, async (req, res) => {
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
    const session = await db.createSession({ playerId: player.id, userAgent: req.headers['user-agent'], ip: clientIp(req) });
    await db.recordLoginEvent({ playerId: player.id, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    await db.recordCoinTransaction({ playerId: player.id, type: 'welcome_bonus', amount: player.coins, balanceAfter: player.coins });

    res.json({ player: await withEquippedCosmetics(player), isNew: true, sessionId: session.id });
  } catch (e) {
    console.error('[oauth-callback]', e);
    res.status(500).json({ error: 'Could not complete sign-in' });
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

app.post('/api/match/create', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const mode = MATCHMAKING_BY_MODE[req.body?.mode] ? req.body.mode : 'private';
    const modeConfig = gameEngine.MATCH_MODES[mode]; // undefined for 'private', which is free and has no shared config entry
    const entryCoins = modeConfig ? modeConfig.entryCoins : 0;

    if (entryCoins > 0 && player.coins < entryCoins) {
      return res.status(400).json({ error: `Not enough coins - ${modeConfig.label} costs ${entryCoins} coins` });
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
    const result = await MATCHMAKING_BY_MODE[mode](playerInfo, req.body);

    if (!result.success) return res.status(400).json(result);
    if (entryCoins > 0) {
      const dbMatchId = gameEngine.getMatch(result.matchId)?.dbMatchId || null;
      await db.debitCoins(player.id, entryCoins, { type: 'match_entry', matchId: dbMatchId });
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
      if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: 'Username must be 3-20 characters' });
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
    if (!(await verifyPasswordViaSupabase(player.email, req.body?.password || ''))) {
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
      experienceLevel: player.experience_level,
      preferredInstruments: player.preferred_instruments || [],
    });
  } catch (e) {
    console.error('[settings get]', e);
    res.status(500).json({ error: 'Could not load settings' });
  }
});

app.patch('/api/player/settings', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const { settings, country, experienceLevel, preferredInstruments } = req.body || {};
    const updates = {};
    if (settings && typeof settings === 'object') updates.settings = { ...player.settings, ...settings };
    if (country !== undefined) updates.country = country;
    if (experienceLevel && ['Beginner', 'Intermediate', 'Professional', 'Expert'].includes(experienceLevel)) {
      updates.experience_level = experienceLevel;
    }
    if (Array.isArray(preferredInstruments)) updates.preferred_instruments = preferredInstruments;

    const updated = await db.updatePlayer(player.id, updates);
    res.json({
      settings: updated.settings,
      avatarUrl: updated.avatar_url,
      country: updated.country,
      experienceLevel: updated.experience_level,
      preferredInstruments: updated.preferred_instruments || [],
    });
  } catch (e) {
    console.error('[settings patch]', e);
    res.status(500).json({ error: 'Could not update settings' });
  }
});

app.post('/api/notifications/coaching-notify', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    await db.updatePlayer(player.id, { settings: { ...player.settings, coaching_notify: true } });
    res.json({ success: true });
  } catch (e) {
    console.error('[coaching notify]', e);
    res.status(500).json({ error: 'Could not save notification preference' });
  }
});

app.post('/api/player/avatar', requireDb, authenticate, avatarUpload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
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

app.post('/api/friends/:requestId/accept', requireDb, authenticate, async (req, res) => {
  try {
    const row = await db.acceptFriendRequest(req.params.requestId, req.tokenPlayer.id);
    const accepter = await db.getPlayerById(req.tokenPlayer.id);
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

    const owned = await db.listShopPurchases(req.tokenPlayer.id);
    if (owned.some((o) => o.item_id === itemId)) return res.status(400).json({ error: 'Already owned' });

    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (item.requiresTier && tierForRating(player.war_rating) !== item.requiresTier) {
      return res.status(403).json({ error: `Requires ${item.requiresTier} tier` });
    }
    if (player.coins < item.price) {
      return res.status(400).json({ error: 'Not enough coins', required: item.price, balance: player.coins });
    }

    if (item.price > 0) await db.debitCoins(player.id, item.price, { type: 'shop_purchase' });
    await db.recordShopPurchase({ playerId: player.id, itemType: item.type, itemId: item.id, coinsSpent: item.price });
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
    if (tierCoins > 0) await db.creditCoins(playerId, tierCoins, { type: 'battlepass_tier' });
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

app.post('/api/battlepass/subscribe', requireDb, authenticate, async (req, res) => {
  try {
    if (!stripeConfigured) {
      return res.status(503).json({ error: 'Stripe is not configured - add STRIPE_SECRET_KEY to .env' });
    }
    const season = battlepass.currentSeason();
    const player = await db.getPlayerById(req.tokenPlayer.id);
    const origin = req.headers.origin || `http://localhost:${PORT}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Spike & Crush - Battle Pass (Premium)' },
            unit_amount: 499,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      metadata: { type: 'battlepass', playerId: player.id, season },
      success_url: `${origin}/battle-pass?subscribe=success`,
      cancel_url: `${origin}/battle-pass?subscribe=cancelled`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[battlepass subscribe]', e);
    res.status(500).json({ error: 'Could not start checkout' });
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
    await db.creditCoins(req.tokenPlayer.id, challenge.coins, { type: 'battlepass_challenge' });
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
      if (t.entry_coins > 0) await db.creditCoins(r.player_id, t.entry_coins, { type: 'tournament_refund' });
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
    if (t.entry_coins > 0) {
      if (player.coins < t.entry_coins) return res.status(400).json({ error: 'Not enough coins' });
      await db.debitCoins(player.id, t.entry_coins, { type: 'tournament_entry' });
    }
    await db.registerForTournament({ tournamentId: t.id, playerId: player.id, seed: regs.length + 1 });

    let updated = await db.getTournament(t.id);
    updated = await checkAndCloseSignup(updated);
    res.json({ success: true, tournament: tournamentSummary(updated) });
  } catch (e) {
    console.error('[tournament register]', e);
    res.status(500).json({ error: 'Could not register' });
  }
});

app.post('/api/tournament/:id/play', requireDb, authenticate, async (req, res) => {
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

// ---- coaching marketplace -----------------------------------------------------

app.get('/api/coaching/coaches', requireDb, authenticate, async (req, res) => {
  try {
    const coaches = await db.listCoaches();
    const withRatings = await Promise.all(
      coaches.map(async (c) => ({
        id: c.id,
        username: c.username,
        avatarUrl: c.avatar_url,
        warRating: c.war_rating,
        tier: tierForRating(c.war_rating),
        rateAed: c.coaching_rate_aed,
        bio: c.coaching_bio,
        ...(await db.getCoachRatingSummary(c.id)),
      }))
    );
    res.json({ coaches: withRatings, sessionTypes: coaching.SESSION_TYPES });
  } catch (e) {
    console.error('[coaching coaches]', e);
    res.status(500).json({ error: 'Could not load coaches' });
  }
});

app.post('/api/coaching/profile', requireDb, authenticate, async (req, res) => {
  try {
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (tierForRating(player.war_rating) !== coaching.COACH_TIER) {
      return res.status(403).json({ error: `Only ${coaching.COACH_TIER} tier players can coach` });
    }
    const { enabled, rateAed, bio } = req.body || {};
    if (enabled && !coaching.validRate(rateAed)) {
      return res.status(400).json({ error: `Rate must be between AED ${coaching.MIN_RATE_AED} and ${coaching.MAX_RATE_AED}` });
    }
    const updated = await db.setCoachingProfile(player.id, { enabled: !!enabled, rateAed, bio });
    res.json({ success: true, player: sanitizePlayer(updated) });
  } catch (e) {
    console.error('[coaching profile]', e);
    res.status(500).json({ error: 'Could not update coaching profile' });
  }
});

app.post('/api/coaching/book', requireDb, authenticate, async (req, res) => {
  try {
    if (!stripeConfigured) {
      return res.status(503).json({ error: 'Stripe is not configured - add STRIPE_SECRET_KEY to .env' });
    }
    const { coachId, sessionType, scheduledAt } = req.body || {};
    const sessionTypeDef = coaching.SESSION_TYPES[sessionType];
    if (!sessionTypeDef) return res.status(400).json({ error: 'Unknown session type' });
    if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt is required' });

    const coach = await db.getPlayerById(coachId);
    if (!coach || !coach.coaching_enabled) return res.status(404).json({ error: 'Coach not found or not accepting bookings' });
    if (coach.id === req.tokenPlayer.id) return res.status(400).json({ error: 'You cannot book a session with yourself' });

    const priceAed = Number(coach.coaching_rate_aed);
    const row = await db.createCoachingSession({
      coachId: coach.id,
      studentId: req.tokenPlayer.id,
      sessionType,
      priceAed,
      durationMinutes: sessionTypeDef.durationMinutes,
      scheduledAt,
    });

    const origin = req.headers.origin || `http://localhost:${PORT}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'aed',
            product_data: { name: `Coaching: ${sessionTypeDef.label} with ${coach.username}` },
            unit_amount: Math.round(priceAed * 100),
          },
          quantity: 1,
        },
      ],
      metadata: { type: 'coaching', sessionId: row.id },
      success_url: `${origin}/coaching?booking=success`,
      cancel_url: `${origin}/coaching?booking=cancelled`,
    });

    await db.updateCoachingSession(row.id, { stripe_payment_intent: session.id });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[coaching book]', e);
    res.status(500).json({ error: 'Could not start booking checkout' });
  }
});

app.get('/api/coaching/my-sessions', requireDb, authenticate, async (req, res) => {
  try {
    const sessions = await db.listCoachingSessionsFor(req.tokenPlayer.id);
    res.json({ sessions, playerId: req.tokenPlayer.id });
  } catch (e) {
    console.error('[coaching my-sessions]', e);
    res.status(500).json({ error: 'Could not load sessions' });
  }
});

app.post('/api/coaching/complete', requireDb, authenticate, async (req, res) => {
  try {
    const { sessionId, rating, reviewText } = req.body || {};
    const row = await db.getCoachingSession(sessionId);
    if (!row) return res.status(404).json({ error: 'Session not found' });
    if (row.student_id !== req.tokenPlayer.id) return res.status(403).json({ error: 'Only the student can complete this session' });
    if (row.status !== 'scheduled') return res.status(400).json({ error: 'Session is not in a completable state' });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });

    await db.updateCoachingSession(sessionId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      rating,
      review_text: reviewText || null,
    });
    notifyPlayer(row.coach_id, 'coaching_booked', `Session reviewed: ${rating}★`);
    res.json({ success: true });
  } catch (e) {
    console.error('[coaching complete]', e);
    res.status(500).json({ error: 'Could not complete session' });
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

app.patch('/api/wallet/daily-limit', requireDb, authenticate, async (req, res) => {
  try {
    const PLATFORM_MAX = 2000;
    const val = Number(req.body?.limitUsd);
    if (!Number.isFinite(val) || val <= 0 || val > PLATFORM_MAX) {
      return res.status(400).json({ error: `Limit must be between 0 and ${PLATFORM_MAX}` });
    }
    const updated = await db.updatePlayer(req.tokenPlayer.id, { daily_loss_limit_usd: val });
    res.json({ dailyLossLimitUsd: updated.daily_loss_limit_usd });
  } catch (e) {
    console.error('[daily limit]', e);
    res.status(500).json({ error: 'Could not update daily loss limit' });
  }
});

app.get('/api/version', (req, res) => {
  res.json({ version: require('../package.json').version });
});

// ---- home page stats --------------------------------------------------------------

app.get('/api/stats/home', async (req, res) => {
  try {
    const live = gameEngine.getHomeStats();
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
// index.js already uses for presence pushes), and it also wants a lifetime
// total rather than /api/stats/home's today-scoped coinsWonToday.
app.get('/api/stats/live', async (req, res) => {
  try {
    const activePlayers = playerSockets.size;
    const { matchesToday } = gameEngine.getHomeStats();
    if (!db.isConfigured) {
      return res.json({ activePlayers, matchesToday, largestWinToday: 0, totalPrizesDistributed: 0 });
    }
    const [largestWinToday, totalPrizesDistributed] = await Promise.all([
      db.getLargestWinToday(),
      db.getTotalPrizesDistributed(),
    ]);
    res.json({ activePlayers, matchesToday, largestWinToday, totalPrizesDistributed });
  } catch (e) {
    console.error('[stats live]', e);
    res.json({ activePlayers: 0, matchesToday: 0, largestWinToday: 0, totalPrizesDistributed: 0 });
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

app.get('/api/stats/activity', async (req, res) => {
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

app.get('/api/leaderboard', requireDb, async (req, res) => {
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

// ---- coins / stripe -----------------------------------------------------------

const COIN_PACKAGES = {
  100: { coins: 100, priceUsd: 0.99 },
  500: { coins: 500, priceUsd: 3.99 },
  1500: { coins: 1500, priceUsd: 9.99 },
  5000: { coins: 5000, priceUsd: 24.99 },
};

app.post('/api/coins/purchase', requireDb, authenticate, async (req, res) => {
  try {
    const pkg = COIN_PACKAGES[req.body?.packageId];
    if (!pkg) return res.status(400).json({ error: 'Unknown coin package' });
    const player = await db.getPlayerById(req.tokenPlayer.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (!stripeConfigured) {
      return res.status(503).json({ error: 'Stripe is not configured - add STRIPE_SECRET_KEY to .env' });
    }

    const origin = req.headers.origin || `http://localhost:${PORT}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `Spike & Crush - ${pkg.coins} coins` },
            unit_amount: Math.round(pkg.priceUsd * 100),
          },
          quantity: 1,
        },
      ],
      metadata: { playerId: player.id, coins: String(pkg.coins) },
      success_url: `${origin}/profile.html?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/profile.html?purchase=cancelled`,
    });

    await db.recordCoinPurchase({
      playerId: player.id,
      packageCoins: pkg.coins,
      amountUsd: pkg.priceUsd,
      stripeSessionId: session.id,
      status: 'pending',
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('[coins/purchase]', e);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// Dev-only self-service top-up so testing the game doesn't require running
// a real Stripe test-mode checkout every time. Self-disabling the moment a
// real webhook secret is configured (the same signal /api/webhook/stripe
// uses to fail closed), so this can never work against a production Stripe
// setup - it only exists while the payment integration itself is still
// unconfigured for real webhook delivery. Grants a fixed, modest amount per
// call (rate-limited by the existing apiLimiter) rather than an arbitrary
// client-supplied number, so it can't be scripted into an unlimited coin
// faucet even in dev.
const DEV_COIN_GRANT_AMOUNT = 1000;
app.post('/api/dev/add-coins', requireDb, authenticate, async (req, res) => {
  if (stripeWebhookConfigured) {
    return res.status(403).json({ error: 'Dev coin grants are disabled once a real Stripe webhook is configured' });
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

// Fallback completion path for the success redirect. The webhook above is
// the source of truth in production, but it requires a configured
// STRIPE_WEBHOOK_SECRET and a publicly reachable URL (or `stripe listen`)
// to ever fire - neither is available in every deployment, which otherwise
// leaves paid purchases stuck in "pending" forever. This asks Stripe
// directly whether the session was paid (never trusts the client) and
// reuses the same idempotent db.completeCoinPurchase used by the webhook,
// so calling both for the same session is harmless.
app.post('/api/coins/verify-session', requireDb, authenticate, async (req, res) => {
  try {
    if (!stripeConfigured) {
      return res.status(503).json({ error: 'Stripe is not configured - add STRIPE_SECRET_KEY to .env' });
    }
    const sessionId = req.body?.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.playerId !== req.tokenPlayer.id) {
      return res.status(403).json({ error: 'This session does not belong to you' });
    }
    if (session.payment_status !== 'paid') {
      return res.json({ status: session.payment_status, credited: false });
    }

    const purchase = await db.completeCoinPurchase(session.id);
    const player = await db.getPlayerById(req.tokenPlayer.id);
    res.json({ status: 'paid', credited: true, coins: purchase?.package_coins ?? null, player });
  } catch (e) {
    console.error('[coins/verify-session]', e);
    res.status(500).json({ error: 'Could not verify purchase' });
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

io.on('connection', (socket) => {
  const notifyPid = socket.data.player?.id;
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
      const result = gameEngine.joinMatch(match, playerInfo, socket.id);
      if (!result.success) return ack?.({ success: false, error: result.error });

      if (entryCoins > 0) {
        await db.debitCoins(player.id, entryCoins, { type: 'match_entry', matchId: match.dbMatchId });
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
  res.status(err.status || 400).json({ error: err.message || 'Request failed' });
});

const instrumentReport = instrumentsRegistry.preloadAll();
const csvCount = instrumentReport.filter((r) => r.source === 'csv').length;
console.log(`[instruments] loaded ${instrumentReport.length} instruments (${csvCount} from real CSV data, ${instrumentReport.length - csvCount} synthetic):`);
for (const r of instrumentReport) {
  console.log(`  ${r.symbol.padEnd(8)} ${r.source.padEnd(10)} ${r.points} one-minute data points`);
}

server.listen(PORT, () => {
  console.log(`Spike & Crush server listening on http://localhost:${PORT}`);
  if (!db.isConfigured) {
    console.warn(
      'Running WITHOUT a configured database - accounts, matchmaking persistence and leaderboards are disabled until SUPABASE_SERVICE_KEY is set in .env.'
    );
  }
  if (!stripeConfigured) {
    console.warn('Stripe is not configured - coin purchases are disabled until STRIPE_SECRET_KEY is set in .env.');
  }
});
