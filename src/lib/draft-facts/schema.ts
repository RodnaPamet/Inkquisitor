/**
 * The draft read's structured output (Phase 5.3): 4.0's facts (`FactOutputSchema`,
 * unchanged) and the threads the piece plants or pays off. CODE, never built
 * from author text (D5), within 2.1's structured-output limits (every member
 * required, no nullable member). The answer is untrusted: each item is re-read
 * on its own, so one malformed item costs only itself, and `validate.ts` holds
 * every survivor to the rules.
 */
import { z } from 'zod';
import { FACT_QUOTE_MAX_CHARS } from '@/lib/sources/quote';
import { FactOutputSchema, FACTS_PER_CHUNK_MAX, type FactOutput } from '@/lib/sources/schema';
import { LINK_ROLES, LINKS_PER_CALL_MAX } from './vocabulary';

export const ThreadLinkOutputSchema = z
    .object({
        thread: z.number().int(),
        role: z.enum(LINK_ROLES),
        quote: z.string().max(FACT_QUOTE_MAX_CHARS),
    })
    .strict();
export type ThreadLinkOutput = z.infer<typeof ThreadLinkOutputSchema>;

export const DraftReadOutputSchema = z
    .object({
        facts: z.array(FactOutputSchema).max(FACTS_PER_CHUNK_MAX),
        threads: z.array(ThreadLinkOutputSchema).max(LINKS_PER_CALL_MAX),
    })
    .strict();

/** Each thread link of an answer read on its own: the well-formed ones, and how many were not. */
export function parseThreadLinks(raw: unknown): { items: ThreadLinkOutput[]; malformed: number } {
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { threads?: unknown }).threads) ? (raw as { threads: unknown[] }).threads : [];
    const items: ThreadLinkOutput[] = [];
    let malformed = 0;
    for (const item of list) {
        const parsed = ThreadLinkOutputSchema.safeParse(item);
        if (parsed.success) items.push(parsed.data);
        else malformed++;
    }
    return { items, malformed };
}

export type { FactOutput };
