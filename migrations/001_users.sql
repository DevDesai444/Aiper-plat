-- Migration 001 — users
--
-- users.id is the Supabase auth.uid() (a UUID). We do NOT generate it
-- ourselves — the row is inserted lazily on the first authenticated
-- request that presents a JWT whose `sub` is not yet known here. That
-- lets a person be invited by email before they have ever opened Aiper.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id           uuid PRIMARY KEY,          -- = Supabase auth.uid()
  email        text NOT NULL UNIQUE,
  display_name text NOT NULL,
  avatar_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_email_lower_idx ON users (lower(email));

COMMIT;
