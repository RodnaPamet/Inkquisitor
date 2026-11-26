/**
 * The stress test's author text as it is STORED (Phase 4.3, D29): a weak
 * point's label and questions, sanitised at the usecase layer again as they are
 * written (`validateWeakPoints` sanitised them once), bounded, and encrypted by
 * the extension (the columns are in `src/lib/security/encrypted-fields.ts`).
 * The questions are one JSON array serialised to a string and sealed whole.
 */
import { plainLine } from '@/lib/bible/text';
import { QUESTIONS_PER_WEAK_POINT_MAX, WEAK_POINT_QUESTION_MAX, WEAK_POINT_TITLE_MAX } from './vocabulary';

export class WeakPointNotStorableError extends Error {
    constructor(readonly what: string) {
        super(`nothing storable: ${what}`);
        this.name = 'WeakPointNotStorableError';
    }
}

function clip(text: string, max: number): string {
    return text.length > max ? text.slice(0, max).trimEnd() : text;
}

/** A weak point's label and questions as written: one line each, bounded; the questions as a JSON string. */
export function sanitiseWeakPointForStorage(input: { title: string; questions: readonly string[] }): { title: string; questions: string } {
    const title = clip(plainLine(input.title), WEAK_POINT_TITLE_MAX);
    if (title === '') throw new WeakPointNotStorableError('title');
    const questions = input.questions
        .slice(0, QUESTIONS_PER_WEAK_POINT_MAX)
        .map((q) => clip(plainLine(q), WEAK_POINT_QUESTION_MAX))
        .filter((q) => q !== '');
    if (questions.length === 0) throw new WeakPointNotStorableError('questions');
    return { title, questions: JSON.stringify(questions) };
}

/** The stored questions, read back (a value that is not a list of strings reads as none). */
export function decodeWeakPointQuestions(stored: string): string[] {
    try {
        const v = JSON.parse(stored) as unknown;
        return Array.isArray(v) ? v.filter((q): q is string => typeof q === 'string') : [];
    } catch {
        return [];
    }
}
