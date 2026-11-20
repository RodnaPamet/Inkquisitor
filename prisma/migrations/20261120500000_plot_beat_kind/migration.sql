-- Phase 3.2 (decision D22): the bible's PLOT_BEAT kind, one beat of a
-- plotline, drawn as a card on the plot board.
--
-- ON ITS OWN, ON PURPOSE. `ALTER TYPE … ADD VALUE` cannot be used in the
-- transaction that adds it, and Prisma applies a migration file as one
-- transaction; the story order's CHECK (the next migration) names the value,
-- so it lives in a file of its own that runs after this one commits.
--
-- AFTER 'PLOT', so the database's enum order is the fixed kind order of
-- `src/lib/bible/kinds.ts` (`listForInterview` and the board sort by it).
--
-- ROLLING-DEPLOY SAFETY (the 3.2 note, "One deploy"). Additive: no row holds
-- the value until code that knows it writes one. A previous image still
-- running beside the new one would fail to read a book once a beat is in it
-- (its Prisma client does not know the value); there is no rolling deploy
-- before Phase 7, where the deploy runbook takes a new kind in two steps.

-- AlterEnum
ALTER TYPE "BibleElementKind" ADD VALUE 'PLOT_BEAT' AFTER 'PLOT';
