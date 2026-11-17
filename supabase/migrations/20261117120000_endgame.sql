-- Endgame (branch endgame-seasons): balance data, versioned card config,
-- seasons with a track, soft rank reset, card mastery and prestige.
-- Server and admin only: RLS on, no client policies. Safe to re-run.
-- Never touches GAME_RULES, money maths, the ledger or match result maths.

-- Stage 1: nightly per-card numbers by day, mode and rank bracket.
create table if not exists public.card_balance_daily (
  day date not null,
  card_id text not null,
  mode text not null,
  bracket text not null,
  held int not null default 0,              -- player-matches where the card was in hand
  played int not null default 0,            -- player-matches where it was played
  played_wins int not null default 0,       -- ...and the player finished 1st
  held_unplayed int not null default 0,
  held_unplayed_wins int not null default 0,
  rank_sum_played numeric not null default 0,
  rank_sum_unplayed numeric not null default 0,
  primary key (day, card_id, mode, bracket)
);

-- Stage 1: card parameters as versioned settings (one active version).
create table if not exists public.card_config_versions (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  created_by text not null,
  note text,
  params jsonb not null,
  active boolean not null default false
);
create unique index if not exists card_config_one_active on public.card_config_versions (active) where active;

-- Stage 2: seasons.
create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by text,
  name text not null,
  theme text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  state text not null default 'scheduled' check (state in ('scheduled','active','ending','archived')),
  featured_cards text[] not null default '{}',
  track jsonb not null default '[]'::jsonb,        -- [{ level, reward: { type, id|amount, name } }]
  peak_rewards jsonb not null default '[]'::jsonb, -- [{ tier, reward }]
  soft_reset_pct int not null default 25 check (soft_reset_pct between 0 and 100),
  ended_at timestamptz,
  check (ends_at > starts_at)
);

create table if not exists public.season_progress (
  season_id uuid not null references public.seasons(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  xp int not null default 0,
  level int not null default 1,
  peak_rating int,
  peak_tier text,
  claimed_levels int[] not null default '{}',
  peak_reward_given boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (season_id, player_id)
);

create table if not exists public.season_resets (
  season_id uuid not null references public.seasons(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  rating_before int not null,
  rating_after int not null,
  at timestamptz not null default now(),
  primary key (season_id, player_id)
);

-- Stage 3: card mastery (cosmetic only) and prestige.
create table if not exists public.card_mastery (
  player_id uuid not null references public.players(id) on delete cascade,
  card_id text not null,
  uses int not null default 0,
  successes int not null default 0,
  level int not null default 0,
  targets jsonb not null default '{}'::jsonb,  -- { targetId: count } for "favourite target"
  updated_at timestamptz not null default now(),
  primary key (player_id, card_id)
);

alter table public.players add column if not exists prestige_level int not null default 0;
alter table public.players add column if not exists prestige_xp_offset int not null default 0;

create table if not exists public.prestige_events (
  id bigserial primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  at timestamptz not null default now(),
  from_prestige int not null,
  to_prestige int not null,
  xp_at int not null
);

alter table public.card_balance_daily enable row level security;
alter table public.card_config_versions enable row level security;
alter table public.seasons enable row level security;
alter table public.season_progress enable row level security;
alter table public.season_resets enable row level security;
alter table public.card_mastery enable row level security;
alter table public.prestige_events enable row level security;
