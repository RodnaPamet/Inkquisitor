-- Phase 4.1, review hardening.
--
-- 1. StoryFactProvenance is append-only for app_user by GRANT as well as by
--    trigger: the trigger refused UPDATE only, and app_user held DELETE and
--    TRUNCATE by the schema's default privileges. Nothing in the product deletes
--    a provenance row; the cascades from a deleted fact or version run as the
--    table's owner and do not need the grant.
-- 2. A fact's `invalidatedByFactId` goes back to NULL only by its foreign key's
--    ON DELETE SET NULL, i.e. only when the newer fact is gone. The trigger
--    allowed any writer to clear it while the newer fact still stood, erasing
--    which fact the author invalidated the older one by. The function is 4.1's,
--    one clause added: a clear is refused while the newer fact exists.

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "StoryFactProvenance" FROM app_user;

CREATE OR REPLACE FUNCTION story_fact_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."sourceId" IS DISTINCT FROM OLD."sourceId"
       OR NEW."chunkId" IS DISTINCT FROM OLD."chunkId" OR NEW."position" IS DISTINCT FROM OLD."position"
       OR NEW."sourceKind" IS DISTINCT FROM OLD."sourceKind" OR NEW."subjectName" IS DISTINCT FROM OLD."subjectName"
       OR NEW."predicate" IS DISTINCT FROM OLD."predicate" OR NEW."objectLiteral" IS DISTINCT FROM OLD."objectLiteral"
       OR NEW."statement" IS DISTINCT FROM OLD."statement" OR NEW."quote" IS DISTINCT FROM OLD."quote"
       OR NEW."quoteStart" IS DISTINCT FROM OLD."quoteStart" OR NEW."quoteEnd" IS DISTINCT FROM OLD."quoteEnd"
       OR NEW."storyTimeFrom" IS DISTINCT FROM OLD."storyTimeFrom" OR NEW."storyTimeTo" IS DISTINCT FROM OLD."storyTimeTo"
       OR NEW."statedAt" IS DISTINCT FROM OLD."statedAt" OR NEW."flags" IS DISTINCT FROM OLD."flags"
       OR NEW."carriedFromFactId" IS DISTINCT FROM OLD."carriedFromFactId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."bookId" IS DISTINCT FROM OLD."bookId" OR NEW."elementId" IS DISTINCT FROM OLD."elementId"
       OR NEW."relationId" IS DISTINCT FROM OLD."relationId" OR NEW."bibleVersionId" IS DISTINCT FROM OLD."bibleVersionId"
       OR NEW."relationVersionId" IS DISTINCT FROM OLD."relationVersionId" OR NEW."automatic" IS DISTINCT FROM OLD."automatic"
       OR NEW."dedupeKey" IS DISTINCT FROM OLD."dedupeKey"
       OR (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt")
       OR (NEW."invalidatedByFactId" IS NOT NULL AND NEW."invalidatedByFactId" IS DISTINCT FROM OLD."invalidatedByFactId" AND OLD."supersededAt" IS NOT NULL)
       OR (NEW."invalidatedByFactId" IS NULL AND OLD."invalidatedByFactId" IS NOT NULL
           AND EXISTS (SELECT 1 FROM "StoryFact" n WHERE n."id" = OLD."invalidatedByFactId"))
       OR (NEW."subjectElementId" IS NOT NULL AND NEW."subjectElementId" IS DISTINCT FROM OLD."subjectElementId")
       OR (NEW."objectElementId" IS NOT NULL AND NEW."objectElementId" IS DISTINCT FROM OLD."objectElementId") THEN
        RAISE EXCEPTION 'STORY_FACT_FIXED: only a fact''s decision may change' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;
