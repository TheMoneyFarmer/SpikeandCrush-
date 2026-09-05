'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { requireSuperAdmin, logAdminActivity, MASTER_ADMIN_EMAIL, clientIp } = require('../lib/auth');

function router() {
  const r = express.Router();

  // ---- admin users --------------------------------------------------------------

  r.get('/', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Database not configured' });
    try {
      const { data, error } = await supabase
        .from('admin_users')
        .select('id, email, name, role, is_master, invited_by, last_login, is_active, created_at')
        .order('is_master', { ascending: false })
        .order('created_at', { ascending: true });
      if (error) throw error;

      // Resolve invited_by ids to emails for display, in one extra query
      // rather than N+1 - the table is tiny (admin headcount, not players).
      const byId = Object.fromEntries(data.map((a) => [a.id, a.email]));
      const rows = data.map((a) => ({ ...a, invited_by_email: a.invited_by ? byId[a.invited_by] || null : null }));
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // super_admin-only: inviting a new admin is itself an admin-management
  // action, same as deactivating one below.
  r.post('/invite', requireSuperAdmin, async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Database not configured' });
    const { email, name, role } = req.body || {};
    if (!email || !name || !role) return res.status(400).json({ error: 'email, name, and role are required' });
    if (!['super_admin', 'admin', 'moderator'].includes(role)) return res.status(400).json({ error: 'role must be super_admin, admin, or moderator' });

    const normalizedEmail = String(email).toLowerCase().trim();
    const tempPassword = 'SC' + Math.random().toString(36).slice(2, 10).toUpperCase();

    try {
      const hash = await bcrypt.hash(tempPassword, 12);
      const { data, error } = await supabase
        .from('admin_users')
        .insert({
          email: normalizedEmail,
          name,
          password_hash: hash,
          role,
          is_master: false,
          invited_by: req.admin.id || null,
          is_active: true,
        })
        .select()
        .single();
      if (error) throw error;

      await logAdminActivity({
        adminId: req.admin.id || null,
        adminEmail: req.admin.email || req.admin.username,
        action: 'INVITE_ADMIN',
        targetTable: 'admin_users',
        targetId: data.id,
        details: { email: normalizedEmail, name, role },
        ip: clientIp(req),
      });

      res.json({ success: true, tempPassword, admin: { id: data.id, email: data.email, name: data.name, role: data.role } });
    } catch (e) {
      res.status(400).json({ error: 'Could not invite admin: ' + e.message });
    }
  });

  // Soft-delete (is_active: false) rather than a real DELETE - keeps the
  // admin_activity_log's admin_id foreign key intact for past actions, and
  // matches the "Deactivate" language used in the dashboard UI.
  r.delete('/:id', requireSuperAdmin, async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Database not configured' });
    try {
      const { data: target, error: findErr } = await supabase.from('admin_users').select('id, email, is_master').eq('id', req.params.id).maybeSingle();
      if (findErr) throw findErr;
      if (!target) return res.status(404).json({ error: 'Admin not found' });
      if (target.is_master || target.email === MASTER_ADMIN_EMAIL) {
        return res.status(403).json({ error: 'The master admin cannot be deleted or deactivated' });
      }

      await supabase.from('admin_users').update({ is_active: false }).eq('id', req.params.id);
      await logAdminActivity({
        adminId: req.admin.id || null,
        adminEmail: req.admin.email || req.admin.username,
        action: 'DEACTIVATE_ADMIN',
        targetTable: 'admin_users',
        targetId: req.params.id,
        details: { email: target.email },
        ip: clientIp(req),
      });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- password reset ---------------------------------------------------------------

  // Self-service: any logged-in admin (including the master) changes their
  // own password. Only works for an admin_users-backed login - the legacy
  // shared ADMIN_USERNAME/ADMIN_PASSWORD login has no DB row to update, so
  // that one still has to be rotated in .env by hand.
  r.post('/change-password', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Database not configured' });
    if (!req.admin.id) {
      return res.status(400).json({ error: 'The shared admin login has no password to change here - update ADMIN_PASSWORD in .env instead' });
    }
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    try {
      const { data: admin, error: findErr } = await supabase.from('admin_users').select('id, password_hash, email').eq('id', req.admin.id).maybeSingle();
      if (findErr) throw findErr;
      if (!admin) return res.status(404).json({ error: 'Admin not found' });

      const valid = await bcrypt.compare(currentPassword, admin.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

      const hash = await bcrypt.hash(newPassword, 12);
      await supabase.from('admin_users').update({ password_hash: hash }).eq('id', admin.id);
      await logAdminActivity({ adminId: admin.id, adminEmail: admin.email, action: 'CHANGE_PASSWORD', ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // super_admin-only: for when another admin is locked out and can't use
  // change-password themselves. Generates a new temp password the same way
  // /invite does - the master admin is excluded (same reasoning as the
  // delete guard above: letting other super_admins reset the master's own
  // password would undermine "nobody but the master controls the master").
  r.post('/:id/reset-password', requireSuperAdmin, async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Database not configured' });
    try {
      const { data: target, error: findErr } = await supabase.from('admin_users').select('id, email, is_master').eq('id', req.params.id).maybeSingle();
      if (findErr) throw findErr;
      if (!target) return res.status(404).json({ error: 'Admin not found' });
      if (target.is_master || target.email === MASTER_ADMIN_EMAIL) {
        return res.status(403).json({ error: "The master admin's password can only be changed by the master admin themselves" });
      }

      const tempPassword = 'SC' + Math.random().toString(36).slice(2, 10).toUpperCase();
      const hash = await bcrypt.hash(tempPassword, 12);
      await supabase.from('admin_users').update({ password_hash: hash }).eq('id', target.id);
      await logAdminActivity({
        adminId: req.admin.id || null,
        adminEmail: req.admin.email || req.admin.username,
        action: 'RESET_ADMIN_PASSWORD',
        targetTable: 'admin_users',
        targetId: target.id,
        details: { email: target.email },
        ip: clientIp(req),
      });
      res.json({ success: true, tempPassword });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- activity log ---------------------------------------------------------------

  r.get('/activity-log', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Database not configured' });
    try {
      let query = supabase.from('admin_activity_log').select('*').order('created_at', { ascending: false }).limit(500);
      if (req.query.adminEmail) query = query.eq('admin_email', req.query.adminEmail);
      if (req.query.action) query = query.eq('action', req.query.action);
      if (req.query.from) query = query.gte('created_at', req.query.from);
      if (req.query.to) query = query.lte('created_at', req.query.to);
      const { data, error } = await query;
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
