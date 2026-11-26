/**
 * Continuity's author text as it is STORED (Phase 4.2, D28): sanitised at the
 * usecase layer before it is written (`plainLine` / `plainBlock` over
 * `sanitizePlainText`), bounded, and encrypted by the extension (the columns
 * are in `src/lib/security/encrypted-fields.ts`). Each function is the one its
 * repository's writers call (`encrypted-field-sanitiser-coverage`).
 */
import { plainBlock, plainLine } from '@/lib/bible/text';
import { EXPLANATION_MAX, THREAD_NOTE_MAX, THREAD_TITLE_MAX } from './vocabulary';

export class ContinuityTextNotStorableError extends Error {
    constructor(readonly what: string) {
        super(`nothing storable: ${what}`);
        this.name = 'ContinuityTextNotStorableError';
    }
}

function clip(text: string, max: number): string {
    return text.length > max ? text.slice(0, max).trimEnd() : text;
}

/** A thread's title (one line, required) and note (a block, or null), as the author or an accepted proposal gives them. */
export function sanitiseThreadForStorage(input: { title: string; note: string | null }): { title: string; note: string | null } {
    const title = clip(plainLine(input.title.slice(0, THREAD_TITLE_MAX * 4)), THREAD_TITLE_MAX);
    if (title === '') throw new ContinuityTextNotStorableError('title');
    const note = input.note === null ? null : clip(plainBlock(input.note.slice(0, THREAD_NOTE_MAX * 4)), THREAD_NOTE_MAX) || null;
    return { title, note };
}

/**
 * A proposed thread's title and quote, sanitised again as it is written (`validateBibleThreads` sanitised the title
 * once). The quote is the version's own rendered slice (already sanitised text): re-sanitising it would move the span,
 * so it is kept as that slice and only checked to hold words.
 */
export function sanitiseThreadProposalForStorage<T extends { title: string | null; quote: string }>(p: T): T {
    if (plainLine(p.quote) === '') throw new ContinuityTextNotStorableError('quote');
    const title = p.title === null ? null : clip(plainLine(p.title), THREAD_TITLE_MAX);
    if (title === '') throw new ContinuityTextNotStorableError('title');
    return { ...p, title };
}

/** The author's explanation of a contradiction they resolved as "both true": one bounded block, required. */
export function sanitiseExplanationForStorage(text: string): string {
    const out = clip(plainLine(text.slice(0, EXPLANATION_MAX * 4)), EXPLANATION_MAX);
    if (out === '') throw new ContinuityTextNotStorableError('explanation');
    return out;
}
