-- Competition Hub: organizers, competitions, entries. Idempotent.

create table if not exists public.organizers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_url text,
  website text,
  is_verified boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.competitions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  rules text,
  type text not null default 'native' check (type in ('native', 'external', 'sponsored')),
  organizer_id uuid references public.organizers(id) on delete set null,
  prize_pool numeric(12,2) not null default 0 check (prize_pool >= 0),
  prize_details jsonb not null default '{}'::jsonb,
  instruments text[] not null default '{}',
  entry_fee_coins integer not null default 0 check (entry_fee_coins >= 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  external_url text check (external_url is null or external_url ~* '^https?://'),
  platform_name text,
  is_featured boolean not null default false,
  is_published boolean not null default true,
  click_count integer not null default 0,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists competitions_published_ends_idx on public.competitions (is_published, ends_at);

create table if not exists public.competition_entries (
  competition_id uuid not null references public.competitions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  entered_at timestamptz not null default now(),
  primary key (competition_id, player_id)
);

alter table public.organizers enable row level security;
alter table public.competitions enable row level security;
alter table public.competition_entries enable row level security;

create or replace function public.increment_competition_clicks(comp_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.competitions set click_count = click_count + 1 where id = comp_id;
$$;
revoke all on function public.increment_competition_clicks(uuid) from public, anon, authenticated;
