-- Competition rewards (branch competition-rewards): sponsoring partners with
-- encrypted IB-manager contacts, competition winners reviewed by an admin,
-- single-use claim links (hash only), consent records and a status pipeline.
-- Server and admin only: RLS on, no client policies. Safe to re-run.

create table if not exists public.comp_partners (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,
  partner_type text not null check (partner_type in ('broker','prop_firm')),
  -- The partner listing whose encrypted outbound link (with the IB code) the
  -- claim button uses through the opaque /go/ redirect.
  listing_id uuid references public.competitions(id) on delete set null,
  allowed_countries text[] not null default '{}',     -- empty = any not restricted
  restricted_countries text[] not null default '{}',
  claim_steps text,                                   -- shown on the claim page
  name_in_terms boolean not null default false,       -- may the email name them
  contact_enc text,                                   -- encrypted {email, whatsapp, notes} (LISTING_SECRETS_KEY)
  reminder_days int not null default 5 check (reminder_days between 1 and 60)
);

alter table public.competitions add column if not exists partner_id uuid references public.comp_partners(id) on delete set null;
alter table public.competition_templates add column if not exists partner_id uuid references public.comp_partners(id) on delete set null;

create table if not exists public.comp_winners (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  account_id uuid references public.comp_accounts(id) on delete set null,
  player_id uuid references public.players(id) on delete set null,
  rank int not null,
  prize_amount numeric(12,2) not null default 0,
  prize_currency text not null default 'USD',
  prize_text text,
  partner_id uuid references public.comp_partners(id) on delete set null,
  status text not null default 'pending_review' check (status in (
    'pending_review','approved','email_sent','claimed','link_clicked','registered','verified',
    'account_created','prize_requested','prize_credited','closed','declined','ineligible','expired','manual_payout')),
  flags jsonb not null default '[]'::jsonb,
  claim_token_hash text unique,
  claim_expires_at timestamptz,
  claim_used_at timestamptz,
  email_sent_at timestamptz,
  age_confirmed boolean,
  country text,
  consent_text text,
  consent_at timestamptz,
  account_number_enc text,
  prize_requested_at timestamptz,
  click_ip_hash text,
  data_deleted_at timestamptz,
  unique (competition_id, rank)
);
create index if not exists comp_winners_status_idx on public.comp_winners (status, created_at desc);

create table if not exists public.comp_winner_events (
  id uuid primary key default gen_random_uuid(),
  winner_id uuid not null references public.comp_winners(id) on delete cascade,
  created_at timestamptz not null default now(),
  actor text not null,
  kind text not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists comp_winner_events_winner_idx on public.comp_winner_events (winner_id, created_at);

alter table public.comp_partners enable row level security;
alter table public.comp_winners enable row level security;
alter table public.comp_winner_events enable row level security;
