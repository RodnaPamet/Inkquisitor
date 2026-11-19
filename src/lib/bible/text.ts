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
 * Both also remove control characters (`stripControlChars`): C0 controls but
 * tab, line feed and carriage return, and DEL. PostgreSQL refuses a NUL in a
 * text column outright (a 500 for the whole save), and an encoded one
 * (`&#0;`) survives a schema check only to be decoded by the sanitiser, so
 * the strip runs on what the sanitiser returns.
 *
 * Both trim. An empty result is `''`; the caller decides whether that clears
 * an optional value or refuses a required one, and bounds the length of what
 * is left (the stored value, not the raw input).
 */
import { sanitizePlainText } from '@/lib/security/sanitize';

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** `input` without C0 controls (tab, LF and CR kept) and DEL. */
export function stripControlChars(input: string): string {
    return input.replace(CONTROL_CHARS, '');
}

export function plainLine(input: string): string {
    return stripControlChars(sanitizePlainText(input)).replace(/\s+/g, ' ').trim();
}

export function plainBlock(input: string): string {
    // Line by line rather than one regex over the whole value: a pattern like
    // /[ \t]+\n/ backtracks quadratically over a long run of spaces.
    const lines = stripControlChars(sanitizePlainText(input))
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
