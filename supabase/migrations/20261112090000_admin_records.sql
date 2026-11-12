-- Admin records: match account numbers, MT5-style tickets and deals, a
-- per-match event log, statements, dispute flags, the sponsor placement
-- lifecycle and per-admin preferences. Safe to run twice: every step checks
-- before it changes anything, and back-fills only touch rows still missing ids.

-- ---- account numbers --------------------------------------------------------
-- One registry for every match account (war seats and competition entries),
-- so a number is unique across the whole system and is never handed out
-- again, even after the account row itself is deleted.
create table if not exists public.account_numbers (
  number bigint primary key check (number between 10000000 and 99999999),
  kind text not null check (kind in ('match', 'competition')),
  ref_id uuid,
  player_id uuid,
  created_at timestamptz not null default now()
);
alter table public.account_numbers enable row level security;

create or replace function public.claim_account_number(p_kind text, p_ref uuid, p_player uuid)
returns bigint language plpgsql as $$
declare n bigint; tries int := 0;
begin
  loop
    -- 8 digits, random (never sequential), retried on the rare collision.
    n := 10000000 + floor(random() * 90000000)::bigint;
    begin
      insert into public.account_numbers (number, kind, ref_id, player_id) values (n, p_kind, p_ref, p_player);
      return n;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 50 then raise; end if;
    end;
  end loop;
end $$;

alter table public.match_players add column if not exists account_number bigint;
alter table public.match_players add column if not exists summary jsonb;
alter table public.match_players add column if not exists equity_curve jsonb;
alter table public.comp_accounts add column if not exists account_number bigint;
create unique index if not exists match_players_account_number_key on public.match_players (account_number);
create unique index if not exists comp_accounts_account_number_key on public.comp_accounts (account_number);
create index if not exists match_players_match_player_idx on public.match_players (match_id, player_id);

create or replace function public.match_players_account_number() returns trigger language plpgsql as $$
begin
  if new.account_number is null then
    new.account_number := public.claim_account_number('match', new.id, new.player_id);
  end if;
  return new;
end $$;
drop trigger if exists match_players_account_number on public.match_players;
create trigger match_players_account_number before insert on public.match_players
  for each row execute function public.match_players_account_number();

create or replace function public.comp_accounts_account_number() returns trigger language plpgsql as $$
begin
  if new.account_number is null then
    new.account_number := public.claim_account_number('competition', new.id, new.player_id);
  end if;
  return new;
end $$;
drop trigger if exists comp_accounts_account_number on public.comp_accounts;
create trigger comp_accounts_account_number before insert on public.comp_accounts
  for each row execute function public.comp_accounts_account_number();

-- Back-fill existing seats, oldest first.
do $$
declare r record;
begin
  for r in select mp.id, mp.player_id from public.match_players mp join public.matches m on m.id = mp.match_id
           where mp.account_number is null order by m.created_at, mp.id loop
    update public.match_players set account_number = public.claim_account_number('match', r.id, r.player_id) where id = r.id;
  end loop;
  for r in select id, player_id from public.comp_accounts where account_number is null order by created_at, id loop
    update public.comp_accounts set account_number = public.claim_account_number('competition', r.id, r.player_id) where id = r.id;
  end loop;
end $$;

-- ---- tickets and deals --------------------------------------------------------
-- One ticket counter and one deal counter for war trades and competition
-- positions together, so "#1000123" names exactly one order system-wide.
create sequence if not exists public.trade_ticket_seq start 1000001;
create sequence if not exists public.trade_deal_seq start 5000001;

alter table public.trades add column if not exists ticket bigint;
alter table public.trades add column if not exists deal bigint;
alter table public.trades add column if not exists stop_loss numeric;
alter table public.trades add column if not exists take_profit numeric;
alter table public.trades add column if not exists close_reason text;
alter table public.trades add column if not exists comment text;
alter table public.trades add column if not exists position_ref text;
alter table public.trades add column if not exists data_open_s numeric;
alter table public.trades add column if not exists data_close_s numeric;
alter table public.trades add column if not exists account_number bigint;
alter table public.trades add column if not exists backfilled boolean not null default false;
alter table public.comp_positions add column if not exists ticket bigint;
alter table public.comp_positions add column if not exists deal bigint;
alter table public.comp_positions add column if not exists backfilled boolean not null default false;

-- Back-fill tickets for rows that have none, in open-time order across both
-- tables, numbered after the highest ticket already issued.
do $$
declare base bigint;
begin
  select greatest(1000000,
                  coalesce((select max(ticket) from public.trades), 0),
                  coalesce((select max(ticket) from public.comp_positions), 0)) into base;
  with todo as (
    select 't' src, id, opened_at from public.trades where ticket is null
    union all
    select 'c' src, id, opened_at from public.comp_positions where ticket is null
  ), numbered as (
    select src, id, base + row_number() over (order by opened_at nulls first, id) n from todo
  ), upd_t as (
    update public.trades t set ticket = numbered.n, backfilled = true
    from numbered where numbered.src = 't' and numbered.id = t.id returning 1
  )
  update public.comp_positions c set ticket = numbered.n, backfilled = true
  from numbered where numbered.src = 'c' and numbered.id = c.id;

  select greatest(5000000,
                  coalesce((select max(deal) from public.trades), 0),
                  coalesce((select max(deal) from public.comp_positions), 0)) into base;
  with todo as (
    select 't' src, id, closed_at from public.trades where deal is null and closed_at is not null
    union all
    select 'c' src, id, closed_at from public.comp_positions where deal is null and closed_at is not null
  ), numbered as (
    select src, id, base + row_number() over (order by closed_at, id) n from todo
  ), upd_t as (
    update public.trades t set deal = numbered.n, backfilled = true
    from numbered where numbered.src = 't' and numbered.id = t.id returning 1
  )
  update public.comp_positions c set deal = numbered.n, backfilled = true
  from numbered where numbered.src = 'c' and numbered.id = c.id;
end $$;

-- Move the counters past every number now in use (is_called keeps the next
-- nextval() strictly greater).
select setval('public.trade_ticket_seq', greatest(1000000,
  coalesce((select max(ticket) from public.trades), 0),
  coalesce((select max(ticket) from public.comp_positions), 0)), true);
select setval('public.trade_deal_seq', greatest(5000000,
  coalesce((select max(deal) from public.trades), 0),
  coalesce((select max(deal) from public.comp_positions), 0)), true);

alter table public.trades alter column ticket set default nextval('public.trade_ticket_seq');
alter table public.comp_positions alter column ticket set default nextval('public.trade_ticket_seq');
create unique index if not exists trades_ticket_key on public.trades (ticket);
create unique index if not exists trades_deal_key on public.trades (deal);
create unique index if not exists comp_positions_ticket_key on public.comp_positions (ticket);
create unique index if not exists comp_positions_deal_key on public.comp_positions (deal);

-- A deal id is issued the moment a row becomes closed, and the war seat's
-- account number is copied onto each trade so a ticket names its account.
create or replace function public.trades_records() returns trigger language plpgsql as $$
begin
  if new.closed_at is not null and new.deal is null then
    new.deal := nextval('public.trade_deal_seq');
  end if;
  if tg_op = 'INSERT' and new.account_number is null then
    select account_number into new.account_number from public.match_players
      where match_id = new.match_id and player_id = new.player_id limit 1;
  end if;
  return new;
end $$;
drop trigger if exists trades_records on public.trades;
create trigger trades_records before insert or update on public.trades
  for each row execute function public.trades_records();

create or replace function public.comp_positions_deal() returns trigger language plpgsql as $$
begin
  if new.closed_at is not null and new.deal is null then
    new.deal := nextval('public.trade_deal_seq');
  end if;
  return new;
end $$;
drop trigger if exists comp_positions_deal on public.comp_positions;
create trigger comp_positions_deal before insert or update on public.comp_positions
  for each row execute function public.comp_positions_deal();

create index if not exists trades_match_opened_idx on public.trades (match_id, opened_at);
create index if not exists trades_account_idx on public.trades (account_number);

-- ---- match event log -------------------------------------------------------------
-- Every order, close, SL/TP change, card play, spike alert, disconnect,
-- elimination and mission, with real time and market (data) time side by
-- side. Written by the game server only; admin reads it; nobody edits it.
create table if not exists public.match_events (
  id bigserial primary key,
  match_id uuid,
  competition_id uuid,
  player_id uuid,
  kind text not null,
  real_at timestamptz not null default now(),
  data_s numeric,
  data_at timestamptz,
  position_ref text,
  payload jsonb not null default '{}'::jsonb
);
alter table public.match_events enable row level security;
create index if not exists match_events_match_idx on public.match_events (match_id, id);
create index if not exists match_events_comp_idx on public.match_events (competition_id, id) where competition_id is not null;
create index if not exists match_events_player_idx on public.match_events (player_id, real_at desc);

-- ---- statements and dispute flags ------------------------------------------------
create table if not exists public.account_statements (
  id uuid primary key default gen_random_uuid(),
  account_number bigint not null,
  sha256 text not null,
  signature text not null,
  generated_by text not null,
  created_at timestamptz not null default now()
);
alter table public.account_statements enable row level security;
create index if not exists account_statements_account_idx on public.account_statements (account_number, created_at desc);
create index if not exists account_statements_hash_idx on public.account_statements (sha256);

create table if not exists public.record_flags (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('match', 'trade', 'account', 'competition')),
  target_id text not null,
  match_id uuid,
  competition_id uuid,
  note text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table public.record_flags enable row level security;
create index if not exists record_flags_match_idx on public.record_flags (match_id);
create index if not exists record_flags_target_idx on public.record_flags (target_type, target_id);

alter table public.support_tickets add column if not exists account_number bigint;
create index if not exists support_tickets_account_idx on public.support_tickets (account_number) where account_number is not null;

-- ---- history list speed --------------------------------------------------------
create index if not exists matches_mode_created_idx on public.matches (mode, created_at desc);
create index if not exists matches_status_created_idx on public.matches (status, created_at desc);
create index if not exists competitions_status_idx on public.competitions (status, starts_at desc);

-- ---- sponsor placement lifecycle ------------------------------------------------
-- status stays the admin's intent (draft/active/paused/ended); lifecycle is
-- where the dates put it, kept current by an hourly job.
alter table public.sponsor_placements add column if not exists lifecycle text;
alter table public.sponsor_placements add column if not exists archived_at timestamptz;
alter table public.sponsor_placements add column if not exists remind_contact boolean not null default false;
alter table public.sponsors add column if not exists archived_at timestamptz;
alter table public.sponsors add column if not exists remind_contact boolean not null default false;
do $$ begin
  alter table public.sponsor_placements add constraint sponsor_placements_lifecycle_check
    check (lifecycle is null or lifecycle in ('scheduled', 'active', 'expiring', 'expired', 'archived'));
exception when duplicate_object then null; end $$;
create index if not exists sponsor_placements_lifecycle_idx on public.sponsor_placements (lifecycle, ends_at);

-- One reminder per placement per milestone, ever (the primary key is the
-- idempotency key).
create table if not exists public.sponsor_reminders (
  placement_id uuid not null,
  milestone text not null check (milestone in ('d10', 'd2', 'd0')),
  sent_at timestamptz not null default now(),
  recipients text[] not null default '{}',
  digest boolean not null default false,
  primary key (placement_id, milestone)
);
alter table public.sponsor_reminders enable row level security;

-- Stats outlive a deleted placement: they are copied here first, and the
-- sponsor reports read both tables.
create table if not exists public.sponsor_stats_archive (
  placement_id uuid not null,
  sponsor_id uuid,
  slot text,
  targets text,
  day date not null,
  impressions integer not null default 0,
  unique_viewers integer not null default 0,
  clicks integer not null default 0,
  entries integer not null default 0,
  outbound_clicks integer not null default 0,
  archived_at timestamptz not null default now(),
  primary key (placement_id, day)
);
alter table public.sponsor_stats_archive enable row level security;
create index if not exists sponsor_stats_archive_sponsor_idx on public.sponsor_stats_archive (sponsor_id, day);

-- ---- per-admin preferences (date range etc.) ------------------------------------
create table if not exists public.admin_prefs (
  admin_key text primary key,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.admin_prefs enable row level security;

-- ---- date-range reports: time indexes for the dashboard widgets -----------------
create index if not exists trades_opened_at_idx on public.trades (opened_at);
create index if not exists login_events_created_at_idx on public.login_events (created_at);
create index if not exists players_created_at_idx on public.players (created_at);
create index if not exists coin_purchases_created_at_idx on public.coin_purchases (created_at);
create index if not exists competition_waitlist_created_at_idx on public.competition_waitlist (created_at);
create index if not exists support_conversations_created_at_idx on public.support_conversations (created_at);
create index if not exists friendships_created_at_idx on public.friendships (created_at);
create index if not exists sponsor_stats_daily_day_idx on public.sponsor_stats_daily (day);
