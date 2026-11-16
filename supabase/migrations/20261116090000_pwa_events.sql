-- Install-the-app analytics: daily counts per event and platform (no player
-- ids). Events: prompt_shown, prompt_dismissed, prompt_never, install_click,
-- installed, standalone_session, match_installed, match_browser,
-- lock_failed_nudge. Safe to run twice.
create table if not exists public.pwa_events_daily (
  day date not null,
  kind text not null,
  platform text not null,
  count integer not null default 0,
  primary key (day, kind, platform)
);
alter table public.pwa_events_daily enable row level security;

create or replace function public.pwa_event_bump(p_day date, p_kind text, p_platform text)
returns void language sql as $$
  insert into public.pwa_events_daily (day, kind, platform, count) values (p_day, p_kind, p_platform, 1)
  on conflict (day, kind, platform) do update set count = public.pwa_events_daily.count + 1;
$$;
revoke all on function public.pwa_event_bump(date, text, text) from public, anon, authenticated;
