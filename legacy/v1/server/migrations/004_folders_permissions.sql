-- Migration 004 — folders and per-folder permissions.
--
-- Until now documents were a flat list with a text path, and the only access control was a
-- global role. Real work is organised as folders (a submission, a product, a section) with
-- different people allowed into each, so access is granted on the folder and inherited by
-- everything inside it.
--
-- Resolution order for "can this user do X here":
--   1. Global `admin` role wins outright.
--   2. Otherwise walk up the folder chain and take the NEAREST explicit grant.
--   3. No grant anywhere on the chain means no access — deny by default, which is the right
--      posture for regulated content.

BEGIN;

CREATE TABLE folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  parent_id   uuid REFERENCES folders(id),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  -- Sibling names must be unique so a path reads unambiguously. Postgres treats NULLs as
  -- distinct in a normal unique index, so root folders need their own partial index.
  UNIQUE (parent_id, name)
);
CREATE UNIQUE INDEX folders_root_name_idx ON folders (name) WHERE parent_id IS NULL;

-- viewer: open and read. editor: also check out and save. owner: also manage who has access.
CREATE TYPE aiper_access AS ENUM ('viewer', 'editor', 'owner');

CREATE TABLE folder_permissions (
  folder_id  uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  access     aiper_access NOT NULL,
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (folder_id, user_id)
);
CREATE INDEX folder_permissions_user_idx ON folder_permissions (user_id);

ALTER TABLE documents ADD COLUMN folder_id uuid REFERENCES folders(id);
CREATE INDEX documents_folder_idx ON documents (folder_id);

-- `path` was the document's identity-ish label while everything was flat. Names only need to
-- be unique within their folder now, so drop the global constraint.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_path_key;
CREATE UNIQUE INDEX documents_folder_path_idx ON documents (folder_id, path);

/**
 * Effective access for a user on a folder, honouring inheritance.
 * Returns NULL when the user has no access at all.
 */
CREATE OR REPLACE FUNCTION aiper_effective_access(p_user uuid, p_folder uuid)
RETURNS aiper_access AS $$
DECLARE
  v_current uuid := p_folder;
  v_access  aiper_access;
BEGIN
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_user AND role = 'admin') THEN
    RETURN 'owner';
  END IF;

  WHILE v_current IS NOT NULL LOOP
    SELECT access INTO v_access FROM folder_permissions
     WHERE folder_id = v_current AND user_id = p_user;
    IF v_access IS NOT NULL THEN
      RETURN v_access;
    END IF;
    SELECT parent_id INTO v_current FROM folders WHERE id = v_current;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
