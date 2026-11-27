/**
 * The manuscript in the full export (Phase 5.H-a, D36 and the D33 addendum): a stored scene's HTML read as styled
 * blocks, written as a DOCX a word processor opens (read back here through mammoth, the same reader 5.1's import
 * uses) and as Markdown — deterministic, escaped, and never reading a tag as text or text as a tag.
 */
import mammoth from 'mammoth';
import { manuscriptDocx, manuscriptMarkdown, markdownText, xmlText, type ExportManuscript } from '@/lib/export/manuscript-files';
import { passphraseRefusal } from '@/lib/export/passphrase';
import { sceneBlocks } from '@/lib/manuscript/scene-blocks';

const SCENE = '<p>She ran for <em>the boats</em>, <strong>fast</strong>.</p><blockquote><p>A quoted line.</p></blockquote><ul><li>one</li><li>two</li></ul><hr><p>Line one<br>line two &amp; a &lt;tag&gt;</p>';

const book: ExportManuscript = {
    bookTitle: 'The Salt Roads',
    singleDefaultPart: true,
    parts: [
        {
            title: null,
            chapters: [
                { title: 'The Harbour', scenes: [{ title: 'Low tide', blocks: sceneBlocks(SCENE) }, { title: null, blocks: sceneBlocks('<p>Second scene.</p>') }] },
                { title: null, scenes: [{ title: null, blocks: sceneBlocks('<p>Third.</p>') }] },
            ],
        },
    ],
};

describe('sceneBlocks', () => {
    it('reads paragraphs, quotes, items, rules and marked runs; entities decoded once; a mention is its text', () => {
        const blocks = sceneBlocks(SCENE);
        expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'quote', 'bullet', 'bullet', 'rule', 'paragraph']);
        expect(blocks[0].runs).toEqual([
            { text: 'She ran for ', bold: false, italic: false, underline: false, strike: false },
            { text: 'the boats', bold: false, italic: true, underline: false, strike: false },
            { text: ', ', bold: false, italic: false, underline: false, strike: false },
            { text: 'fast', bold: true, italic: false, underline: false, strike: false },
            { text: '.', bold: false, italic: false, underline: false, strike: false },
        ]);
        expect(blocks[5].runs.map((r) => r.text).join('')).toBe('Line one\nline two & a <tag>');
        expect(sceneBlocks('<p>Met <span data-mention="el_1">@Wren</span>.</p>')[0].runs.map((r) => r.text).join('')).toBe('Met @Wren.');
        expect(sceneBlocks('')).toEqual([]);
        expect(sceneBlocks('<ol><li>a</li><li>b</li></ol>').map((b) => b.kind)).toEqual(['number', 'number']);
    });
});

describe('the DOCX', () => {
    it('opens in a reader with every scene’s words, the headings and the emphasis', async () => {
        const docx = manuscriptDocx(book);
        const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(docx) });
        expect(html).toContain('<h2>The Harbour</h2>');
        expect(html).toContain('<h3>Low tide</h3>');
        expect(html).toContain('<em>the boats</em>');
        expect(html).toContain('<strong>fast</strong>');
        expect(html).toContain('line two &amp; a &lt;tag&gt;');
        expect(html).toContain('Second scene.');
        expect(html).toContain('<h2>Chapter 2</h2>');
        expect(html).toContain('Third.');
        // An untitled scene after another is parted by "* * *".
        expect(html.indexOf('* * *', html.indexOf('Low tide'))).toBeLessThan(html.indexOf('Second scene.'));
    });

    it('is a function of the manuscript alone (the same bytes twice)', () => {
        expect(Buffer.from(manuscriptDocx(book)).equals(Buffer.from(manuscriptDocx(book)))).toBe(true);
    });

    it('escapes XML and drops what XML cannot hold', () => {
        expect(xmlText('a <b> & "c"')).toBe('a &lt;b&gt; &amp; &quot;c&quot;');
        expect(xmlText('ok\u0001\uD800!')).toBe('ok!');
        expect(xmlText('emoji 😀 stays')).toBe('emoji 😀 stays');
    });
});

describe('the Markdown', () => {
    it('writes headings, emphasis, quotes, items, separators and hard breaks', () => {
        const md = manuscriptMarkdown(book);
        expect(md.startsWith('# The Salt Roads\n\n## The Harbour\n\n### Low tide\n\n')).toBe(true);
        expect(md).toContain('She ran for *the boats*, **fast**.');
        expect(md).toContain('> A quoted line.');
        expect(md).toContain('- one\n\n- two');
        expect(md).toContain('Line one\\\nline two & a \\<tag\\>');
        expect(md).toContain('* * *\n\nSecond scene.');
        expect(md.endsWith('Third.\n')).toBe(true);
    });

    it('escapes what Markdown would read as markup', () => {
        expect(markdownText('*not em* # [link](x) <b>')).toBe('\\*not em\\* \\# \\[link\\](x) \\<b\\>');
    });
});

describe('passphraseRefusal', () => {
    it('asks for twelve varied characters, counted as code points', () => {
        expect(passphraseRefusal('short')).toBe('PASSPHRASE_TOO_SHORT');
        expect(passphraseRefusal('aaaaaaaaaaaaaaaa')).toBe('PASSPHRASE_TOO_SIMPLE');
        expect(passphraseRefusal('x'.repeat(257))).toBe('PASSPHRASE_TOO_LONG');
        expect(passphraseRefusal('salt roads at low tide')).toBeNull();
        expect(passphraseRefusal('čšžđćčšžđćab')).toBeNull();
        expect(passphraseRefusal('😀😃😄😁😆😅😂🤣😊😇🙂')).toBe('PASSPHRASE_TOO_SHORT'); // eleven
    });
});
