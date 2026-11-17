-- Leads centre (branch leads-centre): every message from outside lands here,
-- categorised, so nothing lives only in an email. Server and admin only:
-- RLS on, no policies (the anon/authenticated roles can neither read nor write).
-- Safe to re-run.

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source_form text not null,
  category text not null check (category in ('partner_broker','partner_prop_firm','sponsor_brand','advertiser','competition_listing','press_media','support_escalation','player_feedback','bug_report','business_other','waitlist')),
  name text,
  company text,
  role text,
  email text,
  phone text,
  country text,
  website text,
  message text,
  extras jsonb not null default '{}'::jsonb,
  player_id uuid references public.players(id) on delete set null,
  status text not null default 'new' check (status in ('new','contacted','qualified','in_talks','won','lost','spam')),
  owner text,
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  tags text[] not null default '{}',
  last_contact_at timestamptz,
  next_followup_at timestamptz,
  lost_reason text,
  consent_text text,
  consent_at timestamptz,
  ip_hash text,
  read_at timestamptz,
  converted_to jsonb not null default '{}'::jsonb,
  email_status text not null default 'pending' check (email_status in ('pending','sent','failed','skipped'))
);
create index if not exists leads_category_created_idx on public.leads (category, created_at desc);
create index if not exists leads_email_category_idx on public.leads (lower(email), category, created_at desc);
create index if not exists leads_status_idx on public.leads (status);
create index if not exists leads_followup_idx on public.leads (next_followup_at) where next_followup_at is not null;

create table if not exists public.lead_notes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  created_at timestamptz not null default now(),
  author text not null,
  note text not null
);
create index if not exists lead_notes_lead_idx on public.lead_notes (lead_id, created_at);

create table if not exists public.lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  created_at timestamptz not null default now(),
  actor text not null,
  kind text not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists lead_events_lead_idx on public.lead_events (lead_id, created_at);

-- Admin settings for leads: per-category notification routing, reply-time
-- promise, days before a New lead is "stale", captcha switch.
create table if not exists public.lead_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.leads enable row level security;
alter table public.lead_notes enable row level security;
alter table public.lead_events enable row level security;
alter table public.lead_settings enable row level security;
