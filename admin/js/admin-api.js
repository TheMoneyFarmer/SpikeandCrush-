'use strict';

window.Admin = window.Admin || {};

(function () {
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Not authenticated');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }

  Admin.api = api;

  Admin.escapeHtml = (str) =>
    String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  Admin.formatMoney = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  Admin.formatCoins = (n) => `🪙 ${Number(n || 0).toLocaleString()}`;
  Admin.formatNumber = (n) => Number(n || 0).toLocaleString();
  Admin.formatDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  Admin.timeAgo = (iso) => {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  Admin.toast = (message, type = 'info') => {
    let wrap = document.getElementById('adminToast');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'adminToast';
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = `admin-toast-item ${type}`;
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  };

  Admin.downloadCsv = (filename, rows) => {
    if (!rows.length) return Admin.toast('Nothing to export', 'warning');
    const headers = Object.keys(rows[0]);
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  Admin.confirmModal = ({ title, body, confirmLabel = 'Confirm', danger = false }) =>
    new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'admin-modal-backdrop';
      backdrop.innerHTML = `
        <div class="admin-modal">
          <h3>${Admin.escapeHtml(title)}</h3>
          <div style="font-size:13px;color:var(--text-secondary);">${body}</div>
          <div class="admin-modal-actions">
            <button class="btn" id="admModalCancel">Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="admModalConfirm">${Admin.escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);
      backdrop.querySelector('#admModalCancel').addEventListener('click', () => { backdrop.remove(); resolve(false); });
      backdrop.querySelector('#admModalConfirm').addEventListener('click', () => { backdrop.remove(); resolve(true); });
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(false); } });
    });
})();
