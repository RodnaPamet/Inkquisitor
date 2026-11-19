/**
 * `toPdfText` (src/lib/pdf/text.ts, issue #24): what the font covers is kept
 * exactly; what it does not is one `�` per user-perceived character; format
 * characters the font lacks are dropped, never counted as missing; controls
 * are dropped. Against a stated coverage, then against the real font's.
 */
import { pdfFontCovers, drawableText } from '@/lib/pdf/fonts';
import { REPLACEMENT_CHARACTER as R, toPdfText } from '@/lib/pdf/text';

/** ASCII and U+FFFD only. */
const asciiOnly = (cp: number) => (cp >= 0x20 && cp < 0x7f) || cp === 0xfffd;

describe('toPdfText', () => {
    it('keeps what the font covers and replaces each other character with one mark', () => {
        expect(toPdfText('plain text', asciiOnly)).toBe('plain text');
        expect(toPdfText('a中b文', asciiOnly)).toBe(`a${R}b${R}`);
        expect(toPdfText('Жx', asciiOnly)).toBe(`${R}x`);
    });

    it('counts a grapheme cluster once: skin tones, families and flags are one mark each', () => {
        expect(toPdfText('👍🏽', asciiOnly)).toBe(R);
        expect(toPdfText('👨‍👩‍👧', asciiOnly)).toBe(R);
        expect(toPdfText('🇧🇬', asciiOnly)).toBe(R);
        expect(toPdfText('🏴󠁧󠁢󠁳󠁣󠁴󠁿', asciiOnly)).toBe(R); // a tag sequence
        expect(toPdfText('x😀😀y', asciiOnly)).toBe(`x${R}${R}y`);
    });

    it('drops a format character the font lacks instead of replacing what it modifies', () => {
        expect(toPdfText('a️b', asciiOnly)).toBe('ab');
        expect(toPdfText('a​b', asciiOnly)).toBe('ab');
        expect(toPdfText('️', asciiOnly)).toBe('');
    });

    it('composes accents first, so a decomposed letter the font has is drawn', () => {
        const covers = (cp: number) => asciiOnly(cp) || cp === 0xe9;
        expect(toPdfText('café', covers)).toBe('café');
        // A combining mark the font lacks takes its whole character with it.
        expect(toPdfText('e⃝!', covers)).toBe(`${R}!`);
    });

    it('drops controls but tab and line feed, and draws a tab the font lacks as a space', () => {
        expect(toPdfText('a\u0000b\tc\nd\u0085e\u007f\r', asciiOnly)).toBe('ab c\nde');
        expect(toPdfText('a\tb', (cp) => asciiOnly(cp) || cp === 0x09)).toBe('a\tb');
    });

    it('never throws, and keeps a typed replacement character as itself', () => {
        expect(toPdfText('', asciiOnly)).toBe('');
        expect(toPdfText('\uD800 lone', asciiOnly)).toBe(`${R} lone`);
        expect(toPdfText(R, asciiOnly)).toBe(R);
    });
});

describe('the Noto Sans coverage', () => {
    it('covers Latin, Latin Extended, Greek and Cyrillic, and the replacement character', () => {
        const ranges: Array<[string, number, number]> = [
            ['Basic Latin', 0x20, 0x7e],
            ['Latin-1 letters', 0xc0, 0xff],
            ['Latin Extended-A', 0x100, 0x17f],
            ['Greek capitals', 0x391, 0x3a1],
            ['Greek capitals', 0x3a3, 0x3a9],
            ['Greek small', 0x3b1, 0x3c9],
            ['Cyrillic', 0x400, 0x45f],
        ];
        for (const [name, from, to] of ranges) {
            const missing: string[] = [];
            for (let cp = from; cp <= to; cp++) if (!pdfFontCovers(cp)) missing.push(cp.toString(16));
            expect([name, missing]).toEqual([name, []]);
        }
        expect(pdfFontCovers(0xfffd)).toBe(true);
    });

    it('does not cover CJK or emoji, which therefore print as marks', () => {
        expect(drawableText('Тайфун 台風 😀')).toBe(`Тайфун ${R}${R} ${R}`);
    });
});
