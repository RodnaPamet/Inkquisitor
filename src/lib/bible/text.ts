/**
 * Plain author text — titles, names, labels, summaries, notes, change
 * summaries — sanitised for storage (Phase 1.1). Both go through
 * `sanitizePlainText` (`src/lib/security/sanitize.ts`): every tag stripped,
 * entities decoded first so an encoded tag cannot survive.
 *
 *   plainLine   one line: whitespace runs (newlines included) collapse to one space
 *   plainBlock  paragraphs kept: line endings normalised to `\n`, trailing
 *               spaces dropped, runs of blank lines cut to one
 *
 * Both trim. An empty result is `''`; the caller decides whether that clears
 * an optional value or refuses a required one, and bounds the length of what
 * is left (the stored value, not the raw input).
 */
import { sanitizePlainText } from '@/lib/security/sanitize';

export function plainLine(input: string): string {
    return sanitizePlainText(input).replace(/\s+/g, ' ').trim();
}

export function plainBlock(input: string): string {
    // Line by line rather than one regex over the whole value: a pattern like
    // /[ \t]+\n/ backtracks quadratically over a long run of spaces.
    const lines = sanitizePlainText(input)
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trimEnd());
    const out: string[] = [];
    for (const line of lines) {
        if (line === '' && out.length > 0 && out[out.length - 1] === '') continue;
        out.push(line);
    }
    return out.join('\n').trim();
}
