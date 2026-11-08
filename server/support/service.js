'use strict';

// Support conversation lifecycle: AI replies, handoff to humans, admin
// actions, notifications and the first-response SLA. Transport-agnostic: the
// HTTP routes, the /support socket namespace and the internal admin bridge in
// ./index.js all call into this.

const { createStore, publicMessage, publicConversation, firstName, REOPEN_WINDOW_MS } = require('./store');
const { createKb } = require('./kb');
const { createToolRunner } = require('./tools');
const { createAgent, SupportAiUnavailable } = require('./agent');
const { createUploads } = require('./uploads');
const safety = require('./safety');
const emails = require('./emails');
const { NO_CASH } = require('./knowledge/articles');

const MAX_BODY = 2000;
const FALLBACK_TEXT = 'I could not answer that. Let me get a human for you.';
const HANDOFF_TEXT = 'A human agent will reply here. You can close this window; we will also email you.';
const WAITING_TEXT = 'Thanks, I have added this to your request. A human agent will reply here.';
const SLA_TEXT = 'Still waiting for a human. Your ticket stays open.';
const UNSURE_RE = /\b(not sure|i'?m unsure|i do not know|i don'?t know|don'?t have (that|this|any) information|do not have (that|this|any) information|couldn'?t find|could not find|can'?t find|cannot find|no information)\b/i;
const CASH_Q_RE = /\b(withdraw\w*|cash ?out|cash\b|real money|payout|pay ?out|bank transfer|paypal|crypto|convert (my )?coins|redeem|sell (my )?coins|exchange (my )?coins)\b/i;
const NO_CASH_RE = /no (real[- ]world )?cash value|cannot be withdrawn|can'?t be withdrawn|not be withdrawn/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function createSupportService({ supabase, nsp, notifyPlayer, adminBridge, model, apiKey, adminBaseUrl }) {
  const store = createStore(supabase);
  const kb = createKb(supabase);
  const uploads = createUploads(supabase);
  const room = (id) => `conv:${id}`;

  let service; // forward ref for tool callbacks
  const tools = createToolRunner({
    supabase,
    kb,
    createTicket: (ctx, input) => service.createTicketFromTool(ctx, input),
    escalate: (ctx, input) => service.requestEscalationFromTool(ctx, input),
  });
  const agent = createAgent({ kb, tools, model, apiKey });

  // ---- events --------------------------------------------------------------
  function adminMessage(m) {
    return { id: m.id, conversation_id: m.conversation_id, sender_type: m.sender_type, sender_name: m.sender_name, body: m.body, attachments: (m.attachments || []).map((a, i) => ({ index: i, mime: a.mime })), meta: m.meta, visible_to_user: m.visible_to_user, created_at: m.created_at };
  }
  function emitMessage(m) {
    if (m.visible_to_user) nsp.to(room(m.conversation_id)).emit('support:message', publicMessage(m));
    adminBridge.emit('message', { conversationId: m.conversation_id, message: adminMessage(m) });
  }
  async function emitStatus(conv) {
    const ticket = await store.getTicketForConversation(conv.id);
    nsp.to(room(conv.id)).emit('support:status', publicConversation(conv, ticket));
    adminBridge.emit('status', { conversationId: conv.id, status: conv.status, priority: conv.priority, assignedAdminName: conv.assigned_admin_name, ticketRef: store.ticketRef(ticket) });
  }
  function userOnline(conversationId) {
    const r = nsp.adapter.rooms.get(room(conversationId));
    return Boolean(r && r.size > 0);
  }
  async function say(conv, senderType, body, meta = {}, extra = {}) {
    const m = await store.addMessage({ conversationId: conv.id, senderType, body, meta, ...extra });
    emitMessage(m);
    return m;
  }

  async function contactEmail(conv) {
    if (conv.user_id) {
      const p = await store.getPlayer(conv.user_id);
      return p && p.email ? p.email : null;
    }
    return conv.guest_email || null;
  }
  async function whoLabel(conv) {
    if (conv.user_id) {
      const p = await store.getPlayer(conv.user_id);
      return p ? p.username : 'Player';
    }
    return conv.guest_email ? `Guest (${safety.maskEmail(conv.guest_email)})` : 'Guest';
  }

  // ---- support hours (app_settings.support_hours) ---------------------------
  // { "timezone": "UTC", "days": [1,2,3,4,5], "start": "09:00", "end": "18:00" }
  // days: 0 = Sunday. Missing setting = no hours message.
  async function hoursNote() {
    let cfg;
    try {
      cfg = await store.getSetting('support_hours');
    } catch (e) {
      return null;
    }
    if (!cfg || !Array.isArray(cfg.days) || !cfg.start || !cfg.end) return null;
    const tz = cfg.timezone || 'UTC';
    const parts = (d) => {
      const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
      const get = (t) => f.find((p) => p.type === t).value;
      const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
      return { wd, mins: Number(get('hour')) * 60 + Number(get('minute')) };
    };
    const toMins = (hhmm) => Number(hhmm.split(':')[0]) * 60 + Number(hhmm.split(':')[1] || 0);
    const now = parts(new Date());
    const open = cfg.days.includes(now.wd) && now.mins >= toMins(cfg.start) && now.mins < toMins(cfg.end);
    if (open) return null;
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let nextDay = null;
    for (let i = 0; i < 8; i++) {
      const wd = (now.wd + i) % 7;
      if (!cfg.days.includes(wd)) continue;
      if (i === 0 && now.mins >= toMins(cfg.start)) continue;
      nextDay = i === 0 ? 'today' : i === 1 ? 'tomorrow' : names[wd];
      break;
    }
    return `Our team is offline right now. They are back ${nextDay || 'soon'} at ${cfg.start} (${tz}). Your request is saved and they will reply here.`;
  }

  // ---- conversation resolution ----------------------------------------------
  async function resolveConversation(owner, conversationId) {
    if (conversationId) {
      const c = await store.getConversation(conversationId);
      if (!store.ownsConversation(c, owner)) return null;
      return c;
    }
    return store.findCurrentConversation(owner);
  }

  // A resolved conversation is reopened (same thread, same ticket) if the user
  // writes again within 7 days; after that, or once closed, a new one starts.
  async function ensureWritable(owner, conv) {
    if (!conv) return store.createConversation(owner);
    if (conv.status === 'closed') return store.createConversation(owner);
    if (conv.status === 'resolved') {
      if (conv.resolved_at && Date.now() - new Date(conv.resolved_at).getTime() <= REOPEN_WINDOW_MS) {
        const reopened = await store.updateConversation(conv.id, { status: 'ai', resolved_at: null, csat: null });
        const ticket = await store.getTicketForConversation(conv.id);
        if (ticket) await store.updateTicket(ticket.id, { status: 'open', resolved_at: null });
        await say(reopened, 'system', 'Conversation reopened');
        await emitStatus(reopened);
        return reopened;
      }
      return store.createConversation(owner);
    }
    return conv;
  }

  // ---- tickets --------------------------------------------------------------
  async function ensureTicket(conv, { subject, message, category = 'other', priority = 'normal' }) {
    const existing = await store.getTicketForConversation(conv.id);
    if (existing) {
      if (['resolved', 'closed'].includes(existing.status)) await store.updateTicket(existing.id, { status: 'open', resolved_at: null });
      return existing;
    }
    const t = await store.createTicket({ playerId: conv.user_id, guestEmail: conv.guest_email, conversationId: conv.id, subject, message, category, priority });
    if (!conv.user_id && conv.guest_email) emails.ticketReceived({ to: conv.guest_email, ticketRef: store.ticketRef(t), subject: t.subject }).catch(() => {});
    return t;
  }

  async function lastUserText(convId) {
    const msgs = await store.recentMessages(convId, 10);
    const u = msgs.filter((m) => m.sender_type === 'user').pop();
    return u ? u.body : '';
  }

  // ---- escalation -----------------------------------------------------------
  async function escalate(conversationId, { reason, summary, source, topic = null }) {
    let conv = await store.getConversation(conversationId);
    if (!conv) return { status: 'error' };
    if (['waiting_human', 'human'].includes(conv.status)) return { status: 'already_with_human' };
    if (!conv.user_id && !conv.guest_email) {
      conv = await store.mergeConversationMeta(conv.id, { pending_escalation: { reason, summary, source, topic: topic && topic.topic } });
      await say(conv, 'system', 'To connect you with a human, enter your email below so we can reply.', { kind: 'need_email' });
      nsp.to(room(conv.id)).emit('support:need_email', { conversationId: conv.id });
      await emitStatus(conv);
      return { status: 'needs_email' };
    }
    const userText = await lastUserText(conv.id);
    const ticket = await ensureTicket(conv, {
      subject: (summary || reason || userText || 'Support request').slice(0, 120),
      message: [summary && `Summary: ${summary}`, reason && `Reason: ${reason}`, userText && `Last message: ${userText}`].filter(Boolean).join('\n'),
      category: (topic && topic.category) || 'other',
      priority: (topic && topic.priority) || 'normal',
    });
    if (topic && topic.topic === 'sponsor') {
      const email = await contactEmail(conv);
      supabase
        .from('sponsor_leads')
        .insert({ company: 'From support chat', contact_name: await whoLabel(conv), email, interest: 'support_chat', message: userText.slice(0, 2000), status: 'new' })
        .then(({ error }) => error && console.warn('[support] sponsor lead insert failed:', error.message));
    }
    const priority = (topic && topic.priority) || conv.priority || 'normal';
    conv = await store.updateConversation(conv.id, {
      status: 'waiting_human',
      escalated_at: new Date().toISOString(),
      escalation_reason: String(reason || '').slice(0, 200),
      escalation_summary: String(summary || '').slice(0, 300),
      topic: (topic && topic.topic) || conv.topic,
      priority,
      meta: { ...(conv.meta || {}), pending_escalation: null, escalation_source: source, sla_notified: false },
    });
    await say(conv, 'system', 'Connecting you to a human agent');
    const hours = await hoursNote();
    await say(conv, 'ai', hours ? `${HANDOFF_TEXT}\n\n${hours}` : HANDOFF_TEXT, { kind: 'handoff' });
    await emitStatus(conv);

    const ref = store.ticketRef(ticket);
    adminBridge.emit('waiting', { conversationId: conv.id, ticketRef: ref, reason, summary, priority });
    // Admin email, throttled to one per conversation per 15 minutes.
    const notifyTo = process.env.SUPPORT_NOTIFY_EMAIL === 'off' ? null : process.env.SUPPORT_NOTIFY_EMAIL || 'hello@spikeandcrush.com';
    const lastMail = conv.meta && conv.meta.last_admin_email_at ? new Date(conv.meta.last_admin_email_at).getTime() : 0;
    if (notifyTo && Date.now() - lastMail > 15 * 60 * 1000) {
      await store.mergeConversationMeta(conv.id, { last_admin_email_at: new Date().toISOString() });
      emails
        .adminNewWaiting({ to: notifyTo, ticketRef: ref, reason, summary, who: await whoLabel(conv), adminUrl: `${adminBaseUrl}/support.html?c=${conv.id}` })
        .catch((e) => console.warn('[support] admin email failed:', e.message));
    }
    if (!conv.user_id && conv.guest_email) emails.escalatedToUser({ to: conv.guest_email, ticketRef: ref, conversationId: conv.id }).catch(() => {});
    return { status: 'escalated', ticket: ref };
  }

  // ---- the main entry point: a user message ---------------------------------
  async function postUserMessage(owner, { conversationId, body, attachments = [] }, { onDelta = () => {}, onConversation = () => {} } = {}) {
    const text = String(body || '').trim();
    if (!text && !attachments.length) return { error: 'Message is empty.', status: 400 };
    if (text.length > MAX_BODY) return { error: `Messages can be up to ${MAX_BODY} characters.`, status: 400 };

    let conv = await resolveConversation(owner, conversationId);
    if (conversationId && !conv) return { error: 'Conversation not found.', status: 404 };

    const limit = safety.checkRateLimit({ conversationId: conv && conv.id, actorKey: owner.actorKey });
    if (!limit.ok) {
      return {
        limited: true,
        status: 429,
        error: limit.scope === 'day' ? 'You have sent a lot of messages today. Please try again tomorrow, or email hello@spikeandcrush.com.' : 'You are sending messages quickly. Please wait a few minutes and try again.',
      };
    }

    conv = await ensureWritable(owner, conv);
    onConversation(conv);

    const cleanAttachments = (Array.isArray(attachments) ? attachments : [])
      .slice(0, 1)
      .filter((a) => a && typeof a.path === 'string' && a.path.startsWith(`${conv.id}/`) && /^image\/(png|jpeg|webp)$/.test(a.mime || ''))
      .map((a) => ({ path: a.path, mime: a.mime, size: Number(a.size) || null }));

    const pii = safety.maskPII(text);
    const userMsg = await store.addMessage({ conversationId: conv.id, senderType: 'user', senderId: owner.playerId || null, body: pii.text, attachments: cleanAttachments, meta: pii.masked ? { pii_masked: true } : {} });
    conv = await store.updateConversation(conv.id, { last_user_message_at: new Date().toISOString() });
    emitMessage(userMsg);
    if (pii.masked) await say(conv, 'system', 'For your safety we hid what looked like card, bank or ID numbers. Please do not share them here; we never need them.');

    if (conv.status === 'waiting_human') {
      const recent = await store.recentMessages(conv.id, 6);
      const lastBot = recent.filter((m) => m.sender_type !== 'user').pop();
      if (!lastBot || !lastBot.meta || lastBot.meta.kind !== 'waiting_ack') await say(conv, 'ai', WAITING_TEXT, { kind: 'waiting_ack' });
      return { conversation: conv, userMessage: userMsg };
    }
    if (conv.status === 'human') return { conversation: conv, userMessage: userMsg };

    // Trigger 1: asked for a human in words (detected in code).
    if (safety.detectHumanRequest(text)) {
      await escalate(conv.id, { reason: 'Player asked for a human', summary: text.slice(0, 200), source: 'user_request' });
      return { conversation: await store.getConversation(conv.id), userMessage: userMsg };
    }

    // Trigger 3: same question again after 2 AI answers on it.
    const history = await store.recentMessages(conv.id, 40);
    const priorUser = history.filter((m) => m.sender_type === 'user' && m.id !== userMsg.id);
    const firstSimilar = priorUser.find((m) => safety.similarity(m.body, text) >= 0.5);
    if (firstSimilar) {
      const aiAnswersSince = history.filter((m) => m.sender_type === 'ai' && m.created_at >= firstSimilar.created_at && !(m.meta && m.meta.kind)).length;
      if (aiAnswersSince >= 2) {
        await say(conv, 'ai', 'I have not been able to sort this out for you. Let me get a human.', { kind: 'unresolved' });
        await escalate(conv.id, { reason: 'Same issue unresolved after 2 AI answers', summary: text.slice(0, 200), source: 'repeat' });
        return { conversation: await store.getConversation(conv.id), userMessage: userMsg };
      }
    }

    const ctx = { playerId: owner.playerId || null, guestHash: owner.guestHash || null, conversationId: conv.id, conversationStatus: conv.status, kbArticleIds: [], pendingEscalation: null, hasGuestEmail: Boolean(conv.guest_email) };
    let result;
    try {
      result = await agent.reply({ ctx, history, latestUserText: pii.text, onDelta });
      if (!result.text) throw new SupportAiUnavailable('empty reply');
    } catch (e) {
      // Trigger 5: model/API failure after the SDK's retry. Never an empty bubble.
      if (!(e instanceof SupportAiUnavailable)) console.error('[support] agent error:', e);
      await say(conv, 'ai', FALLBACK_TEXT, { kind: 'fallback', error: String(e.message || e).slice(0, 200) });
      await escalate(conv.id, { reason: 'AI assistant unavailable', summary: text.slice(0, 200), source: 'ai_failure' });
      return { conversation: await store.getConversation(conv.id), userMessage: userMsg, fallback: true };
    }

    // Rule 1 guarantee in code: a cash/withdrawal question always gets the
    // no-cash-value statement, even if the model somehow left it out.
    let replyText = result.text;
    if (CASH_Q_RE.test(text) && !NO_CASH_RE.test(replyText)) {
      replyText = `${replyText}\n\n${NO_CASH}`;
      result.meta.no_cash_appended = true;
    }
    const aiMsg = await store.addMessage({ conversationId: conv.id, senderType: 'ai', body: replyText, meta: result.meta });
    emitMessage(aiMsg);

    // Gap logging: weak retrieval and the model said it's unsure.
    if (result.meta.retrieval_weak && UNSURE_RE.test(replyText)) kb.logGap(text, conv.id).catch((e) => console.warn('[support] gap log failed:', e.message));

    // Escalation the model asked for (applied after its reply so the thread reads in order).
    if (ctx.pendingEscalation) {
      await escalate(conv.id, ctx.pendingEscalation);
    } else {
      // Trigger 4: always-escalate topics, after the AI's immediate guidance.
      const topic = safety.detectEscalationTopic(text);
      if (topic) await escalate(conv.id, { reason: topic.reason, summary: text.slice(0, 200), source: 'topic', topic });
    }
    return { conversation: await store.getConversation(conv.id), userMessage: userMsg, aiMessage: aiMsg };
  }

  service = {
    store,
    kb,
    agent,
    uploads,
    escalate,
    postUserMessage,
    resolveConversation,
    emitStatus,
    userOnline,

    async requestEscalationFromTool(ctx, { reason, summary }) {
      ctx.pendingEscalation = { reason, summary, source: 'ai' };
      if (!ctx.playerId && !ctx.hasGuestEmail) return { status: 'needs_email', note: 'The chat will ask the guest for their email before a human can take over. Tell them to enter it.' };
      return { status: 'escalation_started', note: 'A human agent will reply in this chat and the player will be emailed.' };
    },

    async createTicketFromTool(ctx, { subject, summary, category, priority }) {
      const conv = await store.getConversation(ctx.conversationId);
      if (!conv.user_id && !conv.guest_email) {
        await store.mergeConversationMeta(conv.id, { pending_ticket: { subject, summary, category, priority } });
        nsp.to(room(conv.id)).emit('support:need_email', { conversationId: conv.id });
        return { status: 'needs_email', note: 'Ask the guest to enter their email in the box shown in the chat; the ticket is created as soon as they do.' };
      }
      const t = await ensureTicket(conv, { subject, message: summary, category, priority });
      adminBridge.emit('ticket', { conversationId: conv.id, ticketRef: store.ticketRef(t) });
      return { status: 'created', ticket: store.ticketRef(t) };
    },

    async requestHuman(owner, conversationId) {
      let conv = await resolveConversation(owner, conversationId);
      if (conversationId && !conv) return { error: 'Conversation not found.', status: 404 };
      conv = await ensureWritable(owner, conv);
      const r = await escalate(conv.id, { reason: 'Player clicked Talk to a human', summary: (await lastUserText(conv.id)).slice(0, 200), source: 'button' });
      return { ...r, conversation: await store.getConversation(conv.id) };
    },

    async setGuestEmail(owner, conversationId, email) {
      const conv = await resolveConversation(owner, conversationId);
      if (!conv || conv.user_id) return { error: 'Conversation not found.', status: 404 };
      const e = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(e)) return { error: 'Please enter a valid email address.', status: 400 };
      // One address per conversation: otherwise replies could be redirected, and
      // one conversation could send emails to a list of other people's addresses.
      if (conv.guest_email) return conv.guest_email === e ? { conversation: conv } : { error: 'This conversation already has an email address.', status: 400 };
      let updated = await store.updateConversation(conv.id, { guest_email: e });
      await say(updated, 'system', `Thanks. We will email you at ${safety.maskEmail(e)}.`);
      const meta = updated.meta || {};
      if (meta.pending_ticket) {
        const t = await ensureTicket(updated, { subject: meta.pending_ticket.subject, message: meta.pending_ticket.summary, category: meta.pending_ticket.category, priority: meta.pending_ticket.priority });
        updated = await store.mergeConversationMeta(conv.id, { pending_ticket: null });
        await say(updated, 'system', `Ticket ${store.ticketRef(t)} created.`);
      }
      if (meta.pending_escalation) await escalate(conv.id, meta.pending_escalation);
      return { conversation: await store.getConversation(conv.id) };
    },

    async submitFeedback(owner, conversationId, rating, comment) {
      const conv = await resolveConversation(owner, conversationId);
      if (!conv || !conversationId) return { error: 'Conversation not found.', status: 404 };
      const r = Number(rating) > 0 ? 1 : -1;
      await supabase.from('support_feedback').insert({ conversation_id: conv.id, rating: r, comment: comment ? String(comment).slice(0, 1000) : null });
      const updated = await store.updateConversation(conv.id, { csat: r });
      adminBridge.emit('feedback', { conversationId: conv.id, rating: r });
      await emitStatus(updated);
      return { ok: true };
    },

    // Thumbs-down on an AI answer; two of them (trigger 3) hands over to a human.
    async rateMessage(owner, messageId, helpful) {
      const m = await store.getMessage(messageId);
      if (!m || m.sender_type !== 'ai') return { error: 'Message not found.', status: 404 };
      const conv = await store.getConversation(m.conversation_id);
      if (!store.ownsConversation(conv, owner)) return { error: 'Message not found.', status: 404 };
      await store.updateMessageMeta(m.id, { helpful: Boolean(helpful) });
      if (!helpful && conv.status === 'ai') {
        const msgs = await store.listMessages(conv.id);
        const since = conv.escalated_at || '1970-01-01';
        const downs = msgs.filter((x) => x.sender_type === 'ai' && x.created_at >= since && x.meta && x.meta.helpful === false).length;
        if (downs >= 2) {
          await say(conv, 'ai', 'Sorry that did not help. Let me get a human for you.', { kind: 'unresolved' });
          await escalate(conv.id, { reason: 'Two AI answers marked not helpful', summary: (await lastUserText(conv.id)).slice(0, 200), source: 'thumbs_down' });
        }
      }
      return { ok: true };
    },

    async createGuestTicket({ email, subject, message, category }) {
      const e = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(e)) return { error: 'Please enter a valid email address.', status: 400 };
      const t = await store.createTicket({ guestEmail: e, subject: safety.maskPII(subject).text, message: safety.maskPII(message).text, category: category || 'other' });
      const ref = store.ticketRef(t);
      await emails.ticketReceived({ to: e, ticketRef: ref, subject: t.subject });
      adminBridge.emit('ticket', { ticketRef: ref });
      return { ticket: ref };
    },

    // ---- admin actions (called through the internal bridge) ------------------
    async adminAssign(conversationId, admin) {
      let conv = await store.getConversation(conversationId);
      if (!conv) return { error: 'Not found', status: 404 };
      const patch = { assigned_admin_id: admin.id || null, assigned_admin_name: admin.name };
      if (['ai', 'waiting_human'].includes(conv.status)) patch.status = 'human';
      conv = await store.updateConversation(conv.id, patch);
      const ticket = await store.getTicketForConversation(conv.id);
      if (ticket) await store.updateTicket(ticket.id, { assigned_admin_id: admin.id || null, status: 'pending_admin' });
      await say(conv, 'system', `${firstName(admin.name)} from the team joined the chat`);
      await emitStatus(conv);
      return { conversation: conv };
    },

    async adminReassign(conversationId, target, admin) {
      const conv = await store.updateConversation(conversationId, { assigned_admin_id: target.id || null, assigned_admin_name: target.name });
      await store.addMessage({ conversationId, senderType: 'note', senderName: admin.name, body: `Reassigned to ${target.name}`, visibleToUser: false }).then(emitMessage);
      await emitStatus(conv);
      return { conversation: conv };
    },

    async adminReply(conversationId, admin, { body, attachments = [], note = false }) {
      let conv = await store.getConversation(conversationId);
      if (!conv) return { error: 'Not found', status: 404 };
      const text = String(body || '').trim();
      if (!text && !attachments.length) return { error: 'Empty reply', status: 400 };
      const m = await store.addMessage({ conversationId, senderType: note ? 'note' : 'human', senderId: admin.id || null, senderName: admin.name, body: text.slice(0, 5000), attachments, visibleToUser: !note });
      // Whether the player saw it live is decided at the moment of delivery,
      // not after the database writes below.
      const online = !note && userOnline(conversationId);
      emitMessage(m);
      if (note) return { message: m };

      const patch = {};
      if (['ai', 'waiting_human', 'resolved'].includes(conv.status)) patch.status = 'human';
      if (!conv.assigned_admin_name) Object.assign(patch, { assigned_admin_id: admin.id || null, assigned_admin_name: admin.name });
      if (!conv.first_human_response_at) patch.first_human_response_at = new Date().toISOString();
      if (Object.keys(patch).length) conv = await store.updateConversation(conv.id, patch);
      const ticket = await store.getTicketForConversation(conv.id);
      if (ticket) await store.updateTicket(ticket.id, { status: 'pending_user', first_response_at: ticket.first_response_at || new Date().toISOString() });
      if (Object.keys(patch).length) await emitStatus(conv);

      // Offline user: email + bell. The chat stays the source of truth.
      const delivery = { online, email: null, bell: false };
      if (!online) {
        const to = await contactEmail(conv);
        if (to) {
          await emails.agentReply({ to, ticketRef: store.ticketRef(ticket), agentName: firstName(admin.name), message: text, conversationId: conv.id }).catch((e) => console.warn('[support] reply email failed:', e.message));
          delivery.email = safety.maskEmail(to);
        }
      }
      if (conv.user_id && notifyPlayer) {
        notifyPlayer(conv.user_id, 'support_reply', 'You have a reply from Spike & Crush support', { data: { conversationId: conv.id } });
        delivery.bell = true;
      }
      return { message: m, delivery };
    },

    async adminHandBack(conversationId, admin) {
      const conv = await store.updateConversation(conversationId, { status: 'ai' });
      await say(conv, 'system', 'You are back with the AI assistant. Ask for a human again any time.');
      await store.addMessage({ conversationId, senderType: 'note', senderName: admin.name, body: 'Handed back to AI', visibleToUser: false }).then(emitMessage);
      await emitStatus(conv);
      return { conversation: conv };
    },

    async adminResolve(conversationId, admin) {
      let conv = await store.getConversation(conversationId);
      if (!conv) return { error: 'Not found', status: 404 };
      conv = await store.updateConversation(conv.id, { status: 'resolved', resolved_at: new Date().toISOString() });
      const ticket = await store.getTicketForConversation(conv.id);
      if (ticket) await store.updateTicket(ticket.id, { status: 'resolved', resolved_at: new Date().toISOString() });
      await say(conv, 'system', 'Marked as resolved');
      await emitStatus(conv);
      if (conv.user_id && notifyPlayer) notifyPlayer(conv.user_id, 'support_resolved', 'Your support request was resolved', { data: { conversationId: conv.id } });
      const to = await contactEmail(conv);
      if (to) emails.resolved({ to, ticketRef: store.ticketRef(ticket), conversationId: conv.id }).catch(() => {});
      return { conversation: conv };
    },

    async adminSetPriority(conversationId, priority) {
      if (!['low', 'normal', 'high', 'urgent'].includes(priority)) return { error: 'Bad priority', status: 400 };
      const conv = await store.updateConversation(conversationId, { priority });
      const ticket = await store.getTicketForConversation(conversationId);
      if (ticket) await store.updateTicket(ticket.id, { priority });
      await emitStatus(conv);
      return { conversation: conv };
    },

    async adminSuggest(conversationId) {
      const thread = await store.listMessages(conversationId, { includeHidden: true });
      const lastUser = thread.filter((m) => m.sender_type === 'user').pop();
      return { draft: await agent.suggestReply({ thread, kbQuery: lastUser ? lastUser.body : '' }) };
    },

    // ---- first-response SLA ----------------------------------------------------
    async checkSla() {
      const minutes = Number(process.env.SUPPORT_FIRST_RESPONSE_MINUTES) || 60;
      const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('support_conversations')
        .select('*')
        .eq('status', 'waiting_human')
        .lt('escalated_at', cutoff)
        .is('first_human_response_at', null)
        .limit(50);
      if (error) throw error;
      for (const conv of data || []) {
        if (conv.meta && conv.meta.sla_notified) continue;
        const updated = await store.updateConversation(conv.id, { priority: 'urgent', meta: { ...(conv.meta || {}), sla_notified: true } });
        const ticket = await store.getTicketForConversation(conv.id);
        if (ticket) await store.updateTicket(ticket.id, { priority: 'urgent' });
        await say(updated, 'ai', SLA_TEXT, { kind: 'sla' });
        await emitStatus(updated);
        adminBridge.emit('sla', { conversationId: conv.id });
      }
      return (data || []).length;
    },
  };
  return service;
}

module.exports = { createSupportService, FALLBACK_TEXT, HANDOFF_TEXT, WAITING_TEXT, SLA_TEXT };
