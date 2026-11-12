'use strict';

// One admin action, written to both audit logs (admin_logs and
// admin_activity_log) with the admin's name and visitor IP.
const { logAdminAction, logAdminActivity, clientIp } = require('./auth');

async function audit(req, actionType, targetType, targetId, details = {}) {
  const ip = clientIp(req);
  await Promise.all([
    logAdminAction({ adminUsername: req.admin.username, actionType, targetType, targetId, details, ip }),
    logAdminActivity({ adminId: req.admin.id || null, adminEmail: req.admin.email || req.admin.username, action: actionType, targetTable: targetType, targetId, details, ip }),
  ]);
}

module.exports = { audit };
