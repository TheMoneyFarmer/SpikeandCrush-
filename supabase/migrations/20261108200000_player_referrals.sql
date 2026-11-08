-- Player invite rewards: each player has one invite code, and each new account
-- can have one inviter. The inviter is paid once, inside one transaction, through
-- coin_apply with an idempotency key, so a retry can never pay twice.

create table if not exists public.player_invite_codes (
  player_id uuid primary key references public.players(id) on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.player_referrals (
  id uuid primary key default gen_random_uuid(),
  inviter_id uuid not null references public.players(id) on delete cascade,
  friend_id uuid not null unique references public.players(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting', 'paid', 'over_limit')),
  match_id uuid,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  check (inviter_id <> friend_id)
);
create index if not exists player_referrals_inviter_status_idx on public.player_referrals (inviter_id, status);

-- Server only: no browser client can read or write these.
alter table public.player_invite_codes enable row level security;
alter table public.player_referrals enable row level security;
revoke all on public.player_invite_codes from anon, authenticated;
revoke all on public.player_referrals from anon, authenticated;

create or replace function public.pay_player_referral(
  p_friend uuid, p_match uuid, p_coins integer, p_limit integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ref player_referrals%rowtype;
  v_paid int;
  v_res jsonb;
begin
  select * into v_ref from player_referrals where friend_id = p_friend for update;
  if not found or v_ref.status <> 'waiting' then
    return jsonb_build_object('paid', false);
  end if;

  -- Holding the inviter's row makes the limit exact when two friends finish together.
  perform 1 from players where id = v_ref.inviter_id for update;
  select count(*) into v_paid from player_referrals where inviter_id = v_ref.inviter_id and status = 'paid';
  if v_paid >= p_limit then
    update player_referrals set status = 'over_limit' where id = v_ref.id;
    return jsonb_build_object('paid', false, 'reason', 'limit');
  end if;

  v_res := coin_apply(v_ref.inviter_id, p_coins, 'referral_reward', p_match, 'referral:' || p_friend::text);
  if v_res ? 'error' then
    raise exception 'referral payment failed: %', v_res->>'error';
  end if;

  update player_referrals set status = 'paid', paid_at = now(), match_id = p_match where id = v_ref.id;
  return jsonb_build_object('paid', true, 'inviter', v_ref.inviter_id);
end $$;

revoke all on function public.pay_player_referral(uuid, uuid, integer, integer) from public, anon, authenticated;
