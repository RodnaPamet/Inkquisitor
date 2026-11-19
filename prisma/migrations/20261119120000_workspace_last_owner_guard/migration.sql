-- Phase 0.H (issue #11) — a workspace always keeps an OWNER, held by the
-- database as well as the usecase.
--
-- `src/app-layer/usecases/members.ts` refuses to demote or remove the last
-- OWNER, counting after `pg_advisory_xact_lock(hashtext('workspace-owner:' ||
-- workspaceId))`. That is the only layer there was: a raw `deleteMany`, a
-- script, or a future code path that forgets the check could leave a workspace
-- nobody can administer. This trigger is the backstop.
--
-- WHAT IT REFUSES. An UPDATE that moves an OWNER membership out of OWNER (or
-- to another workspace), and a DELETE of an OWNER membership, when no OTHER
-- OWNER of that workspace would remain. SQLSTATE P0001, message prefix
-- `LAST_OWNER_GUARD`. Every other membership write returns before the lock.
--
-- WHAT IT LETS THROUGH. The workspace's own deletion: `ON DELETE CASCADE`
-- deletes its memberships after the workspace row, so by the time this
-- trigger runs for them the workspace no longer exists, and an ownerless
-- workspace that does not exist is the intended end state. (A user's deletion
-- is NOT exempt: deleting the last OWNER's account must deal with the
-- workspace first.)
--
-- SERIALISED, THE USECASE'S WAY. Before counting, the function takes the SAME
-- transaction-scoped advisory lock key as the usecase, so the two layers queue
-- on one lock (advisory locks stack within a transaction, so the usecase's own
-- writes re-enter it for free). Under READ COMMITTED two owners demoting each
-- other at once would otherwise each count the other as still an owner and
-- both commit. The COUNT reads a fresh snapshot only because a VOLATILE
-- PL/pgSQL function takes one per statement, after the lock returned: keep
-- this function VOLATILE (the default). A STABLE function would reuse the
-- calling statement's snapshot and the lock would be decorative.
--
-- UNDER REPEATABLE READ AND SERIALIZABLE the fresh snapshot is not there to
-- take: the whole transaction reads the snapshot of its first statement,
-- taken BEFORE the lock was granted, so the plain count saw an owner another
-- transaction had already demoted and committed, and both demotions committed
-- (Phase 0.H review). At those levels the count locks the rows it counts
-- (`FOR UPDATE`): a row changed by a transaction that committed after this
-- snapshot raises SQLSTATE 40001 instead of being counted. The plain count
-- stays for READ COMMITTED, where `FOR UPDATE` would add nothing the lock and
-- fresh snapshot do not, and would let two raw deletes that each hold their
-- own row deadlock on each other's.
--
-- RLS. The function runs with the caller's rights. Under app_user the caller
-- can only reach memberships of the workspace its context names, and every
-- other membership of that workspace is visible to it too, so the count is
-- the workspace's whole count. The migration owner sees every row.
--
-- Adapted from inflect-compliance's `check_not_last_owner` /
-- `tenant_membership_last_owner_guard` (20260424220000, 20261112160000):
-- no ACTIVE status (Inkquisitor memberships have none), the soft-delete
-- exemption replaced by the cascade one.

CREATE OR REPLACE FUNCTION workspace_membership_not_last_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    owner_count INT;
BEGIN
    IF OLD."role" <> 'OWNER' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."role" = 'OWNER' AND NEW."workspaceId" = OLD."workspaceId" THEN
        RETURN NEW;
    END IF;

    -- The workspace's own cascade: it is already gone.
    IF NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = OLD."workspaceId") THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    -- Queue behind every other owner change in this workspace (the usecase's key).
    PERFORM pg_advisory_xact_lock(hashtext('workspace-owner:' || OLD."workspaceId"));

    IF current_setting('transaction_isolation') = 'read committed' THEN
        SELECT COUNT(*) INTO owner_count
          FROM "WorkspaceMembership"
         WHERE "workspaceId" = OLD."workspaceId"
           AND "role" = 'OWNER'
           AND "id" <> OLD."id";
    ELSE
        -- REPEATABLE READ / SERIALIZABLE: the snapshot predates the lock, so
        -- lock the rows counted. One a concurrent transaction changed and
        -- committed since the snapshot raises 40001 (could not serialize)
        -- rather than being counted as it was.
        SELECT COUNT(*) INTO owner_count
          FROM (SELECT 1
                  FROM "WorkspaceMembership"
                 WHERE "workspaceId" = OLD."workspaceId"
                   AND "role" = 'OWNER'
                   AND "id" <> OLD."id"
                   FOR UPDATE) AS other_owners;
    END IF;

    IF owner_count < 1 THEN
        RAISE EXCEPTION 'LAST_OWNER_GUARD: workspace % would have no OWNER', OLD."workspaceId"
            USING ERRCODE = 'P0001';
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS workspace_membership_last_owner_guard ON "WorkspaceMembership";
CREATE TRIGGER workspace_membership_last_owner_guard
    BEFORE UPDATE OR DELETE ON "WorkspaceMembership"
    FOR EACH ROW EXECUTE FUNCTION workspace_membership_not_last_owner();
