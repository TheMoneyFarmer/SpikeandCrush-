'use strict';

// Mounts the support system on the game server:
//  - /api/support/*           player + guest HTTP API (AI replies stream as SSE)
//  - socket.io namespace /support   live agent replies / status for the open chat
//  - /internal/support/*      secret + localhost-only bridge for the admin server
// Identity: a Supabase access token (players) or a random guest token kept in
// the browser (guests). The player id always comes from the verified token.

const express = require('express');
const { requireBridgeSecret } = require('../bridgeAuth');
const multer = require('multer');
const { createSupportService } = require('./service');
const { syncToDatabase } = require('./kbSync');
const safety = require('./safety');
const emails = require('./emails');
const { MAX_BYTES } = require('./uploads');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUEST_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

function createAdminBridge() {
  const url = (process.env.ADMIN_INTERNAL_URL || `http://127.0.0.1:${process.env.ADMIN_PORT || 3003}`).replace(/\/$/, '');
  const secret = process.env.INTERNAL_ADMIN_SECRET;
  return {
    emit(type, payload) {
      if (!secret) return;
      fetch(`${url}/internal/support-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
        body: JSON.stringify({ type, ...payload }),
      }).catch(() => {}); // admin panel may be down; the inbox reloads from the DB anyway
    },
  };
}

function mountSupport({ app, io, supabaseAdmin, getAuthUser, db, notifyPlayer, clientIp, limiters = {} }) {
  const pass = (req, res, next) => next();
  const messageLimiter = limiters.message || pass;
  const ticketLimiter = limiters.ticket || pass;
  const nsp = io.of('/support');
  const adminBridge = createAdminBridge();
  const service = createSupportService({
    supabase: supabaseAdmin,
    nsp,
    notifyPlayer,
    adminBridge,
    model: process.env.SUPPORT_MODEL || 'claude-haiku-4-5-20251001',
    apiKey: process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_value' ? process.env.ANTHROPIC_API_KEY : null,
    adminBaseUrl: (process.env.ADMIN_PUBLIC_URL || 'https://admin.spikeandcrush.com').replace(/\/$/, ''),
  });
  const { store } = service;

  // ---- identity -----------------------------------------------------------
  async function ownerFromToken(token, guestToken, ip) {
    if (token) {
      try {
        const { data, error } = await (getAuthUser ? getAuthUser(token) : supabaseAdmin.auth.getUser(token));
        if (!error && data && data.user) {
          const player = await db.getPlayerBySupabaseUserId(data.user.id);
          if (player) return { playerId: player.id, actorKey: `p:${player.id}` };
        }
      } catch (e) {
        /* fall through to guest */
      }
    }
    if (guestToken && GUEST_TOKEN_RE.test(guestToken)) {
      return { guestHash: safety.hashGuestToken(guestToken), actorKey: `ip:${safety.hashIp(ip || 'unknown')}` };
    }
    return null;
  }
  async function owner(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    return ownerFromToken(token, req.headers['x-support-guest'], clientIp(req));
  }
  const withOwner = (handler) => async (req, res) => {
    try {
      const o = await owner(req);
      if (!o) return res.status(401).json({ error: 'Please refresh the page and try again.' });
      await handler(req, res, o);
    } catch (e) {
      console.error('[support api]', req.method, req.path, e);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
      else if (!res.writableEnded) res.end(); // never leave a started stream hanging
    }
  };
  const fail = (res, r) => res.status(r.status || 400).json({ error: r.error });

  const router = express.Router();

  // Current conversation for this browser/account (or none yet) + its messages.
  router.post(
    '/session',
    withOwner(async (req, res, o) => {
      const requested = UUID_RE.test(req.body?.conversationId || '') ? req.body.conversationId : null;
      const conv = await service.resolveConversation(o, requested);
      const messages = conv ? (await store.listMessages(conv.id)).map(store.publicMessage) : [];
      const ticket = conv ? await store.getTicketForConversation(conv.id) : null;
      res.json({ loggedIn: Boolean(o.playerId), conversation: store.publicConversation(conv, ticket), messages, aiAvailable: service.agent.available });
    })
  );

  // Send a message. Streams Server-Sent Events: conversation, user_message,
  // delta (AI tokens), done. Without Accept: text/event-stream returns JSON.
  router.post(
    '/messages',
    messageLimiter,
    withOwner(async (req, res, o) => {
      const { conversationId, body, attachments } = req.body || {};
      if (conversationId && !UUID_RE.test(conversationId)) return res.status(404).json({ error: 'Conversation not found.' });
      const sse = String(req.headers.accept || '').includes('text/event-stream');
      const send = (event, data) => {
        if (!sse) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      let started = false;
      const start = () => {
        if (!sse || started) return;
        started = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      };
      let result;
      try {
        result = await service.postUserMessage(
        o,
        { conversationId, body, attachments },
        {
          onConversation: (c) => {
            start();
            send('conversation', { id: c.id, status: c.status });
          },
          onDelta: (text) => {
            start();
            send('delta', { text });
          },
        }
      );
      } catch (e) {
        // A failure after the stream started (e.g. a dropped database
        // connection) must still end the stream with an error the widget can
        // show with "Try again", or the player would see typing dots forever.
        console.error('[support api] message failed:', e.message || e);
        if (!started) throw e;
        send('done', { error: 'Something went wrong while answering. Please try again.' });
        return res.end();
      }
      if (result.error && !started) return fail(res, result);
      const conv = result.conversation ? await store.getConversation(result.conversation.id) : null;
      const ticket = conv ? await store.getTicketForConversation(conv.id) : null;
      const payload = {
        error: result.error || null,
        conversation: store.publicConversation(conv, ticket),
        userMessage: result.userMessage ? store.publicMessage(result.userMessage) : null,
        aiMessage: result.aiMessage ? store.publicMessage(result.aiMessage) : null,
        messages: conv ? (await store.listMessages(conv.id)).map(store.publicMessage) : [],
      };
      if (sse) {
        start();
        send('done', payload);
        return res.end();
      }
      res.json(payload);
    })
  );

  router.post(
    '/escalate',
    withOwner(async (req, res, o) => {
      const id = UUID_RE.test(req.body?.conversationId || '') ? req.body.conversationId : null;
      const r = await service.requestHuman(o, id);
      if (r.error) return fail(res, r);
      const ticket = await store.getTicketForConversation(r.conversation.id);
      res.json({ status: r.status, conversation: store.publicConversation(r.conversation, ticket), messages: (await store.listMessages(r.conversation.id)).map(store.publicMessage) });
    })
  );

  // Each email address given here can trigger emails, so this has the strict
  // ticket limit (5 an hour per IP) to stop it being used to bomb an inbox.
  router.post(
    '/guest-email',
    ticketLimiter,
    withOwner(async (req, res, o) => {
      if (o.playerId) return res.status(400).json({ error: 'Signed-in players are emailed at their account address.' });
      const r = await service.setGuestEmail(o, req.body?.conversationId, req.body?.email);
      if (r.error) return fail(res, r);
      const ticket = await store.getTicketForConversation(r.conversation.id);
      res.json({ conversation: store.publicConversation(r.conversation, ticket), messages: (await store.listMessages(r.conversation.id)).map(store.publicMessage) });
    })
  );

  router.post(
    '/feedback',
    withOwner(async (req, res, o) => {
      const r = await service.submitFeedback(o, req.body?.conversationId, req.body?.rating, req.body?.comment);
      if (r.error) return fail(res, r);
      res.json(r);
    })
  );

  router.post(
    '/messages/:id/rate',
    withOwner(async (req, res, o) => {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Message not found.' });
      const r = await service.rateMessage(o, req.params.id, Boolean(req.body?.helpful));
      if (r.error) return fail(res, r);
      res.json(r);
    })
  );

  // One image per message. Uploaded before sending; the returned descriptor
  // is passed with the message and only accepted for this same conversation.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
  router.post(
    '/attachments',
    messageLimiter,
    (req, res, next) =>
      upload.single('file')(req, res, (err) => {
        if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Images must be 3 MB or smaller.' : 'Upload failed.' });
        next();
      }),
    withOwner(async (req, res, o) => {
      if (!req.file) return res.status(400).json({ error: 'No file received.' });
      let conv = await service.resolveConversation(o, UUID_RE.test(req.body?.conversationId || '') ? req.body.conversationId : null);
      if (req.body?.conversationId && !conv) return res.status(404).json({ error: 'Conversation not found.' });
      if (!conv) conv = await store.createConversation(o);
      const r = await service.uploads.store(conv.id, req.file.buffer);
      if (r.error) return res.status(400).json({ error: r.error });
      res.json({ conversationId: conv.id, attachment: r });
    })
  );

  // Attachment fetch: ownership check, then a 60-second signed URL redirect.
  router.get(
    '/attachments/:messageId/:index',
    withOwner(async (req, res, o) => {
      if (!UUID_RE.test(req.params.messageId)) return res.status(404).json({ error: 'Not found' });
      const m = await store.getMessage(req.params.messageId);
      const conv = m && m.visible_to_user ? await store.getConversation(m.conversation_id) : null;
      if (!conv || !store.ownsConversation(conv, o)) return res.status(404).json({ error: 'Not found' });
      const a = (m.attachments || [])[Number(req.params.index) || 0];
      if (!a) return res.status(404).json({ error: 'Not found' });
      res.redirect(302, await service.uploads.signedUrl(a.path));
    })
  );

  router.get(
    '/conversations',
    withOwner(async (req, res, o) => {
      const rows = await store.listConversationsForOwner(o);
      res.json({ conversations: rows.map((c) => store.publicConversation(c, null)) });
    })
  );

  // "My tickets" (signed-in players).
  router.get(
    '/tickets/mine',
    withOwner(async (req, res, o) => {
      if (!o.playerId) return res.json({ tickets: [] });
      const rows = await store.listTicketsForPlayer(o.playerId);
      res.json({
        tickets: rows.map((t) => ({ id: t.id, ref: store.ticketRef(t), subject: t.subject, status: t.status, category: t.category, conversationId: t.conversation_id, updatedAt: t.updated_at || t.created_at })),
      });
    })
  );

  // Ticket form (guests who don't want chat, and the legacy widget). A guest
  // must give an email; signed-in players' tickets are linked to their account.
  router.post('/ticket', ticketLimiter, async (req, res) => {
    try {
      const { subject, message, email, category, website } = req.body || {};
      if (website) return res.json({ success: true });
      if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required.' });
      const o = await owner(req);
      const actorKey = (o && o.actorKey) || `ip:${safety.hashIp(clientIp(req))}`;
      if (!safety.checkRateLimit({ conversationId: null, actorKey }).ok) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      const cat = require('./tools').CATEGORIES.includes(category) ? category : 'other';
      if (o && o.playerId) {
        const t = await store.createTicket({ playerId: o.playerId, subject: safety.maskPII(subject).text, message: safety.maskPII(message).text, category: cat });
        adminBridge.emit('ticket', { ticketRef: store.ticketRef(t) });
        return res.json({ success: true, ticket: store.ticketRef(t) });
      }
      const r = await service.createGuestTicket({ email, subject: String(subject).slice(0, 200), message: String(message).slice(0, 4000), category: cat });
      if (r.error) return fail(res, r);
      res.json({ success: true, ticket: r.ticket });
    } catch (e) {
      console.error('[support ticket]', e);
      res.status(500).json({ error: 'Could not submit the ticket. Please try again.' });
    }
  });

  // The old stateless chat endpoint (pre-rebuild widget). A page loaded before
  // the deploy gets a clear instruction instead of an empty reply.
  router.post('/chat', (req, res) => res.status(410).json({ error: 'Support chat was updated. Please refresh the page to continue.' }));

  app.use('/api/support', router);

  // ---- socket namespace ---------------------------------------------------
  nsp.use(async (socket, next) => {
    try {
      const a = socket.handshake.auth || {};
      const o = await ownerFromToken(a.token, a.guestToken, socket.handshake.address);
      if (!o) return next(new Error('unauthorized'));
      socket.data.owner = o;
      next();
    } catch (e) {
      next(new Error('unauthorized'));
    }
  });
  nsp.on('connection', (socket) => {
    socket.on('support:join', async ({ conversationId } = {}, ack) => {
      try {
        if (!UUID_RE.test(conversationId || '')) return typeof ack === 'function' && ack({ ok: false });
        const conv = await store.getConversation(conversationId);
        if (!store.ownsConversation(conv, socket.data.owner)) return typeof ack === 'function' && ack({ ok: false });
        for (const r of socket.rooms) if (r.startsWith('conv:')) socket.leave(r);
        socket.join(`conv:${conversationId}`);
        if (typeof ack === 'function') ack({ ok: true });
      } catch (e) {
        if (typeof ack === 'function') ack({ ok: false });
      }
    });
  });

  // ---- internal bridge for the admin server -------------------------------
  const internal = express.Router();
  internal.use(requireBridgeSecret);
  const adminOf = (req) => ({ id: UUID_RE.test(req.body?.admin?.id || '') ? req.body.admin.id : null, name: String(req.body?.admin?.name || 'Support').slice(0, 80) });
  const wrap = (fn) => async (req, res) => {
    try {
      if (req.params.id && !UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const r = await fn(req);
      if (r && r.error) return res.status(r.status || 400).json({ error: r.error });
      res.json(r || { ok: true });
    } catch (e) {
      console.error('[support internal]', req.path, e);
      res.status(500).json({ error: e.message });
    }
  };
  internal.post('/conversations/:id/assign', wrap((req) => service.adminAssign(req.params.id, adminOf(req))));
  internal.post('/conversations/:id/reassign', wrap((req) => service.adminReassign(req.params.id, { id: UUID_RE.test(req.body?.target?.id || '') ? req.body.target.id : null, name: String(req.body?.target?.name || '') }, adminOf(req))));
  internal.post('/conversations/:id/reply', wrap((req) => service.adminReply(req.params.id, adminOf(req), { body: req.body?.body, attachments: req.body?.attachments || [], note: Boolean(req.body?.note) })));
  internal.post('/conversations/:id/handback', wrap((req) => service.adminHandBack(req.params.id, adminOf(req))));
  internal.post('/conversations/:id/resolve', wrap((req) => service.adminResolve(req.params.id, adminOf(req))));
  internal.post('/conversations/:id/priority', wrap((req) => service.adminSetPriority(req.params.id, req.body?.priority)));
  internal.post('/conversations/:id/suggest', wrap((req) => service.adminSuggest(req.params.id)));
  internal.post('/conversations/:id/attachments', express.raw({ type: '*/*', limit: '4mb' }), wrap(async (req) => {
    const r = await service.uploads.store(req.params.id, req.body);
    return r.error ? { error: r.error, status: 400 } : { attachment: r };
  }));
  internal.post('/kb/regenerate', wrap((req) => syncToDatabase(supabaseAdmin, { updatedBy: String(req.body?.admin?.name || 'admin') })));
  internal.post('/sla/check', wrap(async () => ({ flagged: await service.checkSla() })));
  internal.get('/online/:id', wrap(async (req) => ({ online: service.userOnline(req.params.id) })));
  if (process.env.SUPPORT_EMAIL_DRY_RUN === '1') {
    internal.get('/test/emails', (req, res) => res.json(emails.outbox));
    internal.post('/test/reset-limits', (req, res) => {
      safety.resetRateLimits();
      res.json({ ok: true });
    });
  }
  app.use('/internal/support', express.json({ limit: '1mb' }), internal);

  // Keep the code-derived knowledge articles in the database in step with the
  // running code. Admin-edited articles are left alone. A failure here (for
  // example the migration hasn't run yet) only logs: it must never stop the game.
  syncToDatabase(supabaseAdmin, { updatedBy: 'server start', writeFiles: false })
    .then((r) => console.log(`[support] knowledge base synced: ${r.written.length} articles, ${r.skippedAdminEdited.length} admin-edited kept`))
    .catch((e) => console.warn('[support] knowledge base sync failed:', e.message));

  // First-response SLA check, once a minute.
  const slaTimer = setInterval(() => service.checkSla().catch((e) => console.warn('[support] SLA check failed:', e.message)), 60 * 1000);
  slaTimer.unref();

  console.log(`[support] mounted - AI ${service.agent.available ? `on (${process.env.SUPPORT_MODEL || 'claude-haiku-4-5-20251001'})` : 'OFF (ANTHROPIC_API_KEY not set): every message gets the fallback and is escalated'}`);
  return service;
}

module.exports = { mountSupport };
