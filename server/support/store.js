'use strict';

// Support data access. Service-role client (server-side only); every function
// that serves a user is called with an already-verified owner, and the
// serializers below decide exactly which fields ever reach a browser.

const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function ticketRef(ticket) {
  return ticket && ticket.ticket_number ? `SC-${String(ticket.ticket_number).padStart(6, '0')}` : null;
}

function firstName(name) {
  const n = String(name || '').trim();
  if (!n) return 'Support';
  const first = n.includes('@') ? n.split('@')[0] : n.split(/\s+/)[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// What a player may see of one message: never notes, never meta internals.
function publicMessage(m) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    sender: m.sender_type,
    senderName: m.sender_type === 'human' ? firstName(m.sender_name) : null,
    body: m.body,
    attachments: (m.attachments || []).map((a, i) => ({ index: i, mime: a.mime })),
    helpful: m.meta && typeof m.meta.helpful === 'boolean' ? m.meta.helpful : null,
    kind: (m.meta && m.meta.kind) || null,
    createdAt: m.created_at,
  };
}

function publicConversation(c, ticket) {
  if (!c) return null;
  return {
    id: c.id,
    status: c.status,
    agentName: c.assigned_admin_name ? firstName(c.assigned_admin_name) : null,
    needsEmail: Boolean(c.meta && c.meta.pending_escalation) && !c.user_id && !c.guest_email,
    hasGuestEmail: Boolean(c.guest_email),
    csatGiven: c.csat !== null && c.csat !== undefined,
    resolvedAt: c.resolved_at,
    ticketRef: ticketRef(ticket),
    createdAt: c.created_at,
  };
}

function createStore(supabase) {
  async function one(q) {
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  const store = {
    ticketRef,
    firstName,
    publicMessage,
    publicConversation,
    REOPEN_WINDOW_MS,

    async getConversation(id) {
      return one(supabase.from('support_conversations').select('*').eq('id', id).maybeSingle());
    },

    ownsConversation(conv, owner) {
      if (!conv || !owner) return false;
      if (owner.playerId) return conv.user_id === owner.playerId;
      return Boolean(owner.guestHash) && !conv.user_id && conv.guest_token === owner.guestHash;
    },

    // The owner's most recent conversation that is still open, or resolved
    // within the reopen window (so a reload or another device picks it up).
    async findCurrentConversation(owner) {
      let q = supabase.from('support_conversations').select('*').order('updated_at', { ascending: false }).limit(1);
      q = owner.playerId ? q.eq('user_id', owner.playerId) : q.eq('guest_token', owner.guestHash).is('user_id', null);
      const rows = await one(q);
      const c = rows && rows[0];
      if (!c) return null;
      if (c.status === 'closed') return null;
      if (c.status === 'resolved' && (!c.resolved_at || Date.now() - new Date(c.resolved_at).getTime() > REOPEN_WINDOW_MS)) return null;
      return c;
    },

    async listConversationsForOwner(owner, limit = 20) {
      let q = supabase.from('support_conversations').select('*').order('updated_at', { ascending: false }).limit(limit);
      q = owner.playerId ? q.eq('user_id', owner.playerId) : q.eq('guest_token', owner.guestHash).is('user_id', null);
      return one(q);
    },

    async createConversation(owner) {
      return one(
        supabase
          .from('support_conversations')
          .insert({ user_id: owner.playerId || null, guest_token: owner.playerId ? null : owner.guestHash, status: 'ai', channel: 'web' })
          .select()
          .single()
      );
    },

    async updateConversation(id, patch) {
      return one(
        supabase
          .from('support_conversations')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('id', id)
          .select()
          .single()
      );
    },

    async mergeConversationMeta(id, patch) {
      const conv = await store.getConversation(id);
      return store.updateConversation(id, { meta: { ...(conv.meta || {}), ...patch } });
    },

    async addMessage({ conversationId, senderType, senderId = null, senderName = null, body = '', attachments = [], meta = {}, visibleToUser = true }) {
      const row = await one(
        supabase
          .from('support_messages')
          .insert({
            conversation_id: conversationId,
            sender_type: senderType,
            sender_id: senderId,
            sender_name: senderName,
            body,
            attachments,
            meta,
            visible_to_user: senderType === 'note' ? false : visibleToUser,
          })
          .select()
          .single()
      );
      await supabase.from('support_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
      return row;
    },

    async getMessage(id) {
      return one(supabase.from('support_messages').select('*').eq('id', id).maybeSingle());
    },

    async updateMessageMeta(id, patch) {
      const m = await store.getMessage(id);
      return one(supabase.from('support_messages').update({ meta: { ...(m.meta || {}), ...patch } }).eq('id', id).select().single());
    },

    async listMessages(conversationId, { includeHidden = false, limit = 500 } = {}) {
      let q = supabase.from('support_messages').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(limit);
      if (!includeHidden) q = q.eq('visible_to_user', true);
      return one(q);
    },

    async recentMessages(conversationId, n = 20) {
      const rows = await one(
        supabase
          .from('support_messages')
          .select('*')
          .eq('conversation_id', conversationId)
          .eq('visible_to_user', true)
          .order('created_at', { ascending: false })
          .limit(n)
      );
      return rows.reverse();
    },

    // ---- tickets ----
    async getTicketForConversation(conversationId) {
      const rows = await one(supabase.from('support_tickets').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(1));
      return rows[0] || null;
    },

    async createTicket({ playerId = null, guestEmail = null, conversationId = null, subject, message, category = 'other', priority = 'normal' }) {
      return one(
        supabase
          .from('support_tickets')
          .insert({
            player_id: playerId,
            guest_email: guestEmail,
            conversation_id: conversationId,
            subject: String(subject || 'Support request').slice(0, 200),
            message: String(message || '').slice(0, 4000),
            category,
            priority,
            status: 'open',
          })
          .select()
          .single()
      );
    },

    async updateTicket(id, patch) {
      return one(supabase.from('support_tickets').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().single());
    },

    async listTicketsForPlayer(playerId) {
      return one(
        supabase
          .from('support_tickets')
          .select('id, ticket_number, subject, status, category, conversation_id, created_at, updated_at, resolved_at')
          .eq('player_id', playerId)
          .order('updated_at', { ascending: false })
          .limit(50)
      );
    },

    async getPlayer(playerId) {
      return one(supabase.from('players').select('*').eq('id', playerId).maybeSingle());
    },

    async getSetting(key) {
      const row = await one(supabase.from('app_settings').select('value').eq('key', key).maybeSingle());
      return row ? row.value : null;
    },
  };
  return store;
}

module.exports = { createStore, ticketRef, firstName, publicMessage, publicConversation, REOPEN_WINDOW_MS };
