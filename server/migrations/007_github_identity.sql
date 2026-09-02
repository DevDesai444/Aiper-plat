-- Migration 007 — GitHub is the identity, and roles are gone.
--
-- Identity
-- --------
-- Aiper no longer issues accounts. You sign in with GitHub; the email GitHub gives us is the
-- identity, and that is what invitations are addressed to. A user row is created on first
-- sign-in rather than by an administrator, which is what makes "add someone by email before
-- they have ever opened Aiper" work end to end.
--
-- 11.100(a) still holds: a user row is never reused or reassigned. github_id is GitHub's
-- immutable numeric id, so renaming a GitHub account does not create a second identity, and
-- somebody taking a freed-up username cannot inherit an existing one.
--
-- Roles
-- -----
-- user_roles and aiper_role are dropped. Nothing reads them any more: what you may do is
-- decided per project by its owners (migration 006), and a global role was the last remaining
-- way to see a project nobody invited you to.

BEGIN;

ALTER TABLE users
  ADD COLUMN github_id    bigint UNIQUE,
  ADD COLUMN github_login text,
  ADD COLUMN avatar_url   text;

-- Password columns stay nullable and unused for GitHub identities; they are kept so existing
-- accounts (and the local sign-in fallback when GitHub is not configured) keep working.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

DROP TABLE IF EXISTS user_roles;
DROP TYPE  IF EXISTS aiper_role;

COMMIT;
