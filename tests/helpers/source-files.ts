/**
 * Small, real source files for the 4.0 tests: a DOCX (WordprocessingML with
 * heading styles, as Word writes one), an EPUB (container, OPF and XHTML
 * spine) and a PDF (pdfkit, with or without a text layer). Built in memory;
 * nothing is read from disk or the network.
 */
import * as zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import { writeZip } from '@/lib/archive/zip';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type DocPart = { heading: string; level?: 1 | 2 } | { para: string };

export function makeDocx(parts: readonly DocPart[], extra: Record<string, string> = {}): Uint8Array {
    const body = parts
        .map((p) =>
            'heading' in p
                ? `<w:p><w:pPr><w:pStyle w:val="Heading${p.level ?? 1}"/></w:pPr><w:r><w:t>${esc(p.heading)}</w:t></w:r></w:p>`
                : `<w:p><w:r><w:t xml:space="preserve">${esc(p.para)}</w:t></w:r></w:p>`,
        )
        .join('');
    const files = new Map<string, string>([
        [
            '[Content_Types].xml',
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
        ],
        ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
        ['word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
        [
            'word/styles.xml',
            '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>',
        ],
        ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`],
    ]);
    for (const [k, v] of Object.entries(extra)) files.set(k, v);
    return writeZip(files);
}

export function makeEpub(chapters: ReadonlyArray<{ title: string; paras: readonly string[] }>, extra: Record<string, string> = {}): Uint8Array {
    const files = new Map<string, string>([
        ['mimetype', 'application/epub+zip'],
        ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
        [
            'OEBPS/content.opf',
            `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>${chapters.map((_, i) => `<item id="c${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`,
        ],
    ]);
    chapters.forEach((c, i) => {
        files.set(`OEBPS/text/ch${i}.xhtml`, `<?xml version="1.0"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(c.title)}</title></head><body><h1>${esc(c.title)}</h1>${c.paras.map((p) => `<p>${esc(p)}</p>`).join('')}</body></html>`);
    });
    for (const [k, v] of Object.entries(extra)) files.set(k, v);
    return writeZip(files);
}

/** A PDF; `pages` of text, or none (shapes only: no text layer, as a scan has). */
export function makePdf(pages: readonly string[] | null): Promise<Uint8Array> {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ compress: false });
        const chunks: Buffer[] = [];
        doc.on('data', (b: Buffer) => chunks.push(b));
        doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
        if (pages === null) {
            doc.rect(40, 40, 200, 200).fill();
        } else {
            pages.forEach((text, i) => {
                if (i > 0) doc.addPage();
                doc.text(text);
            });
        }
        doc.end();
    });
}

/**
 * A small PDF whose one content stream INFLATES to `inflatedMb` megabytes of
 * whitespace (a decompression bomb: the file is a fraction of a megabyte).
 */
export function makePdfStreamBomb(inflatedMb: number): Uint8Array {
    const content = zlib.deflateSync(Buffer.concat([Buffer.from('BT\n'), Buffer.alloc(inflatedMb * 1024 * 1024, 0x20), Buffer.from('\nET\n')]), { level: 9 });
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>',
    ];
    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets: number[] = [];
    const length = () => parts.reduce((n, b) => n + b.length, 0);
    objects.forEach((o, i) => {
        offsets.push(length());
        parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`));
    });
    offsets.push(length());
    parts.push(Buffer.from(`4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, Buffer.from('\nendstream\nendobj\n'));
    const xref = length();
    parts.push(Buffer.from(`xref\n0 5\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    return new Uint8Array(Buffer.concat(parts));
}
