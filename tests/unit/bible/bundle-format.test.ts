/**
 * The bible's Markdown bundle (src/lib/bible/bundle-format.ts, Phase 1.3):
 * the files a bible becomes, that they are a function of the bible alone,
 * that each element file's frontmatter reads back as exactly what was
 * written, and that the YAML reader refuses what it must.
 */
import {
    bundleFiles,
    decodeUtf8,
    elementFrontmatter,
    FrontmatterError,
    frontmatterOf,
    parseYamlFrontmatter,
    richTextLines,
    type BibleBundle,
} from '@/lib/bible/bundle-format';
import { BIBLE_KINDS } from '@/lib/bible/kinds';
import { getTemplate } from '@/lib/bible/templates';
import { sampleBundle } from '../../helpers/bible-bundle-fixture';

const read = (text: string) => parseYamlFrontmatter(frontmatterOf(decodeUtf8(new TextEncoder().encode(text))));

function refusal(fn: () => unknown): string {
    try {
        fn();
    } catch (err) {
        if (err instanceof FrontmatterError) return err.reason;
        throw err;
    }
    throw new Error('accepted');
}

describe('bundleFiles', () => {
    it('writes a manifest, book.md, an index per kind with entries and a file per element, in path order', () => {
        const files = bundleFiles(sampleBundle());
        expect([...files.keys()]).toEqual([
            'book.md',
            'character/_index.md',
            'character/mara-vell.md',
            'character/tam-vell.md',
            'custom/_index.md',
            'custom/tide-tables.md',
            'faction/_index.md',
            'faction/salt-guild.md',
            'manifest.json',
        ]);
        const manifest = JSON.parse(files.get('manifest.json')!) as { format: string; version: number; templateFields: Record<string, string[]> };
        expect(manifest).toMatchObject({ format: 'inkquisitor-bible', version: 1 });
        // Every kind's template keys as the writer knew them, in template order:
        // an import clears only these when a file leaves one out.
        expect(Object.keys(manifest.templateFields)).toEqual(BIBLE_KINDS.map((k) => k.toLowerCase()));
        for (const kind of BIBLE_KINDS) expect(manifest.templateFields[kind.toLowerCase()]).toEqual(getTemplate(kind).fields.map((f) => f.key));
        expect(files.get('character/_index.md')).toContain('- [Mara Vell](mara-vell.md): Draft');
    });

    it('is a function of the bible alone: the same files for the same bible, whatever order the elements and relations come in', () => {
        const a = bundleFiles(sampleBundle());
        const shuffled: BibleBundle = sampleBundle();
        const elements = [...shuffled.elements].reverse().map((e) => ({ ...e, relations: [...e.relations].reverse() }));
        const b = bundleFiles({ ...shuffled, elements });
        expect([...b]).toEqual([...a]);
    });

    it('an element file’s frontmatter reads back as what was written: types, rich text and lists kept exactly', () => {
        const bundle = sampleBundle();
        const files = bundleFiles(bundle);
        const mara = bundle.elements.find((e) => e.slug === 'mara-vell')!;
        const fm = read(files.get('character/mara-vell.md')!);
        expect(fm).toEqual(elementFrontmatter(mara));
        expect(fm).toMatchObject({
            kind: 'CHARACTER',
            slug: 'mara-vell',
            summary: 'A ferrywoman.\n\nShe owes the guild & fears the "water".',
            fields: { agency: 3, defining_traits: ['stubborn', 'dry-witted', '#first'], speaking_voice: mara.fields.get('speaking_voice') },
            relations: [
                { type: 'member_of', to: 'salt-guild', note: 'Reluctantly' },
                { type: 'sibling_of', to: 'tam-vell' },
            ],
        });
        // Field keys follow the template order, not the map's.
        expect(Object.keys((fm as { fields: object }).fields)).toEqual(['role', 'prominence', 'defining_traits', 'speaking_voice', 'agency']);
    });

    it('omits what is empty, carries a custom label only on a CUSTOM element, and reads relations from both ends in the bodies', () => {
        const files = bundleFiles(sampleBundle());
        const tam = files.get('character/tam-vell.md')!;
        expect(read(tam)).toEqual({ kind: 'CHARACTER', name: 'Tam Vell', slug: 'tam-vell', status: 'SETTLED' });
        expect(tam).toContain('- sibling of [Mara Vell](../character/mara-vell.md)');
        expect(files.get('faction/salt-guild.md')).toContain('- has member [Mara Vell](../character/mara-vell.md): Reluctantly');
        expect(read(files.get('custom/tide-tables.md')!)).toMatchObject({ customLabel: 'Almanac' });
        expect(files.get('character/mara-vell.md')).toContain('## Speaking voice\n\nShort clipped sentences & no small talk.\n- never swears');
        expect(files.get('character/mara-vell.md')).toContain('## Drive to act\n\n3 of 5 (Mostly reacts to events to Mostly forces events)');
    });

    it('puts the book’s details in book.md’s frontmatter', () => {
        expect(read(bundleFiles(sampleBundle()).get('book.md')!)).toEqual({
            title: 'The Salt Roads',
            logline: 'A ferrywoman crosses a drowned country.\n\nShe carries a debt.',
            genre: 'Fantasy',
            targetLength: 90_000,
            stage: 'PLANNING',
        });
    });
});

describe('reading frontmatter', () => {
    it('accepts a byte-order mark and CRLF line ends (a file edited on Windows)', () => {
        expect(read('﻿---\r\nname: Mara\r\nkind: CHARACTER\r\n---\r\n\r\nbody')).toEqual({ name: 'Mara', kind: 'CHARACTER' });
    });

    it('refuses a file without a frontmatter block, and bytes that are not UTF-8', () => {
        expect(refusal(() => read('# Just Markdown\n'))).toBe('FRONTMATTER_MISSING');
        expect(refusal(() => read('---\nname: x\n'))).toBe('FRONTMATTER_MISSING');
        expect(refusal(() => decodeUtf8(new Uint8Array([0x2d, 0xff, 0xfe])))).toBe('NOT_UTF8');
    });

    it('refuses any alias, so the billion-laughs expansion never starts', () => {
        expect(refusal(() => parseYamlFrontmatter('a: &x [1, 2]\nb: *x\n'))).toBe('YAML_ALIAS');
        const laughs = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
        for (let i = 1; i < 10; i++) {
            const prev = String.fromCharCode(96 + i);
            const next = String.fromCharCode(97 + i);
            laughs.push(`${next}: &${next} [${Array(9).fill(`*${prev}`).join(',')}]`);
        }
        const started = Date.now();
        expect(refusal(() => parseYamlFrontmatter(laughs.join('\n')))).toBe('YAML_ALIAS');
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it.each([['a: !!binary aGk=\n'], ['a: !custom x\n'], ['a: !!str 3\n'], ['a: !!js/function "x"\n']])('refuses an explicit tag: %s', (yaml) => {
        expect(['YAML_TAG', 'YAML_INVALID']).toContain(refusal(() => parseYamlFrontmatter(yaml)));
    });

    it('refuses a duplicate key and broken YAML', () => {
        expect(refusal(() => parseYamlFrontmatter('a: 1\na: 2\n'))).toBe('YAML_INVALID');
        expect(refusal(() => parseYamlFrontmatter('a: [1, 2\n'))).toBe('YAML_INVALID');
    });

    it('reads plain values with the core schema: no YAML 1.1 surprises', () => {
        expect(parseYamlFrontmatter('a: yes\nb: 012\nc: null\nd: "3"\n')).toEqual({ a: 'yes', b: 12, c: null, d: '3' });
    });
});

describe('richTextLines', () => {
    it('reduces rich text to its text, a line per block', () => {
        expect(richTextLines('<h2>Voice</h2><p>a &amp; <em>c</em></p><ul><li><p>x</p></li><li><p>y</p></li></ul>')).toEqual(['Voice', 'a & c', '- x', '- y']);
    });

    it('never puts markup into the readable body, even text that spells a tag (the frontmatter keeps it exactly)', () => {
        expect(richTextLines('<p>a &lt;script&gt;x&lt;/script&gt; b</p>').join(' ')).not.toMatch(/<|>/);
    });
});
