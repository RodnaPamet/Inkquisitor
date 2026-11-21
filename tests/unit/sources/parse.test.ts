/**
 * Reading an upload (Phase 4.0, D26): every format sniffed from its bytes and
 * read into blocks, and every refusal named — no text layer, a zip bomb, an
 * entity-declaring XML part, a wrong format, an oversize text.
 */
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { readZip, writeZip } from '@/lib/archive/zip';
import { blocksFromHtml, blocksFromMarkdown, blocksFromPlainText, isBreakLine, isChapterLine } from '@/lib/sources/document';
import { parseSource, resolveZipPath, sniffFormat, SOURCE_ZIP_LIMITS, SourceRefusal } from '@/lib/sources/parse';
import { SOURCE_TEXT_MAX_CHARS } from '@/lib/sources/vocabulary';
import { makeDocx, makeEpub, makePdf } from '../../helpers/source-files';

const utf8 = (s: string) => new TextEncoder().encode(s);

async function refusal(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (err) {
        if (err instanceof SourceRefusal) return err.detail ? `${err.reason}:${err.detail}` : err.reason;
        throw err;
    }
    return 'NOT_REFUSED';
}

describe('blocks', () => {
    it('reads HTML headings, paragraphs and breaks with a parser (entities decoded once, script dropped)', () => {
        const blocks = blocksFromHtml('<h1>Part One</h1><h2>Chapter &amp; Verse</h2><p>Wren &lt;b&gt; swam.</p><script>alert(1)</script><hr/><p>Next</p>');
        expect(blocks).toEqual([
            { kind: 'heading', level: 1, text: 'Part One' },
            { kind: 'heading', level: 2, text: 'Chapter & Verse' },
            { kind: 'para', text: 'Wren <b> swam.' },
            { kind: 'break', strength: 'scene' },
            { kind: 'para', text: 'Next' },
        ]);
    });

    it('reads Markdown headings and scene breaks', () => {
        expect(blocksFromMarkdown('# Book\n\n## Chapter 1\n\nOne line\ncontinues.\n\n***\n\nTwo')).toEqual([
            { kind: 'heading', level: 1, text: 'Book' },
            { kind: 'heading', level: 2, text: 'Chapter 1' },
            { kind: 'para', text: 'One line continues.' },
            { kind: 'break', strength: 'scene' },
            { kind: 'para', text: 'Two' },
        ]);
    });

    it('finds chapter lines and break lines in plain text, and nothing in ordinary sentences', () => {
        expect(isChapterLine('Chapter 3')).toBe(true);
        expect(isChapterLine('CHAPTER THREE: The River')).toBe(true);
        expect(isChapterLine('Prologue')).toBe(true);
        expect(isChapterLine('Chapter one was over, she thought.')).toBe(false);
        expect(isBreakLine('* * *')).toBe(true);
        expect(isBreakLine('---')).toBe(true);
        expect(isBreakLine('a - b')).toBe(false);
        expect(blocksFromPlainText('Chapter 1\nShe ran.\n\n* * *\n\nHe stayed.').map((b) => b.kind)).toEqual(['heading', 'para', 'break', 'para']);
    });
});

describe('sniffing', () => {
    it('reads the format from the bytes, the name only telling Markdown from text', () => {
        expect(sniffFormat(utf8('# Hi'), 'notes.md').format).toBe('MARKDOWN');
        expect(sniffFormat(utf8('# Hi'), 'notes.txt').format).toBe('TXT');
        // A DOCX named .txt is a DOCX: the bytes decide.
        expect(sniffFormat(makeDocx([{ para: 'Hello there.' }]), 'renamed.txt').format).toBe('DOCX');
        expect(sniffFormat(makeEpub([{ title: 'One', paras: ['A'] }]), 'book.docx').format).toBe('EPUB');
    });

    it('is never fooled into the PDF reader by a text or an archive that mentions %PDF- near its start', async () => {
        // A note about PDFs is a note.
        expect(sniffFormat(utf8('Printer notes: %PDF-1.7 is the version it wants.\nWren never learned to swim.'), 'notes.txt').format).toBe('TXT');
        expect(sniffFormat(utf8('# Export settings\n\nUse %PDF-1.4 for the proof copy.'), 'notes.md').format).toBe('MARKDOWN');
        // A DOCX whose first entry's name holds the marker is a DOCX, and reads as one.
        const entries = readZip(makeDocx([{ para: 'Wren never learned to swim.' }]), SOURCE_ZIP_LIMITS);
        const docx = writeZip(new Map<string, string | Uint8Array>([['%PDF-1.7 notes.txt', 'x'], ...entries]));
        expect(Buffer.from(docx.subarray(0, 1024)).toString('latin1')).toContain('%PDF-');
        expect(sniffFormat(docx, 'draft.docx').format).toBe('DOCX');
        expect((await parseSource(docx, 'draft.docx', { readPdf: async () => ({ ok: false, reason: 'SOURCE_PARSE_FAILED' }) })).blocks).toEqual([{ kind: 'para', text: 'Wren never learned to swim.' }]);
        // A real PDF still reads as one: at byte 0, or behind junk in bytes that are not text.
        expect(sniffFormat(utf8('%PDF-1.7\n'), 'x.pdf').format).toBe('PDF');
        expect(sniffFormat(new Uint8Array([0xff, 0xfe, 0x00, ...utf8('%PDF-1.7\n'), 0xe2, 0xe3]), 'x.pdf').format).toBe('PDF');
    });

    it('refuses what is none of the five', async () => {
        expect(await refusal(parseSource(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'photo.jpg'))).toBe('SOURCE_TYPE');
        expect(await refusal(parseSource(writeZip(new Map([['readme.txt', 'x']])), 'a.zip'))).toBe('SOURCE_TYPE');
        expect(await refusal(parseSource(utf8('a\u0000b'), 'bin.txt'))).toBe('SOURCE_TYPE');
        expect(await refusal(parseSource(new Uint8Array(), 'empty.txt'))).toBe('SOURCE_EMPTY');
        expect(await refusal(parseSource(utf8('   \n\n  '), 'blank.txt'))).toBe('SOURCE_EMPTY');
    });
});

describe('DOCX', () => {
    it('reads headings and paragraphs through mammoth', async () => {
        const parsed = await parseSource(makeDocx([{ heading: 'Chapter 3' }, { para: 'Wren never learned to swim.' }]), 'draft.docx');
        expect(parsed.format).toBe('DOCX');
        expect(parsed.blocks).toEqual([
            { kind: 'heading', level: 1, text: 'Chapter 3' },
            { kind: 'para', text: 'Wren never learned to swim.' },
        ]);
    });

    it('refuses an XML part that declares an entity (the billion laughs)', async () => {
        const bomb = makeDocx([{ para: 'x' }], {
            'word/document.xml': '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>',
        });
        expect(await refusal(parseSource(bomb, 'bomb.docx'))).toBe('SOURCE_XML_REFUSED');
    });

    it('refuses an entity in a part of ANY name (mammoth follows the relationships), in UTF-16 too, and a DTD', async () => {
        const entity = '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:body></w:document>';
        const elsewhere = makeDocx([{ para: 'x' }], {
            '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/main.part"/></Relationships>',
            'word/main.part': entity,
        });
        expect(await refusal(parseSource(elsewhere, 'renamed-part.docx'))).toBe('SOURCE_XML_REFUSED');
        const utf16 = writeZip(new Map<string, Uint8Array | string>([...readZip(makeDocx([{ para: 'x' }]), SOURCE_ZIP_LIMITS), ['word/document.xml', new Uint8Array(Buffer.from(`\ufeff${entity}`, 'utf16le'))]]));
        expect(await refusal(parseSource(utf16, 'utf16.docx'))).toBe('SOURCE_XML_REFUSED');
        const parameter = makeDocx([{ para: 'x' }], { 'word/settings.xml': '<?xml version="1.0"?><!DOCTYPE s [<!ENTITY % p "x">]><s/>' });
        expect(await refusal(parseSource(parameter, 'param.docx'))).toBe('SOURCE_XML_REFUSED');
        const external = makeDocx([{ para: 'x' }], { 'word/settings.xml': '<?xml version="1.0"?><!DOCTYPE s SYSTEM "http://evil.example/x.dtd"><s/>' });
        expect(await refusal(parseSource(external, 'dtd.docx'))).toBe('SOURCE_XML_REFUSED');
    });

    it('never inlines an image: a photo-heavy draft is read for its words, not refused as too long', async () => {
        // 10 MB of photo (incompressible bytes): as a data URI it would pass the text bound alone.
        const photo = new Uint8Array(randomBytes(10 * 1024 * 1024));
        const drawing =
            '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="1" name="Cover"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId9"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
        const docx = writeZip(
            new Map<string, Uint8Array | string>([
                ...readZip(makeDocx([{ para: 'Wren never learned to swim.' }]), SOURCE_ZIP_LIMITS),
                ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${drawing}<w:p><w:r><w:t>Wren never learned to swim.</w:t></w:r></w:p></w:body></w:document>`],
                [
                    'word/_rels/document.xml.rels',
                    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/cover.png"/></Relationships>',
                ],
                ['word/media/cover.png', photo],
            ]),
        );
        const parsed = await parseSource(docx, 'photos.docx');
        expect(parsed.blocks).toEqual([{ kind: 'para', text: 'Wren never learned to swim.' }]);
    }, 30_000);

    it('refuses a zip bomb before inflating it (an entry far past its ratio)', async () => {
        const zeros = Buffer.alloc(5 * 1024 * 1024);
        const deflated = deflateSync(zeros, { level: 9 });
        // A hand-built archive: one stored-name entry whose deflate data inflates 1000x.
        const name = Buffer.from('word/document.xml');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(deflated.length, 18);
        local.writeUInt32LE(zeros.length, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(deflated.length, 20);
        central.writeUInt32LE(zeros.length, 24);
        central.writeUInt16LE(name.length, 28);
        const localPart = Buffer.concat([local, name, deflated]);
        const centralPart = Buffer.concat([central, name]);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(1, 8);
        eocd.writeUInt16LE(1, 10);
        eocd.writeUInt32LE(centralPart.length, 12);
        eocd.writeUInt32LE(localPart.length, 16);
        const zip = new Uint8Array(Buffer.concat([localPart, centralPart, eocd]));
        expect(await refusal(parseSource(zip, 'bomb.docx'))).toBe('SOURCE_ARCHIVE_REFUSED:ENTRY_RATIO');
    });
});

describe('EPUB', () => {
    it('reads the spine in order, a chapter break between documents', async () => {
        const parsed = await parseSource(makeEpub([{ title: 'One', paras: ['First.'] }, { title: 'Two', paras: ['Second.'] }]), 'book.epub');
        expect(parsed.format).toBe('EPUB');
        expect(parsed.blocks).toEqual([
            { kind: 'heading', level: 1, text: 'One' },
            { kind: 'para', text: 'First.' },
            { kind: 'break', strength: 'chapter' },
            { kind: 'heading', level: 1, text: 'Two' },
            { kind: 'para', text: 'Second.' },
        ]);
    });

    it('never reads above the archive root, and refuses an entity declaration', async () => {
        expect(resolveZipPath('OEBPS', '../../etc/passwd')).toBeNull();
        expect(resolveZipPath('OEBPS', 'text/../ch.xhtml')).toBe('OEBPS/ch.xhtml');
        expect(resolveZipPath('OEBPS', 'https://evil.example/x')).toBeNull();
        const bomb = makeEpub([{ title: 'One', paras: ['x'] }], { 'OEBPS/text/ch0.xhtml': '<?xml version="1.0"?><!DOCTYPE html [<!ENTITY lol "lol">]><html><body><p>&lol;</p></body></html>' });
        expect(await refusal(parseSource(bomb, 'bomb.epub'))).toBe('SOURCE_XML_REFUSED');
    });
});

describe('PDF', () => {
    it('reads a text layer in the bounded worker', async () => {
        const parsed = await parseSource(await makePdf(['Chapter One', 'Wren never learned to swim.']), 'book.pdf');
        expect(parsed.format).toBe('PDF');
        const text = parsed.blocks.map((b) => ('text' in b ? b.text : '|')).join(' ');
        expect(text).toContain('Wren never learned to swim.');
        expect(parsed.blocks.some((b) => b.kind === 'heading' && b.text === 'Chapter One')).toBe(true);
    }, 30_000);

    it('refuses a PDF with no text layer by name (no OCR, D26)', async () => {
        expect(await refusal(parseSource(await makePdf(null), 'scan.pdf'))).toBe('SOURCE_NO_TEXT_LAYER');
    }, 30_000);

    it('names the reader’s own refusals', async () => {
        expect(await refusal(parseSource(utf8('%PDF-1.7 not really'), 'x.pdf', { readPdf: async () => ({ ok: false, reason: 'SOURCE_PARSE_TIMEOUT' }) }))).toBe('SOURCE_PARSE_TIMEOUT');
        expect(await refusal(parseSource(utf8('%PDF-1.7'), 'x.pdf', { readPdf: async () => ({ ok: false, reason: 'SOURCE_ENCRYPTED' }) }))).toBe('SOURCE_ENCRYPTED');
    });
});

describe('size', () => {
    it('refuses a text past the source bound', async () => {
        expect(await refusal(parseSource(utf8('a '.repeat(SOURCE_TEXT_MAX_CHARS / 2 + 10)), 'huge.txt'))).toBe('SOURCE_TOO_LONG');
    });
});
