/**
 * Request shapes for book-level interrogation (Phase 4.3, D29). `.strict()`:
 * an unknown key is a 400.
 */
import { z } from 'zod';

const MICRO_USD = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Start a stress test: the "at most" the page showed, which becomes the job's budget. */
export const StressTestStartInput = z.object({ confirmWorstCaseMicroUsd: MICRO_USD }).strict();

/** Run a gap hunt: the "at most" of the ranking call the page showed (omitted when the page offered only the unranked order). */
export const GapHuntRunInput = z.object({ confirmWorstCaseMicroUsd: MICRO_USD.optional() }).strict();

export const IdParam = z.string().min(1).max(64);
