-- Migration 003 — email/password authentication.
--
-- Replaces the earlier plan to delegate identity to Databricks SSO. Because Aiper now owns
-- credentials, it also owns the Part 11 §11.300 controls that an identity provider would
-- otherwise have supplied: password aging (§11.300(b)), lockout and unauthorised-attempt
-- detection (§11.300(d)), and uniqueness that is never reused (§11.300(a), §11.100(a)).

BEGIN;

ALTER TABLE users
  ADD COLUMN password_hash        text,
  -- Drives aging: 11.300(b) requires ids/passwords be periodically checked or revised.
  ADD COLUMN password_updated_at  timestamptz,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  -- Lockout state, 11.300(d).
  ADD COLUMN failed_login_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until         timestamptz;

-- databricks_user_id is no longer how people sign in; keep the column for a future SSO
-- migration but stop requiring it.
ALTER TABLE users ALTER COLUMN databricks_user_id DROP NOT NULL;

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Only the hash is stored; a leaked database must not yield usable session tokens.
  token_hash    text UNIQUE NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Every attempt, successful or not, so repeated failures against an account are visible.
-- 11.300(d) requires attempted unauthorised use to be detected and reported.
CREATE TABLE login_attempts (
  id           bigserial PRIMARY KEY,
  email        text NOT NULL,
  user_id      uuid REFERENCES users(id),
  succeeded    boolean NOT NULL,
  reason       text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts (email, attempted_at DESC);

COMMIT;
