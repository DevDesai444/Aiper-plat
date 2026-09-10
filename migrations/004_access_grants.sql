-- Migration 004 — access_grants + aiper_effective_access resolver
--
-- One table of grants across all three subject types (project / folder /
-- document). The resolver walks UP the chain from the requested subject,
-- collecting every grant the user has anywhere on that chain, and returns
-- the HIGHEST role (owner > editor > viewer). No grant anywhere on the
-- chain → null (no access).
--
-- Highest-wins matters for the P1/P2 scenario: if P2 owns a project and
-- P1 (owner of a folder inside it, via creator-auto-owns) grants P2 a
-- lower role on that folder, P2 must still be an owner there via the
-- ancestor grant. A "nearest-wins" resolver would let a folder owner
-- demote a project owner inside their folder, which is not the intended
-- product semantics.

BEGIN;

CREATE TYPE aiper_role    AS ENUM ('viewer', 'editor', 'owner');
CREATE TYPE aiper_subject AS ENUM ('project', 'folder', 'document');

CREATE TABLE access_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type   aiper_subject NOT NULL,
  subject_id     uuid NOT NULL,
  -- 'user'  : principal_id is a users.id (as text)
  -- 'invite': principal_id is a normalized (lowercased) email address that
  --           has not yet signed in; converted to a 'user' grant on their
  --           first sign-in in a later PR
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'invite')),
  principal_id   text NOT NULL,
  role           aiper_role NOT NULL,
  granted_by     uuid NOT NULL REFERENCES users(id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, principal_type, principal_id)
);

CREATE INDEX access_grants_lookup_idx    ON access_grants (subject_type, subject_id, principal_type, principal_id);
CREATE INDEX access_grants_principal_idx ON access_grants (principal_type, principal_id);

/**
 * Highest-role-wins walk from (subject_type, subject_id) up to the root
 * of its chain, collecting every user-grant along the way and returning
 * the maximum role. Chain terminations:
 *   document → its folder
 *   folder   → its parent_folder_id if set, else its project
 *   project  → done
 *
 * STABLE, side-effect-free, safe to call inside SELECT lists.
 */
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
    -- Direct grant on the current subject?
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

    -- Walk to the parent.
    IF v_type = 'document' THEN
      SELECT folder_id INTO v_folder_id FROM documents WHERE id = v_id;
      EXIT WHEN v_folder_id IS NULL;
      v_type := 'folder';
      v_id   := v_folder_id;
    ELSIF v_type = 'folder' THEN
      SELECT parent_folder_id, project_id
        INTO v_parent_folder_id, v_project_id
        FROM folders WHERE id = v_id;
      IF v_parent_folder_id IS NOT NULL THEN
        v_id := v_parent_folder_id;    -- still a folder
      ELSIF v_project_id IS NOT NULL THEN
        v_type := 'project';
        v_id   := v_project_id;
      ELSE
        EXIT;
      END IF;
    ELSE
      -- project: no parent, chain ends
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

/**
 * Creator auto-owns. Whenever a new project / folder / document row lands,
 * the creator gets an owner grant in the SAME transaction — so a fresh
 * subject is always reachable by whoever made it.
 *
 * ON CONFLICT DO NOTHING guards against re-firing during migration replays
 * or manual seed data that already carries a grant.
 */
CREATE OR REPLACE FUNCTION aiper_creator_auto_owns() RETURNS trigger AS $$
BEGIN
  INSERT INTO access_grants (subject_type, subject_id, principal_type, principal_id, role, granted_by)
  VALUES (TG_ARGV[0]::aiper_subject, NEW.id, 'user', NEW.created_by::text, 'owner', NEW.created_by)
  ON CONFLICT (subject_type, subject_id, principal_type, principal_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_creator_auto_owns  AFTER INSERT ON projects  FOR EACH ROW EXECUTE FUNCTION aiper_creator_auto_owns('project');
CREATE TRIGGER folders_creator_auto_owns   AFTER INSERT ON folders   FOR EACH ROW EXECUTE FUNCTION aiper_creator_auto_owns('folder');
CREATE TRIGGER documents_creator_auto_owns AFTER INSERT ON documents FOR EACH ROW EXECUTE FUNCTION aiper_creator_auto_owns('document');

COMMIT;
