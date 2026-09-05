'use strict';

window.Admin = window.Admin || {};

(function () {
  Admin.logout = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
    window.location.href = '/login.html';
  };

  Admin.getMe = () => {
    try { return JSON.parse(localStorage.getItem('admin_me') || 'null'); } catch (e) { return null; }
  };
  Admin.setMe = (me) => localStorage.setItem('admin_me', JSON.stringify(me));

  // Self-service password change, available from the sidebar on every page.
  // The legacy shared ADMIN_USERNAME/ADMIN_PASSWORD login has no admin_users
  // row to update, so the server rejects that case with a clear message
  // pointing at .env instead of silently failing.
  Admin.openChangePasswordModal = () => {
    document.getElementById('admChangePasswordOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'admChangePasswordOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:500;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div class="panel" style="max-width:360px;width:90%;">
        <h3 style="margin-top:0;">Change Password</h3>
        <div id="admCpError" class="admin-login-error"></div>
        <div class="field"><label>Current Password</label><input type="password" id="admCpCurrent" autocomplete="current-password" /></div>
        <div class="field"><label>New Password</label><input type="password" id="admCpNew" autocomplete="new-password" /></div>
        <div class="field"><label>Confirm New Password</label><input type="password" id="admCpConfirm" autocomplete="new-password" /></div>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button class="btn" id="admCpCancel" style="flex:1;">Cancel</button>
          <button class="btn btn-primary" id="admCpSubmit" style="flex:1;">Change Password</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#admCpCancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#admCpSubmit').addEventListener('click', async () => {
      const errorEl = overlay.querySelector('#admCpError');
      errorEl.textContent = '';
      const currentPassword = overlay.querySelector('#admCpCurrent').value;
      const newPassword = overlay.querySelector('#admCpNew').value;
      const confirm = overlay.querySelector('#admCpConfirm').value;
      if (newPassword !== confirm) { errorEl.textContent = 'New passwords do not match'; return; }
      try {
        await Admin.api('/admins/change-password', { method: 'POST', body: { currentPassword, newPassword } });
        overlay.remove();
        Admin.toast('Password changed', 'success');
      } catch (e) {
        errorEl.textContent = e.message;
      }
    });
  };
})();
