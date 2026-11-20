-- Phase 2.6 — the research agent (decision D9): a research brief, its
-- background runs, their findings and citations, and the bible changes the
-- findings support, which the author reviews.
--
--   ResearchBrief            the author's question, purpose, scope, URLs and
--                            depth; text encrypted by the application.
--   ResearchSource           a file the author attached, kept as its text
--                            (encrypted), never as a file.
--   ResearchRun              one run of a brief: a background job; status,
--                            outcome, caps, spend, progress and counts only.
--   ResearchFinding          a claim and its summary (encrypted).
--   ResearchCitation         the quoted span a finding rests on, in a fetched
--                            page or an attached file (encrypted).
--   ResearchProposal         a proposed field change or new element, with the
--                            agent's rationale (encrypted).
--   ResearchProposalFinding  the findings a proposal cites (rule 2).
--   BibleEntryVersion        gains `sourceFindingIds` and
--                            `sourceResearchProposalId`: what a RESEARCH
--                            version (a new value of `BibleVersionSource`) is
--                            drawn from (rule 1), written at insert.
--   AiCallLog                gains the billed web search and fetch counts of a
--                            research gather turn, the output mode
--                            `server_tools` and the error code
--                            TOOL_USE_REFUSED.
--
-- The enums, tables, indexes and foreign keys are what `prisma migrate diff`
-- generates from prisma/schema/; the CHECKs, the triggers, the grants and the
-- row-level security are appended by hand below.
--
-- ROLLING-DEPLOY SAFETY. Forward-only and additive: new enums and tables the
-- previous image never reads; a new enum value the previous image never
-- writes (`ALTER TYPE … ADD VALUE` cannot be used in the transaction that adds
-- it, so every comparison below with 'RESEARCH' is made on `source::text`);
-- columns with defaults, whose CHECKs the previous image always satisfies.
-- Widened CHECKs are dropped and re-added in this migration's transaction;
-- every existing row satisfies the wider list.


-- CreateEnum
CREATE TYPE "ResearchDepth" AS ENUM ('QUICK', 'STANDARD', 'THOROUGH');

-- CreateEnum
CREATE TYPE "ResearchBriefStatus" AS ENUM ('READY', 'QUEUED', 'RUNNING', 'DONE', 'FAILED', 'REFUSED');

-- CreateEnum
CREATE TYPE "ResearchRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'REFUSED');

-- CreateEnum
CREATE TYPE "ResearchConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ResearchCitationKind" AS ENUM ('URL', 'UPLOAD');

-- CreateEnum
CREATE TYPE "ResearchProposalOperation" AS ENUM ('ADD', 'UPDATE', 'NEW_ELEMENT');

-- AlterEnum
ALTER TYPE "BibleVersionSource" ADD VALUE 'RESEARCH';

-- AlterTable
ALTER TABLE "AiCallLog" ADD COLUMN     "webFetchRequests" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "webSearchRequests" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BibleEntryVersion" ADD COLUMN     "sourceFindingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sourceResearchProposalId" TEXT;

-- CreateTable
CREATE TABLE "ResearchBrief" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "scopeElementIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceUrls" TEXT,
    "depth" "ResearchDepth" NOT NULL,
    "status" "ResearchBriefStatus" NOT NULL DEFAULT 'READY',
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "status" "ResearchRunStatus" NOT NULL DEFAULT 'QUEUED',
    "outcome" TEXT,
    "depth" "ResearchDepth" NOT NULL,
    "budget" JSONB NOT NULL,
    "spentMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "progress" JSONB,
    "metrics" JSONB,
    "promptVersion" TEXT NOT NULL,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchFinding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "claim" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "confidence" "ResearchConfidence" NOT NULL,
    "noFitReason" TEXT,
    "keptElementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchCitation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "kind" "ResearchCitationKind" NOT NULL,
    "url" TEXT,
    "sourceId" TEXT,
    "title" TEXT,
    "quotedSpan" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchProposal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "operation" "ResearchProposalOperation" NOT NULL,
    "elementId" TEXT,
    "fieldKey" TEXT,
    "proposedValue" TEXT,
    "baseVersion" INTEGER,
    "newKind" "BibleElementKind",
    "newName" TEXT,
    "newSummary" TEXT,
    "rationale" TEXT NOT NULL,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "EnrichmentProposalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "versionId" TEXT,
    "createdElementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchProposalFinding" (
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,

    CONSTRAINT "ResearchProposalFinding_pkey" PRIMARY KEY ("proposalId","findingId")
);

-- CreateIndex
CREATE INDEX "ResearchBrief_workspaceId_bookId_createdAt_idx" ON "ResearchBrief"("workspaceId", "bookId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchBrief_requestedById_idx" ON "ResearchBrief"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchBrief_workspaceId_id_key" ON "ResearchBrief"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ResearchSource_workspaceId_briefId_idx" ON "ResearchSource"("workspaceId", "briefId");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchSource_workspaceId_id_key" ON "ResearchSource"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ResearchRun_workspaceId_briefId_createdAt_idx" ON "ResearchRun"("workspaceId", "briefId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchRun_workspaceId_bookId_status_idx" ON "ResearchRun"("workspaceId", "bookId", "status");

-- CreateIndex
CREATE INDEX "ResearchRun_requestedById_idx" ON "ResearchRun"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchRun_workspaceId_id_key" ON "ResearchRun"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ResearchFinding_workspaceId_runId_position_idx" ON "ResearchFinding"("workspaceId", "runId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchFinding_workspaceId_runId_id_key" ON "ResearchFinding"("workspaceId", "runId", "id");

-- CreateIndex
CREATE INDEX "ResearchCitation_workspaceId_runId_findingId_idx" ON "ResearchCitation"("workspaceId", "runId", "findingId");

-- CreateIndex
CREATE INDEX "ResearchCitation_sourceId_idx" ON "ResearchCitation"("sourceId");

-- CreateIndex
CREATE INDEX "ResearchProposal_workspaceId_runId_createdAt_idx" ON "ResearchProposal"("workspaceId", "runId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchProposal_workspaceId_bookId_status_idx" ON "ResearchProposal"("workspaceId", "bookId", "status");

-- CreateIndex
CREATE INDEX "ResearchProposal_elementId_fieldKey_idx" ON "ResearchProposal"("elementId", "fieldKey");

-- CreateIndex
CREATE INDEX "ResearchProposal_decidedById_idx" ON "ResearchProposal"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchProposal_workspaceId_runId_id_key" ON "ResearchProposal"("workspaceId", "runId", "id");

-- CreateIndex
CREATE INDEX "ResearchProposalFinding_workspaceId_runId_findingId_idx" ON "ResearchProposalFinding"("workspaceId", "runId", "findingId");

-- AddForeignKey
ALTER TABLE "ResearchBrief" ADD CONSTRAINT "ResearchBrief_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchBrief" ADD CONSTRAINT "ResearchBrief_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_workspaceId_briefId_fkey" FOREIGN KEY ("workspaceId", "briefId") REFERENCES "ResearchBrief"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_workspaceId_briefId_fkey" FOREIGN KEY ("workspaceId", "briefId") REFERENCES "ResearchBrief"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchFinding" ADD CONSTRAINT "ResearchFinding_workspaceId_runId_fkey" FOREIGN KEY ("workspaceId", "runId") REFERENCES "ResearchRun"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchCitation" ADD CONSTRAINT "ResearchCitation_workspaceId_runId_findingId_fkey" FOREIGN KEY ("workspaceId", "runId", "findingId") REFERENCES "ResearchFinding"("workspaceId", "runId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchCitation" ADD CONSTRAINT "ResearchCitation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ResearchSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchProposal" ADD CONSTRAINT "ResearchProposal_workspaceId_runId_fkey" FOREIGN KEY ("workspaceId", "runId") REFERENCES "ResearchRun"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchProposal" ADD CONSTRAINT "ResearchProposal_elementId_fkey" FOREIGN KEY ("elementId") REFERENCES "BibleElement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchProposal" ADD CONSTRAINT "ResearchProposal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchProposalFinding" ADD CONSTRAINT "ResearchProposalFinding_workspaceId_runId_proposalId_fkey" FOREIGN KEY ("workspaceId", "runId", "proposalId") REFERENCES "ResearchProposal"("workspaceId", "runId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchProposalFinding" ADD CONSTRAINT "ResearchProposalFinding_workspaceId_runId_findingId_fkey" FOREIGN KEY ("workspaceId", "runId", "findingId") REFERENCES "ResearchFinding"("workspaceId", "runId", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: every research table is workspace-scoped
-- ═══════════════════════════════════════════════════════════════════
--
-- The same set as every scoped table (docs/rls-workspace-isolation.md).

ALTER TABLE "ResearchBrief" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResearchBrief" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ResearchBrief";
CREATE POLICY workspace_isolation ON "ResearchBrief"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ResearchBrief";
CREATE POLICY superuser_bypass ON "ResearchBrief"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ResearchSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResearchSource" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ResearchSource";
CREATE POLICY workspace_isolation ON "ResearchSource"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ResearchSource";
CREATE POLICY superuser_bypass ON "ResearchSource"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ResearchRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResearchRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ResearchRun";
CREATE POLICY workspace_isolation ON "ResearchRun"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ResearchRun";
CREATE POLICY superuser_bypass ON "ResearchRun"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ResearchFinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResearchFinding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ResearchFinding";
CREATE POLICY workspace_isolation ON "ResearchFinding"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ResearchFinding";
CREATE POLICY superuser_bypass ON "ResearchFinding"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ResearchCitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResearchCitation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ResearchCitation";
CREATE POLICY workspace_isolation ON "ResearchCitation"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ResearchCitation";
CREATE POLICY superuser_bypass ON "ResearchCitation"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ResearchProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResearchProposal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ResearchProposal";
CREATE POLICY workspace_isolation ON "ResearchProposal"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ResearchProposal";
CREATE POLICY superuser_bypass ON "ResearchProposal"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ResearchProposalFinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResearchProposalFinding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ResearchProposalFinding";
CREATE POLICY workspace_isolation ON "ResearchProposalFinding"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ResearchProposalFinding";
CREATE POLICY superuser_bypass ON "ResearchProposalFinding"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- The model layer's ledger: a research gather turn
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "AiCallLog" DROP CONSTRAINT "AiCallLog_outputMode_known";
ALTER TABLE "AiCallLog" DROP CONSTRAINT "AiCallLog_errorCode_known";

ALTER TABLE "AiCallLog"
    ADD CONSTRAINT "AiCallLog_outputMode_known" CHECK ("outputMode" IS NULL OR "outputMode" IN ('json_schema', 'single_tool', 'server_tools')),
    ADD CONSTRAINT "AiCallLog_web_tool_counts" CHECK (
        "webSearchRequests" >= 0 AND "webFetchRequests" >= 0
        AND ("outputMode" = 'server_tools' OR ("webSearchRequests" = 0 AND "webFetchRequests" = 0))
    ),
    -- AI_ERROR_CODES in src/lib/ai/errors.ts; a new code widens this list in a migration.
    ADD CONSTRAINT "AiCallLog_errorCode_known" CHECK ("errorCode" IS NULL OR "errorCode" IN (
        'AI_DISABLED', 'CREDENTIAL_NOT_CONFIGURED', 'SDK_AMBIENT_HEADERS_SET', 'ZDR_NOT_CONFIRMED',
        'RETENTION_MODE_UNDECLARED',
        'PROVIDER_HTTP_ERROR', 'PROVIDER_CONNECTION', 'REQUEST_REFUSED', 'MODEL_REFUSED', 'INTERNAL_ERROR',
        'INVALID_AFTER_REPAIR', 'TRUNCATED', 'NO_OUTPUT',
        'GUARD_BLOCKED_INPUT', 'GUARD_BLOCKED_OUTPUT', 'GUARD_UNAVAILABLE', 'TOOL_USE_REFUSED',
        'SPEND_CEILING', 'DEADLINE', 'CALLER_ABORT'
    ));

-- ═══════════════════════════════════════════════════════════════════
-- A RESEARCH version names the findings it is drawn from (rule 1)
-- ═══════════════════════════════════════════════════════════════════
--
-- Exactly a RESEARCH version names findings; only a RESEARCH version names
-- a research proposal (a finding kept as a research note names none). The
-- INTERVIEW check of 2.5 stands unchanged: a RESEARCH version names no answer.

ALTER TABLE "BibleEntryVersion" ADD CONSTRAINT "BibleEntryVersion_research_names_findings"
    CHECK (
        ("source"::text = 'RESEARCH') = (cardinality(coalesce("sourceFindingIds", ARRAY[]::text[])) > 0)
        AND ("sourceResearchProposalId" IS NULL OR "source"::text = 'RESEARCH')
    );

-- ═══════════════════════════════════════════════════════════════════
-- Shape the database holds whoever writes
-- ═══════════════════════════════════════════════════════════════════

-- A run's outcome is a code from the closed list (src/lib/research/vocabulary.ts,
-- RESEARCH_OUTCOMES), set exactly when the run has ended.
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_outcome_known"
    CHECK ("outcome" IS NULL OR "outcome" IN (
        'OK', 'NO_SOURCES', 'NO_FINDINGS', 'ALL_REFUSED', 'BUDGET_SPENT',
        'GUARD_REFUSED', 'QUERY_REFUSED', 'TIMEOUT', 'ABORTED', 'PROVIDER_FAILURE', 'INVALID_OUTPUT',
        'KILL_SWITCH', 'WORKSPACE_CEILING', 'PROMPT_INVALID', 'CLAIM_EXPIRED', 'INTERNAL',
        'AI_UNAVAILABLE', 'RESEARCH_NOT_EVALUATED', 'BRIEF_QUOTES_BIBLE', 'REQUESTER_NOT_PERMITTED'));
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_outcome_with_status"
    CHECK (("status" IN ('QUEUED', 'RUNNING')) = ("outcome" IS NULL)
       AND ("status" IN ('QUEUED', 'RUNNING')) = ("finishedAt" IS NULL)
       AND ("status" <> 'QUEUED' OR "startedAt" IS NULL)
       AND ("status" <> 'DONE' OR "outcome" IN ('OK', 'NO_SOURCES', 'NO_FINDINGS', 'ALL_REFUSED', 'BUDGET_SPENT'))
       AND ("status" <> 'REFUSED' OR "outcome" IN ('AI_UNAVAILABLE', 'RESEARCH_NOT_EVALUATED', 'BRIEF_QUOTES_BIBLE', 'REQUESTER_NOT_PERMITTED')));
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_spent_nonnegative" CHECK ("spentMicroUsd" >= 0);
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_promptVersion_shape"
    CHECK (char_length("promptVersion") BETWEEN 1 AND 128 AND "promptVersion" ~ '^[A-Za-z0-9._+-]+$');

ALTER TABLE "ResearchBrief" ADD CONSTRAINT "ResearchBrief_scope_bounded" CHECK (cardinality("scopeElementIds") <= 12);
ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_shape"
    CHECK ("byteLength" >= 0 AND "mediaType" IN ('text/plain', 'text/markdown'));
ALTER TABLE "ResearchFinding" ADD CONSTRAINT "ResearchFinding_position_nonnegative" CHECK ("position" >= 0);

-- A URL citation names a URL and no file; an UPLOAD citation the reverse.
ALTER TABLE "ResearchCitation" ADD CONSTRAINT "ResearchCitation_kind_shape"
    CHECK (("kind" = 'URL' AND "url" IS NOT NULL AND "sourceId" IS NULL)
        OR ("kind" = 'UPLOAD' AND "sourceId" IS NOT NULL AND "url" IS NULL AND "retrievedAt" IS NULL));

-- An ADD or UPDATE names an element, a field, a value and the element's
-- version; a NEW_ELEMENT names a kind and a name and none of those.
ALTER TABLE "ResearchProposal" ADD CONSTRAINT "ResearchProposal_operation_shape"
    CHECK (
        ("operation" IN ('ADD', 'UPDATE')
            AND "elementId" IS NOT NULL AND "fieldKey" IS NOT NULL AND "proposedValue" IS NOT NULL AND "baseVersion" IS NOT NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL)
        OR
        ("operation" = 'NEW_ELEMENT'
            AND "elementId" IS NULL AND "fieldKey" IS NULL AND "proposedValue" IS NULL AND "baseVersion" IS NULL
            AND "newKind" IS NOT NULL AND "newName" IS NOT NULL AND "versionId" IS NULL)
    );
ALTER TABLE "ResearchProposal" ADD CONSTRAINT "ResearchProposal_fieldKey_shape"
    CHECK ("fieldKey" IS NULL OR ("fieldKey" ~ '^[a-z][a-z0-9_]*$' AND char_length("fieldKey") <= 64));
ALTER TABLE "ResearchProposal" ADD CONSTRAINT "ResearchProposal_baseVersion_positive"
    CHECK ("baseVersion" IS NULL OR "baseVersion" >= 1);
ALTER TABLE "ResearchProposal" ADD CONSTRAINT "ResearchProposal_flags_known"
    CHECK ("flags" <@ ARRAY['POSSIBLE_INSTRUCTION']::text[]);
ALTER TABLE "ResearchProposal" ADD CONSTRAINT "ResearchProposal_decision_shape"
    CHECK (
        ("status" = 'PENDING') = ("decidedAt" IS NULL)
        AND ("status" <> 'PENDING' OR ("decidedById" IS NULL AND "versionId" IS NULL AND "createdElementId" IS NULL))
        AND ("status" NOT IN ('ACCEPTED', 'EDITED_ACCEPTED')
             OR ("operation" IN ('ADD', 'UPDATE') AND "versionId" IS NOT NULL)
             OR ("operation" = 'NEW_ELEMENT' AND "createdElementId" IS NOT NULL))
        AND ("status" IN ('ACCEPTED', 'EDITED_ACCEPTED') OR ("versionId" IS NULL AND "createdElementId" IS NULL))
    );

-- ═══════════════════════════════════════════════════════════════════
-- A proposal's element is in the proposal's book
-- ═══════════════════════════════════════════════════════════════════
--
-- As 2.5's: the element's foreign key is by id, and this AFTER trigger holds
-- it to the proposal's book (another workspace's element is not visible to it).

CREATE OR REPLACE FUNCTION research_proposal_element_in_book() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NEW."elementId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "BibleElement" WHERE "id" = NEW."elementId" AND "bookId" = NEW."bookId" AND "workspaceId" = NEW."workspaceId"
    ) THEN
        RAISE EXCEPTION 'RESEARCH_ELEMENT_NOT_IN_BOOK: a proposal names an element outside its book'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_proposal_element_in_book ON "ResearchProposal";
CREATE TRIGGER research_proposal_element_in_book
    AFTER INSERT OR UPDATE OF "elementId", "bookId" ON "ResearchProposal"
    FOR EACH ROW EXECUTE FUNCTION research_proposal_element_in_book();

-- ═══════════════════════════════════════════════════════════════════
-- What a run found and proposed is never rewritten
-- ═══════════════════════════════════════════════════════════════════
--
-- A proposal changes only by its one decision, from PENDING (and the
-- clearing of `decidedById` when that person is deleted), as 2.5's. A finding
-- changes only when the author keeps it as a research note (`keptElementId`,
-- once). A citation and a proposal's finding link are never changed. app_user
-- deletes none of them; the brief's (book's, workspace's) cascade does.

REVOKE DELETE, TRUNCATE ON TABLE "ResearchProposal" FROM app_user;
REVOKE DELETE, TRUNCATE ON TABLE "ResearchFinding" FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "ResearchCitation" FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "ResearchProposalFinding" FROM app_user;

CREATE OR REPLACE FUNCTION research_proposal_fixed() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    decision_cols text[] := ARRAY['status', 'decidedById', 'decidedAt', 'versionId', 'createdElementId'];
BEGIN
    IF OLD."status" = 'PENDING'
       AND NEW."status" <> 'PENDING'
       AND (to_jsonb(NEW) - decision_cols) = (to_jsonb(OLD) - decision_cols) THEN
        RETURN NEW;
    END IF;
    IF OLD."decidedById" IS NOT NULL
       AND NEW."decidedById" IS NULL
       AND (to_jsonb(NEW) - 'decidedById') = (to_jsonb(OLD) - 'decidedById')
       AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."decidedById") THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'RESEARCH_PROPOSAL_FIXED: a proposal changes only by its one decision'
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS research_proposal_fixed ON "ResearchProposal";
CREATE TRIGGER research_proposal_fixed
    BEFORE UPDATE ON "ResearchProposal"
    FOR EACH ROW EXECUTE FUNCTION research_proposal_fixed();

CREATE OR REPLACE FUNCTION research_finding_fixed() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF OLD."keptElementId" IS NULL
       AND NEW."keptElementId" IS NOT NULL
       AND (to_jsonb(NEW) - 'keptElementId') = (to_jsonb(OLD) - 'keptElementId') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'RESEARCH_FINDING_FIXED: a finding changes only when it is kept, once'
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS research_finding_fixed ON "ResearchFinding";
CREATE TRIGGER research_finding_fixed
    BEFORE UPDATE ON "ResearchFinding"
    FOR EACH ROW EXECUTE FUNCTION research_finding_fixed();

-- ═══════════════════════════════════════════════════════════════════
-- Rule 2: a finding rests on a citation, a proposal cites a finding
-- ═══════════════════════════════════════════════════════════════════
--
-- Deferred constraint triggers refuse, at commit, a finding stored with no
-- citation and a proposal stored with no finding: the usecase writes each
-- with its links in one transaction, and the database checks the result. The
-- links' composite foreign keys hold them to their own run.

CREATE OR REPLACE FUNCTION research_finding_is_cited() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "ResearchFinding" WHERE "id" = NEW."id")
       AND NOT EXISTS (SELECT 1 FROM "ResearchCitation" WHERE "findingId" = NEW."id") THEN
        RAISE EXCEPTION 'RESEARCH_FINDING_UNCITED: a finding must carry at least one citation'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS research_finding_is_cited ON "ResearchFinding";
CREATE CONSTRAINT TRIGGER research_finding_is_cited
    AFTER INSERT ON "ResearchFinding"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION research_finding_is_cited();

CREATE OR REPLACE FUNCTION research_proposal_cites_a_finding() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "ResearchProposal" WHERE "id" = NEW."id")
       AND NOT EXISTS (SELECT 1 FROM "ResearchProposalFinding" WHERE "proposalId" = NEW."id") THEN
        RAISE EXCEPTION 'RESEARCH_PROPOSAL_CITES_NOTHING: a proposal must cite at least one finding'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS research_proposal_cites_a_finding ON "ResearchProposal";
CREATE CONSTRAINT TRIGGER research_proposal_cites_a_finding
    AFTER INSERT ON "ResearchProposal"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION research_proposal_cites_a_finding();
