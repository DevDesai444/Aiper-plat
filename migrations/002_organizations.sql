-- Migration 002 — organizations and org membership
--
-- Membership grants NO access to a project, folder, or document on its
-- own. An org admin can list project titles for billing/audit but cannot
-- open content without a matching access_grants row (migration 004).

BEGIN;

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE aiper_org_role AS ENUM ('admin', 'member');

CREATE TABLE org_members (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  role       aiper_org_role NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX org_members_user_idx ON org_members (user_id);

COMMIT;
