-- "Make every minute fire": market telemetry, progression, card unlocks,
-- quick-mission claims and ghost-challenge links. Additive only: no existing
-- table, column or function is changed. Coins still move only through
-- public.coin_apply (idempotency keys); admin edits are logged in the existing
-- public.admin_activity_log.

-- 1F. Per match, per instrument: how alive the market was.
create table if not exists public.match_market_stats (
  id bigserial primary key,
  match_id uuid not null,
  mode text not null,
  symbol text not null,
  curated boolean not null default false,
  start_offset integer,
  replay_speed integer not null default 1,
  changes_per_min numeric(8,2) not null,
  longest_flat_seconds integer not null,
  range_bps numeric(10,3) not null,
  created_at timestamptz not null default now()
);
create index if not exists match_market_stats_created_idx on public.match_market_stats (created_at desc);
create unique index if not exists match_market_stats_match_symbol_uq on public.match_market_stats (match_id, symbol);

-- 2E. XP and levels (one row per player; lazily created).
create table if not exists public.player_progress (
  player_id uuid primary key references public.players(id) on delete cascade,
  xp integer not null default 0,
  level integer not null default 1,
  xp_day date,
  xp_today integer not null default 0,
  best_streak integer not null default 0,
  best_heat integer not null default 0,
  qualifying_wins integer not null default 0,
  season text,
  season_xp integer not null default 0,
  migrated_at timestamptz,
  updated_at timestamptz not null default now()
);

-- One row per XP award, keyed so the same match never pays XP twice.
create table if not exists public.xp_events (
  id bigserial primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  match_id uuid,
  source text not null,
  amount integer not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

-- 2E. Cards a player has unlocked (the basic deck is implicit, never stored).
create table if not exists public.player_card_unlocks (
  player_id uuid not null references public.players(id) on delete cascade,
  card_id text not null,
  source text not null check (source in ('level', 'condition', 'migration', 'admin')),
  reason text,
  created_at timestamptz not null default now(),
  primary key (player_id, card_id)
);

-- 3.2 Quick missions: one row per completed mission per match (idempotent).
create table if not exists public.mission_claims (
  id bigserial primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  match_id uuid not null,
  mission_id text not null,
  coins integer not null default 0,
  claim_day date not null default (now() at time zone 'utc')::date,
  created_at timestamptz not null default now(),
  unique (player_id, match_id, mission_id)
);
create index if not exists mission_claims_day_idx on public.mission_claims (player_id, claim_day);

-- 3.5 Ghost challenge links: same instruments, offsets and seed as the
-- challenger's match, with the challenger's result to beat.
create table if not exists public.challenge_links (
  code text primary key,
  creator_id uuid not null references public.players(id) on delete cascade,
  source_match_id uuid,
  mode text not null,
  instruments text[] not null,
  market_seed text not null,
  market_starts jsonb not null,
  duration_seconds integer not null,
  creator_result jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists challenge_links_creator_idx on public.challenge_links (creator_id, created_at desc);

-- Server-only tables: the service role bypasses RLS; nothing is exposed to
-- the anon/authenticated roles.
alter table public.match_market_stats enable row level security;
alter table public.player_progress enable row level security;
alter table public.xp_events enable row level security;
alter table public.player_card_unlocks enable row level security;
alter table public.mission_claims enable row level security;
alter table public.challenge_links enable row level security;

-- 2E.5 Earned cosmetics: rank items once reached, monthly season rewards.
-- Never sold (the shop catalog doesn't contain them). One row per item.
create table if not exists public.earned_cosmetics (
  player_id uuid not null references public.players(id) on delete cascade,
  item_id text not null,
  source text not null check (source in ('rank', 'season', 'admin')),
  season text,
  created_at timestamptz not null default now(),
  primary key (player_id, item_id)
);
alter table public.earned_cosmetics enable row level security;

-- Final standings of one monthly season: XP earned inside the month, from
-- the per-match XP log (so a player starting the next season early never
-- erases their result in the last one). Real players only.
create or replace function public.season_top(p_from timestamptz, p_to timestamptz, p_limit integer default 100)
returns table (player_id uuid, xp bigint)
language sql stable security definer set search_path = public as $$
  select e.player_id, sum(e.amount)::bigint as xp
  from xp_events e
  join players p on p.id = e.player_id and p.is_persona = false
  where e.created_at >= p_from and e.created_at < p_to
  group by e.player_id
  having sum(e.amount) > 0
  order by xp desc, e.player_id
  limit p_limit;
$$;
revoke all on function public.season_top(timestamptz, timestamptz, integer) from public, anon, authenticated;
