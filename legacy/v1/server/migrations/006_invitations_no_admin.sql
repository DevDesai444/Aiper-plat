-- Migration 006 — invite by email, and remove the admin concept.
--
-- Two changes, both simplifications:
--
-- 1. You invite an EMAIL, not an account. The person may never have opened Aiper. The
--    invitation sits pending and is claimed automatically the first time someone signs in
--    with that address, so the inviter never has to know or care whether they had an account.
--
-- 2. There is no global administrator. A project belongs to whoever created it, and access is
--    only ever what an owner granted. Nobody sees a project because of a role.
--
--    Worth stating plainly: this also means that if the sole owner of a project leaves the
--    company, nobody can reach that project any more. There is deliberately no override.
--    Adding a second owner is the only recovery path.

BEGIN;

CREATE TABLE folder_invitations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id  uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  -- Stored lowercase; the person may not exist as a user yet.
  email      text NOT NULL,
  access     aiper_access NOT NULL,
  invited_by uuid NOT NULL REFERENCES users(id),
  invited_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by uuid REFERENCES users(id),
  UNIQUE (folder_id, email)
);
CREATE INDEX folder_invitations_email_idx ON folder_invitations (email) WHERE claimed_at IS NULL;

-- Access resolution without the admin short-circuit: only explicit grants, inherited down
-- the folder chain.
CREATE OR REPLACE FUNCTION aiper_effective_access(p_user uuid, p_folder uuid)
RETURNS aiper_access AS $$
DECLARE
  v_current uuid := p_folder;
  v_access  aiper_access;
BEGIN
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

/**
 * Turn any pending invitations for this address into real access. Called on every sign-in,
 * so an invitation sent before the person ever used Aiper just works when they arrive.
 */
CREATE OR REPLACE FUNCTION aiper_claim_invitations(p_user uuid, p_email text)
RETURNS integer AS $$
DECLARE
  v_count integer := 0;
BEGIN
  INSERT INTO folder_permissions (folder_id, user_id, access, granted_by)
  SELECT i.folder_id, p_user, i.access, i.invited_by
    FROM folder_invitations i
   WHERE lower(i.email) = lower(p_email) AND i.claimed_at IS NULL
  ON CONFLICT (folder_id, user_id) DO UPDATE SET access = EXCLUDED.access;

  UPDATE folder_invitations
     SET claimed_at = now(), claimed_by = p_user
   WHERE lower(email) = lower(p_email) AND claimed_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMIT;
