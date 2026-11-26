-- Phase 4.1 — the fact layer's enum values (decision D27), on their own.
--
-- PostgreSQL refuses to USE an enum value in the transaction that adds it, so
-- the values the fact layer's CHECKs and triggers name are added here, one
-- migration before them (as 20261120600000_canvas_interview_enums did for 3.3).
-- No row holds them until code that knows them writes one.

ALTER TYPE "StoryFactSourceKind" ADD VALUE IF NOT EXISTS 'BIBLE_VERSION';
ALTER TYPE "StoryFactSourceKind" ADD VALUE IF NOT EXISTS 'RELATION_VERSION';
