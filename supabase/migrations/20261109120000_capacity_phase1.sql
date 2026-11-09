-- Capacity work: database-side totals and batch writes instead of pulling or
-- writing rows one at a time, plus indexes for the queries that get busy at
-- scale. Idempotent. The server falls back to slower paths until this has run.

create or replace function public.prize_stats(p_since timestamptz, p_include_seeds boolean)
returns table (total bigint, largest bigint)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(t.amount), 0)::bigint, coalesce(max(t.amount), 0)::bigint
  from coin_transactions t
  join players p on p.id = t.player_id
  where t.type in ('prize_won', 'competition_prize', 'tournament_prize')
    and t.amount > 0
    and (p_since is null or t.created_at >= p_since)
    and (p_include_seeds or not p.is_persona)
    and p.username !~* '(test|debug|iso|^monitor|^pclose)';
$$;

create or replace function public.period_leaderboard(p_since timestamptz, p_include_seeds boolean, p_limit int)
returns table (id uuid, username text, war_rating int, period_pnl numeric, period_matches bigint, period_trades bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.username, p.war_rating::int,
         coalesce(sum(mp.final_pnl), 0)::numeric,
         count(*)::bigint,
         coalesce(sum(mp.trades_made), 0)::bigint
  from match_players mp
  join matches m on m.id = mp.match_id
  join players p on p.id = mp.player_id
  where m.end_time >= p_since
    and (p_include_seeds or not p.is_persona)
    and p.username !~* '(test|debug|iso|^monitor|^pclose)'
  group by p.id, p.username, p.war_rating
  order by 4 desc
  limit greatest(p_limit, 1);
$$;

-- One competition tick's results in a single statement: [{id, equity, snapshot}].
create or replace function public.comp_apply_ticks(p_rows jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update comp_accounts a
     set equity = r.equity,
         last_snapshot_at = case when r.snapshot then now() else a.last_snapshot_at end
    from jsonb_to_recordset(p_rows) as r(id uuid, equity numeric, snapshot boolean)
   where a.id = r.id;
  insert into comp_equity_snapshots (account_id, equity)
  select r.id, r.equity
    from jsonb_to_recordset(p_rows) as r(id uuid, equity numeric, snapshot boolean)
   where r.snapshot
  on conflict do nothing;
end $$;

revoke execute on function public.prize_stats(timestamptz, boolean) from public, anon, authenticated;
revoke execute on function public.period_leaderboard(timestamptz, boolean, int) from public, anon, authenticated;
revoke execute on function public.comp_apply_ticks(jsonb) from public, anon, authenticated;

create index if not exists comp_positions_open_idx on public.comp_positions (competition_id, id) where status = 'open';
create index if not exists comp_accounts_comp_id_idx on public.comp_accounts (competition_id, id);
create index if not exists coin_transactions_match_idx on public.coin_transactions (match_id) where match_id is not null;
create index if not exists matches_end_time_idx on public.matches (end_time);
create index if not exists notifications_player_created_idx on public.notifications (player_id, created_at desc);
create index if not exists notifications_created_idx on public.notifications (created_at);
create index if not exists friendships_requester_idx on public.friendships (requester_id);
create index if not exists sessions_player_idx on public.sessions (player_id);
create index if not exists login_events_player_idx on public.login_events (player_id);
create index if not exists tournament_registrations_player_idx on public.tournament_registrations (player_id);
create index if not exists tournament_registrations_tournament_idx on public.tournament_registrations (tournament_id);
create index if not exists replays_created_idx on public.replays (created_at);
