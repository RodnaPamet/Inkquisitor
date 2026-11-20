-- Phase 2.6, decision D15 (2026-11-20) — research egress: every web search
-- query and fetch URL a research run's gather turn issued, listed on the run's
-- result page so the author sees exactly what left the product.
--
--   ResearchEgress   one row per query or URL, in the order the stream
--                    delivered it, with the tripwire's refusal code when it
--                    refused one; the text encrypted by the application.
--
-- The table, index and foreign key are what `prisma migrate diff` generates
-- from prisma/schema/; the CHECKs, the grants and the row-level security are
-- appended by hand below.
--
-- ROLLING-DEPLOY SAFETY. Forward-only and additive: a new table the previous
-- image never reads or writes.

-- CreateTable
CREATE TABLE "ResearchEgress" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "refusal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchEgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResearchEgress_workspaceId_runId_position_key" ON "ResearchEgress"("workspaceId", "runId", "position");

-- AddForeignKey
ALTER TABLE "ResearchEgress" ADD CONSTRAINT "ResearchEgress_workspaceId_runId_fkey" FOREIGN KEY ("workspaceId", "runId") REFERENCES "ResearchRun"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: workspace-scoped, as every research table
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "ResearchEgress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResearchEgress" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ResearchEgress";
CREATE POLICY workspace_isolation ON "ResearchEgress"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ResearchEgress";
CREATE POLICY superuser_bypass ON "ResearchEgress"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- Shape, and a record that is never rewritten
-- ═══════════════════════════════════════════════════════════════════

-- `RESEARCH_EGRESS_PER_RUN_MAX` (src/lib/research/vocabulary.ts) rows a run at most.
ALTER TABLE "ResearchEgress" ADD CONSTRAINT "ResearchEgress_shape"
    CHECK ("position" >= 0 AND "position" < 100
       AND "tool" IN ('web_search', 'web_fetch')
       AND ("refusal" IS NULL OR "refusal" ~ '^[A-Z_]{1,64}$'));

-- What left is a fact: written once, gone only with its run (the run's, the
-- book's or the workspace's cascade).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "ResearchEgress" FROM app_user;
