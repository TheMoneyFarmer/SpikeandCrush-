-- Competitions page rebuild: Daily Open + Weekend Open, Weekly and Monthly
-- discontinued, partner listings (prop firms, brokers, sponsored) with paid
-- tiers, saves, per-listing waitlist, and Partner with us requests.
-- Extends 20261111120000_sponsors_comp_states.sql. Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Recurring templates: rename, prizes, schedules, discontinue two
-- ---------------------------------------------------------------------------
alter table public.competition_templates add column if not exists slug text;
alter table public.competition_templates add column if not exists old_slugs text[] not null default '{}';
alter table public.competition_templates add column if not exists prize_breakdown jsonb not null default '[]'::jsonb;
alter table public.competition_templates add column if not exists instruments text[] not null default '{}';
alter table public.competition_templates add column if not exists schedule jsonb not null default '{}'::jsonb;
alter table public.competition_templates add column if not exists discontinued_at timestamptz;
create unique index if not exists competition_templates_slug_uniq on public.competition_templates (slug) where slug is not null;

-- Player-facing names change; internal keys (daily, weekend) stay.
update public.competition_templates set
  title = 'Daily Open', slug = 'daily-open', old_slugs = array['daily'],
  schedule_text = 'Mon to Fri, open to close', rhythm_text = 'Every weekday when live',
  length_text = 'One trading session', format_hook = 'Trade the real session. Market open to close. Winners every day.',
  rules_line = 'Best equity at the close wins.',
  schedule = '{"days":[1,2,3,4,5],"timezone":"UTC","sessionName":"Forex day","open":"00:00","close":"22:00"}'::jsonb
where key = 'daily' and title = 'Daily War';
update public.competition_templates set
  title = 'Weekend Open', slug = 'weekend-open', old_slugs = array['weekend'],
  schedule_text = 'Sat to Sun, 2 days', rhythm_text = 'Every weekend when live',
  length_text = 'Two days, Saturday to Sunday', format_hook = 'Two days. Weekend markets. One leaderboard.',
  rules_line = 'Best equity at Sunday 23:59 wins.',
  instruments = array['BTCUSD','ETHUSD'],
  schedule = '{"timezone":"UTC","startDay":6,"start":"00:00","endDay":0,"end":"23:59","marketsLabel":"crypto"}'::jsonb
where key = 'weekend' and title = 'Weekend Blitz';
-- Prize seeds (unconfirmed until a paying partner is named): only while unset.
update public.competition_templates set prize_pool_amount = 5000, prize_currency = 'USD', prize_pool_confirmed = false
where key = 'daily' and prize_pool_amount = 0;
update public.competition_templates set prize_pool_amount = 10000, prize_currency = 'USD', prize_pool_confirmed = false
where key = 'weekend' and prize_pool_amount = 0;
update public.competition_templates set prize_breakdown = '[{"places":"1st","share":50},{"places":"2nd","share":25},{"places":"3rd","share":15},{"places":"4th to 10th","share":10}]'::jsonb
where key in ('daily','weekend') and prize_breakdown = '[]'::jsonb;
-- Weekly and Monthly are discontinued (rows and history kept).
update public.competition_templates set state = 'closed', state_reason = 'discontinued', discontinued_at = coalesce(discontinued_at, now())
where key in ('weekly','monthly');

-- ---------------------------------------------------------------------------
-- 2. Competitions as listings: brokers, goods prizes, tiers, pins, Preview
-- ---------------------------------------------------------------------------
alter table public.competitions drop constraint if exists competitions_type_check;
alter table public.competitions add constraint competitions_type_check check (type in ('native','external','sponsored','broker'));
alter table public.competitions drop constraint if exists competitions_prize_kind_chk;
alter table public.competitions add constraint competitions_prize_kind_chk check (prize_kind in ('coins','money','partner','goods'));

alter table public.competitions add column if not exists tier text not null default 'standard';
alter table public.competitions add column if not exists tier_starts_at timestamptz;
alter table public.competitions add column if not exists tier_ends_at timestamptz;
alter table public.competitions add column if not exists listed_at timestamptz not null default now();
alter table public.competitions add column if not exists is_preview boolean not null default false;
alter table public.competitions add column if not exists seed_key text;
alter table public.competitions add column if not exists slug text;
alter table public.competitions add column if not exists listing jsonb not null default '{}'::jsonb;
alter table public.competitions add column if not exists pin_tab text;
alter table public.competitions add column if not exists pin_starts_at timestamptz;
alter table public.competitions add column if not exists pin_ends_at timestamptz;
alter table public.competitions add column if not exists closed_reason text;
alter table public.competitions add column if not exists outbound_clicks int not null default 0;
alter table public.competitions add column if not exists public_token text;
create unique index if not exists competitions_seed_key_uniq on public.competitions (seed_key) where seed_key is not null;
create unique index if not exists competitions_slug_uniq on public.competitions (slug) where slug is not null;
create unique index if not exists competitions_public_token_uniq on public.competitions (public_token) where public_token is not null;
do $$ begin
  alter table public.competitions add constraint competitions_tier_chk check (tier in ('featured','plus','standard'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.competitions add constraint competitions_pin_tab_chk check (pin_tab is null or pin_tab in ('all','ours','prop','broker','sponsored'));
exception when duplicate_object then null; end $$;
-- A listing (prop firm, broker, sponsored) never takes coins and never pays coins.
do $$ begin
  alter table public.competitions add constraint competitions_listing_not_coins_chk
    check (type = 'native' or (prize_kind <> 'coins' and entry_fee_coins = 0 and coalesce(prize_pool_coins, 0) = 0)) not valid;
exception when duplicate_object then null; end $$;

alter table public.organizers add column if not exists country_code text;
alter table public.organizers add column if not exists years_operating int;
alter table public.organizers add column if not exists rating numeric(2,1);
alter table public.organizers add column if not exists logo_dark_url text;
alter table public.organizers add column if not exists seed_key text;
create unique index if not exists organizers_seed_key_uniq on public.organizers (seed_key) where seed_key is not null;

-- Outbound destinations and codes: company revenue, never public. Encrypted by
-- the app (AES-256-GCM, key from env LISTING_SECRETS_KEY) before they get here.
create table if not exists public.competition_listing_secrets (
  competition_id uuid primary key references public.competitions(id) on delete cascade,
  outbound_enc text,
  ref_param text,
  ref_code_enc text,
  ib_param text,
  ib_code_enc text,
  discount_param text,
  discount_code_enc text,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.competition_listing_secrets enable row level security;
revoke all on public.competition_listing_secrets from anon, authenticated;

-- Paid listing tiers (names and prices edited in admin; prices blank until set).
create table if not exists public.listing_tiers (
  key text primary key check (key in ('featured','plus','standard')),
  name text not null,
  rank int not null unique,
  price_text text,
  perks text,
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into public.listing_tiers (key, name, rank, perks) values
  ('featured', 'Featured', 1, 'Top of its tab and of All, a larger row, a gold ring, the Featured chip, your logo in the lobby sponsor strip and on the result screen.'),
  ('plus', 'Plus', 2, 'Above Standard listings, a green ring and the Plus chip.'),
  ('standard', 'Standard', 3, 'A listing in its tab, in the order you joined.')
on conflict (key) do nothing;
alter table public.listing_tiers enable row level security;
drop policy if exists listing_tiers_read on public.listing_tiers;
create policy listing_tiers_read on public.listing_tiers for select to anon, authenticated using (true);

-- Saved listings (the heart), per account.
create table if not exists public.listing_saves (
  user_id uuid not null references public.players(id) on delete cascade,
  competition_id uuid not null references public.competitions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, competition_id)
);
alter table public.listing_saves enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Waitlist for every listing (ours by template, partners by competition)
-- ---------------------------------------------------------------------------
alter table public.competition_waitlist alter column template_key drop not null;
alter table public.competition_waitlist add column if not exists competition_id uuid references public.competitions(id) on delete cascade;
do $$ begin
  alter table public.competition_waitlist add constraint competition_waitlist_target_chk check ((template_key is null) <> (competition_id is null));
exception when duplicate_object then null; end $$;
create unique index if not exists competition_waitlist_user_comp_uniq on public.competition_waitlist (user_id, competition_id) where competition_id is not null;
create index if not exists competition_waitlist_comp_idx on public.competition_waitlist (competition_id) where competition_id is not null;
alter table public.competition_waitlist_sends alter column template_key drop not null;
alter table public.competition_waitlist_sends add column if not exists competition_id uuid;

-- ---------------------------------------------------------------------------
-- 4. Partner with us: extends the existing sponsor_leads inbox
-- ---------------------------------------------------------------------------
alter table public.sponsor_leads add column if not exists company_type text;
alter table public.sponsor_leads add column if not exists website text;
alter table public.sponsor_leads add column if not exists wants text;
alter table public.sponsor_leads add column if not exists tier_interest text;
alter table public.sponsor_leads add column if not exists notes text;
alter table public.sponsor_leads add column if not exists updated_at timestamptz not null default now();
alter table public.sponsor_leads drop constraint if exists sponsor_leads_status_check;
alter table public.sponsor_leads add constraint sponsor_leads_status_check check (status in ('new','contacted','signed','declined','closed'));
do $$ begin
  alter table public.sponsor_leads add constraint sponsor_leads_company_type_chk check (company_type is null or company_type in ('prop_firm','broker','sponsor'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.sponsor_leads add constraint sponsor_leads_wants_chk check (wants is null or wants in ('competition','prize','both'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.sponsor_leads add constraint sponsor_leads_tier_chk check (tier_interest is null or tier_interest in ('featured','plus','standard','not_sure'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 5. Settings
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('competitions.currency', '"USD"'::jsonb),
  ('liveFeed.heartbeatAt', 'null'::jsonb)
on conflict (key) do nothing;

-- Outbound click counter (service role only).
create or replace function public.listing_outbound_bump(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update competitions set outbound_clicks = outbound_clicks + 1 where id = p_id;
$$;
revoke execute on function public.listing_outbound_bump(uuid) from public, anon, authenticated;
