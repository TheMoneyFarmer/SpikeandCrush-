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
})();
