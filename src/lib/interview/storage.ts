/**
 * A question's text on its way to storage, and back (Phase 2.2).
 *
 * A generated question is MODEL OUTPUT built from author text, so it is
 * sanitised like author text before anything judges or stores it: every
 * string through the plain-text sanitiser (`plainLine` for the one-line
 * parts, `plainBlock` for the rationale), so a tag, an encoded tag or a
 * control character the model echoed from an answer never reaches the
 * question table, a later prompt, or the interview page. The engine
 * sanitises each candidate before validating it (so what is judged is what
 * is stored), and the usecase passes every question through the same
 * function again as it writes (the sanitiser is idempotent on its own output;
 * tests/guards/encrypted-field-sanitiser-coverage.test.ts holds the call to
 * the write path).
 *
 * The JSON-shaped columns (options, scale labels, the recommendation) are
 * serialised to a string so the field-encryption extension seals them whole.
 */
import { plainBlock, plainLine } from '@/lib/bible/text';
import type { Candidate } from './candidates';

/** The candidate with every string sanitised (an all-markup string becomes empty and fails validation). */
export function sanitiseQuestionForStorage<C extends Candidate>(c: C): C {
    return {
        ...c,
        text: plainLine(c.text),
        options: c.options ? c.options.map(plainLine) : null,
        scaleLabels: c.scaleLabels ? { low: plainLine(c.scaleLabels.low), high: plainLine(c.scaleLabels.high) } : null,
        challengeQuote: c.challengeQuote === null ? null : plainLine(c.challengeQuote),
        recommendedAnswer: typeof c.recommendedAnswer === 'string' ? plainBlock(c.recommendedAnswer) : c.recommendedAnswer,
        rationale: c.rationale === null ? null : plainBlock(c.rationale) || null,
    };
}

export function encodeJson(value: unknown): string | null {
    return value === null || value === undefined ? null : JSON.stringify(value);
}

export function decodeOptions(stored: string | null): string[] | null {
    if (stored === null) return null;
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null;
}

export function decodeScaleLabels(stored: string | null): { low: string; high: string } | null {
    if (stored === null) return null;
    const value = JSON.parse(stored) as { low?: unknown; high?: unknown };
    return typeof value?.low === 'string' && typeof value?.high === 'string' ? { low: value.low, high: value.high } : null;
}

export function decodeRecommendation(stored: string | null): string | number | null {
    if (stored === null) return null;
    const value: unknown = JSON.parse(stored);
    return typeof value === 'string' || typeof value === 'number' ? value : null;
}
