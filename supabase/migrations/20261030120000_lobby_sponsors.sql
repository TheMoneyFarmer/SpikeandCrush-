-- Lobby redesign + sponsor system. Idempotent: safe to run any number of times.

create table if not exists public.sponsors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_url text,
  link_url text check (link_url is null or link_url ~* '^https?://'),
  tier text not null default 'partner' check (tier in ('platinum','gold','silver','partner')),
  status text not null default 'draft' check (status in ('draft','active','paused','ended')),
  starts_at timestamptz,
  ends_at timestamptz,
  notes text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists sponsors_status_idx on public.sponsors (status, starts_at, ends_at);

create table if not exists public.sponsor_placements (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid not null references public.sponsors(id) on delete cascade,
  placement text not null check (placement in ('global_strip','hero','competition','mode')),
  target_id text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists sponsor_placements_lookup_idx on public.sponsor_placements (placement, target_id) where active;
create index if not exists sponsor_placements_sponsor_idx on public.sponsor_placements (sponsor_id);

create table if not exists public.sponsor_clicks (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid not null references public.sponsors(id) on delete cascade,
  placement text,
  target_id text,
  user_id uuid references public.players(id) on delete set null,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index if not exists sponsor_clicks_sponsor_idx on public.sponsor_clicks (sponsor_id, created_at);

create table if not exists public.sponsor_impressions_daily (
  sponsor_id uuid not null references public.sponsors(id) on delete cascade,
  placement text not null,
  day date not null,
  count int not null default 0,
  primary key (sponsor_id, placement, day)
);

create table if not exists public.sponsor_leads (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  contact_name text not null,
  email text not null,
  interest text,
  budget_band text,
  message text,
  status text not null default 'new' check (status in ('new','contacted','closed')),
  ip_hash text,
  created_at timestamptz not null default now()
);
create index if not exists sponsor_leads_ip_idx on public.sponsor_leads (ip_hash, created_at);

-- Prize pools are always coins.
alter table public.competitions add column if not exists sponsor_id uuid references public.sponsors(id) on delete set null;
alter table public.competitions add column if not exists prize_pool_coins int not null default 0 check (prize_pool_coins >= 0);
alter table public.competitions add column if not exists sponsor_funded boolean not null default false;
update public.competitions c
  set prize_pool_coins = coalesce((select sum((p->>'coins')::int) from jsonb_array_elements(c.prize_payouts) p where p ? 'coins'), 0)
  where c.prize_pool_coins = 0 and jsonb_typeof(c.prize_payouts) = 'array' and jsonb_array_length(c.prize_payouts) > 0;

-- RLS: players may read active sponsors and their placements; every write
-- goes through the service role (game server / admin panel).
alter table public.sponsors enable row level security;
alter table public.sponsor_placements enable row level security;
alter table public.sponsor_clicks enable row level security;
alter table public.sponsor_impressions_daily enable row level security;
alter table public.sponsor_leads enable row level security;

drop policy if exists sponsors_public_read on public.sponsors;
create policy sponsors_public_read on public.sponsors for select to anon, authenticated
  using (status = 'active' and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));
drop policy if exists sponsor_placements_public_read on public.sponsor_placements;
create policy sponsor_placements_public_read on public.sponsor_placements for select to anon, authenticated
  using (active and exists (select 1 from public.sponsors s where s.id = sponsor_id and s.status = 'active'
    and (s.starts_at is null or s.starts_at <= now()) and (s.ends_at is null or s.ends_at > now())));

-- Atomic daily impression counter.
create or replace function public.sponsor_impression_bump(p_sponsor uuid, p_placement text, p_day date, p_n int)
returns void language sql security definer set search_path = public as $$
  insert into sponsor_impressions_daily (sponsor_id, placement, day, count) values (p_sponsor, p_placement, p_day, p_n)
  on conflict (sponsor_id, placement, day) do update set count = sponsor_impressions_daily.count + excluded.count;
$$;
revoke execute on function public.sponsor_impression_bump(uuid, text, date, int) from public, anon, authenticated;

-- Lobby settings (admin-editable). show_seed_accounts=false hides persona
-- accounts from every public board, feed and count.
insert into public.app_settings (key, value) values
  ('show_seed_accounts', 'false'::jsonb),
  ('lobby_empty_message', '"Season 1 is live. Be one of the first traders on the board."'::jsonb),
  ('featured_competition_id', 'null'::jsonb),
  ('season_label', '"Season 1"'::jsonb)
on conflict (key) do nothing;

-- Public bucket for sponsor logos (uploads only via the admin panel's service role).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sponsor-logos', 'sponsor-logos', true, 1048576, array['image/png','image/svg+xml','image/webp'])
on conflict (id) do nothing;
