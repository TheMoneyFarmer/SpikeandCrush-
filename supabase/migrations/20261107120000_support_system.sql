-- Support system rebuild: AI agent + human handoff + admin inbox.
-- Idempotent: safe to run any number of times (every object is guarded).
-- All writes happen server-side with the service role; the only RLS policies
-- are read-only ones letting a signed-in player read their OWN conversations
-- and the messages in them that are marked visible_to_user.

-- ---------------------------------------------------------------------------
-- Why a player's match ended (feeds the support assistant's "why did my match
-- end" answers). Written by gameEngine.js: completed | loss_limit | left | disconnect.
alter table public.match_players add column if not exists end_reason text;

-- ---------------------------------------------------------------------------
-- Conversations
create table if not exists public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.players(id) on delete set null,
  guest_token text,              -- SHA-256 of the guest's random browser token, never the token itself
  guest_email text,
  status text not null default 'ai',
  assigned_admin_id uuid references public.admin_users(id) on delete set null,
  assigned_admin_name text,
  channel text not null default 'web',
  topic text,
  priority text not null default 'normal',
  escalation_reason text,
  escalation_summary text,
  csat smallint,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_user_message_at timestamptz,
  escalated_at timestamptz,
  first_human_response_at timestamptz,
  resolved_at timestamptz
);
alter table public.support_conversations add column if not exists assigned_admin_name text;
alter table public.support_conversations add column if not exists escalation_summary text;
alter table public.support_conversations add column if not exists meta jsonb not null default '{}'::jsonb;
alter table public.support_conversations add column if not exists escalated_at timestamptz;
alter table public.support_conversations add column if not exists first_human_response_at timestamptz;

alter table public.support_conversations drop constraint if exists support_conversations_status_check;
alter table public.support_conversations add constraint support_conversations_status_check
  check (status in ('ai', 'waiting_human', 'human', 'resolved', 'closed'));
alter table public.support_conversations drop constraint if exists support_conversations_priority_check;
alter table public.support_conversations add constraint support_conversations_priority_check
  check (priority in ('low', 'normal', 'high', 'urgent'));
alter table public.support_conversations drop constraint if exists support_conversations_owner_check;
alter table public.support_conversations add constraint support_conversations_owner_check
  check (user_id is not null or guest_token is not null);

create index if not exists support_conversations_user_idx on public.support_conversations (user_id, updated_at desc);
create index if not exists support_conversations_guest_idx on public.support_conversations (guest_token, updated_at desc);
create index if not exists support_conversations_status_idx on public.support_conversations (status, updated_at desc);

-- ---------------------------------------------------------------------------
-- Messages
create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  sender_type text not null,
  sender_id uuid,
  sender_name text,
  body text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  visible_to_user boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.support_messages add column if not exists sender_name text;
alter table public.support_messages drop constraint if exists support_messages_sender_type_check;
alter table public.support_messages add constraint support_messages_sender_type_check
  check (sender_type in ('user', 'ai', 'human', 'system', 'note'));
-- Internal notes can never be visible to the user, whatever the caller sends.
alter table public.support_messages drop constraint if exists support_messages_note_hidden_check;
alter table public.support_messages add constraint support_messages_note_hidden_check
  check (sender_type <> 'note' or visible_to_user = false);
create index if not exists support_messages_conv_idx on public.support_messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Tickets: extend the existing table. Old rows keep working: every new column
-- is nullable or defaulted, and the legacy 'in_progress' status stays valid.
alter table public.support_tickets add column if not exists conversation_id uuid references public.support_conversations(id) on delete set null;
alter table public.support_tickets add column if not exists assigned_admin_id uuid references public.admin_users(id) on delete set null;
alter table public.support_tickets add column if not exists priority text not null default 'normal';
alter table public.support_tickets add column if not exists category text not null default 'other';
alter table public.support_tickets add column if not exists guest_email text;
alter table public.support_tickets add column if not exists first_response_at timestamptz;
alter table public.support_tickets add column if not exists updated_at timestamptz not null default now();
alter table public.support_tickets add column if not exists ticket_number bigint generated by default as identity;

alter table public.support_tickets drop constraint if exists support_tickets_status_check;
alter table public.support_tickets add constraint support_tickets_status_check
  check (status in ('open', 'in_progress', 'pending_user', 'pending_admin', 'resolved', 'closed'));
alter table public.support_tickets drop constraint if exists support_tickets_priority_check;
alter table public.support_tickets add constraint support_tickets_priority_check
  check (priority in ('low', 'normal', 'high', 'urgent'));
alter table public.support_tickets drop constraint if exists support_tickets_category_check;
alter table public.support_tickets add constraint support_tickets_category_check
  check (category in ('gameplay_bug', 'match_ended', 'coins_shop', 'competition_result', 'account_login', 'payment', 'report_player', 'sponsor_partner', 'feedback', 'other'));
create unique index if not exists support_tickets_number_idx on public.support_tickets (ticket_number);
create index if not exists support_tickets_conversation_idx on public.support_tickets (conversation_id);

-- ---------------------------------------------------------------------------
-- Knowledge base
create or replace function public.support_tags_text(tags text[])
returns text language sql immutable parallel safe as $$
  select coalesce(array_to_string(tags, ' '), '')
$$;

create table if not exists public.support_kb_articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  title text not null,
  body_md text not null default '',
  category text not null default 'general',
  tags text[] not null default '{}',
  source text not null default 'admin',
  published boolean not null default true,
  needs_review boolean not null default false,
  overrides_slug text,           -- an admin article that replaces a code-generated one
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', public.support_tags_text(tags)), 'B') ||
    setweight(to_tsvector('english', coalesce(body_md, '')), 'C')
  ) stored
);
alter table public.support_kb_articles add column if not exists needs_review boolean not null default false;
alter table public.support_kb_articles add column if not exists overrides_slug text;
alter table public.support_kb_articles drop constraint if exists support_kb_articles_source_check;
alter table public.support_kb_articles add constraint support_kb_articles_source_check
  check (source in ('code', 'admin', 'faq'));
create unique index if not exists support_kb_articles_slug_idx on public.support_kb_articles (slug);
create index if not exists support_kb_articles_search_idx on public.support_kb_articles using gin (search);

-- Full-text retrieval. Tries the strict websearch query first (all terms);
-- when that finds nothing it retries with the same lexemes OR-ed, so natural
-- questions ("why did my match end so early") still reach the right article.
-- A published admin article with overrides_slug hides the code article it replaces.
create or replace function public.support_kb_search(q text, max_results int default 5)
returns table (id uuid, slug text, title text, body_md text, category text, source text, rank real)
language plpgsql stable set search_path = public as $$
declare
  strict_q tsquery := websearch_to_tsquery('english', coalesce(q, ''));
  loose_q tsquery;
begin
  if strict_q::text = '' then return; end if;
  return query
    select a.id, a.slug, a.title, a.body_md, a.category, a.source, ts_rank_cd(a.search, strict_q)::real
    from support_kb_articles a
    where a.published and a.search @@ strict_q
      and not exists (select 1 from support_kb_articles o where o.published and o.overrides_slug = a.slug and o.id <> a.id)
    order by 7 desc, a.source = 'admin' desc
    limit max_results;
  if found then return; end if;
  loose_q := to_tsquery('english', replace(strict_q::text, ' & ', ' | '));
  return query
    select a.id, a.slug, a.title, a.body_md, a.category, a.source, ts_rank_cd(a.search, loose_q)::real
    from support_kb_articles a
    where a.published and a.search @@ loose_q
      and not exists (select 1 from support_kb_articles o where o.published and o.overrides_slug = a.slug and o.id <> a.id)
    order by 7 desc, a.source = 'admin' desc
    limit max_results;
end;
$$;
revoke all on function public.support_kb_search(text, int) from public, anon, authenticated;
grant execute on function public.support_kb_search(text, int) to service_role;

create table if not exists public.support_kb_gaps (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  question_key text not null,    -- normalised form, groups similar questions
  conversation_id uuid references public.support_conversations(id) on delete set null,
  count int not null default 1,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.support_kb_gaps drop constraint if exists support_kb_gaps_status_check;
alter table public.support_kb_gaps add constraint support_kb_gaps_status_check check (status in ('open', 'answered', 'ignored'));
create unique index if not exists support_kb_gaps_key_idx on public.support_kb_gaps (question_key);

-- ---------------------------------------------------------------------------
create table if not exists public.support_feedback (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  rating smallint not null,
  comment text,
  created_at timestamptz not null default now()
);
alter table public.support_feedback drop constraint if exists support_feedback_rating_check;
alter table public.support_feedback add constraint support_feedback_rating_check check (rating in (-1, 1));

create table if not exists public.support_canned_responses (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  category text not null default 'general',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- New admin role: 'support' (reply and resolve only; enforced in admin/server.js).
alter table public.admin_users drop constraint if exists admin_users_role_check;
alter table public.admin_users add constraint admin_users_role_check
  check (role in ('super_admin', 'admin', 'moderator', 'support'));

-- ---------------------------------------------------------------------------
-- RLS
alter table public.support_conversations enable row level security;
alter table public.support_messages enable row level security;
alter table public.support_kb_articles enable row level security;
alter table public.support_kb_gaps enable row level security;
alter table public.support_feedback enable row level security;
alter table public.support_canned_responses enable row level security;

drop policy if exists support_conversations_owner_read on public.support_conversations;
create policy support_conversations_owner_read on public.support_conversations
  for select to authenticated
  using (user_id in (select p.id from public.players p where p.supabase_user_id = auth.uid()));

drop policy if exists support_messages_owner_read on public.support_messages;
create policy support_messages_owner_read on public.support_messages
  for select to authenticated
  using (
    visible_to_user
    and conversation_id in (
      select c.id from public.support_conversations c
      join public.players p on p.id = c.user_id
      where p.supabase_user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Private bucket for one-image attachments (png/jpg/webp, 3 MB). Objects are
-- only ever reached through short-lived signed URLs minted after an ownership check.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('support-attachments', 'support-attachments', false, 3145728, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
