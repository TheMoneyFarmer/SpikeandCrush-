'use strict';

// Self-injecting floating support widget - included as a single <script> tag
// on every client page (no shared HTML templating layer exists in this
// codebase) rather than requiring 25 separate HTML edits per feature. Talks
// to /api/support/chat (Claude-backed Q&A) and /api/support/ticket (human
// follow-up) - both work whether or not the visitor is logged in, since
// TW.api already attaches an Authorization header only when a token exists.

(function () {
  if (document.getElementById('twSupportWidgetRoot')) return;

  const style = document.createElement('style');
  style.textContent = `
    #twSupportWidgetRoot { position: fixed; bottom: 20px; right: 20px; z-index: 400; font-family: inherit; }
    .tw-sw-launcher { width: 52px; height: 52px; border-radius: 50%; background: var(--accent, #00a87c); color: #fff; border: none; font-size: 22px; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; }
    .tw-sw-panel { display: none; position: fixed; bottom: 84px; right: 20px; width: 340px; max-width: calc(100vw - 32px); height: 460px; max-height: calc(100vh - 120px); background: var(--surface, #14141f); border: 1px solid var(--border, #2a2a3a); border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); display: none; flex-direction: column; overflow: hidden; }
    .tw-sw-panel.open { display: flex; }
    .tw-sw-head { padding: 12px 14px; background: var(--surface-2, #1a1a2a); border-bottom: 1px solid var(--border, #2a2a3a); display: flex; justify-content: space-between; align-items: center; }
    .tw-sw-head strong { font-size: 13px; }
    .tw-sw-close { background: none; border: none; color: inherit; cursor: pointer; font-size: 16px; opacity: 0.7; }
    .tw-sw-body { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .tw-sw-msg { max-width: 85%; padding: 8px 10px; border-radius: 10px; font-size: 13px; line-height: 1.4; white-space: pre-wrap; }
    .tw-sw-msg.user { align-self: flex-end; background: var(--accent, #00a87c); color: #fff; }
    .tw-sw-msg.assistant { align-self: flex-start; background: var(--surface-2, #1a1a2a); color: var(--text, #eee); }
    .tw-sw-msg.system { align-self: center; font-size: 11px; opacity: 0.6; }
    .tw-sw-footer { border-top: 1px solid var(--border, #2a2a3a); padding: 8px; }
    .tw-sw-input-row { display: flex; gap: 6px; }
    .tw-sw-input-row input { flex: 1; padding: 8px; border-radius: 8px; border: 1px solid var(--border, #2a2a3a); background: var(--surface-2, #1a1a2a); color: var(--text, #eee); font-size: 13px; }
    .tw-sw-input-row button { padding: 8px 12px; border-radius: 8px; border: none; background: var(--accent, #00a87c); color: #fff; cursor: pointer; font-size: 13px; }
    .tw-sw-ticket-link { display: block; text-align: center; font-size: 11px; opacity: 0.7; margin-top: 6px; cursor: pointer; text-decoration: underline; }
    .tw-sw-ticket-form { padding: 10px; display: none; flex-direction: column; gap: 8px; }
    .tw-sw-ticket-form.open { display: flex; }
    .tw-sw-ticket-form input, .tw-sw-ticket-form textarea { padding: 8px; border-radius: 8px; border: 1px solid var(--border, #2a2a3a); background: var(--surface-2, #1a1a2a); color: var(--text, #eee); font-size: 13px; font-family: inherit; }
    .tw-sw-ticket-form textarea { resize: vertical; min-height: 70px; }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'twSupportWidgetRoot';
  root.innerHTML = `
    <div class="tw-sw-panel" id="twSwPanel">
      <div class="tw-sw-head"><strong>Spike & Crush Support</strong><button class="tw-sw-close" id="twSwClose">✕</button></div>
      <div class="tw-sw-body" id="twSwBody">
        <div class="tw-sw-msg assistant">Hey! Ask me anything about matches, coins, tournaments, or your account. I'll point you to a support ticket if I can't help.</div>
      </div>
      <div class="tw-sw-ticket-form" id="twSwTicketForm">
        <input type="text" id="twSwTicketSubject" placeholder="Subject" />
        <textarea id="twSwTicketMessage" placeholder="Describe the issue..."></textarea>
        <div class="tw-sw-input-row">
          <button id="twSwTicketCancel" style="background:var(--surface-2,#1a1a2a);color:inherit;">Cancel</button>
          <button id="twSwTicketSubmit">Submit Ticket</button>
        </div>
      </div>
      <div class="tw-sw-footer" id="twSwFooter">
        <div class="tw-sw-input-row">
          <input type="text" id="twSwInput" placeholder="Type a message..." />
          <button id="twSwSend">Send</button>
        </div>
        <div class="tw-sw-ticket-link" id="twSwTicketToggle">Prefer a human? Submit a support ticket instead</div>
      </div>
    </div>
    <button class="tw-sw-launcher" id="twSwLauncher">💬</button>
  `;
  document.body.appendChild(root);

  const panel = document.getElementById('twSwPanel');
  const body = document.getElementById('twSwBody');
  const input = document.getElementById('twSwInput');
  const ticketForm = document.getElementById('twSwTicketForm');
  const footer = document.getElementById('twSwFooter');
  let history = [];
  let sending = false;

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = `tw-sw-msg ${role}`;
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  document.getElementById('twSwLauncher').addEventListener('click', () => panel.classList.toggle('open'));
  document.getElementById('twSwClose').addEventListener('click', () => panel.classList.remove('open'));

  async function send() {
    const message = input.value.trim();
    if (!message || sending) return;
    sending = true;
    input.value = '';
    addMessage('user', message);
    try {
      const api = window.TW && TW.api ? TW.api : (path, opts) => fetch(path, { method: opts.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) }).then((r) => r.json());
      const data = await api('/api/support/chat', { method: 'POST', body: { message, history } });
      history.push({ role: 'user', content: message });
      history.push({ role: 'assistant', content: data.reply });
      addMessage('assistant', data.reply);
    } catch (e) {
      addMessage('system', e.message || 'Support chat is unavailable right now - try submitting a ticket instead.');
    } finally {
      sending = false;
    }
  }
  document.getElementById('twSwSend').addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  document.getElementById('twSwTicketToggle').addEventListener('click', () => {
    ticketForm.classList.add('open');
    footer.style.display = 'none';
  });
  document.getElementById('twSwTicketCancel').addEventListener('click', () => {
    ticketForm.classList.remove('open');
    footer.style.display = 'block';
  });
  document.getElementById('twSwTicketSubmit').addEventListener('click', async () => {
    const subject = document.getElementById('twSwTicketSubject').value.trim();
    const message = document.getElementById('twSwTicketMessage').value.trim();
    if (!subject || !message) return;
    try {
      const api = window.TW && TW.api ? TW.api : (path, opts) => fetch(path, { method: opts.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) }).then((r) => r.json());
      await api('/api/support/ticket', { method: 'POST', body: { subject, message } });
      ticketForm.classList.remove('open');
      footer.style.display = 'block';
      document.getElementById('twSwTicketSubject').value = '';
      document.getElementById('twSwTicketMessage').value = '';
      addMessage('system', 'Ticket submitted - our team will follow up.');
    } catch (e) {
      addMessage('system', e.message || 'Could not submit ticket - please try again.');
    }
  });
})();
