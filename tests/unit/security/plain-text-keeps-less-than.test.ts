/**
 * Plain text keeps a `<` that never closes (issue #45, item 4; Phase 3.H).
 *
 * `sanitizePlainText` handed author text to an HTML parser, which reads `<b`
 * as the start of a tag and drops an unclosed one with everything after it:
 * a sticky note `if a<b then c` was stored as `if a`, and every bible field,
 * name and summary had the same loss. The fix is in the shared sanitiser, so
 * this suite holds it there and through each kind of caller (a bible text,
 * list and rich-text field, a name, a block, the canvas's freeform layer) —
 * and holds that what still forms markup is still stripped.
 */
import { Parser } from 'htmlparser2';

import { normaliseFieldValue } from '@/lib/bible/field-values';
import { richTextLines } from '@/lib/bible/bundle-format';
import { getFieldDef } from '@/lib/bible/templates';
import type { FieldDef } from '@/lib/bible/template-schema';
import { plainBlock, plainLine } from '@/lib/bible/text';
import { sanitiseFreeformRecords } from '@/lib/canvas/freeform';
import { sanitizePlainText } from '@/lib/security/sanitize';

const field = (kind: Parameters<typeof getFieldDef>[0], key: string): FieldDef => {
    const def = getFieldDef(kind, key);
    if (!def) throw new Error(`no field ${kind}.${key}`);
    return def;
};

/**
 * Elements an HTML parser makes of `html`: what "forms markup" means here. A
 * comment or declaration left open at the end of the text is inert (a browser
 * makes a comment of it, never an element), so it is not counted.
 */
function markupIn(html: string): string[] {
    const found: string[] = [];
    const parser = new Parser({ onopentag: (name) => found.push(`<${name}>`) });
    parser.write(html);
    parser.end();
    return found;
}

describe('a < that never closes is text', () => {
    it.each([
        ['if a<b then c', 'if a<b then c'],
        ['x<y', 'x<y'],
        ['ends with <', 'ends with <'],
        ['a</ b and more', 'a</ b and more'],
        ['a<! b', 'a<! b'],
        ['a<?b', 'a<?b'],
        ['a<!-- not a comment > here', 'a<!-- not a comment > here'],
        ['<3 always', '<3 always'],
        ['two <a and <b', 'two <a and <b'],
    ])('%j keeps every character', (input, expected) => {
        expect(sanitizePlainText(input)).toBe(expected);
    });

    it('an entity-encoded unclosed < is decoded and kept, not dropped', () => {
        expect(sanitizePlainText('if a&lt;b then c')).toBe('if a<b then c');
    });

    it('text after real markup is kept too: only the closed tag goes', () => {
        expect(sanitizePlainText('<b>bold</b> and a<b then c')).toBe('bold and a<b then c');
    });
});

describe('what closes is still markup, and is stripped', () => {
    it.each([
        ['<p>Hello <b>world</b></p>', 'Hello world'],
        ['safe<script>alert(1)</script>tail', 'safetail'],
        ['x<img src=x onerror=alert(1)>y', 'xy'],
        ['a<!-- hidden -->b', 'ab'],
        // A browser reads `<b and b>` as a tag too; a space after `<` keeps it text.
        ['a<b and b>c', 'ac'],
        ['a < b and b > c', 'a < b and b > c'],
    ])('%j → %j', (input, expected) => {
        expect(sanitizePlainText(input)).toBe(expected);
    });

    it('an entity-encoded closed tag is still stripped (the double-unescape defence holds)', () => {
        expect(sanitizePlainText('&lt;img src=x onerror=alert(1)&gt;ok')).toBe('ok');
        expect(sanitizePlainText('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;')).toBe('');
    });
});

/** A seeded generator (mulberry32): the same strings every run, no dependency. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const PIECES = ['<', '>', '/', '!', '?', '-', '--', 'a', 'b', 'script', 'img', ' ', '=', '"', "'", '&', 'lt;', 'gt;', '&lt;', '&amp;', 'x', '\n'];

function randomText(next: () => number): string {
    const n = 1 + Math.floor(next() * 24);
    let s = '';
    for (let i = 0; i < n; i++) s += PIECES[Math.floor(next() * PIECES.length)];
    return s;
}

describe('properties over 5,000 seeded strings', () => {
    const next = rng(0x3a45);
    const inputs = Array.from({ length: 5000 }, () => randomText(next));

    it('what is returned forms no element under an HTML parser', () => {
        const offenders = inputs.filter((s) => markupIn(sanitizePlainText(s)).length > 0);
        expect(offenders).toEqual([]);
    });

    it('is idempotent, so an exported value imports back unchanged', () => {
        const offenders = inputs.filter((s) => sanitizePlainText(sanitizePlainText(s)) !== sanitizePlainText(s));
        expect(offenders).toEqual([]);
    });

    it('loses nothing from text with no `>` and no `&` (nothing there can be markup)', () => {
        const plain = inputs.filter((s) => !s.includes('>') && !s.includes('&'));
        expect(plain.length).toBeGreaterThan(100);
        const offenders = plain.filter((s) => sanitizePlainText(s) !== s);
        expect(offenders).toEqual([]);
    });
});

describe('every caller of the sanitiser keeps the text', () => {
    it('a bible text field, list field and name line', () => {
        expect(normaliseFieldValue(field('CHARACTER', 'want'), 'to prove a<b then c')).toEqual({ ok: true, value: 'to prove a<b then c' });
        expect(normaliseFieldValue(field('CHARACTER', 'defining_traits'), ['kind <3', 'x<y'])).toEqual({ ok: true, value: ['kind <3', 'x<y'] });
        expect(plainLine('Ada <the younger')).toBe('Ada <the younger');
    });

    it('a paragraph block keeps its lines', () => {
        expect(plainBlock('first a<b\nsecond <c')).toBe('first a<b\nsecond <c');
    });

    it('a rich-text field keeps an escaped < as text, and its read-out (bundle body, PDF) shows it', () => {
        const rich = normaliseFieldValue(field('CHARACTER', 'wound'), '<p>if a&lt;b then c</p>');
        expect(rich).toEqual({ ok: true, value: '<p>if a&lt;b then c</p>' });
        expect(richTextLines('<p>if a&lt;b then c</p><p>next</p>')).toEqual(['if a<b then c', 'next']);
    });

    it('a sticky note on the canvas keeps its text', () => {
        const [note] = sanitiseFreeformRecords([{ id: 'shape:n1', typeName: 'shape', type: 'note', props: { text: 'if a<b then c' } }]);
        expect((note.props as { text: string }).text).toBe('if a<b then c');
    });
});
