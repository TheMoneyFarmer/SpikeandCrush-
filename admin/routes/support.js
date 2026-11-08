'use strict';

// Admin Support section: inbox, conversation view, user panel, canned
// responses, knowledge base editor, KB gaps and analytics. Mounted at
// /api/support behind requireAdmin. Every action is written to admin_logs.
//
// Reads go straight to Supabase. Anything that must reach a live player
// (replies, status changes, email, bell) goes through the game server's
// internal support bridge so the player's open chat updates instantly.
//
// Roles: super_admin + admin: everything. moderator: reply/resolve, view
// analytics, no KB edits, no CSV export. support: reply/resolve only.

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const internal = require('../lib/internalGameServer');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ref = (n) => (n ? `SC-${String(n).padStart(6, '0')}` : null);
const maskEmail = (e) => {
  const [u, d] = String(e || '').split('@');
  return u && d ? `${u[0]}***@${d}` : null;
};

const canEditKb = (req) => ['super_admin', 'admin'].includes(req.admin.role);
const canExport = (req) => ['super_admin', 'admin'].includes(req.admin.role);
const canSeeAnalytics = (req) => ['super_admin', 'admin', 'moderator'].includes(req.admin.role);

function router() {
  const r = express.Router();
  const nameCache = new Map();

  async function me(req) {
    const key = req.admin.id || req.admin.username;
    if (nameCache.has(key)) return nameCache.get(key);
    let name = req.admin.username;
    if (req.admin.id) {
      const { data } = await supabase.from('admin_users').select('name, email').eq('id', req.admin.id).maybeSingle();
      if (data) name = data.name || data.email;
    }
    const out = { id: req.admin.id || null, name, username: req.admin.username, role: req.admin.role };
    nameCache.set(key, out);
    return out;
  }
  const log = (req, actionType, targetType, targetId, details = {}) =>
    logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType, targetType, targetId, details, ip: clientIp(req) });

  const h = (fn) => async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      if (req.params.id && !UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
      await fn(req, res);
    } catch (e) {
      console.error('[admin support]', req.method, req.path, e.message);
      res.status(e.status || 500).json({ error: e.message });
    }
  };
  async function q(query) {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  // ---- inbox ------------------------------------------------------------------
  async function decorate(convs) {
    if (!convs.length) return [];
    const ids = convs.map((c) => c.id);
    const userIds = Array.from(new Set(convs.map((c) => c.user_id).filter(Boolean)));
    const [players, tickets, msgs] = await Promise.all([
      userIds.length ? q(supabase.from('players').select('id, username').in('id', userIds)) : [],
      q(supabase.from('support_tickets').select('conversation_id, ticket_number, status').in('conversation_id', ids)),
      q(supabase.from('support_messages').select('conversation_id, sender_type, body, created_at').in('conversation_id', ids).neq('sender_type', 'note').order('created_at', { ascending: false }).limit(2000)),
    ]);
    const pById = new Map(players.map((p) => [p.id, p]));
    const tByConv = new Map(tickets.map((t) => [t.conversation_id, t]));
    const lastByConv = new Map();
    const humanTouched = new Set();
    for (const m of msgs) {
      if (!lastByConv.has(m.conversation_id) && m.sender_type !== 'system') lastByConv.set(m.conversation_id, m);
      if (m.sender_type === 'human') humanTouched.add(m.conversation_id);
    }
    return convs.map((c) => {
      const p = c.user_id ? pById.get(c.user_id) : null;
      const last = lastByConv.get(c.id);
      return {
        id: c.id,
        ticketRef: ref(tByConv.get(c.id) && tByConv.get(c.id).ticket_number),
        user: p ? p.username : 'Guest',
        isGuest: !c.user_id,
        status: c.status,
        priority: c.priority,
        assignedAdminName: c.assigned_admin_name,
        assignedAdminId: c.assigned_admin_id,
        preview: last ? `${last.sender_type === 'user' ? '' : `${last.sender_type === 'ai' ? 'AI' : 'Team'}: `}${String(last.body).slice(0, 120)}` : '',
        lastAt: (last && last.created_at) || c.updated_at,
        escalatedAt: c.escalated_at,
        handledBy: humanTouched.has(c.id) ? 'human' : 'ai',
        reason: c.escalation_reason,
      };
    });
  }

  r.get('/conversations', h(async (req, res) => {
    const tab = req.query.tab || 'waiting';
    const search = String(req.query.q || '').trim();
    const admin = await me(req);
    let query = supabase.from('support_conversations').select('*').limit(200);
    if (tab === 'waiting') query = query.eq('status', 'waiting_human').order('escalated_at', { ascending: true });
    else if (tab === 'mine') query = query.in('status', ['waiting_human', 'human']).eq('assigned_admin_name', admin.name).order('updated_at', { ascending: false });
    else if (tab === 'open') query = query.in('status', ['ai', 'waiting_human', 'human']).order('updated_at', { ascending: false });
    else if (tab === 'resolved') query = query.in('status', ['resolved', 'closed']).order('updated_at', { ascending: false });
    else query = query.order('updated_at', { ascending: false });

    if (search) {
      const m = search.match(/^sc-?0*(\d+)$/i) || search.match(/^#?(\d{1,9})$/);
      if (m) {
        const t = await q(supabase.from('support_tickets').select('conversation_id').eq('ticket_number', Number(m[1])));
        query = query.in('id', t.map((x) => x.conversation_id).filter(Boolean).concat(['00000000-0000-0000-0000-000000000000']));
      } else {
        const like = `%${search.replace(/[%_,()]/g, '')}%`;
        const ps = await q(supabase.from('players').select('id').or(`username.ilike.${like},email.ilike.${like}`).limit(100));
        const ids = ps.map((p) => p.id);
        query = ids.length ? query.or(`user_id.in.(${ids.join(',')}),guest_email.ilike.${like}`) : query.ilike('guest_email', like);
      }
    }
    res.json({ conversations: await decorate(await q(query)) });
  }));

  r.get('/counts', h(async (req, res) => {
    const admin = await me(req);
    const count = async (b) => {
      const { count: n, error } = await b;
      if (error) throw error;
      return n || 0;
    };
    const [waiting, mine, open, urgent] = await Promise.all([
      count(supabase.from('support_conversations').select('id', { count: 'exact', head: true }).eq('status', 'waiting_human')),
      count(supabase.from('support_conversations').select('id', { count: 'exact', head: true }).in('status', ['waiting_human', 'human']).eq('assigned_admin_name', admin.name)),
      count(supabase.from('support_conversations').select('id', { count: 'exact', head: true }).in('status', ['ai', 'waiting_human', 'human'])),
      count(supabase.from('support_conversations').select('id', { count: 'exact', head: true }).eq('status', 'waiting_human').eq('priority', 'urgent')),
    ]);
    res.json({ waiting, mine, open, urgent, me: admin });
  }));

  r.get('/conversations/:id', h(async (req, res) => {
    const conv = await q(supabase.from('support_conversations').select('*').eq('id', req.params.id).maybeSingle());
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const [messages, tickets, player] = await Promise.all([
      q(supabase.from('support_messages').select('*').eq('conversation_id', conv.id).order('created_at', { ascending: true })),
      q(supabase.from('support_tickets').select('*').eq('conversation_id', conv.id).order('created_at').limit(1)),
      conv.user_id ? q(supabase.from('players').select('username').eq('id', conv.user_id).maybeSingle()) : null,
    ]);
    const ticket = tickets[0] || null;
    const { guest_token, ...safeConv } = conv;
    res.json({
      conversation: { ...safeConv, guest_email: conv.guest_email ? maskEmail(conv.guest_email) : null, user: player ? player.username : 'Guest' },
      ticket: ticket ? { ...ticket, guest_email: maskEmail(ticket.guest_email), ref: ref(ticket.ticket_number) } : null,
      messages: messages.map((m) => ({ ...m, attachments: (m.attachments || []).map((a, i) => ({ index: i, mime: a.mime })) })),
      me: await me(req),
    });
  }));

  // Read-only user context. Every open of this panel is audit-logged.
  r.get('/conversations/:id/user-panel', h(async (req, res) => {
    const conv = await q(supabase.from('support_conversations').select('user_id, guest_email').eq('id', req.params.id).maybeSingle());
    if (!conv) return res.status(404).json({ error: 'Not found' });
    if (!conv.user_id) {
      await log(req, 'support_view_user', 'support_conversation', req.params.id, { guest: true });
      return res.json({ guest: true, email: maskEmail(conv.guest_email) });
    }
    const pid = conv.user_id;
    const [p, mp, ledger, tickets, mod] = await Promise.all([
      q(supabase.from('players').select('id, username, email, war_rating, tier, coins, is_banned, banned_until, ban_reason, flagged, created_at, discord_id, total_matches').eq('id', pid).maybeSingle()),
      q(supabase.from('match_players').select('match_id, final_rank, final_pnl, rating_change, end_reason').eq('player_id', pid).limit(200)),
      q(supabase.from('coin_transactions').select('type, amount, balance_after, created_at').eq('player_id', pid).order('created_at', { ascending: false }).limit(20)),
      q(supabase.from('support_tickets').select('ticket_number, subject, status, updated_at').eq('player_id', pid).not('status', 'in', '(resolved,closed)').order('updated_at', { ascending: false }).limit(10)),
      q(supabase.from('player_moderation_actions').select('action_type, reason, created_at').eq('player_id', pid).order('created_at', { ascending: false }).limit(10)),
    ]);
    let matches = [];
    if (mp.length) {
      const ms = await q(supabase.from('matches').select('id, mode, created_at, status').in('id', mp.map((m) => m.match_id)).order('created_at', { ascending: false }).limit(10));
      const byId = new Map(mp.map((m) => [m.match_id, m]));
      matches = ms.map((m) => ({ ...m, ...byId.get(m.id) }));
    }
    await log(req, 'support_view_user', 'player', pid, { conversationId: req.params.id });
    const suspended = p && p.is_banned && (!p.banned_until || new Date(p.banned_until) > new Date());
    res.json({
      player: p && {
        id: p.id,
        handle: p.username,
        email: maskEmail(p.email),
        tier: p.tier,
        rating: p.war_rating,
        coins: p.coins,
        status: suspended ? 'suspended' : 'active',
        banReason: suspended ? p.ban_reason : null,
        flagged: p.flagged,
        created: p.created_at,
        discordLinked: Boolean(p.discord_id),
        matchesPlayed: p.total_matches,
      },
      matches,
      ledger,
      openTickets: tickets.map((t) => ({ ...t, ref: ref(t.ticket_number) })),
      moderation: mod,
    });
  }));

  // ---- actions (via the game server so the player's chat updates live) ---------
  const action = (name, path, bodyFn = () => ({})) =>
    h(async (req, res) => {
      const admin = await me(req);
      const out = await internal.support(`/conversations/${req.params.id}${path}`, { admin, ...(await bodyFn(req, admin)) });
      await log(req, `support_${name}`, 'support_conversation', req.params.id, name === 'reply' ? { note: Boolean(req.body?.note), length: String(req.body?.body || '').length } : req.body || {});
      res.json(out);
    });
  r.post('/conversations/:id/assign', action('assign', '/assign'));
  r.post('/conversations/:id/reply', action('reply', '/reply', (req) => ({ body: String(req.body?.body || ''), note: Boolean(req.body?.note), attachments: Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, 1) : [] })));
  r.post('/conversations/:id/handback', action('handback', '/handback'));
  r.post('/conversations/:id/resolve', action('resolve', '/resolve'));
  r.post('/conversations/:id/priority', action('priority', '/priority', (req) => ({ priority: req.body?.priority })));
  r.post('/conversations/:id/reassign', action('reassign', '/reassign', async (req) => {
    const target = UUID_RE.test(req.body?.targetId || '') ? await q(supabase.from('admin_users').select('id, name, email').eq('id', req.body.targetId).maybeSingle()) : null;
    if (!target) throw Object.assign(new Error('Unknown admin'), { status: 400 });
    return { target: { id: target.id, name: target.name || target.email } };
  }));
  r.post('/conversations/:id/suggest', action('suggest', '/suggest'));
  r.post('/conversations/:id/attachments', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'], limit: '4mb' }), h(async (req, res) => {
    const out = await internal.supportUpload(req.params.id, req.body, req.headers['content-type']);
    await log(req, 'support_upload', 'support_conversation', req.params.id);
    res.json(out);
  }));

  r.get('/attachments/:id/:index', h(async (req, res) => {
    const m = await q(supabase.from('support_messages').select('attachments').eq('id', req.params.id).maybeSingle());
    const a = m && (m.attachments || [])[Number(req.params.index) || 0];
    if (!a) return res.status(404).json({ error: 'Not found' });
    const { data, error } = await supabase.storage.from('support-attachments').createSignedUrl(a.path, 60);
    if (error) throw error;
    res.redirect(302, data.signedUrl);
  }));

  r.get('/admins', h(async (req, res) => {
    res.json({ admins: await q(supabase.from('admin_users').select('id, name, email, role').eq('is_active', true).order('name')) });
  }));

  // ---- canned responses ------------------------------------------------------------
  r.get('/canned', h(async (req, res) => res.json({ canned: await q(supabase.from('support_canned_responses').select('*').order('category').order('title')), canEdit: req.admin.role !== 'support' })));
  r.post('/canned', h(async (req, res) => {
    if (req.admin.role === 'support') return res.status(403).json({ error: 'Not allowed for your role' });
    const { title, body, category } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });
    const row = await q(supabase.from('support_canned_responses').insert({ title: String(title).slice(0, 120), body: String(body).slice(0, 4000), category: String(category || 'general').slice(0, 40), created_by: (await me(req)).name }).select().single());
    await log(req, 'support_canned_create', 'support_canned', row.id);
    res.json(row);
  }));
  r.put('/canned/:id', h(async (req, res) => {
    if (req.admin.role === 'support') return res.status(403).json({ error: 'Not allowed for your role' });
    const { title, body, category } = req.body || {};
    const row = await q(supabase.from('support_canned_responses').update({ title: String(title || '').slice(0, 120), body: String(body || '').slice(0, 4000), category: String(category || 'general').slice(0, 40), updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single());
    await log(req, 'support_canned_update', 'support_canned', row.id);
    res.json(row);
  }));
  r.delete('/canned/:id', h(async (req, res) => {
    if (req.admin.role === 'support') return res.status(403).json({ error: 'Not allowed for your role' });
    await q(supabase.from('support_canned_responses').delete().eq('id', req.params.id));
    await log(req, 'support_canned_delete', 'support_canned', req.params.id);
    res.json({ ok: true });
  }));

  // ---- knowledge base -----------------------------------------------------------------
  r.get('/kb', h(async (req, res) => {
    res.json({
      articles: await q(supabase.from('support_kb_articles').select('id, slug, title, category, tags, source, published, needs_review, overrides_slug, updated_by, updated_at').order('category').order('title')),
      canEdit: canEditKb(req),
      canRegenerate: req.admin.role === 'super_admin',
    });
  }));
  r.get('/kb/:id', h(async (req, res) => {
    const a = await q(supabase.from('support_kb_articles').select('id, slug, title, body_md, category, tags, source, published, needs_review, overrides_slug, updated_by, updated_at').eq('id', req.params.id).maybeSingle());
    if (!a) return res.status(404).json({ error: 'Not found' });
    res.json(a);
  }));
  const kbFields = (b) => {
    const out = {};
    if (b.title !== undefined) out.title = String(b.title).slice(0, 200);
    if (b.body_md !== undefined) out.body_md = String(b.body_md).slice(0, 20000);
    if (b.category !== undefined) out.category = String(b.category || 'general').slice(0, 40);
    if (b.tags !== undefined) out.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags).split(',')).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
    if (b.published !== undefined) out.published = Boolean(b.published);
    if (b.needs_review !== undefined) out.needs_review = Boolean(b.needs_review);
    if (b.overrides_slug !== undefined) out.overrides_slug = b.overrides_slug ? String(b.overrides_slug).slice(0, 80) : null;
    return out;
  };
  r.post('/kb', h(async (req, res) => {
    if (!canEditKb(req)) return res.status(403).json({ error: 'Only admins can edit the knowledge base' });
    const f = kbFields(req.body || {});
    if (!f.title || !f.body_md) return res.status(400).json({ error: 'Title and body are required' });
    const slug = `admin-${String(f.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)}-${Date.now().toString(36)}`;
    const row = await q(supabase.from('support_kb_articles').insert({ ...f, slug, source: 'admin', updated_by: (await me(req)).name }).select().single());
    await log(req, 'support_kb_create', 'support_kb_article', row.id, { title: row.title });
    res.json(row);
  }));
  // Editing a code-generated article turns it into an admin article, so
  // "Regenerate from code" never overwrites the edit.
  r.put('/kb/:id', h(async (req, res) => {
    if (!canEditKb(req)) return res.status(403).json({ error: 'Only admins can edit the knowledge base' });
    const f = kbFields(req.body || {});
    const changesContent = f.title !== undefined || f.body_md !== undefined || f.tags !== undefined || f.category !== undefined;
    const row = await q(supabase.from('support_kb_articles').update({ ...f, ...(changesContent ? { source: 'admin' } : {}), updated_by: (await me(req)).name, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single());
    await log(req, 'support_kb_update', 'support_kb_article', row.id, { fields: Object.keys(f) });
    res.json(row);
  }));
  r.post('/kb-regenerate', h(async (req, res) => {
    if (req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Super admin only' });
    const out = await internal.support('/kb/regenerate', { admin: await me(req) });
    await log(req, 'support_kb_regenerate', 'support_kb', null, { written: out.written && out.written.length, skipped: out.skippedAdminEdited });
    res.json(out);
  }));

  // ---- KB gaps --------------------------------------------------------------------------
  r.get('/gaps', h(async (req, res) => {
    const status = ['open', 'answered', 'ignored'].includes(req.query.status) ? req.query.status : 'open';
    res.json({ gaps: await q(supabase.from('support_kb_gaps').select('*').eq('status', status).order('count', { ascending: false }).order('updated_at', { ascending: false }).limit(200)), canEdit: canEditKb(req) });
  }));
  r.post('/gaps/:id', h(async (req, res) => {
    if (!canEditKb(req)) return res.status(403).json({ error: 'Only admins can change KB gaps' });
    const status = req.body?.status;
    if (!['open', 'answered', 'ignored'].includes(status)) return res.status(400).json({ error: 'Bad status' });
    const row = await q(supabase.from('support_kb_gaps').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single());
    await log(req, 'support_gap_update', 'support_kb_gap', row.id, { status });
    res.json(row);
  }));

  // ---- analytics ------------------------------------------------------------------------
  async function analytics(days) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const convs = await q(supabase.from('support_conversations').select('id, status, created_at, escalated_at, escalation_reason, first_human_response_at, resolved_at, csat').gte('created_at', since).limit(10000));
    const gaps = await q(supabase.from('support_kb_gaps').select('question, count').eq('status', 'open').order('count', { ascending: false }).limit(10));
    const perDay = {};
    for (const c of convs) perDay[c.created_at.slice(0, 10)] = (perDay[c.created_at.slice(0, 10)] || 0) + 1;
    const escalated = convs.filter((c) => c.escalated_at);
    const aiOnly = convs.filter((c) => !c.escalated_at).length;
    const reasons = {};
    for (const c of escalated) reasons[c.escalation_reason || 'unknown'] = (reasons[c.escalation_reason || 'unknown'] || 0) + 1;
    const median = (arr) => {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      return Math.round(s[Math.floor(s.length / 2)]);
    };
    const frt = escalated.filter((c) => c.first_human_response_at).map((c) => (new Date(c.first_human_response_at) - new Date(c.escalated_at)) / 60000);
    const rt = convs.filter((c) => c.resolved_at).map((c) => (new Date(c.resolved_at) - new Date(c.created_at)) / 60000);
    const rated = convs.filter((c) => c.csat !== null && c.csat !== undefined);
    return {
      days,
      totalConversations: convs.length,
      perDay: Object.entries(perDay).sort().map(([day, count]) => ({ day, count })),
      aiOnlyPct: convs.length ? Math.round((aiOnly / convs.length) * 100) : null,
      escalationRatePct: convs.length ? Math.round((escalated.length / convs.length) * 100) : null,
      topEscalationReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason, count })),
      medianFirstResponseMinutes: median(frt),
      medianResolutionMinutes: median(rt),
      csatPositivePct: rated.length ? Math.round((rated.filter((c) => c.csat > 0).length / rated.length) * 100) : null,
      csatResponses: rated.length,
      topGaps: gaps,
    };
  }
  r.get('/analytics', h(async (req, res) => {
    if (!canSeeAnalytics(req)) return res.status(403).json({ error: 'Not allowed for your role' });
    res.json({ ...(await analytics(Math.min(365, Math.max(1, Number(req.query.days) || 30)))), canExport: canExport(req) });
  }));
  r.get('/analytics-export', h(async (req, res) => {
    if (!canExport(req)) return res.status(403).json({ error: 'Only admins can export analytics' });
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await q(supabase.from('support_conversations').select('id, status, priority, topic, escalation_reason, created_at, escalated_at, first_human_response_at, resolved_at, csat').gte('created_at', since).order('created_at').limit(10000));
    const cols = ['id', 'status', 'priority', 'topic', 'escalation_reason', 'created_at', 'escalated_at', 'first_human_response_at', 'resolved_at', 'csat'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    await log(req, 'support_analytics_export', 'support', null, { days, rows: rows.length });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="support-${days}d.csv"`);
    res.send([cols.join(','), ...rows.map((row) => cols.map((c) => esc(row[c])).join(','))].join('\n'));
  }));

  // ---- legacy tickets (pre-rebuild rows with no conversation) ---------------------------
  r.get('/tickets', h(async (req, res) => {
    let query = supabase.from('support_tickets').select('*, player:players(username, email)').order('created_at', { ascending: false }).limit(1000);
    if (req.query.status) query = query.eq('status', req.query.status);
    const data = await q(query);
    res.json(data.map((t) => ({ ...t, ref: ref(t.ticket_number), player: t.player ? { username: t.player.username, email: maskEmail(t.player.email) } : null, guest_email: maskEmail(t.guest_email) })));
  }));
  r.post('/tickets/:id/respond', h(async (req, res) => {
    const { response, resolve } = req.body || {};
    if (!response) return res.status(400).json({ error: 'response is required' });
    const ticket = await q(supabase.from('support_tickets').select('player_id, subject').eq('id', req.params.id).maybeSingle());
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const patch = { admin_response: response, responded_by: req.admin.email || req.admin.username, status: resolve ? 'resolved' : 'pending_user', updated_at: new Date().toISOString() };
    if (resolve) patch.resolved_at = new Date().toISOString();
    const data = await q(supabase.from('support_tickets').update(patch).eq('id', req.params.id).select().single());
    if (ticket.player_id) internal.notifyPlayer(ticket.player_id, 'support_response', `Support replied to your ticket "${ticket.subject}"`).catch(() => {});
    await log(req, 'respond_support_ticket', 'support_ticket', req.params.id, { resolve: Boolean(resolve) });
    res.json(data);
  }));
  r.post('/tickets/:id/resolve', h(async (req, res) => {
    const data = await q(supabase.from('support_tickets').update({ status: 'resolved', resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single());
    await log(req, 'resolve_support_ticket', 'support_ticket', req.params.id);
    res.json(data);
  }));

  return r;
}

module.exports = router;
