/**
 * Text for the PDF's embedded font (issue #24, owner decision 2026-11-19).
 *
 * The PDF draws with Noto Sans (./fonts.ts), which covers Latin, Latin
 * Extended, Greek and Cyrillic. Every character it covers is drawn as
 * itself, and its glyph maps back to the same character in the PDF's text
 * layer (copy, search, screen readers). A character it does not cover would
 * otherwise be drawn as the font's empty `.notdef` box, or as nothing, and
 * read back as nothing at all; so `toPdfText` replaces it with the
 * replacement character, U+FFFD `�`, which the font does draw:
 *
 * - **One `�` per user-perceived character** (grapheme cluster,
 *   `Intl.Segmenter`): a flag, a skin-toned or a family emoji is one mark,
 *   not four, and a run of N unsupported characters (CJK, emoji, Arabic, …)
 *   is N marks, so the reader sees where text is missing and how much.
 * - A cluster is drawn only if the font covers every code point in it.
 *   Invisible format characters the font lacks (variation selectors, joiners,
 *   tag characters) are dropped rather than counted against the cluster, so
 *   `©` + VS16 is `©`; a cluster that is nothing but such characters vanishes.
 * - Text is NFC-composed first, so a letter typed with a combining accent is
 *   the precomposed letter the font has.
 * - Control characters are dropped, as before: C0 but tab and line feed, DEL
 *   and C1. A tab is drawn as a space unless the font has a glyph for it.
 *
 * The rule is the same everywhere text is drawn (cover, headers, body), and
 * nothing here throws: any string becomes something drawable.
 */

/** Drawn in place of a character the font cannot draw. */
export const REPLACEMENT_CHARACTER = '�';

/** Whether the font has a glyph for a code point. */
export type CoversCodePoint = (codePoint: number) => boolean;

/** Default-ignorable format characters: dropped when the font lacks them, never replaced. */
function isIgnorable(cp: number): boolean {
    return (
        (cp >= 0x200b && cp <= 0x200f) || // zero-width space, (non-)joiner, direction marks
        (cp >= 0x2060 && cp <= 0x2064) || // word joiner, invisible operators
        cp === 0xfeff || // zero-width no-break space
        (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
        (cp >= 0xe0000 && cp <= 0xe007f) || // tag characters (emoji tag sequences)
        (cp >= 0xe0100 && cp <= 0xe01ef) // variation selectors supplement
    );
}

/** C0 controls but tab and line feed, DEL and C1. */
function isDroppedControl(cp: number): boolean {
    return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) || (cp >= 0x7f && cp < 0xa0);
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** `text` as the font can draw it; see the module header. */
export function toPdfText(text: string, covers: CoversCodePoint): string {
    let clean = '';
    for (const ch of text.normalize('NFC')) {
        const cp = ch.codePointAt(0)!;
        if (isDroppedControl(cp)) continue;
        clean += cp === 0x09 && !covers(cp) ? ' ' : ch;
    }
    let out = '';
    for (const { segment } of graphemes.segment(clean)) {
        let drawn = '';
        let drawable = true;
        for (const ch of segment) {
            const cp = ch.codePointAt(0)!;
            if (cp === 0x0a || covers(cp)) drawn += ch;
            else if (!isIgnorable(cp)) {
                drawable = false;
                break;
            }
        }
        out += drawable ? drawn : REPLACEMENT_CHARACTER;
    }
    return out;
}
