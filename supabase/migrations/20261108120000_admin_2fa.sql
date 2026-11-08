-- Admin two-factor login (authenticator app, TOTP). Replaces the idea of an IP
-- allowlist for an owner who works from many places and machines.
-- Idempotent: safe to run more than once.
alter table public.admin_users add column if not exists totp_secret text;
alter table public.admin_users add column if not exists totp_enabled boolean not null default false;
-- Last accepted 30-second time step: a code can never be used twice.
alter table public.admin_users add column if not exists totp_last_step bigint;

-- The secret is encrypted with a key derived from ADMIN_SECRET, so changing
-- ADMIN_SECRET means running this recovery for each admin too.
-- Lost-phone recovery for an admin (run in the SQL editor, then log in and set up again):
--   update public.admin_users set totp_enabled = false, totp_secret = null where email = '<admin email>';
