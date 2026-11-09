-- Records which Terms version a player accepted at sign-up. Additive and safe to re-run.
-- Existing players keep null: they get a one-time notice and are never blocked.
alter table public.players add column if not exists terms_version text;
alter table public.players add column if not exists terms_accepted_at timestamptz;
