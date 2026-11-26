/**
 * The deep continuity check's structured output (Phase 4.2, D28) and its
 * item-by-item reader. CODE, never built from author text (D5), within 2.1's
 * structured-output limits: every member required, nothing nullable. The
 * answer is untrusted: each pair is re-read on its own, so one malformed pair
 * costs only itself.
 */
import { z } from 'zod';
import { CONTINUITY_FACTS_PER_CALL_MAX, CONTRADICTION_KINDS, type ContradictionKind } from './vocabulary';
import { CONTINUITY_PAIRS_MAX } from './prompt';

export const ContinuityPairSchema = z
    .object({
        first: z.number().int().min(1).max(CONTINUITY_FACTS_PER_CALL_MAX),
        second: z.number().int().min(1).max(CONTINUITY_FACTS_PER_CALL_MAX),
        kind: z.enum(CONTRADICTION_KINDS),
    })
    .strict();

export const ContinuityOutputSchema = z.object({ contradictions: z.array(ContinuityPairSchema).max(CONTINUITY_PAIRS_MAX) }).strict();

/** Each pair read on its own: the well-formed ones, and how many were not. */
export function parseContinuityOutput(raw: unknown): { pairs: Array<{ first: number; second: number; kind: ContradictionKind }>; malformed: number } {
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { contradictions?: unknown }).contradictions) ? (raw as { contradictions: unknown[] }).contradictions : [];
    const pairs: Array<{ first: number; second: number; kind: ContradictionKind }> = [];
    let malformed = 0;
    for (const item of list.slice(0, CONTINUITY_PAIRS_MAX * 2)) {
        const parsed = ContinuityPairSchema.safeParse(item);
        if (!parsed.success) malformed++;
        else pairs.push(parsed.data);
    }
    return { pairs, malformed: malformed + Math.max(0, list.length - CONTINUITY_PAIRS_MAX * 2) };
}
