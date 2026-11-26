-- Phase 4.4 — continuous, deep questioning (decisions D23 and D30).
--
--   InterviewSession.lengthMode / roundBudget / questionBudget
--                                 the author's session length: a number of rounds, a number of questions, or
--                                 until they stop; the fixed six-round limit goes (the CHECK below replaces it)
--   InterviewSession.generatorsOff / minorAccepted
--                                 the generators switched off for the session (a dial), and the author's choice to
--                                 go on once every remaining question was minor
--   *InterviewDefaults.generatorsOff
--                                 the generators switched off by default (book, workspace), resolved like a dial
--   Question.generator / angle / pairElementId / storyFactId / continuityRef / valueScore
--                                 which generator proposed a question, what it rests on (ids and codes only) and the
--                                 code's value score when it was asked
--   StoryFact.decidedByAnswerId   the interview answer a source fact's decision came from (D30, item 2)
--
-- No new table, so no new row-level security: every column lives on a table that already has FORCE RLS and its
-- `workspace_isolation` policy. No author text in any new column.

-- AlterTable
ALTER TABLE "BookInterviewDefaults" ADD COLUMN     "generatorsOff" JSONB;

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN     "generatorsOff" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lengthMode" "InterviewLengthMode" NOT NULL DEFAULT 'ROUNDS',
ADD COLUMN     "minorAccepted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "questionBudget" INTEGER,
ALTER COLUMN "roundBudget" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "angle" TEXT,
ADD COLUMN     "continuityRef" TEXT,
ADD COLUMN     "generator" "QuestionGenerator" NOT NULL DEFAULT 'FRONTIER',
ADD COLUMN     "pairElementId" TEXT,
ADD COLUMN     "storyFactId" TEXT,
ADD COLUMN     "valueScore" INTEGER;

-- AlterTable
ALTER TABLE "StoryFact" ADD COLUMN     "decidedByAnswerId" TEXT;

-- AlterTable
ALTER TABLE "WorkspaceInterviewDefaults" ADD COLUMN     "generatorsOff" JSONB;

-- CreateIndex
CREATE INDEX "Question_bookId_pairElementId_idx" ON "Question"("bookId", "pairElementId");

-- CreateIndex
CREATE INDEX "Question_storyFactId_idx" ON "Question"("storyFactId");

-- CreateIndex
CREATE INDEX "StoryFact_decidedByAnswerId_idx" ON "StoryFact"("decidedByAnswerId");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_bookId_pairElementId_fkey" FOREIGN KEY ("bookId", "pairElementId") REFERENCES "BibleElement"("bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_storyFactId_fkey" FOREIGN KEY ("storyFactId") REFERENCES "StoryFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_decidedByAnswerId_fkey" FOREIGN KEY ("decidedByAnswerId") REFERENCES "Answer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
--  CHECKs
-- ═══════════════════════════════════════════════════════════════════

-- THE SESSION'S LENGTH (D23): the six-round limit goes. A ROUNDS session names its rounds (1..30), a QUESTIONS
-- session its questions (1..300), an UNTIL_STOPPED session neither; every session is still bounded by its token
-- budget, the monthly ceiling, the kill switch, the author and the most questions one session's reads hold
-- (SESSION_LIMIT, in code). Existing sessions are ROUNDS with the budget they started with.
ALTER TABLE "InterviewSession" DROP CONSTRAINT "InterviewSession_budgets_bounded";
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_budgets_bounded"
    CHECK (
        ("lengthMode" = 'ROUNDS') = ("roundBudget" IS NOT NULL)
        AND ("lengthMode" = 'QUESTIONS') = ("questionBudget" IS NOT NULL)
        AND ("roundBudget" IS NULL OR ("roundBudget" BETWEEN 1 AND 30 AND "roundsRun" <= "roundBudget"))
        AND ("questionBudget" IS NULL OR "questionBudget" BETWEEN 1 AND 300)
        AND "roundsRun" >= 0
        AND "tokenBudget" >= 0
        AND "tokensUsed" >= 0
    );

-- The generators a session or a default switches off: a closed list, none twice, not all five.
CREATE OR REPLACE FUNCTION interview_generator_list_ok(list jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT jsonb_typeof(list) = 'array'
        AND jsonb_array_length(list) <= 4
        AND list <@ '["FRONTIER", "LADDER", "RELATIONS", "SOURCES", "CONTINUITY"]'::jsonb
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(list) AS e WHERE jsonb_typeof(e) <> 'string')
        AND jsonb_array_length(list) = (SELECT count(DISTINCT e) FROM jsonb_array_elements(list) AS e);
$$;

ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_generators_off_known"
    CHECK (
        "generatorsOff" IS NOT NULL
        AND cardinality("generatorsOff") <= 4
        AND "generatorsOff" <@ ARRAY['FRONTIER', 'LADDER', 'RELATIONS', 'SOURCES', 'CONTINUITY']::text[]
        AND interview_text_array_distinct("generatorsOff")
    );
ALTER TABLE "WorkspaceInterviewDefaults" ADD CONSTRAINT "WorkspaceInterviewDefaults_generators_off_known"
    CHECK ("generatorsOff" IS NULL OR interview_generator_list_ok("generatorsOff"));
ALTER TABLE "BookInterviewDefaults" ADD CONSTRAINT "BookInterviewDefaults_generators_off_known"
    CHECK ("generatorsOff" IS NULL OR interview_generator_list_ok("generatorsOff"));

-- A question targets one or two fields; since 4.4 a SOURCE question whose fact answers no field targets none (it
-- decides a fact: D30, item 2). Every other question still names one or two.
ALTER TABLE "Question" DROP CONSTRAINT "Question_targets_one_or_two";
ALTER TABLE "Question" ADD CONSTRAINT "Question_targets_one_or_two"
    CHECK (cardinality("targetsFieldKeys") BETWEEN 1 AND 2 OR ("generator" = 'SOURCES' AND cardinality("targetsFieldKeys") = 0));

-- A question's generator and what it rests on: ids and codes, each only where its generator uses it.
ALTER TABLE "Question" ADD CONSTRAINT "Question_angle_known"
    CHECK (
        "angle" IS NULL
        OR ("generator" = 'LADDER' AND "angle" IN ('WHAT', 'WHY', 'COST', 'WHO_KNOWS', 'BREAKS', 'EDGE_CASES'))
        OR ("generator" = 'RELATIONS' AND "angle" IN ('WANTS', 'COLLIDE', 'HIDDEN'))
    );
ALTER TABLE "Question" ADD CONSTRAINT "Question_pair_shape"
    CHECK (
        "pairElementId" IS NULL
        OR ("generator" = 'RELATIONS' AND "relationId" IS NULL AND "aboutPending" = false AND "pairElementId" <> "elementId" AND "angle" IS NOT NULL)
    );
ALTER TABLE "Question" ADD CONSTRAINT "Question_story_fact_only_sources"
    CHECK ("storyFactId" IS NULL OR "generator" = 'SOURCES');
ALTER TABLE "Question" ADD CONSTRAINT "Question_continuity_ref_shape"
    CHECK (
        ("continuityRef" IS NULL)
        OR ("generator" = 'CONTINUITY' AND "continuityRef" ~ '^(proposal|thread|gap):[a-z0-9]{1,64}$')
    );
ALTER TABLE "Question" ADD CONSTRAINT "Question_value_score_bounded"
    CHECK ("valueScore" IS NULL OR "valueScore" BETWEEN 0 AND 100);
-- A code-worded question is a generator's (never the frontier's model wording or a pack's example).
ALTER TABLE "Question" ADD CONSTRAINT "Question_generator_origin"
    CHECK ("origin" <> 'GENERATOR' OR "generator" <> 'FRONTIER');
