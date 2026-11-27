/**
 * Request shapes for the research API (Phase 2.6). Every object is
 * `.strict()`. These bound the RAW input; the usecases sanitise every value
 * (`src/lib/research/storage.ts`, the bible's own field check for an edited
 * value) before anything is stored.
 */
import { z } from 'zod';
import { RAW_INPUT_FACTOR } from '@/lib/bible/field-values';
import { RESEARCH_DEPTHS } from '@/lib/research/vocabulary';
import { PURPOSE_MAX, QUESTION_MAX, URL_MAX, URLS_MAX } from '@/lib/research/storage';
import { BaseVersionInput, CHANGE_SUMMARY_MAX, ELEMENT_NAME_MAX, ELEMENT_SUMMARY_MAX, FieldValueInput } from './bible';

const id = z.string().min(1).max(64);
const raw = (max: number) => z.string().max(max * RAW_INPUT_FACTOR);

/** Scope elements a brief names at most (the CHECK `ResearchBrief_scope_bounded`). */
export const SCOPE_ELEMENTS_MAX = 12;
/** Manuscript chapters and scenes a brief names at most (Phase 5.1; the CHECK `ResearchBrief_manuscript_scope_bounded`). */
export const SCOPE_CHAPTERS_MAX = 8;
export const SCOPE_SCENES_MAX = 12;
/** Files a brief carries at most. */
export const SOURCES_PER_BRIEF_MAX = 6;
/** An attached file's bytes, read bounded (413 past it). */
export const SOURCE_UPLOAD_MAX_BYTES = 1024 * 1024;

export const CreateBriefInput = z
    .object({
        question: raw(QUESTION_MAX).min(1),
        purpose: raw(PURPOSE_MAX).min(1),
        scopeElementIds: z.array(id).max(SCOPE_ELEMENTS_MAX).default([]),
        scopeChapterIds: z.array(id).max(SCOPE_CHAPTERS_MAX).default([]),
        scopeSceneIds: z.array(id).max(SCOPE_SCENES_MAX).default([]),
        urls: z.array(z.string().max(URL_MAX)).max(URLS_MAX).default([]),
        depth: z.enum(RESEARCH_DEPTHS),
    })
    .strict();
export type CreateBriefInput = z.infer<typeof CreateBriefInput>;

/** Accept a research proposal, as proposed or edited (2.5's shape). */
export const AcceptResearchInput = z
    .object({
        baseVersion: BaseVersionInput.optional(),
        reviewedCurrent: z.boolean().optional(),
        value: FieldValueInput.optional(),
        name: raw(ELEMENT_NAME_MAX).min(1).optional(),
        summary: raw(ELEMENT_SUMMARY_MAX).nullish(),
        changeSummary: raw(CHANGE_SUMMARY_MAX).nullish(),
    })
    .strict();
export type AcceptResearchInput = z.infer<typeof AcceptResearchInput>;

/** Keep a finding as a research note: an optional name for it. */
export const KeepFindingInput = z.object({ name: raw(ELEMENT_NAME_MAX).min(1).optional() }).strict();

export const ResearchIdParam = id;
