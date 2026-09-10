-- Migration 009 — let documents live directly under a project
--
-- Until now every document belonged to a folder (documents.folder_id
-- NOT NULL). Product decision: a project can hold documents directly,
-- without forcing a folder. So a document now has EITHER a folder_id OR
-- a project_id — exactly one, enforced by a CHECK.
--
-- The permission resolver has to learn the new parent edge: a document
-- with folder_id set walks to its folder (unchanged); a document with
-- project_id set walks straight to the project. Everything else about
-- the highest-wins walk stays identical.

BEGIN;

-- folder_id becomes optional; add the project parent.
ALTER TABLE documents ALTER COLUMN folder_id DROP NOT NULL;
ALTER TABLE documents ADD COLUMN project_id uuid REFERENCES projects(id);

-- Exactly one parent. (a IS NULL) <> (b IS NULL) is true iff exactly one
-- of the two is null — i.e. exactly one is set.
ALTER TABLE documents
  ADD CONSTRAINT documents_one_parent_chk
  CHECK ((folder_id IS NULL) <> (project_id IS NULL));

CREATE INDEX documents_project_idx ON documents (project_id);

-- Resolver: reproduce 004's function verbatim except the document branch,
-- which now walks to folder OR project depending on which parent is set.
CREATE OR REPLACE FUNCTION aiper_effective_access(
  p_user_id      uuid,
  p_subject_type aiper_subject,
  p_subject_id   uuid
) RETURNS aiper_role AS $$
DECLARE
  v_type              aiper_subject := p_subject_type;
  v_id                uuid          := p_subject_id;
  v_highest_rank      int           := 0;   -- 0=none, 1=viewer, 2=editor, 3=owner
  v_role              aiper_role;
  v_this_rank         int;
  v_folder_id         uuid;
  v_parent_folder_id  uuid;
  v_project_id        uuid;
BEGIN
  LOOP
    SELECT role INTO v_role
      FROM access_grants
     WHERE principal_type = 'user'
       AND principal_id   = p_user_id::text
       AND subject_type   = v_type
       AND subject_id     = v_id;

    IF v_role IS NOT NULL THEN
      v_this_rank := CASE v_role
                       WHEN 'owner'  THEN 3
                       WHEN 'editor' THEN 2
                       WHEN 'viewer' THEN 1
                     END;
      IF v_this_rank > v_highest_rank THEN
        v_highest_rank := v_this_rank;
      END IF;
    END IF;

    IF v_type = 'document' THEN
      -- A document parents to a folder OR directly to a project.
      SELECT folder_id, project_id
        INTO v_folder_id, v_project_id
        FROM documents WHERE id = v_id;
      IF v_folder_id IS NOT NULL THEN
        v_type := 'folder';
        v_id   := v_folder_id;
      ELSIF v_project_id IS NOT NULL THEN
        v_type := 'project';
        v_id   := v_project_id;
      ELSE
        EXIT;
      END IF;
    ELSIF v_type = 'folder' THEN
      SELECT parent_folder_id, project_id
        INTO v_parent_folder_id, v_project_id
        FROM folders WHERE id = v_id;
      IF v_parent_folder_id IS NOT NULL THEN
        v_id := v_parent_folder_id;
      ELSIF v_project_id IS NOT NULL THEN
        v_type := 'project';
        v_id   := v_project_id;
      ELSE
        EXIT;
      END IF;
    ELSE
      EXIT;
    END IF;
  END LOOP;

  RETURN CASE v_highest_rank
           WHEN 3 THEN 'owner'::aiper_role
           WHEN 2 THEN 'editor'::aiper_role
           WHEN 1 THEN 'viewer'::aiper_role
           ELSE NULL
         END;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
