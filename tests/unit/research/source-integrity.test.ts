/**
 * Every kept citation of a fetched page carries the SHA-256 of the exact text
 * its quote was verified in (issue #41 item 3), so it can be proved later
 * against what was fetched; the page text itself is never stored. A file's
 * citation carries none (the file's text is stored).
 */
import { parseFindingsOutput } from '@/lib/research/schema';
import { citationProvable, sourceTextSha256, type ResearchSourceDoc } from '@/lib/research/sources';
import { sanitiseFindingForStorage } from '@/lib/research/storage';
import { validateFindings } from '@/lib/research/validate';

const TEXT = 'Medieval falconers began training by manning the bird on the fist for many hours. A hood made of leather kept the falcon calm.';
const PAGE: ResearchSourceDoc = { ref: 'web.1', kind: 'URL', url: 'https://falconry.example.org/manning', sourceId: null, title: 'Manning', text: TEXT, retrievedAt: '2026-11-20T10:00:00Z' };
const FILE: ResearchSourceDoc = { ref: 'file.1', kind: 'UPLOAD', url: null, sourceId: 'src_1', title: 'notes.md', text: TEXT, retrievedAt: null };
const QUOTE = 'A hood made of leather kept the falcon calm.';

function kept(source: ResearchSourceDoc) {
    const r = validateFindings(
        parseFindingsOutput({ findings: [{ claim: QUOTE, summary: QUOTE, confidence: 'HIGH', citations: [{ ref: source.ref, quote: QUOTE }] }] }),
        [source],
        6,
    );
    expect(r.findings).toHaveLength(1);
    return r.findings[0];
}

it('a page citation carries the hash of the text the quote was verified in, through to what is stored', () => {
    const f = kept(PAGE);
    expect(f.citations[0].sourceSha256).toBe(sourceTextSha256(TEXT));
    expect(f.citations[0].sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sanitiseFindingForStorage(f, null).citations[0].sourceSha256).toBe(sourceTextSha256(TEXT));
});

it('a file citation carries none', () => {
    const f = kept(FILE);
    expect(f.citations[0].sourceSha256).toBeNull();
    expect(sanitiseFindingForStorage(f, null).citations[0].sourceSha256).toBeNull();
});

it('a stored citation is provable against the same text, and not against a page that changed', () => {
    const stored = sanitiseFindingForStorage(kept(PAGE), null).citations[0];
    expect(citationProvable(TEXT, stored)).toBe(true);
    expect(citationProvable(TEXT.replace('many hours', 'a day'), stored)).toBe(false);
    expect(citationProvable(TEXT, { ...stored, quotedSpan: 'Falcons were never hooded.' })).toBe(false);
    expect(citationProvable(TEXT, { ...stored, sourceSha256: null })).toBe(false);
});
