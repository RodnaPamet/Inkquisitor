/**
 * Ranking in memory (Phase 3.4, decision D21): BM25F with field weights,
 * exact before stem, exact case as a signal, phrases required and boosted,
 * snippets in plain text with their highlight offsets, the skipping of
 * unmatchable sources that never changes a result, and the counted work.
 */
import { createAnalyzer } from '@/lib/search/analyse';
import { parseQuery, type ParsedQuery } from '@/lib/search/query';
import { candidateNeedles, mergeSpans, rankDocuments, snippetOf, type SearchDocument, type SearchSource } from '@/lib/search/rank';
import { SEARCH_MATCHES_PER_RESULT, SNIPPET_MAX_CHARS } from '@/lib/search/vocabulary';

const FILLER = 'The keeper climbed the stair and watched the water turn grey under a low sky';

function q(text: string, analyzer = createAnalyzer('en')): ParsedQuery {
    const r = parseQuery(text, analyzer);
    if (!r.ok) throw new Error(r.reason);
    return r.query;
}

function el(name: string, sources: Array<Partial<SearchSource> & Pick<SearchSource, 'kind' | 'text'>>, id = name.toLowerCase().replace(/\W+/g, '-')): SearchDocument {
    return { kind: 'element', elementId: id, elementKind: 'CHARACTER', name, customLabel: null, sources: [{ kind: 'name', text: name }, ...sources] };
}

function rank(docs: SearchDocument[], text: string, limit = 50) {
    const analyzer = createAnalyzer('en');
    return rankDocuments(docs, q(text, analyzer), analyzer, { limit });
}

/** A book of neutral elements, so document frequencies are not degenerate. */
const background = Array.from({ length: 20 }, (_, i) => el(`Filler ${i}`, [{ kind: 'summary', text: FILLER }]));

describe('field weights: a name beats a summary, which beats field text', () => {
    it('orders the same word by where it stands', () => {
        const docs = [
            el('Ilse', [{ kind: 'field', text: `${FILLER} lantern`, fieldKey: 'role', fieldLabel: 'Role' }]),
            el('Lantern', []),
            el('Wenna', [{ kind: 'summary', text: `${FILLER} lantern` }]),
            ...background,
        ];
        expect(rank(docs, 'lantern').hits.map((h) => h.name)).toEqual(['Lantern', 'Wenna', 'Ilse']);
    });
});

describe('matching', () => {
    it('finds stemmed variants, and ranks an exact surface match above a stem match', () => {
        const docs = [el('A', [{ kind: 'summary', text: `${FILLER}, then ran.` }]), el('B', [{ kind: 'summary', text: `${FILLER}, then running.` }]), ...background];
        const r = rank(docs, 'running');
        expect(r.hits.map((h) => h.name)).toEqual(['B', 'A']);
    });

    it('a capitalised query word prefers the exact-case name, without excluding the lower-case word', () => {
        const docs = [
            el('Ilse', [{ kind: 'summary', text: 'She keeps hope alive through the winter nights.' }]),
            el('Wenna', [{ kind: 'summary', text: 'She named the boat Hope after her sister.' }]),
            ...background,
        ];
        expect(rank(docs, 'Hope').hits.map((h) => h.name)).toEqual(['Wenna', 'Ilse']);
        // Lower case asks for no case: the two tie on the word and fall to the name.
        expect(rank(docs, 'hope').hits.map((h) => h.name)).toEqual(['Ilse', 'Wenna']);
    });

    it('a phrase is required and matched in sequence by surface form', () => {
        const docs = [
            el('A', [{ kind: 'summary', text: 'the red door and a blue one' }]),
            el('B', [{ kind: 'summary', text: 'a door, red with rust' }]),
            el('C', [{ kind: 'summary', text: 'the red doors' }]),
            ...background,
        ];
        expect(rank(docs, '"red door"').hits.map((h) => h.name)).toEqual(['A']);
        // Words beside a phrase only rank among the elements that hold it.
        expect(rank(docs, 'rust "red door"').hits.map((h) => h.name)).toEqual(['A']);
        // Unquoted, all three hold the words.
        expect(rank(docs, 'red door').hits.map((h) => h.name).sort()).toEqual(['A', 'B', 'C']);
    });

    it('a phrase never runs across a block: a paragraph or list break between its words is no match (Phase 3.H, #48 item 2)', () => {
        const docs = [
            // Rich text read as plain text: each block is a line (`HtmlTextReader`), and so is each list item.
            el('Across', [{ kind: 'field', text: 'The tide came in at the end\nStart of the second watch' }]),
            el('Items', [{ kind: 'field', text: 'a lamp at the end\nstart again' }]),
            el('Within', [{ kind: 'field', text: 'From the end start the count again' }]),
            ...background,
        ];
        expect(rank(docs, '"end start"').hits.map((h) => h.name)).toEqual(['Within']);
        // Unquoted, the words still match wherever they stand.
        expect(rank(docs, 'end start').hits.map((h) => h.name).sort()).toEqual(['Across', 'Items', 'Within']);
    });

    it('a word the irregular table changes still finds the words its regular stem shares (Phase 3.H, #48 item 3)', () => {
        const docs = [
            el('Brokenly', [{ kind: 'summary', text: 'She spoke brokenly of the wreck.' }]),
            el('Broke', [{ kind: 'summary', text: 'The mast broke in the gale.' }]),
            el('Broken', [{ kind: 'summary', text: 'A broken oar.' }]),
            ...background,
        ];
        // "broken" is the lemma break's (broke, broken) AND Porter2's own stem broken (brokenly).
        expect(rank(docs, 'broken').hits.map((h) => h.name).sort()).toEqual(['Broke', 'Broken', 'Brokenly']);
        // And the other way: "brokenly" finds "broken", not "broke" (a different regular stem).
        expect(rank(docs, 'brokenly').hits.map((h) => h.name).sort()).toEqual(['Broken', 'Brokenly']);
    });

    it('a phrase counts as its own signal: holding the words in sequence ranks above holding them apart', () => {
        const docs = [el('Apart', [{ kind: 'summary', text: 'red paint on the old door' }]), el('Together', [{ kind: 'summary', text: 'paint on the old red door' }]), ...background];
        const analyzer = createAnalyzer('en');
        const both = q('red door', analyzer);
        const withPhrase: ParsedQuery = { ...both, phrases: [{ surfaces: ['red', 'door'] }] };
        expect(rankDocuments(docs, withPhrase, analyzer, { limit: 10 }).hits.map((h) => h.name)).toEqual(['Together']);
        expect(rankDocuments(docs, both, analyzer, { limit: 10 }).hits.map((h) => h.name).sort()).toEqual(['Apart', 'Together']);
    });

    it('a quoted single word matches its surface form only', () => {
        const docs = [el('A', [{ kind: 'summary', text: 'she runs' }]), el('B', [{ kind: 'summary', text: 'she was running' }]), ...background];
        expect(rank(docs, '"running"').hits.map((h) => h.name)).toEqual(['B']);
        expect(rank(docs, 'running').hits.map((h) => h.name)).toEqual(['B', 'A']);
    });

    it('rarer words weigh more (inverse document frequency)', () => {
        const docs = [
            el('Common', [{ kind: 'summary', text: 'water water' }]),
            el('Rare', [{ kind: 'summary', text: 'lighthouse' }]),
            ...background.map((d) => ({ ...d, sources: [...d.sources, { kind: 'field' as const, text: 'water' }] })),
        ];
        expect(rank(docs, 'water lighthouse').hits[0].name).toBe('Rare');
    });

    it('matches nothing and returns nothing for words the book does not hold', () => {
        const r = rank([el('A', [{ kind: 'summary', text: FILLER }])], 'zebra');
        expect(r).toMatchObject({ hits: [], totalHits: 0, truncated: false });
    });

    it('caps the hits and says it did', () => {
        const docs = Array.from({ length: 12 }, (_, i) => el(`Lamp ${i}`, []));
        const r = rank(docs, 'lamp', 5);
        expect(r.hits).toHaveLength(5);
        expect(r.totalHits).toBe(12);
        expect(r.truncated).toBe(true);
    });

    it('breaks ties by name, then id, never by chance', () => {
        const docs = [el('Same', [], 'b'), el('Same', [], 'a'), el('Alpha same', [], 'c')];
        expect(rank(docs, 'same').hits.map((h) => h.elementId)).toEqual(['a', 'b', 'c']);
    });
});

describe('a result', () => {
    it('names its matched sources best first, at most a few, with how many matched', () => {
        const doc = el('Ilse', [
            { kind: 'field', text: 'lamp', fieldKey: 'want', fieldLabel: 'Want' },
            { kind: 'summary', text: 'The lamp keeper' },
            { kind: 'relationNote', text: 'met at the lamp', otherElementName: 'Wenna' },
            { kind: 'field', text: 'a lamp of brass', fieldKey: 'object', fieldLabel: 'Object' },
        ]);
        const [hit] = rank([doc, ...background], 'lamp').hits;
        expect(hit.matchedSourceCount).toBe(4);
        expect(hit.matches).toHaveLength(SEARCH_MATCHES_PER_RESULT);
        expect(hit.matches[0].source).toBe('summary');
        expect(hit.matches.find((m) => m.source === 'relationNote')?.otherElementName ?? 'Wenna').toBe('Wenna');
        expect(hit.matches.find((m) => m.source === 'field')).toMatchObject({ fieldKey: 'want', fieldLabel: 'Want' });
    });

    it('highlights every matched word by offsets into its snippet, which is plain text', () => {
        const text = 'Ilse ran to the light. Running, she kept running.';
        const [hit] = rank([el('Ilse', [{ kind: 'summary', text }]), ...background], 'run').hits;
        const snippet = hit.matches[0].snippet;
        expect(snippet.text).toBe(text);
        expect(snippet.highlights.map((h) => snippet.text.slice(h.start, h.end))).toEqual(['ran', 'Running', 'running']);
    });

    it('highlights a phrase as one range', () => {
        const [hit] = rank([el('A', [{ kind: 'summary', text: 'Past the red door, left.' }]), ...background], '"red door"').hits;
        const s = hit.matches[0].snippet;
        expect(s.highlights.map((h) => s.text.slice(h.start, h.end))).toEqual(['red door']);
    });
});

describe('snippets', () => {
    it('cut a long source around the first match, at spaces, saying what was cut', () => {
        const before = 'word '.repeat(80);
        const after = ' more'.repeat(80);
        const text = `${before}lighthouse keeper${after}`;
        const s = snippetOf(text, [{ start: before.length, end: before.length + 'lighthouse'.length }]);
        expect(s.text.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
        expect(s.cutBefore && s.cutAfter).toBe(true);
        expect(s.text.startsWith('word')).toBe(true);
        expect(s.text.endsWith('more')).toBe(true);
        expect(text.slice(s.start, s.start + s.text.length)).toBe(s.text);
        expect(s.highlights.map((h) => s.text.slice(h.start, h.end))).toEqual(['lighthouse']);
    });

    it('a short source is its whole snippet', () => {
        expect(snippetOf('the lamp', [{ start: 4, end: 8 }])).toEqual({ text: 'the lamp', start: 0, cutBefore: false, cutAfter: false, highlights: [{ start: 4, end: 8 }] });
    });

    it('merge overlapping highlights', () => {
        expect(mergeSpans([{ start: 5, end: 9 }, { start: 0, end: 3 }, { start: 3, end: 6 }, { start: 12, end: 14 }])).toEqual([
            { start: 0, end: 9 },
            { start: 12, end: 14 },
        ]);
    });
});

describe('skipping sources that cannot match', () => {
    const corpus: SearchDocument[] = [
        el('Ilse', [{ kind: 'summary', text: 'She went down to the cove. Her children ran; the mice hid.' }]),
        el('Café Hope', [{ kind: 'summary', text: 'Zoë’s café, where they had gone running before.' }]),
        el('Wenna', [{ kind: 'field', text: 'Happiness is a lantern; generously given, generally lost.' }]),
        el('Søren', [{ kind: 'relationNote', text: 'The authors’ ΟΔΟΣ, a ﬁne line.' }]),
        el('Wreck', [{ kind: 'field', text: 'He spoke brokenly; the oar was broken, the mast broke.\nWent home' }]),
        ...background,
    ];

    it.each(['go', 'went', 'run', 'running', 'mouse', 'child', 'cafe', 'Hope', 'happy', 'generous', 'general', 'author', 'οδος', 'fine', 'soren', '"had gone"', '"the cove"', 'zoe', 'keeper', 'nothing', 'broken', 'brokenly', 'broke', 'went', '"broke went"'])(
        '%s: the same results whether unmatchable sources are skipped or not',
        (text) => {
            const a = createAnalyzer('en');
            const query = q(text, a);
            const skipped = rankDocuments(corpus, query, a, { limit: 50 });
            const full = rankDocuments(corpus, query, createAnalyzer('en'), { limit: 50, skipUnmatchable: false });
            expect(skipped.hits).toEqual(full.hits);
            expect(skipped.totalHits).toBe(full.totalHits);
            expect(skipped.work.sourcesTokenised).toBeLessThanOrEqual(full.work.sourcesTokenised);
        },
    );

    it('finds a word spelled with any apostrophe, skipping or not, whichever apostrophe the query uses', () => {
        const spellings = ["'", '’', '`', '´', '′'];
        for (const inText of spellings) {
            const docs = [el('Ilse', [{ kind: 'field', text: `She said don${inText}t go to the reef.` }]), ...background];
            for (const inQuery of spellings) {
                const a = createAnalyzer('en');
                const skipped = rankDocuments(docs, q(`don${inQuery}t`, a), a, { limit: 50 });
                const full = rankDocuments(docs, q(`don${inQuery}t`), createAnalyzer('en'), { limit: 50, skipUnmatchable: false });
                expect([inText, inQuery, skipped.hits.map((h) => h.name), full.hits.map((h) => h.name)]).toEqual([inText, inQuery, ['Ilse'], ['Ilse']]);
                const snippet = skipped.hits[0].matches[0].snippet;
                expect(snippet.highlights.map((h) => snippet.text.slice(h.start, h.end))).toEqual([`don${inText}t`]);
            }
        }
    });

    it('a word skips every source that does not hold its needle', () => {
        const r = rank(corpus, 'lantern');
        expect(r.work.sourcesTokenised).toBe(1);
        expect(r.work.sourcesRead).toBe(corpus.reduce((n, d) => n + d.sources.length, 0));
    });

    it('needles: a stem’s prefix and its irregular forms, a phrase’s first word, a quoted word', () => {
        // "went" stems as go (the table) and as went (Porter2's own, Phase 3.H): both stems' needles.
        expect(candidateNeedles(q('went'), { language: 'en' }).sort()).toEqual(['g', 'goes', 'gone', 'went', 'we'].sort());
        expect(candidateNeedles(q('lighthouses "red door" "Ran"'), { language: 'en' }).sort()).toEqual(['lightho', 'ran', 'red'].sort());
        expect(candidateNeedles(q('running', createAnalyzer('other')), { language: 'other' })).toEqual(['running']);
    });
});

describe('counted work', () => {
    const book = (n: number) =>
        Array.from({ length: n }, (_, i) =>
            el(`Element ${i}`, [
                { kind: 'summary', text: `${FILLER} number ${i}` },
                { kind: 'field', text: `Paragraph ${i} of considered prose about the matter at hand.` },
            ]),
        );

    it('grows linearly with the book: twice the book, twice the words, and no more stems than distinct words', () => {
        const run = (n: number) => rank(book(n), 'considered keeper').work;
        const small = run(400);
        const large = run(800);
        expect(large.sourcesRead).toBe(2 * small.sourcesRead);
        expect(large.wordsSegmented / small.wordsSegmented).toBeLessThanOrEqual(2.05);
        expect(large.wordsSegmented / small.wordsSegmented).toBeGreaterThanOrEqual(1.95);
        // Stems are cached per request: the new words are the numbers, not the prose.
        expect(large.stemsComputed - small.stemsComputed).toBeLessThanOrEqual(2 * 400 + 10);
    });

    it('tokenises only the sources that can match', () => {
        const work = rank(book(400), 'considered').work;
        expect(work.sourcesTokenised).toBe(400);
        expect(work.sourcesRead).toBe(1200);
    });

    it('an empty query reads every source and tokenises none', () => {
        const analyzer = createAnalyzer('en');
        const work = rankDocuments(book(10), q('', analyzer), analyzer, { limit: 5 }).work;
        expect(work).toMatchObject({ sourcesRead: 30, sourcesTokenised: 0, wordsSegmented: 0 });
    });
});
