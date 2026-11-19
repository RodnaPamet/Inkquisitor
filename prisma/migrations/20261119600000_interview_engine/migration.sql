-- Phase 2.2 — the question engine: InterviewSession, InterviewRound,
-- Question and Answer. The enums, CREATE TABLEs, indexes and foreign keys are
-- what `prisma migrate diff` generates from prisma/schema/interview.prisma
-- and enums.prisma; the row-level security, the CHECK constraints, the
-- append-only trigger on Answer and the two vector-store triggers are
-- appended by hand below.
--
--   InterviewSession  one interview of a book's bible (one element, one kind,
--                     or the whole book), its dials, status and stop reason.
--   InterviewRound    one round: the plan it was asked from (field
--                     references, no text) and its generation metrics.
--   Question          one question of a round (text, options, scale labels,
--                     recommendation, rationale and challenge quote are
--                     encrypted by the field-encryption extension).
--   Answer            what the author did with a question: APPEND-ONLY; a
--                     re-answer is the next revision.

-- CreateEnum
CREATE TYPE "InterviewScope" AS ENUM ('ELEMENT', 'KIND', 'BOOK');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'STOPPED');

-- CreateEnum
CREATE TYPE "InterviewStopReason" AS ENUM ('FRONTIER_EMPTY', 'NOTHING_AT_DEPTH', 'ROUND_BUDGET', 'TOKEN_BUDGET', 'WORKSPACE_CEILING', 'KILL_SWITCH', 'AUTHOR_STOPPED', 'PROVIDER_FAILURE', 'NO_ACCEPTABLE_QUESTION', 'GUARD_REFUSED');

-- CreateEnum
CREATE TYPE "InterviewRoundStatus" AS ENUM ('GENERATING', 'OPEN', 'CLOSED', 'FAILED');

-- CreateEnum
CREATE TYPE "QuestionKind" AS ENUM ('OPEN', 'CHOICE', 'EITHER_OR', 'SCENARIO', 'SCALE');

-- CreateEnum
CREATE TYPE "QuestionMode" AS ENUM ('FRONTIER', 'CHALLENGE');

-- CreateEnum
CREATE TYPE "QuestionOrigin" AS ENUM ('MODEL', 'PACK_FALLBACK');

-- CreateEnum
CREATE TYPE "AnswerStatus" AS ENUM ('ANSWERED', 'SKIPPED', 'DECIDE_LATER');

-- CreateTable
CREATE TABLE "InterviewSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "scope" "InterviewScope" NOT NULL,
    "targetElementId" TEXT,
    "targetKind" "BibleElementKind",
    "depth" INTEGER NOT NULL,
    "detail" INTEGER NOT NULL,
    "personaKeys" TEXT[],
    "offerRecommended" BOOLEAN NOT NULL DEFAULT true,
    "preferChoice" BOOLEAN NOT NULL DEFAULT false,
    "status" "InterviewStatus" NOT NULL DEFAULT 'ACTIVE',
    "stopReason" "InterviewStopReason",
    "stopDetail" JSONB,
    "roundBudget" INTEGER NOT NULL,
    "roundsRun" INTEGER NOT NULL DEFAULT 0,
    "tokenBudget" INTEGER NOT NULL,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "InterviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewRound" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "InterviewRoundStatus" NOT NULL DEFAULT 'GENERATING',
    "plan" JSONB NOT NULL,
    "metrics" JSONB,
    "promptVersion" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "InterviewRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "elementId" TEXT NOT NULL,
    "targetsFieldKeys" TEXT[],
    "mode" "QuestionMode" NOT NULL,
    "origin" "QuestionOrigin" NOT NULL,
    "personaKey" TEXT,
    "kind" "QuestionKind" NOT NULL,
    "text" TEXT NOT NULL,
    "options" TEXT,
    "scaleLabels" TEXT,
    "recommendedAnswer" TEXT,
    "recommendationBasis" JSONB,
    "rationale" TEXT,
    "challengeQuote" TEXT,
    "dependsOnQuestionIds" TEXT[],
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Answer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "AnswerStatus" NOT NULL,
    "text" TEXT,
    "choice" TEXT,
    "scale" INTEGER,
    "acceptedRecommendation" BOOLEAN NOT NULL DEFAULT false,
    "answeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InterviewSession_workspaceId_bookId_createdAt_idx" ON "InterviewSession"("workspaceId", "bookId", "createdAt");

-- CreateIndex
CREATE INDEX "InterviewSession_bookId_targetElementId_idx" ON "InterviewSession"("bookId", "targetElementId");

-- CreateIndex
CREATE INDEX "InterviewSession_createdById_idx" ON "InterviewSession"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewSession_workspaceId_id_key" ON "InterviewSession"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewSession_workspaceId_bookId_id_key" ON "InterviewSession"("workspaceId", "bookId", "id");

-- CreateIndex
CREATE INDEX "InterviewRound_workspaceId_sessionId_idx" ON "InterviewRound"("workspaceId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewRound_sessionId_number_key" ON "InterviewRound"("sessionId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewRound_sessionId_id_key" ON "InterviewRound"("sessionId", "id");

-- CreateIndex
CREATE INDEX "Question_bookId_elementId_createdAt_idx" ON "Question"("bookId", "elementId", "createdAt");

-- CreateIndex
CREATE INDEX "Question_workspaceId_bookId_dedupeKey_idx" ON "Question"("workspaceId", "bookId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Question_roundId_position_key" ON "Question"("roundId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Question_workspaceId_sessionId_id_key" ON "Question"("workspaceId", "sessionId", "id");

-- CreateIndex
CREATE INDEX "Answer_workspaceId_sessionId_questionId_idx" ON "Answer"("workspaceId", "sessionId", "questionId");

-- CreateIndex
CREATE INDEX "Answer_answeredById_idx" ON "Answer"("answeredById");

-- CreateIndex
CREATE UNIQUE INDEX "Answer_questionId_revision_key" ON "Answer"("questionId", "revision");

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_bookId_targetElementId_fkey" FOREIGN KEY ("bookId", "targetElementId") REFERENCES "BibleElement"("bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewRound" ADD CONSTRAINT "InterviewRound_workspaceId_sessionId_fkey" FOREIGN KEY ("workspaceId", "sessionId") REFERENCES "InterviewSession"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_workspaceId_bookId_sessionId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sessionId") REFERENCES "InterviewSession"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_sessionId_roundId_fkey" FOREIGN KEY ("sessionId", "roundId") REFERENCES "InterviewRound"("sessionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_bookId_elementId_fkey" FOREIGN KEY ("bookId", "elementId") REFERENCES "BibleElement"("bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_workspaceId_sessionId_questionId_fkey" FOREIGN KEY ("workspaceId", "sessionId", "questionId") REFERENCES "Question"("workspaceId", "sessionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: every interview table is workspace-scoped
-- ═══════════════════════════════════════════════════════════════════
--
-- The same set as every scoped table (docs/rls-workspace-isolation.md): RLS
-- enabled and FORCED, ONE `workspace_isolation` policy with USING and WITH
-- CHECK on the same predicate, and `superuser_bypass` for every role but
-- app_user. tests/guards/rls-migration-coverage.test.ts compares these
-- statements exactly; tests/integration/rls-coverage.test.ts compares what
-- PostgreSQL stored and proves they isolate. app_user's table grants come from
-- the default privileges the 0.3 migration set.

ALTER TABLE "InterviewSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InterviewSession" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "InterviewSession";
CREATE POLICY workspace_isolation ON "InterviewSession"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "InterviewSession";
CREATE POLICY superuser_bypass ON "InterviewSession"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "InterviewRound" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InterviewRound" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "InterviewRound";
CREATE POLICY workspace_isolation ON "InterviewRound"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "InterviewRound";
CREATE POLICY superuser_bypass ON "InterviewRound"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "Question" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Question" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "Question";
CREATE POLICY workspace_isolation ON "Question"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "Question";
CREATE POLICY superuser_bypass ON "Question"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "Answer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Answer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "Answer";
CREATE POLICY workspace_isolation ON "Answer"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "Answer";
CREATE POLICY superuser_bypass ON "Answer"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- Shape the database holds whoever writes
-- ═══════════════════════════════════════════════════════════════════
--
-- The readable columns only. An encrypted column's stored length is the
-- envelope's, so its bound lives in the usecase (src/lib/interview/).

ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_dials_bounded"
    CHECK ("depth" BETWEEN 1 AND 5 AND "detail" BETWEEN 1 AND 5);
-- Phase 2.2 mounts at most one persona; 2.3 widens this to one to three.
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_personas_known"
    CHECK (
        cardinality("personaKeys") <= 1
        AND "personaKeys" <@ ARRAY['gentle-mentor', 'ruthless-editor', 'socratic', 'devils-advocate', 'target-reader', 'genre-specialist']::text[]
    );
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_target_matches_scope"
    CHECK (
        ("scope" = 'ELEMENT' AND "targetElementId" IS NOT NULL AND "targetKind" IS NULL)
        OR ("scope" = 'KIND' AND "targetElementId" IS NULL AND "targetKind" IS NOT NULL)
        OR ("scope" = 'BOOK' AND "targetElementId" IS NULL AND "targetKind" IS NULL)
    );
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_budgets_bounded"
    CHECK (
        "roundBudget" BETWEEN 1 AND 6
        AND "roundsRun" BETWEEN 0 AND "roundBudget"
        AND "tokenBudget" >= 0
        AND "tokensUsed" >= 0
    );
-- An active session has no stop reason; every other status says why it stopped.
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_stop_reason_iff_stopped"
    CHECK (("status" = 'ACTIVE') = ("stopReason" IS NULL));
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_ended_iff_final"
    CHECK (("status" IN ('COMPLETED', 'STOPPED')) = ("endedAt" IS NOT NULL));

ALTER TABLE "InterviewRound" ADD CONSTRAINT "InterviewRound_number_positive" CHECK ("number" >= 1);
ALTER TABLE "InterviewRound" ADD CONSTRAINT "InterviewRound_closed_iff_closedAt"
    CHECK (("status" = 'CLOSED') = ("closedAt" IS NOT NULL));

ALTER TABLE "Question" ADD CONSTRAINT "Question_position_positive" CHECK ("position" >= 1);
ALTER TABLE "Question" ADD CONSTRAINT "Question_targets_one_or_two"
    CHECK (cardinality("targetsFieldKeys") BETWEEN 1 AND 2);
-- A challenge quotes the stored value it tests; a frontier question quotes nothing.
ALTER TABLE "Question" ADD CONSTRAINT "Question_challenge_quote_iff_challenge"
    CHECK (("mode" = 'CHALLENGE') = ("challengeQuote" IS NOT NULL));
-- A pack fallback is asked as the pack wrote it: no persona, no recommendation.
ALTER TABLE "Question" ADD CONSTRAINT "Question_fallback_plain"
    CHECK ("origin" <> 'PACK_FALLBACK' OR ("personaKey" IS NULL AND "recommendedAnswer" IS NULL AND "mode" = 'FRONTIER'));
ALTER TABLE "Question" ADD CONSTRAINT "Question_dedupeKey_shape" CHECK ("dedupeKey" ~ '^[0-9a-f]{64}$');

ALTER TABLE "Answer" ADD CONSTRAINT "Answer_revision_positive" CHECK ("revision" >= 1);
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_scale_bounded" CHECK ("scale" IS NULL OR "scale" BETWEEN 1 AND 5);
-- An answer carries a value; a skip or a deferral carries none.
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_value_iff_answered"
    CHECK (
        ("status" = 'ANSWERED' AND ("text" IS NOT NULL OR "choice" IS NOT NULL OR "scale" IS NOT NULL))
        OR ("status" <> 'ANSWERED' AND "text" IS NULL AND "choice" IS NULL AND "scale" IS NULL AND NOT "acceptedRecommendation")
    );

-- ═══════════════════════════════════════════════════════════════════
-- Answer is append-only
-- ═══════════════════════════════════════════════════════════════════
--
-- An answer is what the author said, and a later proposal (2.5) cites it by
-- id: it is never edited in place. A re-answer is a NEW row with the next
-- revision, and the latest revision is the answer.
--
--   app_user    may read and insert; it holds no UPDATE, DELETE or TRUNCATE.
--   every role  the trigger below refuses UPDATE and DELETE (P0001, message
--               prefix ANSWER_APPEND_ONLY) and TRUNCATE, for the owner and a
--               superuser too.
--
-- Two writes pass, both made by the database's own referential actions (as
-- the version table's trigger admits, 20261119200000_bible_model):
--
--   * the DELETE its question's cascade makes (the question's element, round,
--     session, book or workspace deleted): by the time the trigger runs for
--     those rows the question row is already gone, which is what it reads;
--   * the UPDATE that clears `answeredById` when that person's account is
--     deleted (ON DELETE SET NULL): only that column changes, to NULL, from a
--     user who no longer exists.
--
-- Keep the function VOLATILE: each check reads a fresh snapshot.

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "Answer" FROM app_user;

CREATE OR REPLACE FUNCTION answer_append_only() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM "Question" WHERE "id" = OLD."questionId") THEN
            RETURN OLD;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD."answeredById" IS NOT NULL
           AND NEW."answeredById" IS NULL
           AND (to_jsonb(NEW) - 'answeredById') = (to_jsonb(OLD) - 'answeredById')
           AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."answeredById") THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'ANSWER_APPEND_ONLY: % of Answer refused', TG_OP
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS answer_no_update_delete ON "Answer";
CREATE TRIGGER answer_no_update_delete
    BEFORE UPDATE OR DELETE ON "Answer"
    FOR EACH ROW EXECUTE FUNCTION answer_append_only();

DROP TRIGGER IF EXISTS answer_no_truncate ON "Answer";
CREATE TRIGGER answer_no_truncate
    BEFORE TRUNCATE ON "Answer"
    FOR EACH STATEMENT EXECUTE FUNCTION answer_append_only();

-- ═══════════════════════════════════════════════════════════════════
-- A question's vectors live and die with the question
-- ═══════════════════════════════════════════════════════════════════
--
-- Questions are the vector store's first source table (subphase 2.0, D8):
-- each question's text is embedded, so a later round can find a reworded
-- repeat of it anywhere in the book.
--
-- 1. Deleted with it. The 2.0 trigger function, attached as its header says:
--    whoever deletes a question (its element's, round's, session's or book's
--    cascade included), its vectors go in the same statement.

DROP TRIGGER IF EXISTS "Question_vector_embedding_delete" ON "Question";
CREATE TRIGGER "Question_vector_embedding_delete"
    AFTER DELETE ON "Question" FOR EACH ROW
    EXECUTE FUNCTION vector_embedding_delete_with_source('Question');

-- 2. Never written for a question that no longer exists (issue #23, item 1).
--    A rebuild reads its source rows outside the transaction that writes their
--    vectors, so a question deleted in between would have its vector
--    re-inserted after the delete trigger above ran, and it would outlive its
--    source until the next rebuild. This trigger runs BEFORE every insert of a
--    vector for a registered source model and takes a KEY SHARE lock on the
--    source row in the inserting transaction:
--
--      * the row is there: the lock holds until commit, so a concurrent delete
--        waits for the vector to commit and its trigger (1) then deletes it;
--      * the row is gone (deleted and committed first), OR a delete of it is
--        in flight (the row is locked against KEY SHARE): a rebuild's write
--        (`rebuildGeneration` set) skips the vector silently — the source no
--        longer yields it — and any other write is refused
--        (P0001 VECTOR_SOURCE_MISSING), because writing a vector for a row it
--        cannot see is a caller's bug.
--
--    The lock is taken SKIP LOCKED, never waited for. A vector write that
--    waited on a deleting transaction could deadlock with it: a multi-row
--    write locks question 1, a cascade delete holds question 2 and waits on
--    question 1, the write then waits on question 2 (40P01, and one of the two
--    is rolled back — a book purge or an element delete among them). Skipping
--    means the inserting side never waits on a source row, so no cycle can
--    form; the price is that a vector whose delete is later ROLLED BACK is
--    missing until the question is written or rebuilt again, which only
--    degrades deduplication to its lexical signals.
--
--    The function is generic: a source table attaches it with its model and
--    table names, as `Question` does here; a source model with no guard
--    attached is not checked (only a source table that attaches it is). Dynamic
--    SQL names the table by `format('%I.%I')` from the trigger's own schema and
--    argument, never from the row and never through the caller's search_path.
--    As SECURITY INVOKER it reads as the inserting role, so under app_user the
--    source row must be visible in the vector's own workspace (the second
--    predicate says so for every role). FOR KEY SHARE needs UPDATE on some
--    column of the source table, which app_user holds on Question.

CREATE OR REPLACE FUNCTION vector_embedding_require_source() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    found_rows integer;
BEGIN
    IF TG_NARGS <> 2 OR TG_ARGV[0] !~ '^[A-Z][A-Za-z0-9]{0,63}$' OR TG_ARGV[1] !~ '^[A-Za-z][A-Za-z0-9_]{0,62}$' THEN
        RAISE EXCEPTION 'VECTOR_SOURCE_TRIGGER_MISCONFIGURED: the guard on % must name its source model and table', TG_TABLE_NAME
            USING ERRCODE = 'P0001';
    END IF;
    IF NEW."sourceModel" <> TG_ARGV[0] THEN
        RETURN NEW;
    END IF;
    EXECUTE format('SELECT 1 FROM %I.%I WHERE "id" = $1 AND "workspaceId" = $2 FOR KEY SHARE SKIP LOCKED', TG_TABLE_SCHEMA, TG_ARGV[1])
        USING NEW."sourceId", NEW."workspaceId";
    GET DIAGNOSTICS found_rows = ROW_COUNT;
    IF found_rows > 0 THEN
        RETURN NEW;
    END IF;
    IF NEW."rebuildGeneration" IS NOT NULL THEN
        RETURN NULL;
    END IF;
    RAISE EXCEPTION 'VECTOR_SOURCE_MISSING: no % row % for this vector', TG_ARGV[0], NEW."sourceId"
        USING ERRCODE = 'P0001';
END
$$;

DROP TRIGGER IF EXISTS "VectorEmbedding_question_source_guard" ON "VectorEmbedding";
CREATE TRIGGER "VectorEmbedding_question_source_guard"
    BEFORE INSERT ON "VectorEmbedding" FOR EACH ROW
    WHEN (NEW."sourceModel" = 'Question')
    EXECUTE FUNCTION vector_embedding_require_source('Question', 'Question');
