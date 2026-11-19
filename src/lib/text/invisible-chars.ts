/**
 * Invisible-character stripping, used by the AI guard's normaliser.
 *
 * Lifted from inflect-compliance's `src/lib/text/invisible-chars.ts` (see
 * docs/carve-manifest.md); the sync-text normaliser inflect keeps beside these
 * two functions is not carried. Inflect keeps this step apart from the guard
 * because a caller that COMPARES text needs it without the guard's other
 * steps: `foldHomoglyphs` maps Cyrillic `в` to `b` and destroys real names,
 * and the base64 / hex decoders APPEND decoded payloads to the text, so a
 * normaliser that can lengthen its input is unusable as a matching key.
 * Inkquisitor keeps the same separation for the question deduplication of
 * Phase 2.2, which compares author-facing text.
 *
 * ‾‾‾ WHAT IS STRIPPED ‾‾‾
 *
 * U+00AD SOFT HYPHEN, U+200B..U+200F, U+2060 WORD JOINER, U+FEFF BOM, and the bidi
 * controls U+202A..U+202E / U+2066..U+2069. Characters that are invisible on screen
 * and so can make two different strings present identically — to a scanner looking
 * for a keyword, and to a person reading the text.
 *
 * Built through the `RegExp` constructor from `\u` escapes so this source file
 * carries no invisible characters of its own. That is not fastidiousness: a literal
 * U+2028 inside a regex literal is a line terminator and makes the literal
 * unterminated, and a literal zero-width space in a character class is impossible
 * to review in a diff.
 */

/** The invisible characters both callers remove. Global; callers own `lastIndex`. */
const INVISIBLE_RE = new RegExp('[\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]', 'g');

/**
 * Remove invisible characters. `tests/unit/ai/guard-scanners.test.ts` pins the
 * class.
 */
export function stripInvisible(input: string): string {
    return input.replace(INVISIBLE_RE, '');
}

/** Whether a string carries any of them. */
export function hasInvisible(input: string): boolean {
    // A fresh regex: the shared one is global, and `test` on a global regex
    // advances `lastIndex`, so consecutive calls on the same input disagree.
    return new RegExp('[\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]').test(input);
}
