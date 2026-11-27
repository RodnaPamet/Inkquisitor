-- Phase 5.1 — the manuscript (decision D33): the enum values the next migration uses.
--
-- A value added to an existing enum cannot be used in the transaction that adds it, so the additions
-- land on their own, before the tables and constraints that name them.
--
--   ResearchProposalOperation.SCENE_NOTE   the research fit step's note on a manuscript scene (never its prose, D3)
--   SceneVersionSource                     how a scene's text version came to be: EDIT, RESTORE, IMPORT

ALTER TYPE "ResearchProposalOperation" ADD VALUE 'SCENE_NOTE';

CREATE TYPE "SceneVersionSource" AS ENUM ('EDIT', 'RESTORE', 'IMPORT');
