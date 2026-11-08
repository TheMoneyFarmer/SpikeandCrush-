-- Security / money-path hardening (audit 2026-11-08, docs/AUDIT_REPORT.md).
-- Idempotent: safe to run more than once. Apply to dev first, then prod.
--
-- 1. Every coin movement goes through coin_apply(): one statement moves the
--    balance (never below zero) and writes the ledger row in the same
--    transaction, with an optional idempotency key so retries, double clicks
--    and duplicate webhooks can never move coins twice.
-- 2. Stripe purchases complete exactly once (complete_coin_purchase) and
--    Stripe events are de-duplicated (stripe_events).
-- 3. Shop items can only be bought once per player (shop_buy + unique index).
-- 4. Prize totals are summed in SQL, and the hot queries get indexes.

-- ---- ledger columns and constraints ------------------------------------------------
alter table public.coin_transactions add column if not exists idempotency_key text;
create unique index if not exists coin_transactions_idempotency_key_uq
  on public.coin_transactions (idempotency_key) where idempotency_key is not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'players_coins_nonnegative') then
    alter table public.players add constraint players_coins_nonnegative check (coins >= 0) not valid;
  end if;
end $$;
alter table public.players validate constraint players_coins_nonnegative;

-- one purchase row per Stripe checkout session
create unique index if not exists coin_purchases_stripe_session_uq
  on public.coin_purchases (stripe_session_id) where stripe_session_id is not null;

-- one shop item per player (keep the earliest duplicate, if any exist)
delete from public.shop_purchases a using public.shop_purchases b
  where a.player_id = b.player_id and a.item_id = b.item_id
    and (a.purchased_at, a.id) > (b.purchased_at, b.id);
create unique index if not exists shop_purchases_player_item_uq
  on public.shop_purchases (player_id, item_id);

-- Stripe webhook de-duplication
create table if not exists public.stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
alter table public.stripe_events enable row level security;

-- ---- coin_apply: the only way coins move ---------------------------------------------
-- p_delta > 0 credits, < 0 debits. Returns
--   {ok:true, balance:n}                    applied
--   {ok:true, duplicate:true, balance:n}    idempotency key already used (no change)
--   {error:'insufficient_coins', balance:n} debit would go below zero (no change)
--   {error:'player_not_found'}
create or replace function public.coin_apply(
  p_player uuid, p_delta integer, p_type text, p_match uuid default null, p_key text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_coins int;
begin
  if p_key is not null and exists (select 1 from coin_transactions where idempotency_key = p_key) then
    select coins into v_coins from players where id = p_player;
    return jsonb_build_object('ok', true, 'duplicate', true, 'balance', v_coins);
  end if;

  update players
     set coins = coins + p_delta,
         coins_earned_total = coalesce(coins_earned_total, 0) + greatest(p_delta, 0),
         coins_spent_total  = coalesce(coins_spent_total, 0) + greatest(-p_delta, 0)
   where id = p_player and coins + p_delta >= 0
  returning coins into v_coins;

  if not found then
    select coins into v_coins from players where id = p_player;
    if not found then return jsonb_build_object('error', 'player_not_found'); end if;
    return jsonb_build_object('error', 'insufficient_coins', 'balance', v_coins);
  end if;

  begin
    insert into coin_transactions (player_id, type, amount, balance_after, match_id, idempotency_key)
    values (p_player, p_type, p_delta, v_coins, p_match, p_key);
  exception when unique_violation then
    -- a concurrent call with the same key won the race: undo our balance move
    raise exception 'coin_apply duplicate key %', p_key using errcode = 'P0001', hint = 'duplicate';
  end;
  return jsonb_build_object('ok', true, 'balance', v_coins);
end $$;

-- ---- Stripe purchase completion: exactly once ------------------------------------
create or replace function public.complete_coin_purchase(p_session text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_purchase coin_purchases%rowtype; v_res jsonb;
begin
  update coin_purchases set status = 'completed'
   where stripe_session_id = p_session and status <> 'completed'
  returning * into v_purchase;
  if not found then
    select * into v_purchase from coin_purchases where stripe_session_id = p_session;
    if not found then return jsonb_build_object('error', 'not_found'); end if;
    return jsonb_build_object('already', true, 'player_id', v_purchase.player_id, 'coins', v_purchase.package_coins);
  end if;
  v_res := coin_apply(v_purchase.player_id, v_purchase.package_coins, 'coin_purchase', null, 'purchase:' || p_session);
  if v_res ? 'error' then raise exception 'credit failed: %', v_res->>'error'; end if;
  return jsonb_build_object('ok', true, 'player_id', v_purchase.player_id, 'coins', v_purchase.package_coins,
                            'amount_usd', v_purchase.amount_usd, 'balance', v_res->'balance');
end $$;

-- ---- shop purchase: own once, pay once -------------------------------------------
create or replace function public.shop_buy(p_player uuid, p_item_type text, p_item_id text, p_price integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_coins int; v_id uuid; v_res jsonb;
begin
  select coins into v_coins from players where id = p_player for update;
  if not found then return jsonb_build_object('error', 'player_not_found'); end if;
  if exists (select 1 from shop_purchases where player_id = p_player and item_id = p_item_id) then
    return jsonb_build_object('error', 'already_owned');
  end if;
  if v_coins < p_price then return jsonb_build_object('error', 'insufficient_coins', 'balance', v_coins); end if;
  insert into shop_purchases (player_id, item_type, item_id, coins_spent)
  values (p_player, p_item_type, p_item_id, p_price)
  on conflict (player_id, item_id) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('error', 'already_owned'); end if;
  if p_price > 0 then
    v_res := coin_apply(p_player, -p_price, 'shop_purchase', null, 'shop:' || p_player || ':' || p_item_id);
    if v_res ? 'error' then raise exception 'debit failed: %', v_res->>'error'; end if;
    v_coins := (v_res->>'balance')::int;
  end if;
  return jsonb_build_object('ok', true, 'purchase_id', v_id, 'balance', v_coins);
end $$;

-- ---- prize total for the landing/lobby stats (was a 10k-row scan in JS) ----------
create or replace function public.prize_total(p_since timestamptz default null)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(t.amount), 0)::bigint
    from coin_transactions t join players p on p.id = t.player_id
   where t.type in ('prize_won', 'competition_prize', 'tournament_prize')
     and t.amount > 0
     and not coalesce(p.is_persona, false)
     and p.username !~* '(test|debug|iso|^monitor|^pclose)'
     and (p_since is null or t.created_at >= p_since);
$$;

-- server-only: no anon/authenticated access to any of these
revoke all on function public.coin_apply(uuid, integer, text, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_coin_purchase(text) from public, anon, authenticated;
revoke all on function public.shop_buy(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.prize_total(timestamptz) from public, anon, authenticated;

-- ---- indexes for hot queries and unindexed foreign keys ---------------------------
create index if not exists players_rating_live_idx on public.players (war_rating desc) where not is_persona;
create index if not exists idx_matches_created_at on public.matches (created_at);
create index if not exists idx_matches_status_end on public.matches (status, end_time desc);
create index if not exists idx_coin_tx_type_created on public.coin_transactions (type, created_at);
create index if not exists idx_coin_transactions_player_id on public.coin_transactions (player_id);
create index if not exists idx_match_players_match_id on public.match_players (match_id);
create index if not exists idx_match_players_player_id on public.match_players (player_id);
create index if not exists idx_trades_match_id on public.trades (match_id);
create index if not exists idx_trades_player_id on public.trades (player_id);
create index if not exists idx_notifications_player on public.notifications (player_id);
create index if not exists idx_sabotage_events_match_id on public.sabotage_events (match_id);
create index if not exists idx_shop_purchases_player on public.shop_purchases (player_id);
create index if not exists idx_coin_purchases_player_id on public.coin_purchases (player_id);
create index if not exists idx_support_tickets_player on public.support_tickets (player_id);
create index if not exists idx_friendships_addressee on public.friendships (addressee_id);
-- duplicates of the unique-constraint indexes
drop index if exists public.players_email_idx;
drop index if exists public.idx_matches_room_code;

-- ---- avatar storage (avatars used to live on Railway's ephemeral disk) -------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/png','image/jpeg','image/gif','image/webp'])
on conflict (id) do nothing;
