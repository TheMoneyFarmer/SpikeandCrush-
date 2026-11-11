-- Cards, streaks, Heat and missions in competitions (server/compFire.js).
-- Safe to run more than once.

-- Each competition account's card state: hand, streak, Heat, missions and
-- the timed card effects on it (they expire on their own).
alter table public.comp_accounts add column if not exists fire jsonb not null default '{}'::jsonb;

-- Positions closed by a card (Force Close, Margin Call).
alter table public.comp_positions drop constraint if exists comp_positions_exit_reason_check;
alter table public.comp_positions add constraint comp_positions_exit_reason_check
  check (exit_reason in ('manual','sl','tp','loss_limit','settle','void','disqualified','sabotage'));

-- Card money (Capital Drain, Pip Theft, Profit Skim, Profit Tax) in one
-- transaction: p_from loses p_amount, p_to (optional) gains it. Both must be
-- active accounts in the same competition. Returns false if not applied.
create or replace function public.comp_card_transfer(p_from uuid, p_to uuid, p_amount numeric)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_comp uuid;
begin
  if p_amount is null or p_amount <= 0 then return false; end if;
  update comp_accounts set balance = balance - p_amount, realised_pnl = realised_pnl - p_amount
    where id = p_from and status = 'active' returning competition_id into v_comp;
  if not found then return false; end if;
  if p_to is not null then
    update comp_accounts set balance = balance + p_amount, realised_pnl = realised_pnl + p_amount
      where id = p_to and competition_id = v_comp and status = 'active';
    if not found then raise exception 'comp_card_transfer: receiver not active in this competition'; end if;
  end if;
  return true;
end $$;

revoke execute on function public.comp_card_transfer(uuid, uuid, numeric) from public, anon, authenticated;
