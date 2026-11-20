-- Phase 3.2 (decision D22): an ordered kind's place in its story order.
--
--   BibleElement.orderRank   a fractional rank (`src/lib/bible/story-order.ts`):
--                            digits and lower-case letters, never ending in
--                            '0', at most 64 characters. A reorder writes the
--                            ONE element moved: its new rank sits strictly
--                            between its neighbours', and nobody else's moves.
--                            NULL is "not placed yet". Only PLOT_BEAT and
--                            TIMELINE_EVENT carry one (the CHECK).
--
--   BibleEntryVersion.movedInOrder   the save moved the element in its order;
--                            the history words the version from it (the
--                            change summary holds only the author's words).
--                            A column with a default: the append-only trigger
--                            refuses row updates, not a new column.
--
-- One element per place: the unique (bookId, kind, orderRank), NULLs distinct
-- (Postgres's default), so any number of elements may be unplaced. A reorder
-- computes its rank under the order's advisory lock; the index is the
-- guarantee behind it.
--
-- ROLLING-DEPLOY SAFETY: a nullable column the previous image never reads or
-- writes, and an index every existing row satisfies (all NULL). The CHECK
-- compares `kind::text`, so it does not depend on the value being usable in a
-- transaction (the previous migration committed it already).

-- AlterTable
ALTER TABLE "BibleElement" ADD COLUMN     "orderRank" TEXT;

-- AlterTable
ALTER TABLE "BibleEntryVersion" ADD COLUMN     "movedInOrder" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "BibleElement_bookId_kind_orderRank_key" ON "BibleElement"("bookId", "kind", "orderRank");

-- Only an ordered kind is placed, and a rank has the shape the rank module writes.
ALTER TABLE "BibleElement" ADD CONSTRAINT "BibleElement_order_rank_check" CHECK (
    "orderRank" IS NULL
    OR ("kind"::text IN ('PLOT_BEAT', 'TIMELINE_EVENT') AND "orderRank" ~ '^[0-9a-z]{0,63}[1-9a-z]$')
);
