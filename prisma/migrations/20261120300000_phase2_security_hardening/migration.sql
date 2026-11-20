-- Phase 2.H, the security and privacy half of Phase 2's hardening.
--
--   1. Money columns are BIGINT (issue #30 item 8).
--   2. A newly set Book."deletedAt" is pinned to the database's clock for
--      app_user (issue #29 item 2).
--   3. One live element per normalised name in a book (issues #39 item 5,
--      #41 item 5).
--   4. AiCallLog's retention: the one delete its append-only trigger admits
--      besides the cascades (issue #30 item 4).
--   5. A fetched page's hash beside its verified spans (issue #41 item 3).

-- ═══════════════════════════════════════════════════════════════════
-- 1. Money columns are BIGINT
-- ═══════════════════════════════════════════════════════════════════
--
-- A micro-dollar INTEGER holds at most about $2,147: one call priced at the
-- dearest rates over a long prompt passes that, and the settlement INSERT
-- would then fail with the call already made and paid for, leaving no
-- record. ALTER … TYPE rewrites the table; it fires no row trigger, so the
-- call log's append-only trigger is not involved.

ALTER TABLE "AiCallLog"
    ALTER COLUMN "costMicroUsd" TYPE BIGINT,
    ALTER COLUMN "worstCaseMicroUsd" TYPE BIGINT;
ALTER TABLE "AiSpendReservation" ALTER COLUMN "amountMicroUsd" TYPE BIGINT;
ALTER TABLE "ResearchRun" ALTER COLUMN "spentMicroUsd" TYPE BIGINT;

-- ═══════════════════════════════════════════════════════════════════
-- 2. A deletion time is the database's, not the caller's
-- ═══════════════════════════════════════════════════════════════════
--
-- `book_delete_only_when_purge_due` lets a book go only 30 days after
-- `deletedAt`. app_user could UPDATE `deletedAt` to any past time and delete
-- the book at once. For app_user (the role every request runs as) a
-- `deletedAt` that is newly set or changed to another non-NULL value is
-- replaced by the current UTC time, so the window always starts when the
-- book was deleted. Clearing it (a restore) is untouched. Every other role
-- (the superuser the tests and the operator connect as, which `superuser_bypass`
-- already trusts) may set any time: that is the fixtures' backdating seam.
-- UTC without a zone, as the purge trigger compares it.

CREATE OR REPLACE FUNCTION book_deleted_at_is_now() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF current_setting('role') <> 'app_user' OR NEW."deletedAt" IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW."deletedAt" IS NOT DISTINCT FROM OLD."deletedAt" THEN
            RETURN NEW;
        END IF;
    END IF;
    NEW."deletedAt" := (now() AT TIME ZONE 'UTC');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS book_deleted_at_is_now ON "Book";
CREATE TRIGGER book_deleted_at_is_now
    BEFORE INSERT OR UPDATE OF "deletedAt" ON "Book"
    FOR EACH ROW EXECUTE FUNCTION book_deleted_at_is_now();

-- ═══════════════════════════════════════════════════════════════════
-- 5. A fetched page's hash beside its verified spans
-- ═══════════════════════════════════════════════════════════════════
--
-- The page text is never stored; its SHA-256 (lower-case hex) is, with each
-- citation of it, so a citation can be proved later against what was fetched
-- (src/lib/research/sources.ts, `citationProvable`). A file's citation
-- carries none (the file's text is stored). Rows written before this
-- migration have none either, so the column is nullable.

ALTER TABLE "ResearchCitation" ADD COLUMN "sourceSha256" TEXT;
ALTER TABLE "ResearchCitation"
    ADD CONSTRAINT "ResearchCitation_sourceSha256_shape" CHECK ("sourceSha256" IS NULL OR "sourceSha256" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "ResearchCitation_sourceSha256_url_only" CHECK ("sourceSha256" IS NULL OR "kind" = 'URL');

-- ═══════════════════════════════════════════════════════════════════
-- 4. AiCallLog's retention
-- ═══════════════════════════════════════════════════════════════════
--
-- The call log stays append-only for every request: app_user can never
-- delete a row. One more DELETE passes, besides the two cascades: by a role
-- other than app_user (the daily `ai-call-log-retention` job runs outside
-- row-level security, on the connection's own role, as `superuser_bypass`
-- trusts it) of a row started more than 365 days ago. 365 is a FLOOR written
-- here, so no configuration can delete a younger record; the job's own
-- retention (AI_CALL_LOG_RETENTION_DAYS, default 400, src/lib/ai/
-- call-log-retention.ts, RETENTION_FLOOR_DAYS equal to this) is at least it.
-- "startedAt" is a timestamp WITHOUT time zone holding UTC, compared as such.

CREATE OR REPLACE FUNCTION ai_call_log_append_only() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = OLD."workspaceId") THEN
            RETURN OLD;
        END IF;
        IF OLD."bookId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Book" WHERE "id" = OLD."bookId") THEN
            RETURN OLD;
        END IF;
        IF current_setting('role') <> 'app_user'
           AND OLD."startedAt" < (now() AT TIME ZONE 'UTC') - interval '365 days' THEN
            RETURN OLD;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD."requestedById" IS NOT NULL
           AND NEW."requestedById" IS NULL
           AND (to_jsonb(NEW) - 'requestedById') = (to_jsonb(OLD) - 'requestedById')
           AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."requestedById") THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'AI_CALL_LOG_APPEND_ONLY: % of AiCallLog refused', TG_OP
        USING ERRCODE = 'P0001';
END;
$$;

CREATE INDEX "AiCallLog_startedAt_idx" ON "AiCallLog"("startedAt");
