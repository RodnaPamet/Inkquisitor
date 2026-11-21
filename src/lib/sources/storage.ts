/**
 * The source library's author text as it is STORED (Phase 4.0): sanitised at
 * the usecase layer before it is written (`plainLine` / `plainBlock` over
 * `sanitizePlainText`), bounded, and encrypted by the extension (the columns
 * are in `src/lib/security/encrypted-fields.ts`). Each function is the one its
 * repository's writers call (`encrypted-field-sanitiser-coverage`).
 */
import { plainBlock, plainLine } from '@/lib/bible/text';
import type { FactDraft } from './validate';
import { OVERRIDE_TEXT_MAX } from './vocabulary';

export class SourceTextNotStorableError extends Error {
    constructor(readonly what: string) {
        super(`nothing storable: ${what}`);
        this.name = 'SourceTextNotStorableError';
    }
}

export const FILENAME_MAX = 200;

/** A source's file name: one line, bounded; a name that sanitises to nothing is stored as `source`. */
export function sanitiseSourceNameForStorage(filename: string): string {
    const name = plainLine(filename.slice(0, FILENAME_MAX * 4)).slice(0, FILENAME_MAX).trim();
    return name === '' ? 'source' : name;
}

/** A chunk's text and its heading path (a JSON array of lines), sanitised. The text must keep words. */
export function sanitiseChunkForStorage(chunk: { text: string; headingPath: readonly string[] }): { text: string; headingPath: string | null } {
    const text = plainBlock(chunk.text);
    if (text === '') throw new SourceTextNotStorableError('chunk');
    const path = chunk.headingPath.map((h) => plainLine(h).slice(0, 200)).filter((h) => h !== '');
    return { text, headingPath: path.length > 0 ? JSON.stringify(path) : null };
}

/** A chunk's stored heading path, read back. */
export function decodeHeadingPath(stored: string | null): string[] {
    if (!stored) return [];
    try {
        const v = JSON.parse(stored) as unknown;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * A fact's text, sanitised again as it is written (`validate.ts` sanitised it
 * once). The quote is the passage's own slice, which `sanitiseChunkForStorage`
 * already produced: re-sanitising it would move the span, so it is kept as
 * that slice and only checked to hold words.
 */
export function sanitiseFactForStorage(fact: FactDraft): FactDraft {
    const line = (v: string | null) => (v === null ? null : plainLine(v) || null);
    if (plainLine(fact.quote) === '') throw new SourceTextNotStorableError('quote');
    const subjectName = plainLine(fact.subjectName);
    const statement = plainLine(fact.statement);
    if (subjectName === '' || statement === '') throw new SourceTextNotStorableError('fact');
    return { ...fact, subjectName, statement, objectLiteral: line(fact.objectLiteral), storyTimeFrom: line(fact.storyTimeFrom), storyTimeTo: line(fact.storyTimeTo) };
}

/** A book's own answer in place of an inherited fact: one block of plain text, bounded. */
export function sanitiseOverrideForStorage(text: string): string {
    const stored = plainBlock(text).slice(0, OVERRIDE_TEXT_MAX).trim();
    if (stored === '') throw new SourceTextNotStorableError('override');
    return stored;
}
