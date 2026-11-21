/**
 * The extraction's structured output (Phase 4.0) and the item-by-item reader
 * code uses on whatever the model returned. CODE, never built from author
 * text (D5), within 2.1's structured-output limits: every member required, no
 * nullable member (an absent object or time is an empty string). The answer
 * is untrusted: each item is re-read on its own, so one malformed item costs
 * only itself, and `validate.ts` holds every survivor to the rules.
 */
import { z } from 'zod';
import { FACT_QUOTE_MAX_CHARS } from './quote';
import { FACT_PREDICATES } from './vocabulary';

/** Facts one call may return (more are refused OVER_LIMIT). */
export const FACTS_PER_CHUNK_MAX = 24;
export const SUBJECT_RAW_MAX = 240;
export const OBJECT_RAW_MAX = 800;
export const STATEMENT_RAW_MAX = 1_200;
export const STORY_TIME_RAW_MAX = 240;
/** Stored bounds, after sanitising. */
export const SUBJECT_MAX = 120;
export const OBJECT_MAX = 400;
export const STATEMENT_MAX = 600;
export const STORY_TIME_MAX = 120;

export const FactOutputSchema = z
    .object({
        subject: z.string().max(SUBJECT_RAW_MAX),
        predicate: z.enum(FACT_PREDICATES),
        object: z.string().max(OBJECT_RAW_MAX),
        statement: z.string().max(STATEMENT_RAW_MAX),
        quote: z.string().max(FACT_QUOTE_MAX_CHARS),
        storyTimeFrom: z.string().max(STORY_TIME_RAW_MAX),
        storyTimeTo: z.string().max(STORY_TIME_RAW_MAX),
    })
    .strict();
export type FactOutput = z.infer<typeof FactOutputSchema>;

export const FactsOutputSchema = z.object({ facts: z.array(FactOutputSchema).max(FACTS_PER_CHUNK_MAX) }).strict();

/** Each item of an answer read on its own: the well-formed ones, and how many were not. */
export function parseFactsOutput(raw: unknown): { items: FactOutput[]; malformed: number } {
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { facts?: unknown }).facts) ? ((raw as { facts: unknown[] }).facts) : [];
    const items: FactOutput[] = [];
    let malformed = 0;
    for (const item of list) {
        const parsed = FactOutputSchema.safeParse(item);
        if (parsed.success) items.push(parsed.data);
        else malformed++;
    }
    return { items, malformed };
}
