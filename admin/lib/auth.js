'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { supabase, isConfigured } = require('./supabaseAdmin');

const SESSION_HOURS = 8;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MINUTES = 15;

// Any of these three roles gets into the panel - the distinction between
// them only matters for the admin_users management endpoints themselves
// (invite/deactivate require super_admin). This can never be deleted,
// demoted, or deactivated - see seedMasterAdmin() and the admin_users
// routes' own checks against this exact email.
const ADMIN_ROLES = ['super_admin', 'admin', 'moderator'];
const MASTER_ADMIN_EMAIL = 'thandolwenkosimceeyah@gmail.com';

// req.ip honours `trust proxy` (set to the single Railway hop in server.js), so
// it is the real client address. Reading X-Forwarded-For directly, as before,
// let anyone put an allowlisted IP in the header and bypass ADMIN_ALLOWED_IPS.
function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').replace('::ffff:', '');
}

// Optional IP allowlist. Empty/unset ADMIN_ALLOWED_IPS means "allow anything" -
// fine for local dev, should be set before this ever leaves localhost.
function ipAllowed(req) {
  const list = (process.env.ADMIN_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  const ip = clientIp(req).replace('::ffff:', '');
  return list.includes(ip);
}

async function logAdminAction({ adminUsername, actionType, targetType = null, targetId = null, details = {}, ip = null }) {
  if (!isConfigured) return;
  try {
    await supabase.from('admin_logs').insert({
      admin_username: adminUsername,
      action_type: actionType,
      target_type: targetType,
      target_id: targetId ? String(targetId) : null,
      details,
      ip_address: ip,
    });
  } catch (e) {
    console.warn('[admin] failed to write admin_logs row:', e.message);
  }
}

async function recordLoginAttempt(username, ip, success) {
  if (!isConfigured) return;
  try {
    await supabase.from('admin_login_attempts').insert({ username, ip_address: ip, success });
  } catch (e) {
    console.warn('[admin] failed to record login attempt:', e.message);
  }
}

// 5 failed attempts for this username in the last 15 minutes -> locked out,
// regardless of which IP they're coming from (spec: "lock out for 15 minutes
// after 5 failures").
// Keyed on username AND IP: before, five bad attempts from anyone locked the
// real admin out for 15 minutes (a free denial-of-service on the master login).
// Fails closed if the attempts table can't be read.
async function isLockedOut(username, ip = null) {
  if (!isConfigured) return false;
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MINUTES * 60 * 1000).toISOString();
  let query = supabase
    .from('admin_login_attempts')
    .select('success, created_at')
    .eq('username', username)
    .gte('created_at', since);
  if (ip) query = query.eq('ip_address', ip);
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(LOCKOUT_THRESHOLD);
  if (error || !data) return true;
  return data.length >= LOCKOUT_THRESHOLD && data.every((row) => row.success === false);
}

const JWT_OPTS = { algorithms: ['HS256'] };

function signAdminToken(username, sid) {
  return jwt.sign({ username, role: 'admin', sid }, process.env.ADMIN_SECRET, { expiresIn: `${SESSION_HOURS}h`, algorithm: 'HS256' });
}

// For a real admin_users row (as opposed to the legacy single shared
// ADMIN_USERNAME/ADMIN_PASSWORD login above, which still works and signs
// its token the old way). Carries id/email/is_master so the admin_users
// management endpoints and the UI's "you are the master admin" badge have
// something to check without a DB round trip on every request.
function signAdminUserToken(adminUser, sid) {
  return jwt.sign(
    {
      username: adminUser.email,
      id: adminUser.id,
      email: adminUser.email,
      role: adminUser.role,
      is_master: Boolean(adminUser.is_master),
      sid,
    },
    process.env.ADMIN_SECRET,
    { expiresIn: `${SESSION_HOURS}h`, algorithm: 'HS256' }
  );
}

// ---- session revocation ------------------------------------------------------------
// Every token names its admin_sessions row (sid). A token is only honoured while
// that row is unrevoked and unexpired and, for named admins, while the admin is
// still active - so logout and deactivation take effect immediately instead of
// after the 8 h JWT expiry. Cached briefly to avoid a DB read on every request.
const sessionCache = new Map(); // sid -> { ok, at }
const SESSION_CACHE_MS = 20 * 1000;
async function sessionStillValid(decoded) {
  if (!isConfigured) return true;
  if (!decoded.sid) return false; // tokens issued before revocation existed
  const hit = sessionCache.get(decoded.sid);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit.ok;
  let ok = false;
  try {
    const { data: sess } = await supabase.from('admin_sessions').select('revoked, expires_at').eq('id', decoded.sid).maybeSingle();
    ok = Boolean(sess && !sess.revoked && new Date(sess.expires_at).getTime() > Date.now());
    if (ok && decoded.id) {
      const { data: admin } = await supabase.from('admin_users').select('is_active, role').eq('id', decoded.id).maybeSingle();
      ok = Boolean(admin && admin.is_active && admin.role === decoded.role);
    }
  } catch (e) {
    ok = false;
  }
  sessionCache.set(decoded.sid, { ok, at: Date.now() });
  return ok;
}
function forgetSession(sid) {
  sessionCache.delete(sid);
}
async function revokeSessions({ sid = null, username = null }) {
  if (!isConfigured) return;
  let q = supabase.from('admin_sessions').update({ revoked: true });
  q = sid ? q.eq('id', sid) : q.eq('admin_username', username);
  await q;
  if (sid) forgetSession(sid);
  else sessionCache.clear();
}

// Inserts into admin_activity_log - distinct from logAdminAction/admin_logs
// above, which tracks actions taken on *game* entities (ban a player, create
// an announcement). This table is specifically the admin_users audit trail
// (logins, invites, deactivations) that FIX 1's Activity Log tab reads.
async function logAdminActivity({ adminId = null, adminEmail, action, targetTable = null, targetId = null, details = {}, ip = null }) {
  if (!isConfigured) return;
  try {
    await supabase.from('admin_activity_log').insert({
      admin_id: adminId,
      admin_email: adminEmail,
      action,
      target_table: targetTable,
      target_id: targetId ? String(targetId) : null,
      details,
      ip_address: ip,
    });
  } catch (e) {
    console.warn('[admin] failed to write admin_activity_log row:', e.message);
  }
}

// Seeds (or re-promotes) the permanent master admin on every server start.
// This email can never be deleted or demoted - see the admin_users routes'
// own guard against MASTER_ADMIN_EMAIL for the enforcement side of that.
//
// The password is *always* forced to match MASTER_ADMIN_PASSWORD on every
// restart, not just seeded once at creation - by design, this one account's
// credential is controlled by whoever manages the deployment's env vars, not
// by the panel's own self-service /change-password form. (Trade-off: if the
// master admin changes their password through that form, it silently reverts
// to the env var on the next restart/redeploy - documented here since it's
// the one account this applies to.)
async function seedMasterAdmin() {
  if (!isConfigured) {
    console.warn('[admin] Supabase not configured - skipping master admin seed');
    return;
  }
  // No fallback password. A missing or weak MASTER_ADMIN_PASSWORD now skips the
  // password sync (the existing hash is left as it is) instead of resetting the
  // super-admin to a value that was in the source code and git history.
  const password = process.env.MASTER_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    console.error('[admin] MASTER_ADMIN_PASSWORD is not set or shorter than 12 characters - master admin password NOT synced. Set a strong value in the environment.');
    return;
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const { data: existing, error: selectErr } = await supabase.from('admin_users').select('id, is_master').eq('email', MASTER_ADMIN_EMAIL).maybeSingle();
    if (selectErr) {
      // Logged separately from the catch below - a Postgres/RLS error here
      // (e.g. "permission denied for table admin_users") means the service
      // is connecting fine but effectively can't see the table, which reads
      // identically to "no admin exists yet" if this error is ignored - the
      // insert attempt just below would then either fail loudly on the
      // email UNIQUE constraint (a real row exists, just invisible to this
      // key) or, worse, silently no-op under the same restriction.
      console.error('[admin] master admin SELECT failed:', selectErr.message, selectErr.code || '', selectErr.hint || '');
    }
    if (!existing) {
      const { error: insertErr } = await supabase.from('admin_users').insert({
        email: MASTER_ADMIN_EMAIL,
        name: 'Thando — Master Admin',
        password_hash: hash,
        role: 'super_admin',
        is_master: true,
        is_active: true,
      });
      if (insertErr) {
        console.error('[admin] master admin INSERT failed:', insertErr.message, insertErr.code || '', insertErr.hint || '');
      } else {
        console.log('[admin] master admin seeded:', MASTER_ADMIN_EMAIL);
      }
    } else {
      const updates = { password_hash: hash };
      if (!existing.is_master) Object.assign(updates, { role: 'super_admin', is_master: true, is_active: true });
      const { error: updateErr } = await supabase.from('admin_users').update(updates).eq('id', existing.id);
      if (updateErr) {
        console.error('[admin] master admin UPDATE failed:', updateErr.message, updateErr.code || '', updateErr.hint || '');
      } else {
        console.log('[admin] master admin password synced from MASTER_ADMIN_PASSWORD:', MASTER_ADMIN_EMAIL);
      }
    }
  } catch (e) {
    console.error('[admin] master admin seed error:', e.message);
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    acc[key] = val;
    return acc;
  }, {});
}

function getToken(req) {
  const cookies = parseCookies(req);
  if (cookies.admin_token) return cookies.admin_token;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

// Applied to every /admin/api/* route. Redirects HTML page requests to the
// login page, but returns JSON 401 for XHR/fetch calls (checked via Accept
// header) so the front-end JS can show an inline error instead of navigating.
async function requireAdmin(req, res, next) {
  if (!ipAllowed(req)) {
    return res.status(403).json({ error: 'Your IP is not on the admin allowlist' });
  }
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const decoded = jwt.verify(token, process.env.ADMIN_SECRET, JWT_OPTS);
    if (!ADMIN_ROLES.includes(decoded.role)) throw new Error('wrong role');
    if (!(await sessionStillValid(decoded))) throw new Error('session revoked');
    req.admin = decoded;
    if (isConfigured) {
      supabase
        .from('admin_sessions')
        .update({ last_active: new Date().toISOString() })
        .eq('admin_username', decoded.username)
        .eq('revoked', false)
        .gte('expires_at', new Date().toISOString())
        .then(() => {})
        .catch(() => {});
    }
    next();
  } catch (e) {
    res.clearCookie('admin_token');
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
}

// Layers on top of requireAdmin (which must run first, so req.admin is set)
// for the admin_users management endpoints - inviting or deactivating other
// admins is super_admin-only. The permanent master admin is always seeded
// as super_admin, so this never locks them out.
function requireSuperAdmin(req, res, next) {
  if (!req.admin || req.admin.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

// Applied to page routes (the .html files) so hitting them directly without a
// valid session bounces to the login screen instead of a bare 401.
async function requirePageAuth(req, res, next) {
  if (!ipAllowed(req)) return res.status(403).send('Forbidden - IP not allowlisted');
  const token = getToken(req);
  if (!token) return res.redirect('/login.html');
  try {
    const decoded = jwt.verify(token, process.env.ADMIN_SECRET, JWT_OPTS);
    if (!ADMIN_ROLES.includes(decoded.role)) throw new Error('wrong role');
    if (!(await sessionStillValid(decoded))) throw new Error('session revoked');
    req.admin = decoded;
    next();
  } catch (e) {
    return res.redirect('/login.html');
  }
}

module.exports = {
  SESSION_HOURS,
  ADMIN_ROLES,
  MASTER_ADMIN_EMAIL,
  clientIp,
  ipAllowed,
  logAdminAction,
  logAdminActivity,
  recordLoginAttempt,
  isLockedOut,
  signAdminToken,
  signAdminUserToken,
  seedMasterAdmin,
  getToken,
  requireAdmin,
  requireSuperAdmin,
  requirePageAuth,
  revokeSessions,
  sessionStillValid,
  JWT_OPTS,
};
