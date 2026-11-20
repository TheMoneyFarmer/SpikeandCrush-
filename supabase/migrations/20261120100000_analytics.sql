-- Analytics (branch analytics): first-party events, first-touch attribution,
-- internal-traffic flag, device on match results, durable tech health, and
-- the old sponsor_clicks table removed. Server and admin only: RLS on, no
-- client policies. Safe to re-run. Never touches GAME_RULES, money maths,
-- the ledger or ranking maths.

-- Stage 1: one flag for traffic that must never count (admin, test, computer players).
alter table public.players add column if not exists is_internal boolean not null default false;
update public.players set is_internal = true
  where coalesce(is_persona, false)
     or username ~* '^(qatest|modetest|audit_|rectest|firetest|e2e|smoke|loadtest|lt_|test)';

-- Stage 2: first-touch attribution, saved at sign-up.
alter table public.players add column if not exists first_source text;
alter table public.players add column if not exists first_medium text;
alter table public.players add column if not exists first_campaign text;
alter table public.players add column if not exists first_referrer text;
alter table public.players add column if not exists first_partner text;
alter table public.players add column if not exists first_landing text;
alter table public.players add column if not exists first_seen_at timestamptz;

-- Stage 2: one event table. No raw IP or full browser string, ever: visitors
-- are a daily-rotating hash (visitor_day_hash) or, after cookie consent, a
-- first-party id (anonymous_id). Country only (Cloudflare's header).
create table if not exists public.analytics_events (
  id bigserial primary key,
  occurred_at timestamptz not null default now(),   -- server time, UTC
  event_name text not null,
  schema_version int not null default 1,
  source text not null default 'server',             -- 'server' or 'client'
  anonymous_id text,
  visitor_day_hash text,
  user_id uuid references public.players(id) on delete set null,
  session_id text,
  page text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  partner_id text,
  placement_id uuid,
  device_class text,
  browser_family text,
  coarse_country text,
  mode text,
  match_id text,
  properties jsonb not null default '{}'::jsonb,
  is_internal boolean not null default false
);
create index if not exists analytics_events_time_idx on public.analytics_events (occurred_at desc);
create index if not exists analytics_events_name_time_idx on public.analytics_events (event_name, occurred_at desc);
create index if not exists analytics_events_user_idx on public.analytics_events (user_id, occurred_at desc) where user_id is not null;
create index if not exists analytics_events_placement_idx on public.analytics_events (placement_id, occurred_at desc) where placement_id is not null;
create index if not exists analytics_events_session_idx on public.analytics_events (session_id) where session_id is not null;
alter table public.analytics_events enable row level security;

-- Stage 4: device on each match result; end reasons for older rows.
alter table public.match_players add column if not exists device_class text;
update public.match_players mp set end_reason = case
    when exists (select 1 from public.match_events e where e.match_id = mp.match_id and e.player_id = mp.player_id and e.kind = 'leave' and e.payload->>'reason' = 'disconnect') then 'disconnect'
    when exists (select 1 from public.match_events e where e.match_id = mp.match_id and e.player_id = mp.player_id and e.kind = 'leave') then 'left'
    else 'unknown' end
  where mp.end_reason is null;

-- Stage 4: durable tech health (disconnects, reconnects, freezes, tick and event-loop lag).
create table if not exists public.tech_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  kind text not null,          -- disconnect, reconnect, client_freeze, tick_lag, loop_lag
  match_id text,
  mode text,
  player_id uuid references public.players(id) on delete set null,
  value_ms int,
  properties jsonb not null default '{}'::jsonb
);
create index if not exists tech_events_time_idx on public.tech_events (at desc);
create index if not exists tech_events_kind_idx on public.tech_events (kind, at desc);
alter table public.tech_events enable row level security;

-- Stage 3: the legacy per-click table (player id + ip hash) goes, only if empty.
do $$
begin
  if to_regclass('public.sponsor_clicks') is not null and not exists (select 1 from public.sponsor_clicks) then
    drop table public.sponsor_clicks;
  end if;
end $$;
