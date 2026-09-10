-- Migration 006: E2's domain columns on E1's projects / folders / documents
-- stubs, plus the folder self-parent CHECK.
--
-- Sits on top of E1's 001..005:
--   001_users.sql
--   002_organizations.sql        (+ org_members + aiper_org_role enum)
--   003_hierarchy.sql            (STUBS for projects / folders / documents:
--                                 minimum columns for FK correctness only)
--   004_access_grants.sql        (access_grants + aiper_role + aiper_subject
--                                 enums + aiper_effective_access resolver
--                                 + aiper_creator_auto_owns trigger already
--                                 attached to all three tables)
--   005_audit_log.sql            (E1's PR-4 — append-only audit_log with
--                                 truncate triggers; unrelated to this file)
--
-- This file ALTERs those stubs to add the columns @aiper/shared's Project,
-- Folder, and Document interfaces expect (packages/aiper-shared/src/types/
-- hierarchy.ts). It does NOT create any tables and does NOT attach any
-- triggers — E1 already handled both.
--
-- Reconciled against E1's actual PR-3:
--   - Postgres via `CREATE EXTENSION pgcrypto` (PG 13+); gen_random_uuid()
--     is available and we use it below where E1 also does.
--   - Migration runner (apps/server/src/db/migrate.ts) wraps each file in
--     one BEGIN/COMMIT — no explicit BEGIN here, and no IF NOT EXISTS
--     (matches E1's style throughout 001..004).
--   - aiper_subject enum literals are 'project' | 'folder' | 'document'.
--   - aiper_role enum has 'owner' among its literals; E1's
--     aiper_creator_auto_owns is already attached to these three tables
--     and does not need any second trigger from us.

-- ---------------------------------------------------------------------------
-- projects: description, updated_at (defaulted), archived_at (nullable).
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN description TEXT,
  ADD COLUMN updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN archived_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- folders: same lifecycle columns, plus the self-parent CHECK the schema
-- design called for. Deeper cycle detection stays in the create route
-- (recursive-CTE trigger per insert is too expensive for what is otherwise
-- a "did the caller pass a nonsense value" guard).
-- ---------------------------------------------------------------------------
ALTER TABLE folders
  ADD COLUMN updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN archived_at TIMESTAMPTZ;

ALTER TABLE folders
  ADD CONSTRAINT folders_no_self_parent
    CHECK (parent_folder_id IS NULL OR parent_folder_id <> id);

-- ---------------------------------------------------------------------------
-- documents: kind (TEXT + CHECK, default 'authored' so E1's stub rows keep
-- validating), current_snapshot_id (UUID, no FK — E3 owns the snapshots
-- table and adds the FK in a follow-up), updated_at, archived_at.
-- ---------------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN kind                TEXT        NOT NULL DEFAULT 'authored'
                                   CHECK (kind IN ('authored','technical-sheet','template')),
  ADD COLUMN current_snapshot_id UUID,
  ADD COLUMN updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN archived_at         TIMESTAMPTZ;
