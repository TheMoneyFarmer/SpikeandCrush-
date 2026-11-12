-- Security checklist item 5: close direct public reads of sponsor and
-- competition config tables.
--
-- These four tables had SELECT policies for the anon and authenticated roles,
-- so anyone holding the public anon key (it is in every browser) could read
-- them straight from Supabase's REST API, bypassing the game server:
--   sponsors              contact_name, contact_email, notes, link_url, utm_*
--   sponsor_placements    cta_url (the outbound destination), created_by
--   competition_templates prize_partner_note, updated_by
--   listing_tiers         price_text
-- The site never reads these tables from the browser: the game server reads
-- them with the service key (which bypasses RLS) and sends only public fields.
-- Dropping the policies leaves RLS on with no policy = no direct client reads.
-- Safe to re-run.

drop policy if exists sponsors_public_read on public.sponsors;
drop policy if exists sponsor_placements_public_read on public.sponsor_placements;
drop policy if exists competition_templates_public_read on public.competition_templates;
drop policy if exists listing_tiers_read on public.listing_tiers;

alter table public.sponsors enable row level security;
alter table public.sponsor_placements enable row level security;
alter table public.competition_templates enable row level security;
alter table public.listing_tiers enable row level security;
