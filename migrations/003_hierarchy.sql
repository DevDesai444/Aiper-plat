-- Migration 003 — projects → folders → documents
--
-- E1 (this PR) creates the tables with the minimum columns the resolver
-- needs to walk the chain: an id, a parent link, and created_by so the
-- creator-auto-owns trigger in migration 004 can find the right user.
--
-- E2 will ALTER these tables in later migrations to add domain columns
-- (project.description, folder.archived_at, document.kind /
-- current_snapshot_id, etc.) as their routes need them. Those additions
-- do NOT change the resolver — it only touches id / parent_folder_id /
-- project_id / folder_id, all frozen here.

BEGIN;

CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id),
  name       text NOT NULL,
  slug       text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE INDEX projects_org_idx ON projects (org_id);

CREATE TABLE folders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  parent_folder_id uuid REFERENCES folders(id),
  name             text NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX folders_project_idx ON folders (project_id);
CREATE INDEX folders_parent_idx  ON folders (parent_folder_id);

CREATE TABLE documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id  uuid NOT NULL REFERENCES folders(id),
  title      text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_folder_idx ON documents (folder_id);

COMMIT;
