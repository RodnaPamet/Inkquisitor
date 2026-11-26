/**
 * The gap ranking's structured output (Phase 4.3, D29) and its item-by-item
 * reader. CODE, never built from author text (D5), within 2.1's limits.
 */
import { z } from 'zod';
import { GAP_CANDIDATES_MAX, GAP_CITES_MAX, GAP_PICKS_MAX } from './vocabulary';

export const GapPickSchema = z
    .object({
        candidate: z.number().int().min(1).max(GAP_CANDIDATES_MAX),
        reason: z.string().max(800),
        cites: z.array(z.number().int().min(1).max(GAP_CANDIDATES_MAX)).max(GAP_CITES_MAX * 2),
    })
    .strict();

export const GapRankOutputSchema = z.object({ picks: z.array(GapPickSchema).max(GAP_PICKS_MAX) }).strict();

export function parseGapRankOutput(raw: unknown): { items: Array<z.infer<typeof GapPickSchema>>; malformed: number } {
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { picks?: unknown }).picks) ? (raw as { picks: unknown[] }).picks : [];
    const items: Array<z.infer<typeof GapPickSchema>> = [];
    let malformed = 0;
    for (const item of list.slice(0, GAP_PICKS_MAX * 2)) {
        const parsed = GapPickSchema.safeParse(item);
        if (!parsed.success) malformed++;
        else items.push(parsed.data);
    }
    return { items, malformed: malformed + Math.max(0, list.length - GAP_PICKS_MAX * 2) };
}
