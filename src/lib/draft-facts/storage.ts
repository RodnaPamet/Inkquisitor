/**
 * The draft reading's author text as it is STORED (Phase 5.3). Sanitised at the usecase layer before it is written,
 * and encrypted by the extension (the columns are in `src/lib/security/encrypted-fields.ts`). Each function is the one
 * its repository's writers call (`encrypted-field-sanitiser-coverage`). A draft fact itself goes through 4.0's
 * `sanitiseFactForStorage` (the fact columns are 4.0's).
 */
import { plainLine } from '@/lib/bible/text';

export class DraftTextNotStorableError extends Error {
    constructor(readonly what: string) {
        super(`nothing storable: ${what}`);
        this.name = 'DraftTextNotStorableError';
    }
}

/**
 * A link's quote: the scene's own plain-text slice at the located span (already text: 3.4's reader over sanitised
 * HTML). Re-sanitising it would move the span, so it is kept as that slice and only checked to hold words.
 */
export function sanitiseLinkQuoteForStorage(quote: string): string {
    if (plainLine(quote) === '') throw new DraftTextNotStorableError('quote');
    return quote;
}
