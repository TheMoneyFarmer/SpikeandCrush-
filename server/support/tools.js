'use strict';

// Tools the support assistant can call. Rules:
// - No tool accepts a user id. The player is ctx.playerId, taken from the
//   verified session on the server, never from the model or the browser.
// - Every read tool returns a minimal set of fields for the caller's own data.
// - Only create_ticket and escalate_to_human write anything (and only support
//   rows). Nothing here can change coins, ratings, bans, passwords or results.

const { tierForRating, GAME_RULES, RECONNECT_GRACE_SECONDS } = require('../gameEngine');
const { maskEmail } = require('./safety');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ['gameplay_bug', 'match_ended', 'coins_shop', 'competition_result', 'account_login', 'payment', 'report_player', 'sponsor_partner', 'feedback', 'other'];

const END_REASON_TEXT = {
  completed: 'played to the end of the match timer',
  loss_limit: `hit the ${GAME_RULES.HARD_LOSS_PCT * 100}% max loss limit (positions auto-closed, trading ended for the match)`,
  left: 'left the match early (counts as a forfeit, placed last)',
  disconnect: `disconnected and did not reconnect within ${RECONNECT_GRACE_SECONDS} seconds (counts as a forfeit, placed last)`,
};

const DEFINITIONS = {
  search_kb: {
    name: 'search_kb',
    description: 'Search the Spike & Crush help articles. Use a short, specific query. Returns the best matching articles.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look up, e.g. "disconnect forfeit rating"' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  get_my_account: {
    name: 'get_my_account',
    description: "The signed-in player's own account summary: handle, tier, ratings, level, coin balance, masked email, verification, sign-in providers, Discord link, account status and created date.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  get_my_recent_matches: {
    name: 'get_my_recent_matches',
    description: "The signed-in player's own recent matches: mode, start time, rank, rating change, P&L and why the match ended for them.",
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 10, description: 'How many matches (max 10)' } },
      additionalProperties: false,
    },
  },
  get_my_match: {
    name: 'get_my_match',
    description: "Details of one of the signed-in player's own matches by match id: result, why it ended for them and a summary of their trades.",
    input_schema: {
      type: 'object',
      properties: { match_id: { type: 'string', description: 'The match id (UUID)' } },
      required: ['match_id'],
      additionalProperties: false,
    },
  },
  get_my_coin_ledger: {
    name: 'get_my_coin_ledger',
    description: "The signed-in player's own recent coin transactions: reason, amount, balance after, time.",
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many rows (max 20)' } },
      additionalProperties: false,
    },
  },
  get_my_competition_entries: {
    name: 'get_my_competition_entries',
    description: "Competitions the signed-in player entered: status, rank, equity, prize in coins and whether the prize was paid.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  get_competition_status: {
    name: 'get_competition_status',
    description: 'Public facts about one competition by id: title, start and end, entry fee, prizes in coins, status.',
    input_schema: {
      type: 'object',
      properties: { competition_id: { type: 'string', description: 'The competition id (UUID)' } },
      required: ['competition_id'],
      additionalProperties: false,
    },
  },
  get_my_open_tickets: {
    name: 'get_my_open_tickets',
    description: "The signed-in player's own open support tickets: ticket id, subject, status, last update.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  create_ticket: {
    name: 'create_ticket',
    description: 'Create a support ticket linked to this conversation, for the team to follow up later. Use when the player wants to report something and does not need an immediate human reply.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Short subject, max 120 characters' },
        summary: { type: 'string', description: 'What the player reported, in 1-4 sentences' },
        category: { type: 'string', enum: CATEGORIES },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['subject', 'summary', 'category'],
      additionalProperties: false,
    },
  },
  escalate_to_human: {
    name: 'escalate_to_human',
    description: 'Hand this conversation to a human agent. Use when the player asks for a human, when something must be changed on their account, when you cannot answer, or for payment disputes, ban appeals, hacking, harassment, legal/data requests, sponsor enquiries or bugs that cost coins.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why a human is needed, a few words' },
        summary: { type: 'string', description: 'One line summarising the issue for the agent' },
      },
      required: ['reason', 'summary'],
      additionalProperties: false,
    },
  },
};

const GUEST_TOOLS = ['search_kb', 'create_ticket', 'escalate_to_human'];
const WRITE_TOOLS = new Set(['create_ticket', 'escalate_to_human']);

function toolsFor(ctx) {
  const names = ctx.playerId ? Object.keys(DEFINITIONS) : GUEST_TOOLS;
  return names.map((n) => DEFINITIONS[n]);
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// deps: { supabase, kb, escalate(ctx, {reason, summary, source}), createTicket(ctx, {...}) }
function createToolRunner(deps) {
  const { supabase, kb } = deps;

  async function q(query) {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  const handlers = {
    async search_kb(ctx, { query }) {
      const r = await kb.search(query);
      ctx.kbArticleIds.push(...r.articles.map((a) => a.id));
      ctx.lastRetrievalWeak = r.weak;
      if (!r.articles.length) return { results: [], note: 'No matching articles.' };
      return { results: r.articles.map((a) => ({ title: a.title, text: a.body })) };
    },

    async get_my_account(ctx) {
      const p = await q(supabase.from('players').select('username, email, war_rating, grand_war_rating, solo_rating, experience_level, coins, created_at, is_banned, banned_until, ban_reason, discord_id, discord_username, supabase_user_id, total_matches').eq('id', ctx.playerId).maybeSingle());
      if (!p) return { error: 'Account not found' };
      let emailVerified = null;
      let providers = [];
      if (p.supabase_user_id) {
        try {
          const { data } = await supabase.auth.admin.getUserById(p.supabase_user_id);
          if (data && data.user) {
            emailVerified = Boolean(data.user.email_confirmed_at);
            providers = (data.user.app_metadata && data.user.app_metadata.providers) || (data.user.identities || []).map((i) => i.provider);
          }
        } catch (e) {
          /* leave unknown */
        }
      }
      const suspended = p.is_banned && (!p.banned_until || new Date(p.banned_until).getTime() > Date.now());
      return {
        handle: p.username,
        tier: tierForRating(p.war_rating || 0),
        war_rating: p.war_rating,
        grand_war_rating: p.grand_war_rating,
        solo_rating: p.solo_rating,
        experience_level: p.experience_level,
        matches_played: p.total_matches,
        coins_balance: p.coins,
        email: maskEmail(p.email),
        email_verified: emailVerified,
        sign_in_providers: providers,
        discord_linked: Boolean(p.discord_id),
        account_status: suspended ? 'suspended' : 'active',
        suspension_reason: suspended ? p.ban_reason || 'No reason recorded' : null,
        suspended_until: suspended && p.banned_until ? p.banned_until : null,
        created: p.created_at,
      };
    },

    async get_my_recent_matches(ctx, { limit } = {}) {
      const n = clampInt(limit, 1, 10, 5);
      const mine = await q(supabase.from('match_players').select('match_id, final_rank, final_pnl, rating_change, end_reason, is_draw').eq('player_id', ctx.playerId).limit(200));
      if (!mine.length) return { matches: [] };
      const ids = mine.map((m) => m.match_id);
      const matches = await q(supabase.from('matches').select('id, mode, status, start_time, end_time, created_at').in('id', ids).order('created_at', { ascending: false }).limit(n));
      const byId = new Map(mine.map((m) => [m.match_id, m]));
      return {
        matches: matches.map((m) => {
          const mp = byId.get(m.id);
          return {
            match_id: m.id,
            mode: m.mode,
            started: m.start_time || m.created_at,
            status: m.status,
            rank: mp.final_rank,
            pnl: mp.final_pnl,
            rating_change: mp.rating_change,
            draw: mp.is_draw,
            ended_reason: mp.end_reason ? END_REASON_TEXT[mp.end_reason] || mp.end_reason : m.status === 'finished' ? 'not recorded (match finished before end reasons were tracked)' : 'match not finished',
          };
        }),
      };
    },

    async get_my_match(ctx, { match_id }) {
      if (!UUID_RE.test(String(match_id || ''))) return { error: 'That is not a valid match id.' };
      // Ownership first: a match the player wasn't in is reported exactly like
      // one that doesn't exist, so ids of other players' matches reveal nothing.
      const mp = await q(supabase.from('match_players').select('final_rank, final_pnl, rating_change, end_reason, trades_made, cards_played, is_draw').eq('match_id', match_id).eq('player_id', ctx.playerId).maybeSingle());
      if (!mp) return { error: 'No match with that id was found on your account.' };
      const m = await q(supabase.from('matches').select('mode, status, start_time, end_time').eq('id', match_id).maybeSingle());
      const players = await q(supabase.from('match_players').select('player_id', { count: 'exact', head: false }).eq('match_id', match_id));
      const trades = await q(supabase.from('trades').select('symbol, direction, lots, pnl, opened_at, closed_at').eq('match_id', match_id).eq('player_id', ctx.playerId).limit(100));
      const totalPnl = trades.reduce((s, t) => s + Number(t.pnl || 0), 0);
      return {
        mode: m && m.mode,
        status: m && m.status,
        started: m && m.start_time,
        ended: m && m.end_time,
        players_in_match: players.length,
        your_rank: mp.final_rank,
        your_pnl: mp.final_pnl,
        rating_change: mp.rating_change,
        draw: mp.is_draw,
        ended_reason: mp.end_reason ? END_REASON_TEXT[mp.end_reason] || mp.end_reason : 'not recorded',
        trades_made: mp.trades_made,
        cards_played: mp.cards_played,
        trades_summary: {
          closed_trades: trades.length,
          instruments: Array.from(new Set(trades.map((t) => t.symbol))),
          total_closed_pnl: Math.round(totalPnl * 100) / 100,
          largest_lot: trades.reduce((mx, t) => Math.max(mx, Number(t.lots || 0)), 0),
        },
      };
    },

    async get_my_coin_ledger(ctx, { limit } = {}) {
      const n = clampInt(limit, 1, 20, 10);
      const rows = await q(supabase.from('coin_transactions').select('type, amount, balance_after, created_at').eq('player_id', ctx.playerId).order('created_at', { ascending: false }).limit(n));
      return { transactions: rows.map((r) => ({ reason: r.type, amount: r.amount, balance_after: r.balance_after, time: r.created_at })) };
    },

    async get_my_competition_entries(ctx) {
      const rows = await q(
        supabase
          .from('comp_accounts')
          .select('competition_id, status, equity, final_rank, final_pnl, prize_coins, prize_paid, created_at, competition:competitions(title, status, starts_at, ends_at)')
          .eq('player_id', ctx.playerId)
          .order('created_at', { ascending: false })
          .limit(20)
      );
      return {
        entries: rows.map((r) => ({
          competition_id: r.competition_id,
          title: r.competition && r.competition.title,
          competition_status: r.competition && r.competition.status,
          starts: r.competition && r.competition.starts_at,
          ends: r.competition && r.competition.ends_at,
          your_account_status: r.status,
          equity: r.equity,
          final_rank: r.final_rank,
          prize_coins: r.prize_coins || 0,
          prize_settled: Boolean(r.prize_paid),
        })),
      };
    },

    async get_competition_status(ctx, { competition_id }) {
      if (!UUID_RE.test(String(competition_id || ''))) return { error: 'That is not a valid competition id.' };
      const c = await q(
        supabase
          .from('competitions')
          .select('title, status, starts_at, ends_at, entry_fee_coins, prize_payouts, prize_pool_coins, is_published, is_test, instruments')
          .eq('id', competition_id)
          .maybeSingle()
      );
      if (!c || !c.is_published || c.is_test) return { error: 'No public competition with that id.' };
      const now = Date.now();
      const live = c.status === 'active' && now >= new Date(c.starts_at).getTime() && now < new Date(c.ends_at).getTime();
      return {
        title: c.title,
        status: c.status,
        live,
        starts: c.starts_at,
        ends: c.ends_at,
        entry_fee_coins: c.entry_fee_coins,
        prizes_coins: (c.prize_payouts || []).map((p) => ({ rank: p.rank, coins: Number(p.coins) || 0 })),
        prize_pool_coins: c.prize_pool_coins,
        instruments: c.instruments,
      };
    },

    async get_my_open_tickets(ctx) {
      const rows = await q(
        supabase
          .from('support_tickets')
          .select('ticket_number, subject, status, updated_at')
          .eq('player_id', ctx.playerId)
          .not('status', 'in', '(resolved,closed)')
          .order('updated_at', { ascending: false })
          .limit(10)
      );
      return { tickets: rows.map((t) => ({ ticket: `SC-${String(t.ticket_number).padStart(6, '0')}`, subject: t.subject, status: t.status, last_update: t.updated_at })) };
    },

    async create_ticket(ctx, input) {
      const category = CATEGORIES.includes(input.category) ? input.category : 'other';
      const priority = ['low', 'normal', 'high'].includes(input.priority) ? input.priority : 'normal';
      return deps.createTicket(ctx, { subject: String(input.subject || '').slice(0, 120), summary: String(input.summary || '').slice(0, 2000), category, priority });
    },

    async escalate_to_human(ctx, input) {
      return deps.escalate(ctx, { reason: String(input.reason || 'Requested by assistant').slice(0, 200), summary: String(input.summary || '').slice(0, 300), source: 'ai' });
    },
  };

  async function run(ctx, name, input) {
    const allowed = toolsFor(ctx).some((t) => t.name === name);
    if (!allowed || !handlers[name]) return { error: `Tool ${name} is not available.` };
    if (input && typeof input === 'object' && ('user_id' in input || 'player_id' in input || 'userId' in input)) {
      // Defence in depth: schemas forbid extra fields, but never honour one anyway.
      delete input.user_id;
      delete input.player_id;
      delete input.userId;
    }
    return handlers[name](ctx, input || {});
  }

  return { run };
}

module.exports = { DEFINITIONS, toolsFor, createToolRunner, WRITE_TOOLS, GUEST_TOOLS, CATEGORIES, END_REASON_TEXT };
