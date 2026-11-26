-- Phase 4.1 review — an embedding task names the CHANGE it waits for, not only the row.
--
-- An element's task is one row per element (a repeat while it waits is the same
-- task). The dispatcher reads the element, embeds it outside every transaction,
-- then files the vector and deletes the task. A save that committed between the
-- read and the delete hit the existing task (ON CONFLICT DO NOTHING) and changed
-- nothing, so the delete took it too: the vector stayed the old text's until the
-- element's next change. Now a repeat BUMPS `generation`, and the dispatcher
-- deletes a task only at the generation it read; a bumped task waits for the
-- next tick, which embeds the row as it stands then.

-- AlterTable
ALTER TABLE "EmbeddingTask" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "EmbeddingTask" ADD CONSTRAINT "EmbeddingTask_generation_nonnegative" CHECK ("generation" >= 0);

CREATE OR REPLACE FUNCTION bible_entry_version_fact_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "BibleFactExtraction" ("id", "workspaceId", "bookId", "kind", "elementId", "bibleVersionId")
        VALUES (gen_random_uuid()::text, NEW."workspaceId", NEW."bookId", 'BIBLE_VERSION', NEW."elementId", NEW."id");
    INSERT INTO "EmbeddingTask" ("id", "workspaceId", "sourceModel", "sourceId")
        VALUES (gen_random_uuid()::text, NEW."workspaceId", 'BibleElement', NEW."elementId")
        ON CONFLICT ("workspaceId", "sourceModel", "sourceId") DO UPDATE SET "generation" = "EmbeddingTask"."generation" + 1;
    RETURN NULL;
END
$$;
