/**
 * The stress test's structured output (Phase 4.3, D29) and its item-by-item
 * reader. CODE, never built from author text (D5), within 2.1's
 * structured-output limits: every member required, nothing nullable. The
 * answer is untrusted: each weak point is re-read on its own, so one malformed
 * item costs only itself.
 */
import { z } from 'zod';
import { CITES_PER_WEAK_POINT_MAX, QUESTIONS_PER_WEAK_POINT_MAX, WEAK_POINT_KINDS, WEAK_POINTS_MAX, type WeakPointKind } from './vocabulary';

/** Raw bounds (4× the stored ones, as every raw input): a longer item is malformed, never cut. */
export const WeakPointSchema = z
    .object({
        kind: z.enum(WEAK_POINT_KINDS),
        title: z.string().max(400),
        questions: z.array(z.string().max(1_200)).max(QUESTIONS_PER_WEAK_POINT_MAX * 2),
        cites: z.array(z.string().max(16)).max(CITES_PER_WEAK_POINT_MAX * 2),
    })
    .strict();

export const StressTestOutputSchema = z.object({ weakPoints: z.array(WeakPointSchema).max(WEAK_POINTS_MAX) }).strict();

export interface WeakPointOutput {
    readonly kind: WeakPointKind;
    readonly title: string;
    readonly questions: readonly string[];
    readonly cites: readonly string[];
}

/** Each weak point read on its own: the well-formed ones, and how many were not. */
export function parseStressTestOutput(raw: unknown): { items: WeakPointOutput[]; malformed: number } {
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { weakPoints?: unknown }).weakPoints) ? (raw as { weakPoints: unknown[] }).weakPoints : [];
    const items: WeakPointOutput[] = [];
    let malformed = 0;
    for (const item of list.slice(0, WEAK_POINTS_MAX * 2)) {
        const parsed = WeakPointSchema.safeParse(item);
        if (!parsed.success) malformed++;
        else items.push(parsed.data);
    }
    return { items, malformed: malformed + Math.max(0, list.length - WEAK_POINTS_MAX * 2) };
}
