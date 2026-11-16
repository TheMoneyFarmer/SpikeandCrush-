-- Account recovery (branch auth-recovery).
-- auth_valid_after + auth_keep_session: after a password change or "sign out
-- of all devices", login tokens issued before auth_valid_after are refused
-- unless they belong to auth_keep_session (the device that made the change).
-- password_changed_at: shown in admin and on the account screen.
-- Server only (players already has RLS with no client writes). Safe to re-run.

alter table public.players add column if not exists auth_valid_after timestamptz;
alter table public.players add column if not exists auth_keep_session text;
alter table public.players add column if not exists password_changed_at timestamptz;
