-- Sponsorship system, competition states ("Coming soon"), partner competitions.
-- Idempotent: safe to run more than once. Extends the existing competitions
-- and sponsor tables (20261029113721, 20261030120000) rather than duplicating.

-- ---------------------------------------------------------------------------
-- 1. Competition states, data source, and the two prize worlds
-- ---------------------------------------------------------------------------
-- state: the player-facing availability (separate from the engine's own
-- `status` lifecycle scheduled/active/ended/void, which stays as it is).
alter table public.competitions add column if not exists state text not null default 'open';
alter table public.competitions add column if not exists data_source text not null default 'replay';
-- prize_kind: 'coins' (coin prizes, may charge a coin entry), 'money' (cash
-- prize paid by the named competition partner, entry always free), 'partner'
-- (hosted on a partner's site; prize text set by the partner, entry free).
alter table public.competitions add column if not exists prize_kind text not null default 'coins';
alter table public.competitions add column if not exists prize_currency text not null default 'USD';
alter table public.competitions add column if not exists prize_pool_confirmed boolean not null default false;
alter table public.competitions add column if not exists prize_top_amount numeric(12,2) not null default 0;
alter table public.competitions add column if not exists prize_text text;           -- partner competitions: exactly as the admin typed it
alter table public.competitions add column if not exists rules_summary text;        -- partner competitions
alter table public.competitions add column if not exists template_key text;

do $$ begin
  alter table public.competitions add constraint competitions_state_chk check (state in ('coming_soon','open','running','paused','closed'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.competitions add constraint competitions_data_source_chk check (data_source in ('replay','live'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.competitions add constraint competitions_prize_kind_chk check (prize_kind in ('coins','money','partner'));
exception when duplicate_object then null; end $$;
-- The separation rule, in the schema. A money or partner competition can
-- never charge coins or pay coins; a coin event can never carry a money pool.
-- NOT VALID: enforced on every new or changed row without rewriting history.
do $$ begin
  alter table public.competitions add constraint competitions_money_is_free_chk
    check (prize_kind = 'coins' or (entry_fee_coins = 0 and coalesce(prize_pool_coins, 0) = 0)) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.competitions add constraint competitions_coins_no_money_chk
    check (prize_kind <> 'coins' or (prize_pool = 0 and prize_top_amount = 0)) not valid;
exception when duplicate_object then null; end $$;

-- Existing rows: external listings become partner competitions; everything
-- else stays a coin event exactly as it is today.
update public.competitions set prize_kind = 'partner' where type = 'external' and prize_kind = 'coins' and entry_fee_coins = 0 and coalesce(prize_pool_coins, 0) = 0;
update public.competitions set template_key = frequency where template_key is null and frequency is not null;

-- Templates: one row per recurring format, edited in admin.
create table if not exists public.competition_templates (
  key text primary key,                         -- daily, weekly, weekend, monthly
  title text not null,
  schedule_text text not null,                  -- "Every weekday, market open to close"
  rhythm_text text not null,                    -- "Runs every weekday when live"
  length_text text not null,
  format_hook text not null,                    -- the line that sells the format
  rules_line text not null,
  state text not null default 'coming_soon' check (state in ('coming_soon','open','running','paused','closed')),
  data_source text not null default 'live' check (data_source in ('replay','live')),
  prize_kind text not null default 'money' check (prize_kind in ('coins','money')),
  prize_currency text not null default 'USD',
  prize_pool_amount numeric(12,2) not null default 0 check (prize_pool_amount >= 0),
  prize_top_amount numeric(12,2) not null default 0 check (prize_top_amount >= 0),
  prize_pool_confirmed boolean not null default false,
  prize_partner_note text,                       -- who pays; admin only
  entry_fee_coins int not null default 0,
  state_reason text,
  updated_by text,
  updated_at timestamptz not null default now(),
  check (prize_kind = 'coins' or entry_fee_coins = 0)   -- money competitions are always free to enter
);
insert into public.competition_templates (key, title, schedule_text, rhythm_text, length_text, format_hook, rules_line, state_reason) values
  ('daily',   'Daily War',     'Every weekday, market open to close', 'Runs every weekday when live',        'One trading session', 'Trade the real session. Market open to close. Winners every day.',        'Best equity at the close wins.',         'Needs the live price feed'),
  ('weekly',  'Weekly War',    'Monday to Friday',                    'Runs every week when live',           'Five trading days',   'Five days. One leaderboard. The most consistent trader takes it.',       'One account for the whole week, no resets.', 'Needs the live price feed'),
  ('weekend', 'Weekend Blitz', 'Saturday and Sunday, crypto',         'Runs every weekend when live',        '48 hours',            '48 hours, no sleep for the leaderboard.',                                'Bitcoin and Ethereum only.',             'Needs the live price feed'),
  ('monthly', 'Monthly Grand', 'The whole calendar month',            'Runs every month when live',          'Thirty days',         'The Grand. Thirty days to prove you belong at the top.',                 'One account for the month, no resets.',  'Needs the live price feed')
on conflict (key) do nothing;
alter table public.competition_templates enable row level security;
drop policy if exists competition_templates_public_read on public.competition_templates;
create policy competition_templates_public_read on public.competition_templates for select to anon, authenticated using (true);

-- Upcoming coin runs of those formats that nobody has entered yet are locked
-- with their template; runs already under way or with entrants finish as
-- coin events (their entrants paid coins), then stop.
update public.competitions c set state = 'coming_soon', data_source = 'live'
  where c.frequency in ('daily','weekly','weekend','monthly') and c.status = 'scheduled' and c.starts_at > now()
    and not exists (select 1 from public.comp_accounts a where a.competition_id = c.id);
update public.competitions set state = 'running' where status = 'active' and state = 'open';
update public.competitions set state = 'closed' where status in ('ended','void') and state = 'open';

-- ---------------------------------------------------------------------------
-- 2. Waitlist ("Notify me")
-- ---------------------------------------------------------------------------
create table if not exists public.competition_waitlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.players(id) on delete cascade,
  template_key text not null references public.competition_templates(key) on delete cascade,
  source text not null default 'card' check (source in ('card','detail','email','signup')),
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  unique (user_id, template_key)
);
create index if not exists competition_waitlist_template_idx on public.competition_waitlist (template_key);
create table if not exists public.competition_waitlist_sends (
  id uuid primary key default gen_random_uuid(),
  template_key text not null,
  sent_by text,
  recipients int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.competition_waitlist enable row level security;
alter table public.competition_waitlist_sends enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Sponsors: richer sponsor records and the ten placement slots
-- ---------------------------------------------------------------------------
alter table public.sponsors add column if not exists slug text;
alter table public.sponsors add column if not exists tagline text;
alter table public.sponsors add column if not exists logo_dark_url text;
alter table public.sponsors add column if not exists utm_source text default 'spikeandcrush';
alter table public.sponsors add column if not exists utm_medium text default 'sponsorship';
alter table public.sponsors add column if not exists utm_campaign text;
alter table public.sponsors add column if not exists contact_name text;
alter table public.sponsors add column if not exists contact_email text;
alter table public.sponsors add column if not exists updated_at timestamptz not null default now();
do $$ begin
  alter table public.sponsors add constraint sponsors_tagline_len check (tagline is null or char_length(tagline) <= 60);
exception when duplicate_object then null; end $$;
create unique index if not exists sponsors_slug_uniq on public.sponsors (slug) where slug is not null;

alter table public.sponsor_placements add column if not exists slot text;
alter table public.sponsor_placements add column if not exists targets text not null default 'all';
alter table public.sponsor_placements add column if not exists weight int not null default 1;
alter table public.sponsor_placements add column if not exists starts_at timestamptz;
alter table public.sponsor_placements add column if not exists ends_at timestamptz;
alter table public.sponsor_placements add column if not exists status text not null default 'active';
alter table public.sponsor_placements add column if not exists creative text not null default 'logo_tagline';
alter table public.sponsor_placements add column if not exists tagline text;
alter table public.sponsor_placements add column if not exists cta_text text;
alter table public.sponsor_placements add column if not exists cta_url text;
alter table public.sponsor_placements add column if not exists created_by text;
alter table public.sponsor_placements add column if not exists updated_at timestamptz not null default now();
do $$ begin
  alter table public.sponsor_placements add constraint sponsor_placements_slot_chk check (slot is null or slot in (
    'lobby_strip','competition_card','prematch','match_header_chip','spike_strip_tag','result_screen',
    'leaderboard_header','event_banner','email_footer','cosmetic'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.sponsor_placements add constraint sponsor_placements_status_chk check (status in ('draft','active','paused','ended'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.sponsor_placements add constraint sponsor_placements_creative_chk check (creative in ('logo','logo_tagline','logo_tagline_cta'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.sponsor_placements add constraint sponsor_placements_weight_chk check (weight between 1 and 100);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.sponsor_placements add constraint sponsor_placements_cta_url_chk check (cta_url is null or cta_url ~* '^https?://');
exception when duplicate_object then null; end $$;
-- the old placement names map onto the new slots
update public.sponsor_placements set slot = case placement when 'global_strip' then 'lobby_strip' when 'competition' then 'competition_card' when 'hero' then 'lobby_strip' when 'mode' then 'match_header_chip' end
  where slot is null;
update public.sponsor_placements set status = case when active then 'active' else 'paused' end where status = 'active' and not active;
create index if not exists sponsor_placements_slot_idx on public.sponsor_placements (slot, status);

-- Daily counts per placement. Counts only: no player ids, handles or emails.
create table if not exists public.sponsor_stats_daily (
  placement_id uuid not null references public.sponsor_placements(id) on delete cascade,
  day date not null,
  impressions int not null default 0,
  unique_viewers int not null default 0,
  clicks int not null default 0,
  entries int not null default 0,
  outbound_clicks int not null default 0,
  primary key (placement_id, day)
);
alter table public.sponsor_stats_daily enable row level security;

-- Sponsor data never names a player: the old click log stops keeping who clicked.
update public.sponsor_clicks set user_id = null where user_id is not null;
do $$ begin
  alter table public.sponsor_clicks add constraint sponsor_clicks_no_player_chk check (user_id is null) not valid;
exception when duplicate_object then null; end $$;

-- Read-only report links for a sponsor (token stored as a hash only).
create table if not exists public.sponsor_report_tokens (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid not null references public.sponsors(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.sponsor_report_tokens enable row level security;

-- Atomic counter bump for the stats table (service role only).
create or replace function public.sponsor_stats_bump(p_placement uuid, p_day date, p_impressions int, p_unique int, p_clicks int, p_entries int, p_outbound int)
returns void language sql security definer set search_path = public as $$
  insert into sponsor_stats_daily (placement_id, day, impressions, unique_viewers, clicks, entries, outbound_clicks)
  values (p_placement, p_day, greatest(p_impressions,0), greatest(p_unique,0), greatest(p_clicks,0), greatest(p_entries,0), greatest(p_outbound,0))
  on conflict (placement_id, day) do update set
    impressions = sponsor_stats_daily.impressions + excluded.impressions,
    unique_viewers = sponsor_stats_daily.unique_viewers + excluded.unique_viewers,
    clicks = sponsor_stats_daily.clicks + excluded.clicks,
    entries = sponsor_stats_daily.entries + excluded.entries,
    outbound_clicks = sponsor_stats_daily.outbound_clicks + excluded.outbound_clicks;
$$;
revoke execute on function public.sponsor_stats_bump(uuid, date, int, int, int, int, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Settings
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('liveFeed.ready', 'false'::jsonb),
  ('sponsors.enabled', 'true'::jsonb),
  ('waitlist.showCountFrom', '50'::jsonb),
  ('lobbyStrip.maxTiles', '6'::jsonb)
on conflict (key) do nothing;
