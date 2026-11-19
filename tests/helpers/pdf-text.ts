/**
 * The text a PDFKit document draws, for tests (Phase 1.3): every content
 * stream inflated, every `[…] TJ` array's hex strings joined and decoded as
 * WinAnsi (the encoding of PDFKit's standard fonts). One string per text
 * operation, in drawing order. Enough to assert that a PDF names what it
 * should; not a general PDF parser.
 */
import { inflateSync } from 'node:zlib';

/** The WinAnsi bytes 0x80–0x9F that are not Latin-1. */
const WIN_ANSI_HIGH: Readonly<Record<number, string>> = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
    0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
    0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodeHex(hex: string): string {
    let out = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
        const b = parseInt(hex.slice(i, i + 2), 16);
        out += WIN_ANSI_HIGH[b] ?? String.fromCharCode(b);
    }
    return out;
}

export function pdfTextRuns(pdf: Uint8Array): string[] {
    const source = Buffer.from(pdf).toString('latin1');
    const runs: string[] = [];
    const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    for (let m = streams.exec(source); m; m = streams.exec(source)) {
        let content: string;
        try {
            content = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
        } catch {
            continue; // not a deflated content stream (a font, an image)
        }
        const arrays = /\[((?:<[0-9a-fA-F]*>|[^\]])*)\]\s*TJ/g;
        for (let a = arrays.exec(content); a; a = arrays.exec(content)) {
            runs.push([...a[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => decodeHex(h[1])).join(''));
        }
    }
    return runs;
}

/** Every text run joined with newlines. */
export function pdfText(pdf: Uint8Array): string {
    return pdfTextRuns(pdf).join('\n');
}
