/**
 * The bible fact call's structured output (Phase 4.1, D27) and the item-by-item
 * reader. CODE, never built from author text (D5), within 2.1's structured-
 * output limits: every member required, nothing nullable. 4.0's fact item plus
 * `contradicts`, the numbers (from 1) of the existing facts shown that the new
 * fact contradicts (graphiti's `contradicted_facts`). The answer is untrusted:
 * each item is re-read on its own, so one malformed item costs only itself.
 */
import { z } from 'zod';
import { FACT_QUOTE_MAX_CHARS } from '@/lib/sources/quote';
import { FACTS_PER_CHUNK_MAX, OBJECT_RAW_MAX, STATEMENT_RAW_MAX, STORY_TIME_RAW_MAX, SUBJECT_RAW_MAX, type FactOutput } from '@/lib/sources/schema';
import { FACT_PREDICATES } from '@/lib/sources/vocabulary';
import { EXISTING_FACTS_SHOWN_MAX } from './prompt';

export const BibleFactOutputSchema = z
    .object({
        subject: z.string().max(SUBJECT_RAW_MAX),
        predicate: z.enum(FACT_PREDICATES),
        object: z.string().max(OBJECT_RAW_MAX),
        statement: z.string().max(STATEMENT_RAW_MAX),
        quote: z.string().max(FACT_QUOTE_MAX_CHARS),
        storyTimeFrom: z.string().max(STORY_TIME_RAW_MAX),
        storyTimeTo: z.string().max(STORY_TIME_RAW_MAX),
        contradicts: z.array(z.number().int().min(1).max(EXISTING_FACTS_SHOWN_MAX)).max(EXISTING_FACTS_SHOWN_MAX),
    })
    .strict();
export type BibleFactOutput = z.infer<typeof BibleFactOutputSchema>;

export const BibleFactsOutputSchema = z.object({ facts: z.array(BibleFactOutputSchema).max(FACTS_PER_CHUNK_MAX) }).strict();

/** Each item read on its own: the well-formed ones (as 4.0's fact items, with their `contradicts`), and how many were not. */
export function parseBibleFactsOutput(raw: unknown): { items: Array<{ fact: FactOutput; contradicts: number[] }>; malformed: number } {
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { facts?: unknown }).facts) ? (raw as { facts: unknown[] }).facts : [];
    const items: Array<{ fact: FactOutput; contradicts: number[] }> = [];
    let malformed = 0;
    for (const item of list) {
        const parsed = BibleFactOutputSchema.safeParse(item);
        if (!parsed.success) {
            malformed++;
            continue;
        }
        const { contradicts, ...fact } = parsed.data;
        items.push({ fact, contradicts: [...new Set(contradicts)] });
    }
    return { items, malformed };
}
