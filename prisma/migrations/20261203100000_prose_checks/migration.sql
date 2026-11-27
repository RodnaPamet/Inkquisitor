-- Phase 5.2 — the style sheet's prose checks (decision D34).
--
--   ProseCheckSettings   a book's rules turned off and its inclusive-language switch (off by default)
--   SceneProseCheck      a scene's newest check: the text it read (a keyed hash), the rules version and the
--                        sheet it ran under (a keyed hash), what was cut, readability; replaced whole
--   ProseFinding         one margin note: offsets into the scene's plain text, a rule, a dismissal key (keyed
--                        hash), and its ENCRYPTED detail (message parameters and the deterministic suggestion)
--   ProseDismissal       a dismissed note: its rule and its sentence's keyed hash; never the sentence
--   ProseBookBaseline    the book's word frequencies for the overused-words rule, ENCRYPTED whole
--
-- Every new table is workspace-scoped: FORCE RLS, `workspace_isolation`, `superuser_bypass`; the workspace and the
-- book (or the scene, or the check) travel in every foreign key, and each goes with its book or scene by cascade.
-- No author text is stored in clear in any of them.

-- CreateTable
CREATE TABLE "ProseCheckSettings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "alexEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rulesOff" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProseCheckSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SceneProseCheck" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "textKey" TEXT NOT NULL,
    "rulesVersion" INTEGER NOT NULL,
    "configKey" TEXT NOT NULL,
    "styleElementId" TEXT,
    "rulesNotRun" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "textCut" BOOLEAN NOT NULL DEFAULT false,
    "findingsCut" BOOLEAN NOT NULL DEFAULT false,
    "charsChecked" INTEGER NOT NULL,
    "wordsChecked" INTEGER NOT NULL,
    "sentences" INTEGER NOT NULL,
    "readingEase" DOUBLE PRECISION,
    "gradeLevel" DOUBLE PRECISION,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneProseCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProseFinding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    "sentenceKey" TEXT NOT NULL,
    "detail" TEXT NOT NULL,

    CONSTRAINT "ProseFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProseDismissal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "sentenceKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProseDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProseBookBaseline" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "baseline" TEXT NOT NULL,
    "totalWords" INTEGER NOT NULL,
    "scenesRead" INTEGER NOT NULL,
    "cut" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProseBookBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProseCheckSettings_workspaceId_bookId_key" ON "ProseCheckSettings"("workspaceId", "bookId");

-- CreateIndex
CREATE UNIQUE INDEX "SceneProseCheck_workspaceId_bookId_sceneId_key" ON "SceneProseCheck"("workspaceId", "bookId", "sceneId");

-- CreateIndex
CREATE UNIQUE INDEX "SceneProseCheck_workspaceId_id_key" ON "SceneProseCheck"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ProseFinding_workspaceId_checkId_idx" ON "ProseFinding"("workspaceId", "checkId");

-- CreateIndex
CREATE INDEX "ProseDismissal_workspaceId_bookId_sentenceKey_idx" ON "ProseDismissal"("workspaceId", "bookId", "sentenceKey");

-- CreateIndex
CREATE INDEX "ProseDismissal_workspaceId_bookId_createdAt_idx" ON "ProseDismissal"("workspaceId", "bookId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProseDismissal_workspaceId_bookId_ruleId_sentenceKey_key" ON "ProseDismissal"("workspaceId", "bookId", "ruleId", "sentenceKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProseBookBaseline_workspaceId_bookId_key" ON "ProseBookBaseline"("workspaceId", "bookId");

-- AddForeignKey
ALTER TABLE "ProseCheckSettings" ADD CONSTRAINT "ProseCheckSettings_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneProseCheck" ADD CONSTRAINT "SceneProseCheck_workspaceId_bookId_sceneId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sceneId") REFERENCES "ManuscriptScene"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProseFinding" ADD CONSTRAINT "ProseFinding_workspaceId_checkId_fkey" FOREIGN KEY ("workspaceId", "checkId") REFERENCES "SceneProseCheck"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProseDismissal" ADD CONSTRAINT "ProseDismissal_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProseBookBaseline" ADD CONSTRAINT "ProseBookBaseline_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Constraints
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "ProseFinding" ADD CONSTRAINT "ProseFinding_range" CHECK ("start" >= 0 AND "end" > "start");
ALTER TABLE "ProseFinding" ADD CONSTRAINT "ProseFinding_severity" CHECK ("severity" IN ('NOTE', 'WARNING'));
ALTER TABLE "ProseFinding" ADD CONSTRAINT "ProseFinding_rule_shape" CHECK ("ruleId" ~ '^[a-z]+(-[a-z]+)*$' AND length("ruleId") <= 40);
ALTER TABLE "ProseDismissal" ADD CONSTRAINT "ProseDismissal_rule_shape" CHECK ("ruleId" ~ '^[a-z]+(-[a-z]+)*$' AND length("ruleId") <= 40);
ALTER TABLE "ProseFinding" ADD CONSTRAINT "ProseFinding_key_shape" CHECK ("sentenceKey" ~ '^[0-9a-f]{64}$');
ALTER TABLE "ProseDismissal" ADD CONSTRAINT "ProseDismissal_key_shape" CHECK ("sentenceKey" ~ '^[0-9a-f]{64}$');
ALTER TABLE "SceneProseCheck" ADD CONSTRAINT "SceneProseCheck_keys_shape" CHECK ("textKey" ~ '^[0-9a-f]{64}$' AND "configKey" ~ '^[0-9a-f]{64}$');
ALTER TABLE "SceneProseCheck" ADD CONSTRAINT "SceneProseCheck_counts" CHECK ("revision" >= 0 AND "rulesVersion" >= 1 AND "charsChecked" >= 0 AND "wordsChecked" >= 0 AND "sentences" >= 0);
ALTER TABLE "ProseCheckSettings" ADD CONSTRAINT "ProseCheckSettings_rules_off_bounded" CHECK (cardinality("rulesOff") <= 40);
ALTER TABLE "ProseBookBaseline" ADD CONSTRAINT "ProseBookBaseline_counts" CHECK ("totalWords" >= 0 AND "scenesRead" >= 0);

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "ProseCheckSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProseCheckSettings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ProseCheckSettings";
CREATE POLICY workspace_isolation ON "ProseCheckSettings"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ProseCheckSettings";
CREATE POLICY superuser_bypass ON "ProseCheckSettings"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "SceneProseCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SceneProseCheck" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "SceneProseCheck";
CREATE POLICY workspace_isolation ON "SceneProseCheck"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "SceneProseCheck";
CREATE POLICY superuser_bypass ON "SceneProseCheck"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ProseFinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProseFinding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ProseFinding";
CREATE POLICY workspace_isolation ON "ProseFinding"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ProseFinding";
CREATE POLICY superuser_bypass ON "ProseFinding"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ProseDismissal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProseDismissal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ProseDismissal";
CREATE POLICY workspace_isolation ON "ProseDismissal"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ProseDismissal";
CREATE POLICY superuser_bypass ON "ProseDismissal"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ProseBookBaseline" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProseBookBaseline" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ProseBookBaseline";
CREATE POLICY workspace_isolation ON "ProseBookBaseline"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ProseBookBaseline";
CREATE POLICY superuser_bypass ON "ProseBookBaseline"
    USING (current_setting('role') != 'app_user');
