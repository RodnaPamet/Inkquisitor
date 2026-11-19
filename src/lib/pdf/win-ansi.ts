/**
 * Text for PDFKit's standard fonts (Phase 1.3).
 *
 * The standard 14 fonts (Helvetica, the family the PDF helpers use) encode
 * text in WinAnsi: Latin-1 plus a few punctuation marks. A character outside
 * it has no glyph, and PDFKit writes whatever byte the low bits give, so an
 * author's Ω would print as some other letter. `toWinAnsi` keeps what the
 * fonts can draw, folds a letter with a combining accent into its composed
 * form first (NFC), and shows anything else as `?` — visible, never a wrong
 * letter. Control characters (but tab and line feed) are dropped.
 *
 * Embedding a Unicode font would print every script; it is a recorded
 * follow-up, not done here.
 */

/** The code points above Latin-1 that WinAnsi (Windows-1252) also carries. */
const WIN_ANSI_EXTRA = new Set(
    [0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178],
);

export function toWinAnsi(text: string): string {
    let out = '';
    for (const ch of text.normalize('NFC')) {
        const cp = ch.codePointAt(0)!;
        if (cp === 0x09 || cp === 0x0a) out += ch;
        else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
        else if (cp <= 0xff || WIN_ANSI_EXTRA.has(cp)) out += ch;
        else out += '?';
    }
    return out;
}
