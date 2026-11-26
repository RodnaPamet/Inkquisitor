-- Phase 4.2 — continuity's enum value (decision D28), on its own.
--
-- PostgreSQL refuses to USE an enum value in the transaction that adds it, so
-- the value the continuity migration's CHECK names is added here, one migration
-- before it (as 20261126100000_fact_layer_enums did for 4.1). No row holds it
-- until code that knows it writes one.

ALTER TYPE "StoryFactSourceKind" ADD VALUE IF NOT EXISTS 'AUTHOR_RESOLUTION';
