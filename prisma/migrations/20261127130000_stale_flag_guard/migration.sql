-- Phase 4.2 review — StaleFlag holds what the database itself raised; nothing else writes it but its two decisions.
--
-- A flag is RAISED (inserted, or raised again over a cleared or dismissed one) only by the trigger
-- `bible_entry_version_stale_flags`, in a version's transaction; a statement of its own can neither forge one nor move
-- one's ids, citation or versions. What a statement may do is the product's two decisions, each on an OPEN flag with
-- every other column unchanged: DISMISS it (the author, `dismissedAt` and `dismissedById` set) or mark it CLEARED (the
-- nightly sweep, after its entry was saved). Nothing deletes one but a cascade (its element, the element it drew on,
-- its version or its book gone): app_user holds no DELETE, and the trigger refuses any other delete for every role.
--
-- The trigger tells the raise from a statement by `pg_trigger_depth()`: the version trigger's own INSERT … ON CONFLICT
-- runs its row triggers one level down (2), as does a referential action (`dismissedById` set to NULL with its user),
-- while a statement's runs at 1. Keep the function VOLATILE.

REVOKE DELETE, TRUNCATE ON TABLE "StaleFlag" FROM app_user;

CREATE OR REPLACE FUNCTION stale_flag_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM "BibleElement" WHERE "id" = OLD."elementId")
           OR NOT EXISTS (SELECT 1 FROM "BibleElement" WHERE "id" = OLD."upstreamElementId")
           OR NOT EXISTS (SELECT 1 FROM "BibleEntryVersion" WHERE "id" = OLD."upstreamVersionId")
           OR NOT EXISTS (SELECT 1 FROM "Book" WHERE "id" = OLD."bookId") THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'STALE_FLAG_FIXED: a flag goes only with what it names' USING ERRCODE = 'P0001';
    END IF;
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'STALE_FLAG_FIXED: a flag is raised only by a version''s save' USING ERRCODE = 'P0001';
    END IF;
    IF OLD."status" = 'OPEN'
       AND ((NEW."status" = 'DISMISSED' AND NEW."dismissedAt" IS NOT NULL AND NEW."dismissedById" IS NOT NULL)
            OR (NEW."status" = 'CLEARED' AND NEW."dismissedAt" IS NULL AND NEW."dismissedById" IS NULL))
       AND (to_jsonb(NEW) - 'status' - 'dismissedAt' - 'dismissedById') = (to_jsonb(OLD) - 'status' - 'dismissedAt' - 'dismissedById') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'STALE_FLAG_FIXED: only an open flag''s dismissal or clearing may be written' USING ERRCODE = 'P0001';
END
$$;
DROP TRIGGER IF EXISTS stale_flag_guard ON "StaleFlag";
CREATE TRIGGER stale_flag_guard BEFORE INSERT OR UPDATE OR DELETE ON "StaleFlag" FOR EACH ROW EXECUTE FUNCTION stale_flag_guard();
