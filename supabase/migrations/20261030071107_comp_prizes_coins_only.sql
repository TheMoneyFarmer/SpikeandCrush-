-- Competition prizes are coin credits only (coins have no cash value).
-- Pays one account's coin prize exactly once (prize_paid is the guard).
create or replace function public.comp_pay_prize(p_account uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_acc comp_accounts%rowtype; v_coins int;
begin
  update comp_accounts set prize_paid = true where id = p_account and not prize_paid returning * into v_acc;
  if not found then return false; end if;
  if v_acc.prize_coins > 0 then
    update players set coins = coins + v_acc.prize_coins, coins_earned_total = coalesce(coins_earned_total, 0) + v_acc.prize_coins
      where id = v_acc.player_id returning coins into v_coins;
    insert into coin_transactions (player_id, type, amount, balance_after) values (v_acc.player_id, 'competition_prize', v_acc.prize_coins, v_coins);
  end if;
  return true;
end $$;
revoke execute on function public.comp_pay_prize(uuid) from public, anon, authenticated;
create unique index if not exists prize_claims_player_competition_uniq on public.prize_claims (player_id, competition_id) where competition_id is not null;
