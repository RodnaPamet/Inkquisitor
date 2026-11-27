-- Phase 5.1 — the manuscript (decision D33).
--
--   Manuscript / ManuscriptPart / ManuscriptChapter / ManuscriptScene   the book's prose: one manuscript a book,
--                                  parts → chapters → scenes, each ordered by a fractional rank unique per parent
--   SceneElementLink               a bible element a scene mentions (@ in the editor) or links explicitly
--   SceneBeatLink                  a PLOT_BEAT a scene dramatises (D33 item 2)
--   SceneVersion                   the scene text's history: written at a checkpoint or past the server's bound,
--                                  never on every autosave (D33 item 1); append-only
--   SceneNoteVersion               the scene NOTE's history (research findings land here, never in the text, D3)
--   ResearchBrief.scopeChapterIds / scopeSceneIds, ResearchProposal.sceneId + SCENE_NOTE   the 2.6 fit step's
--                                  note on a scene
--
-- Every new table is workspace-scoped: FORCE RLS, `workspace_isolation`, `superuser_bypass`; each cascades with
-- its book (the 30-day purge takes it). The workspace and the book travel in every foreign key; a scene names a
-- bible element by (bookId, elementId), so the database refuses another book's character, place or beat, and a
-- trigger holds each to its kind (POV a CHARACTER, setting a SETTING, a beat a PLOT_BEAT).

-- AlterTable
ALTER TABLE "ResearchBrief" ADD COLUMN     "scopeChapterIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scopeSceneIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ResearchProposal" ADD COLUMN     "sceneId" TEXT;

-- CreateTable
CREATE TABLE "Manuscript" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Manuscript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManuscriptPart" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "manuscriptId" TEXT NOT NULL,
    "title" TEXT,
    "rank" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManuscriptPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManuscriptChapter" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "title" TEXT,
    "rank" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManuscriptChapter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManuscriptScene" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "title" TEXT,
    "rank" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "povElementId" TEXT,
    "settingElementId" TEXT,
    "storyTime" TEXT,
    "note" TEXT,
    "noteVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManuscriptScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SceneElementLink" (
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "elementId" TEXT NOT NULL,
    "mentioned" BOOLEAN NOT NULL DEFAULT false,
    "explicit" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneElementLink_pkey" PRIMARY KEY ("sceneId","elementId")
);

-- CreateTable
CREATE TABLE "SceneBeatLink" (
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "beatElementId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneBeatLink_pkey" PRIMARY KEY ("sceneId","beatElementId")
);

-- CreateTable
CREATE TABLE "SceneVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "source" "SceneVersionSource" NOT NULL,
    "restoredFromVersion" INTEGER,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SceneNoteVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "source" "BibleVersionSource" NOT NULL,
    "sourceFindingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceResearchProposalId" TEXT,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneNoteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Manuscript_workspaceId_bookId_key" ON "Manuscript"("workspaceId", "bookId");

-- CreateIndex
CREATE UNIQUE INDEX "Manuscript_workspaceId_id_key" ON "Manuscript"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Manuscript_workspaceId_bookId_id_key" ON "Manuscript"("workspaceId", "bookId", "id");

-- CreateIndex
CREATE INDEX "ManuscriptPart_workspaceId_bookId_idx" ON "ManuscriptPart"("workspaceId", "bookId");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptPart_manuscriptId_rank_key" ON "ManuscriptPart"("manuscriptId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptPart_workspaceId_id_key" ON "ManuscriptPart"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptPart_workspaceId_bookId_id_key" ON "ManuscriptPart"("workspaceId", "bookId", "id");

-- CreateIndex
CREATE INDEX "ManuscriptChapter_workspaceId_bookId_idx" ON "ManuscriptChapter"("workspaceId", "bookId");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptChapter_partId_rank_key" ON "ManuscriptChapter"("partId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptChapter_workspaceId_id_key" ON "ManuscriptChapter"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptChapter_workspaceId_bookId_id_key" ON "ManuscriptChapter"("workspaceId", "bookId", "id");

-- CreateIndex
CREATE INDEX "ManuscriptScene_workspaceId_bookId_idx" ON "ManuscriptScene"("workspaceId", "bookId");

-- CreateIndex
CREATE INDEX "ManuscriptScene_bookId_povElementId_idx" ON "ManuscriptScene"("bookId", "povElementId");

-- CreateIndex
CREATE INDEX "ManuscriptScene_bookId_settingElementId_idx" ON "ManuscriptScene"("bookId", "settingElementId");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptScene_chapterId_rank_key" ON "ManuscriptScene"("chapterId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptScene_workspaceId_id_key" ON "ManuscriptScene"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptScene_workspaceId_bookId_id_key" ON "ManuscriptScene"("workspaceId", "bookId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptScene_bookId_id_key" ON "ManuscriptScene"("bookId", "id");

-- CreateIndex
CREATE INDEX "SceneElementLink_workspaceId_bookId_idx" ON "SceneElementLink"("workspaceId", "bookId");

-- CreateIndex
CREATE INDEX "SceneElementLink_bookId_elementId_idx" ON "SceneElementLink"("bookId", "elementId");

-- CreateIndex
CREATE INDEX "SceneBeatLink_workspaceId_bookId_idx" ON "SceneBeatLink"("workspaceId", "bookId");

-- CreateIndex
CREATE INDEX "SceneBeatLink_bookId_beatElementId_idx" ON "SceneBeatLink"("bookId", "beatElementId");

-- CreateIndex
CREATE INDEX "SceneVersion_workspaceId_bookId_idx" ON "SceneVersion"("workspaceId", "bookId");

-- CreateIndex
CREATE INDEX "SceneVersion_authorId_idx" ON "SceneVersion"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "SceneVersion_sceneId_versionNumber_key" ON "SceneVersion"("sceneId", "versionNumber");

-- CreateIndex
CREATE INDEX "SceneNoteVersion_workspaceId_bookId_idx" ON "SceneNoteVersion"("workspaceId", "bookId");

-- CreateIndex
CREATE INDEX "SceneNoteVersion_authorId_idx" ON "SceneNoteVersion"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "SceneNoteVersion_sceneId_versionNumber_key" ON "SceneNoteVersion"("sceneId", "versionNumber");

-- CreateIndex
CREATE INDEX "ResearchProposal_bookId_sceneId_idx" ON "ResearchProposal"("bookId", "sceneId");

-- AddForeignKey
ALTER TABLE "Manuscript" ADD CONSTRAINT "Manuscript_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptPart" ADD CONSTRAINT "ManuscriptPart_workspaceId_bookId_manuscriptId_fkey" FOREIGN KEY ("workspaceId", "bookId", "manuscriptId") REFERENCES "Manuscript"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptChapter" ADD CONSTRAINT "ManuscriptChapter_workspaceId_bookId_partId_fkey" FOREIGN KEY ("workspaceId", "bookId", "partId") REFERENCES "ManuscriptPart"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptScene" ADD CONSTRAINT "ManuscriptScene_workspaceId_bookId_chapterId_fkey" FOREIGN KEY ("workspaceId", "bookId", "chapterId") REFERENCES "ManuscriptChapter"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptScene" ADD CONSTRAINT "ManuscriptScene_bookId_povElementId_fkey" FOREIGN KEY ("bookId", "povElementId") REFERENCES "BibleElement"("bookId", "id") ON DELETE SET NULL ("povElementId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptScene" ADD CONSTRAINT "ManuscriptScene_bookId_settingElementId_fkey" FOREIGN KEY ("bookId", "settingElementId") REFERENCES "BibleElement"("bookId", "id") ON DELETE SET NULL ("settingElementId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneElementLink" ADD CONSTRAINT "SceneElementLink_workspaceId_bookId_sceneId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sceneId") REFERENCES "ManuscriptScene"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneElementLink" ADD CONSTRAINT "SceneElementLink_bookId_elementId_fkey" FOREIGN KEY ("bookId", "elementId") REFERENCES "BibleElement"("bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneBeatLink" ADD CONSTRAINT "SceneBeatLink_workspaceId_bookId_sceneId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sceneId") REFERENCES "ManuscriptScene"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneBeatLink" ADD CONSTRAINT "SceneBeatLink_bookId_beatElementId_fkey" FOREIGN KEY ("bookId", "beatElementId") REFERENCES "BibleElement"("bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneVersion" ADD CONSTRAINT "SceneVersion_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneVersion" ADD CONSTRAINT "SceneVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneNoteVersion" ADD CONSTRAINT "SceneNoteVersion_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneNoteVersion" ADD CONSTRAINT "SceneNoteVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchProposal" ADD CONSTRAINT "ResearchProposal_bookId_sceneId_fkey" FOREIGN KEY ("bookId", "sceneId") REFERENCES "ManuscriptScene"("bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Shape the database holds whoever writes
-- ═══════════════════════════════════════════════════════════════════

-- Ranks: `src/lib/bible/story-order.ts`'s shape (base 36, never ending in '0', at most 64 characters).
ALTER TABLE "ManuscriptPart" ADD CONSTRAINT "ManuscriptPart_rank_shape" CHECK ("rank" ~ '^[0-9a-z]{0,63}[1-9a-z]$');
ALTER TABLE "ManuscriptChapter" ADD CONSTRAINT "ManuscriptChapter_rank_shape" CHECK ("rank" ~ '^[0-9a-z]{0,63}[1-9a-z]$');
ALTER TABLE "ManuscriptScene" ADD CONSTRAINT "ManuscriptScene_rank_shape" CHECK ("rank" ~ '^[0-9a-z]{0,63}[1-9a-z]$');
ALTER TABLE "ManuscriptScene" ADD CONSTRAINT "ManuscriptScene_counts_not_negative"
    CHECK ("wordCount" >= 0 AND "revision" >= 0 AND "noteVersion" >= 0);
-- A link is a mention, an explicit link, or both; never neither (a row that is neither is deleted).
ALTER TABLE "SceneElementLink" ADD CONSTRAINT "SceneElementLink_is_something" CHECK ("mentioned" OR "explicit");
ALTER TABLE "SceneVersion" ADD CONSTRAINT "SceneVersion_shape"
    CHECK ("versionNumber" >= 1 AND "wordCount" >= 0
       AND ("source" = 'RESTORE') = ("restoredFromVersion" IS NOT NULL)
       AND ("restoredFromVersion" IS NULL OR "restoredFromVersion" >= 1));
-- A RESEARCH note version names the findings (and the proposal) it is drawn from; only a RESEARCH one does
-- (rule 1, as `BibleEntryVersion_research_names_findings`). A note version is MANUAL or RESEARCH.
ALTER TABLE "SceneNoteVersion" ADD CONSTRAINT "SceneNoteVersion_shape"
    CHECK ("versionNumber" >= 1
       AND "source"::text IN ('MANUAL', 'RESEARCH')
       AND ("source"::text = 'RESEARCH') = (cardinality(coalesce("sourceFindingIds", ARRAY[]::text[])) > 0)
       AND ("source"::text = 'RESEARCH') = ("sourceResearchProposalId" IS NOT NULL));

-- A brief's manuscript scope is bounded like its element scope.
ALTER TABLE "ResearchBrief" ADD CONSTRAINT "ResearchBrief_manuscript_scope_bounded"
    CHECK (cardinality("scopeChapterIds") <= 8 AND cardinality("scopeSceneIds") <= 12);

-- A research proposal's operation and its columns (2.6's CHECK, with SCENE_NOTE): a note names a scene and the
-- note, and no element, field, base version or new element.
ALTER TABLE "ResearchProposal" DROP CONSTRAINT "ResearchProposal_operation_shape";
ALTER TABLE "ResearchProposal" ADD CONSTRAINT "ResearchProposal_operation_shape"
    CHECK (
        ("operation" IN ('ADD', 'UPDATE')
            AND "elementId" IS NOT NULL AND "fieldKey" IS NOT NULL AND "proposedValue" IS NOT NULL AND "baseVersion" IS NOT NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL AND "sceneId" IS NULL)
        OR
        ("operation" = 'NEW_ELEMENT'
            AND "elementId" IS NULL AND "fieldKey" IS NULL AND "proposedValue" IS NULL AND "baseVersion" IS NULL
            AND "newKind" IS NOT NULL AND "newName" IS NOT NULL AND "versionId" IS NULL AND "sceneId" IS NULL)
        OR
        ("operation" = 'SCENE_NOTE'
            AND "sceneId" IS NOT NULL AND "proposedValue" IS NOT NULL
            AND "elementId" IS NULL AND "fieldKey" IS NULL AND "baseVersion" IS NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL)
    );
ALTER TABLE "ResearchProposal" DROP CONSTRAINT "ResearchProposal_decision_shape";
ALTER TABLE "ResearchProposal" ADD CONSTRAINT "ResearchProposal_decision_shape"
    CHECK (
        ("status" = 'PENDING') = ("decidedAt" IS NULL)
        AND ("status" <> 'PENDING' OR ("decidedById" IS NULL AND "versionId" IS NULL AND "createdElementId" IS NULL))
        AND ("status" NOT IN ('ACCEPTED', 'EDITED_ACCEPTED')
             OR ("operation" IN ('ADD', 'UPDATE', 'SCENE_NOTE') AND "versionId" IS NOT NULL)
             OR ("operation" = 'NEW_ELEMENT' AND "createdElementId" IS NOT NULL))
        AND ("status" IN ('ACCEPTED', 'EDITED_ACCEPTED') OR ("versionId" IS NULL AND "createdElementId" IS NULL))
    );

-- ═══════════════════════════════════════════════════════════════════
-- A scene names elements of the right kind
-- ═══════════════════════════════════════════════════════════════════
--
-- The composite keys hold every element to the scene's book; these triggers hold its kind. An element's kind is
-- fixed at creation (1.1), so a check at write time stays true. They are AFTER triggers: a row of another workspace
-- is refused by row-level security's WITH CHECK first (a BEFORE trigger would read the element through RLS, see
-- nothing, and refuse it for the wrong reason), and an AFTER trigger's exception still undoes the statement.

CREATE OR REPLACE FUNCTION manuscript_scene_element_kinds() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NEW."povElementId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "BibleElement" WHERE "id" = NEW."povElementId" AND "bookId" = NEW."bookId" AND "kind" = 'CHARACTER'
    ) THEN
        RAISE EXCEPTION 'SCENE_ELEMENT_KIND: a scene''s point of view is a character of its book' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."settingElementId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "BibleElement" WHERE "id" = NEW."settingElementId" AND "bookId" = NEW."bookId" AND "kind" = 'SETTING'
    ) THEN
        RAISE EXCEPTION 'SCENE_ELEMENT_KIND: a scene''s setting is a setting of its book' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS manuscript_scene_element_kinds ON "ManuscriptScene";
CREATE TRIGGER manuscript_scene_element_kinds
    AFTER INSERT OR UPDATE OF "povElementId", "settingElementId" ON "ManuscriptScene"
    FOR EACH ROW EXECUTE FUNCTION manuscript_scene_element_kinds();

CREATE OR REPLACE FUNCTION scene_beat_link_is_beat() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM "BibleElement" WHERE "id" = NEW."beatElementId" AND "bookId" = NEW."bookId" AND "kind" = 'PLOT_BEAT') THEN
        RAISE EXCEPTION 'SCENE_ELEMENT_KIND: a scene dramatises a plot beat of its book' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scene_beat_link_is_beat ON "SceneBeatLink";
CREATE TRIGGER scene_beat_link_is_beat
    AFTER INSERT OR UPDATE ON "SceneBeatLink"
    FOR EACH ROW EXECUTE FUNCTION scene_beat_link_is_beat();

-- ═══════════════════════════════════════════════════════════════════
-- A scene's history is append-only
-- ═══════════════════════════════════════════════════════════════════
--
-- As BibleEntryVersion (the 1.1 migration): app_user reads and inserts; the trigger refuses UPDATE and DELETE
-- (P0001 SCENE_VERSION_APPEND_ONLY) and TRUNCATE for every role, except the delete its book's cascade makes (the
-- book is already gone when the check reads it) and the clearing of `authorId` when that person is deleted. A
-- scene's own deletion leaves its history with the book. Keep the function VOLATILE.

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "SceneVersion" FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "SceneNoteVersion" FROM app_user;

CREATE OR REPLACE FUNCTION scene_version_append_only() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM "Book" WHERE "id" = OLD."bookId") THEN
            RETURN OLD;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD."authorId" IS NOT NULL
           AND NEW."authorId" IS NULL
           AND (to_jsonb(NEW) - 'authorId') = (to_jsonb(OLD) - 'authorId')
           AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."authorId") THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'SCENE_VERSION_APPEND_ONLY: % of % refused', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS scene_version_no_update_delete ON "SceneVersion";
CREATE TRIGGER scene_version_no_update_delete
    BEFORE UPDATE OR DELETE ON "SceneVersion"
    FOR EACH ROW EXECUTE FUNCTION scene_version_append_only();
DROP TRIGGER IF EXISTS scene_version_no_truncate ON "SceneVersion";
CREATE TRIGGER scene_version_no_truncate
    BEFORE TRUNCATE ON "SceneVersion"
    FOR EACH STATEMENT EXECUTE FUNCTION scene_version_append_only();

DROP TRIGGER IF EXISTS scene_note_version_no_update_delete ON "SceneNoteVersion";
CREATE TRIGGER scene_note_version_no_update_delete
    BEFORE UPDATE OR DELETE ON "SceneNoteVersion"
    FOR EACH ROW EXECUTE FUNCTION scene_version_append_only();
DROP TRIGGER IF EXISTS scene_note_version_no_truncate ON "SceneNoteVersion";
CREATE TRIGGER scene_note_version_no_truncate
    BEFORE TRUNCATE ON "SceneNoteVersion"
    FOR EACH STATEMENT EXECUTE FUNCTION scene_version_append_only();

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "Manuscript" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Manuscript" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "Manuscript";
CREATE POLICY workspace_isolation ON "Manuscript"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "Manuscript";
CREATE POLICY superuser_bypass ON "Manuscript"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ManuscriptPart" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManuscriptPart" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ManuscriptPart";
CREATE POLICY workspace_isolation ON "ManuscriptPart"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ManuscriptPart";
CREATE POLICY superuser_bypass ON "ManuscriptPart"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ManuscriptChapter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManuscriptChapter" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ManuscriptChapter";
CREATE POLICY workspace_isolation ON "ManuscriptChapter"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ManuscriptChapter";
CREATE POLICY superuser_bypass ON "ManuscriptChapter"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ManuscriptScene" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManuscriptScene" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ManuscriptScene";
CREATE POLICY workspace_isolation ON "ManuscriptScene"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ManuscriptScene";
CREATE POLICY superuser_bypass ON "ManuscriptScene"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "SceneElementLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SceneElementLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "SceneElementLink";
CREATE POLICY workspace_isolation ON "SceneElementLink"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "SceneElementLink";
CREATE POLICY superuser_bypass ON "SceneElementLink"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "SceneBeatLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SceneBeatLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "SceneBeatLink";
CREATE POLICY workspace_isolation ON "SceneBeatLink"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "SceneBeatLink";
CREATE POLICY superuser_bypass ON "SceneBeatLink"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "SceneVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SceneVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "SceneVersion";
CREATE POLICY workspace_isolation ON "SceneVersion"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "SceneVersion";
CREATE POLICY superuser_bypass ON "SceneVersion"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "SceneNoteVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SceneNoteVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "SceneNoteVersion";
CREATE POLICY workspace_isolation ON "SceneNoteVersion"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "SceneNoteVersion";
CREATE POLICY superuser_bypass ON "SceneNoteVersion"
    USING (current_setting('role') != 'app_user');
