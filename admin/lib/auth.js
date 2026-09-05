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

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
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
async function isLockedOut(username) {
  if (!isConfigured) return false;
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('admin_login_attempts')
    .select('success, created_at')
    .eq('username', username)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(LOCKOUT_THRESHOLD);
  if (error || !data) return false;
  return data.length >= LOCKOUT_THRESHOLD && data.every((row) => row.success === false);
}

function signAdminToken(username) {
  return jwt.sign({ username, role: 'admin' }, process.env.ADMIN_SECRET, { expiresIn: `${SESSION_HOURS}h` });
}

// For a real admin_users row (as opposed to the legacy single shared
// ADMIN_USERNAME/ADMIN_PASSWORD login above, which still works and signs
// its token the old way). Carries id/email/is_master so the admin_users
// management endpoints and the UI's "you are the master admin" badge have
// something to check without a DB round trip on every request.
function signAdminUserToken(adminUser) {
  return jwt.sign(
    {
      username: adminUser.email,
      id: adminUser.id,
      email: adminUser.email,
      role: adminUser.role,
      is_master: Boolean(adminUser.is_master),
    },
    process.env.ADMIN_SECRET,
    { expiresIn: `${SESSION_HOURS}h` }
  );
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
async function seedMasterAdmin() {
  if (!isConfigured) {
    console.warn('[admin] Supabase not configured - skipping master admin seed');
    return;
  }
  const password = process.env.MASTER_ADMIN_PASSWORD || 'SpikeAndCrush2026!';
  try {
    const { data: existing } = await supabase.from('admin_users').select('id, is_master').eq('email', MASTER_ADMIN_EMAIL).maybeSingle();
    if (!existing) {
      const hash = await bcrypt.hash(password, 12);
      await supabase.from('admin_users').insert({
        email: MASTER_ADMIN_EMAIL,
        name: 'Thando — Master Admin',
        password_hash: hash,
        role: 'super_admin',
        is_master: true,
        is_active: true,
      });
      console.log('[admin] master admin seeded:', MASTER_ADMIN_EMAIL);
    } else if (!existing.is_master) {
      await supabase.from('admin_users').update({ role: 'super_admin', is_master: true, is_active: true }).eq('id', existing.id);
      console.log('[admin] master admin re-promoted:', MASTER_ADMIN_EMAIL);
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
function requireAdmin(req, res, next) {
  if (!ipAllowed(req)) {
    return res.status(403).json({ error: 'Your IP is not on the admin allowlist' });
  }
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const decoded = jwt.verify(token, process.env.ADMIN_SECRET);
    if (!ADMIN_ROLES.includes(decoded.role)) throw new Error('wrong role');
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
function requirePageAuth(req, res, next) {
  if (!ipAllowed(req)) return res.status(403).send('Forbidden - IP not allowlisted');
  const token = getToken(req);
  if (!token) return res.redirect('/login.html');
  try {
    const decoded = jwt.verify(token, process.env.ADMIN_SECRET);
    if (!ADMIN_ROLES.includes(decoded.role)) throw new Error('wrong role');
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
};
