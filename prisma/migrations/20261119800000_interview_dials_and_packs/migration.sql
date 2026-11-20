-- Phase 2.3 — the dials and the pack mount system.
--
--   InterviewStopReason          gains PACK_CHANGED: a pack a session pinned
--                                changed since it started.
--   InterviewSession.packPins    the packs a session mounted, pinned when it
--                                starts: WRITTEN ONCE (a trigger refuses any
--                                change after the insert, for every role).
--                                NULL: the session predates pinning (2.2).
--   InterviewSession.personaKeys widened from at most one persona to at most
--                                three, known, no repeats.
--   WorkspaceInterviewDefaults   a workspace's dial defaults, one row.
--   BookInterviewDefaults        a book's dial defaults, one row.
--
-- The enum value, the column, the two tables, their index and foreign keys are
-- what `prisma migrate diff` generates from prisma/schema/; the CHECKs, the
-- trigger and the row-level security are appended by hand below.
--
-- ROLLING-DEPLOY SAFETY. Forward-only and additive: a new enum value (the
-- previous image never writes or reads it — no stopped session carries it
-- until this image pauses one), a nullable column the previous image never
-- selects, two new tables, and a CHECK that only widens.

-- AlterEnum
ALTER TYPE "InterviewStopReason" ADD VALUE 'PACK_CHANGED';

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN     "packPins" JSONB;

-- CreateTable
CREATE TABLE "WorkspaceInterviewDefaults" (
    "workspaceId" TEXT NOT NULL,
    "depth" INTEGER,
    "detail" INTEGER,
    "personaKeys" JSONB,
    "offerRecommended" BOOLEAN,
    "preferChoice" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceInterviewDefaults_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "BookInterviewDefaults" (
    "bookId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "depth" INTEGER,
    "detail" INTEGER,
    "personaKeys" JSONB,
    "offerRecommended" BOOLEAN,
    "preferChoice" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookInterviewDefaults_pkey" PRIMARY KEY ("bookId")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookInterviewDefaults_workspaceId_bookId_key" ON "BookInterviewDefaults"("workspaceId", "bookId");

-- AddForeignKey
ALTER TABLE "WorkspaceInterviewDefaults" ADD CONSTRAINT "WorkspaceInterviewDefaults_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookInterviewDefaults" ADD CONSTRAINT "BookInterviewDefaults_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: both defaults tables are workspace-scoped
-- ═══════════════════════════════════════════════════════════════════
--
-- The same set as every scoped table (docs/rls-workspace-isolation.md).

ALTER TABLE "WorkspaceInterviewDefaults" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceInterviewDefaults" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "WorkspaceInterviewDefaults";
CREATE POLICY workspace_isolation ON "WorkspaceInterviewDefaults"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "WorkspaceInterviewDefaults";
CREATE POLICY superuser_bypass ON "WorkspaceInterviewDefaults"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "BookInterviewDefaults" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookInterviewDefaults" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "BookInterviewDefaults";
CREATE POLICY workspace_isolation ON "BookInterviewDefaults"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "BookInterviewDefaults";
CREATE POLICY superuser_bypass ON "BookInterviewDefaults"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- Shape the database holds whoever writes
-- ═══════════════════════════════════════════════════════════════════
--
-- The persona keys are the closed list of the content formats (1.10); a
-- session and a default name at most three, none twice. CHECK cannot hold a
-- subquery, so "no repeats" is an IMMUTABLE function of the value alone.

CREATE OR REPLACE FUNCTION interview_text_array_distinct(arr text[]) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT cardinality(arr) = (SELECT count(DISTINCT x) FROM unnest(arr) AS x);
$$;

CREATE OR REPLACE FUNCTION interview_persona_list_ok(list jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT jsonb_typeof(list) = 'array'
        AND jsonb_array_length(list) <= 3
        AND list <@ '["gentle-mentor", "ruthless-editor", "socratic", "devils-advocate", "target-reader", "genre-specialist"]'::jsonb
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(list) AS e WHERE jsonb_typeof(e) <> 'string')
        AND jsonb_array_length(list) = (SELECT count(DISTINCT e) FROM jsonb_array_elements(list) AS e);
$$;

-- Phase 2.2 mounted at most one persona; 2.3 widens this to at most three.
ALTER TABLE "InterviewSession" DROP CONSTRAINT "InterviewSession_personas_known";
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_personas_known"
    CHECK (
        cardinality("personaKeys") <= 3
        AND "personaKeys" <@ ARRAY['gentle-mentor', 'ruthless-editor', 'socratic', 'devils-advocate', 'target-reader', 'genre-specialist']::text[]
        AND interview_text_array_distinct("personaKeys")
    );

ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_packPins_is_array"
    CHECK ("packPins" IS NULL OR jsonb_typeof("packPins") = 'array');

ALTER TABLE "WorkspaceInterviewDefaults" ADD CONSTRAINT "WorkspaceInterviewDefaults_dials_bounded"
    CHECK (("depth" IS NULL OR "depth" BETWEEN 1 AND 5) AND ("detail" IS NULL OR "detail" BETWEEN 1 AND 5));
ALTER TABLE "WorkspaceInterviewDefaults" ADD CONSTRAINT "WorkspaceInterviewDefaults_personas_known"
    CHECK ("personaKeys" IS NULL OR interview_persona_list_ok("personaKeys"));

ALTER TABLE "BookInterviewDefaults" ADD CONSTRAINT "BookInterviewDefaults_dials_bounded"
    CHECK (("depth" IS NULL OR "depth" BETWEEN 1 AND 5) AND ("detail" IS NULL OR "detail" BETWEEN 1 AND 5));
ALTER TABLE "BookInterviewDefaults" ADD CONSTRAINT "BookInterviewDefaults_personas_known"
    CHECK ("personaKeys" IS NULL OR interview_persona_list_ok("personaKeys"));

-- ═══════════════════════════════════════════════════════════════════
-- A session's pack pins are written once
-- ═══════════════════════════════════════════════════════════════════
--
-- The pins record what the session was taught: the content hash of every pack
-- it mounted, when it started. A later write could only be a reconstruction,
-- and a reconstructed pin is the thing a pin exists to rule out. The table is
-- updated constantly on the ordinary path (status, rounds, tokens), so a
-- privilege cannot separate this column from the rest of the row: a trigger
-- refuses any change to it, for every role (lifted from inflect-compliance's
-- `workflow_run_mounted_skills_immutable`; see docs/carve-manifest.md).
--
-- Raised at the default SQLSTATE (P0001), so the message, which names the
-- rule, reaches the caller. Keep the function VOLATILE.

CREATE OR REPLACE FUNCTION interview_session_pack_pins_immutable_guard() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NEW."packPins" IS DISTINCT FROM OLD."packPins" THEN
        RAISE EXCEPTION 'PACK_PINS_IMMUTABLE: InterviewSession.packPins is written once, when the session starts.'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS interview_session_pack_pins_immutable ON "InterviewSession";
CREATE TRIGGER interview_session_pack_pins_immutable
    BEFORE UPDATE ON "InterviewSession"
    FOR EACH ROW
    EXECUTE FUNCTION interview_session_pack_pins_immutable_guard();
