-- Phase 5.3 — the draft held against the bible (decisions D3 and D35): the enum values the next migration uses.
--
-- A value added to an existing enum cannot be used in the transaction that adds it, so the additions land on their
-- own, before the tables and constraints that name them.
--
--   StoryFactSourceKind.SCENE_TEXT        a DRAFT fact read from a manuscript scene (never canon, never decided)
--   BibleVersionSource.MANUSCRIPT         the author's own save of a field opened prefilled from a scene ("Update the bible")
--   InterviewScope.SCENE                  "Grill me on this scene": one scene's card (goal, conflict, outcome, what changed)
--   EnrichmentProposalKind.SCENE_CARD_FIELD   a change to one field of a scene's card (never its prose, D3)

ALTER TYPE "StoryFactSourceKind" ADD VALUE 'SCENE_TEXT';
ALTER TYPE "BibleVersionSource" ADD VALUE 'MANUSCRIPT';
ALTER TYPE "InterviewScope" ADD VALUE 'SCENE';
ALTER TYPE "EnrichmentProposalKind" ADD VALUE 'SCENE_CARD_FIELD';
