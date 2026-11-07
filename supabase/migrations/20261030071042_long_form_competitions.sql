-- Long-form competitions (Daily / Weekly / Weekend / Monthly): competition
-- lifecycle columns, accounts, positions, equity snapshots, job lock and the
-- atomic entry / close / prize / refund functions. Idempotent.

alter table public.competitions
  add column if not exists replay_speed numeric not null default 1 check (replay_speed > 0),
  add column if not exists data_window_start timestamptz,
  add column if not exists frequency text check (frequency in ('daily','weekly','weekend','monthly')),
  add column if not exists is_test boolean not null default false,
  add column if not exists status text not null default 'scheduled' check (status in ('scheduled','active','ended','void')),
  add column if not exists prize_payouts jsonb not null default '[]'::jsonb,
  add column if not exists last_tick_at timestamptz,
  add column if not exists last_tick_data_time timestamptz,
  add column if not exists notices_sent text[] not null default '{}',
  add column if not exists settled_at timestamptz;
-- production competitions replay in real time; only test ones may speed up
alter table public.competitions drop constraint if exists competitions_replay_speed_test_only;
alter table public.competitions add constraint competitions_replay_speed_test_only check (is_test or replay_speed = 1);
create index if not exists competitions_status_idx on public.competitions (status, ends_at);
create index if not exists competitions_frequency_idx on public.competitions (frequency, starts_at);

create table if not exists public.comp_accounts (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  starting_capital numeric not null,
  balance numeric not null,
  equity numeric not null,
  realised_pnl numeric not null default 0,
  status text not null default 'active' check (status in ('active','loss_limit','finished','disqualified')),
  loss_limit_hit_at timestamptz,
  final_rank int,
  final_pnl numeric,
  prize_coins int not null default 0,
  prize_usd numeric not null default 0,
  prize_paid boolean not null default false,
  trade_count int not null default 0,
  last_snapshot_at timestamptz,
  created_at timestamptz not null default now(),
  unique (competition_id, player_id)
);
create index if not exists comp_accounts_comp_idx on public.comp_accounts (competition_id);
create index if not exists comp_accounts_player_idx on public.comp_accounts (player_id);

create table if not exists public.comp_positions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.comp_accounts(id) on delete cascade,
  competition_id uuid not null references public.competitions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  symbol text not null,
  side text not null check (side in ('BUY','SELL')),
  lots numeric not null check (lots > 0),
  entry_price numeric not null,
  stop_loss numeric,
  take_profit numeric,
  status text not null default 'open' check (status in ('open','closed')),
  exit_price numeric,
  exit_reason text check (exit_reason in ('manual','sl','tp','loss_limit','settle','void','disqualified')),
  pnl numeric,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists comp_positions_comp_idx on public.comp_positions (competition_id);
create index if not exists comp_positions_player_idx on public.comp_positions (player_id);
create index if not exists comp_positions_account_status_idx on public.comp_positions (account_id, status);

create table if not exists public.comp_equity_snapshots (
  account_id uuid not null references public.comp_accounts(id) on delete cascade,
  ts timestamptz not null default now(),
  equity numeric not null,
  primary key (account_id, ts)
);

-- single-runner lock for the tick/settlement jobs across server instances
create table if not exists public.comp_job_locks (
  name text primary key,
  holder text,
  locked_until timestamptz not null default now()
);

alter table public.prize_claims alter column tournament_id drop not null;
alter table public.prize_claims add column if not exists competition_id uuid references public.competitions(id);

alter table public.comp_accounts enable row level security;
alter table public.comp_positions enable row level security;
alter table public.comp_equity_snapshots enable row level security;
alter table public.comp_job_locks enable row level security;

create or replace function public.comp_try_lock(p_name text, p_holder text, p_ttl_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into comp_job_locks (name, holder, locked_until) values (p_name, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update set holder = excluded.holder, locked_until = excluded.locked_until
    where comp_job_locks.locked_until < now() or comp_job_locks.holder = excluded.holder;
  return found;
end $$;

-- Atomic, idempotent entry: one fee, one account, however many times it's called.
create or replace function public.comp_enter(p_comp uuid, p_player uuid, p_fee int, p_capital numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_coins int; v_account comp_accounts%rowtype;
begin
  select coins into v_coins from players where id = p_player for update;
  if not found then return jsonb_build_object('error', 'player_not_found'); end if;
  select * into v_account from comp_accounts where competition_id = p_comp and player_id = p_player;
  if found then return jsonb_build_object('already', true, 'account_id', v_account.id); end if;
  if p_fee > 0 then
    if v_coins < p_fee then return jsonb_build_object('error', 'insufficient_coins'); end if;
    update players set coins = coins - p_fee, coins_spent_total = coalesce(coins_spent_total, 0) + p_fee where id = p_player;
    insert into coin_transactions (player_id, type, amount, balance_after) values (p_player, 'competition_entry', -p_fee, v_coins - p_fee);
  end if;
  insert into competition_entries (competition_id, player_id) values (p_comp, p_player) on conflict do nothing;
  insert into comp_accounts (competition_id, player_id, starting_capital, balance, equity)
    values (p_comp, p_player, p_capital, p_capital, p_capital) returning * into v_account;
  return jsonb_build_object('already', false, 'account_id', v_account.id);
end $$;

-- Closes one position exactly once and books its P&L into the account.
create or replace function public.comp_close_position(p_position uuid, p_exit numeric, p_reason text, p_pnl numeric)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_account uuid;
begin
  update comp_positions set status = 'closed', exit_price = p_exit, exit_reason = p_reason, pnl = p_pnl, closed_at = now()
    where id = p_position and status = 'open' returning account_id into v_account;
  if not found then return false; end if;
  update comp_accounts set balance = balance + p_pnl, realised_pnl = realised_pnl + p_pnl where id = v_account;
  return true;
end $$;

-- Refunds one entry fee exactly once (void), reusing prize_paid as the guard.
create or replace function public.comp_refund_entry(p_account uuid, p_fee int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_acc comp_accounts%rowtype; v_coins int;
begin
  update comp_accounts set prize_paid = true where id = p_account and not prize_paid returning * into v_acc;
  if not found then return false; end if;
  if p_fee > 0 then
    update players set coins = coins + p_fee where id = v_acc.player_id returning coins into v_coins;
    insert into coin_transactions (player_id, type, amount, balance_after) values (v_acc.player_id, 'competition_refund', p_fee, v_coins);
  end if;
  return true;
end $$;

revoke execute on function public.comp_try_lock(text, text, int) from public, anon, authenticated;
revoke execute on function public.comp_enter(uuid, uuid, int, numeric) from public, anon, authenticated;
revoke execute on function public.comp_close_position(uuid, numeric, text, numeric) from public, anon, authenticated;
revoke execute on function public.comp_refund_entry(uuid, int) from public, anon, authenticated;
