/**
 * The retriever's ORDER and BUDGET (Phase 4.1, D27), over mocked reads: the
 * related summaries first (cut to their share), then the top k facts — the
 * scope's bible facts, its confirmed source facts, then the vector's nearest
 * of the book's other facts — then passages; each part cut, and the cut said,
 * where the budget runs out. The vector searches name the allowed set.
 */
const searches: Array<Record<string, unknown>> = [];
const bibleAbout = jest.fn();
const anyByIds = jest.fn();
jest.mock('@/app-layer/repositories/source.repository', () => ({
    BibleFactRepository: { listLiveAbout: (...a: unknown[]) => bibleAbout(...a), listAnyByIds: (...a: unknown[]) => anyByIds(...a) },
    StoryFactRepository: { listConfirmed: jest.fn(async () => []) },
    StoryFactOverrideRepository: { listForBook: jest.fn(async () => []) },
    SourceChunkRepository: { listForSources: jest.fn(async () => []), listByIds: jest.fn(async () => []) },
}));
// The entries as they stand: every fact's quote is in its element's current text unless a test takes it out.
let entrySummary = '';
jest.mock('@/app-layer/repositories/fact-layer.repository', () => ({
    BibleVersionReadRepository: {
        newestElementSnapshots: async () => {
            const { buildSnapshot, serialiseSnapshot } = jest.requireActual('@/lib/bible/snapshot');
            return new Map([['el-1', serialiseSnapshot(buildSnapshot({ element: { kind: 'CHARACTER', name: 'Wren', slug: 'wren', status: 'DRAFT', summary: entrySummary, customLabel: null }, fields: [] }))]]);
        },
        newestRelationSnapshots: async () => new Map(),
    },
}));
jest.mock('@/app-layer/repositories/vector.repository', () => ({
    getVectorRepository: () => ({
        search: async (_db: unknown, _ws: string, q: Record<string, unknown>) => {
            searches.push(q);
            return q.within && (q.within as { scope: string }).scope === 'facts-of-book' ? [{ sourceId: 'near-1' }, { sourceId: 'other-book' }] : [];
        },
    }),
}));
jest.mock('@/app-layer/usecases/source-common', () => ({ bookSourceSet: async () => ({ bookSourceIds: ['src-book'], seriesSourceIds: ['src-series'] }) }));

import { assembleSourceContext, FACTS_TOP_K } from '@/app-layer/usecases/source-retrieval';

const ctx = { workspaceId: 'ws', requestId: 'r', userId: 'u', workspaceSlug: 'w', role: 'OWNER', permissions: {} } as never;
const db = {} as never;
const scope = [{ elementId: 'el-1', kind: 'CHARACTER' as const, name: 'Wren' }];
const fact = (id: string, statement: string) => ({ id, elementId: 'el-1', relationId: null, quote: statement, subjectElementId: 'el-1', predicate: 'WANT', statement, subjectName: 'Wren', supersededAt: null, bookId: 'book-1', sourceId: null, status: 'CONFIRMED' });

/** The scope's live bible facts, each still stated by its element's current text. */
function serve(rows: Array<ReturnType<typeof fact>>) {
    bibleAbout.mockResolvedValue(rows);
    entrySummary = rows.map((r) => r.quote).join(' ');
}

beforeEach(() => {
    searches.length = 0;
    bibleAbout.mockReset();
    bibleAbout.mockImplementation(async () => []);
    entrySummary = '';
    anyByIds.mockReset();
});

it('related summaries, then the scope’s facts, then the nearest others, the allowed set named in every vector query', async () => {
    serve([fact('own-1', 'Wren wants to cross the river.')]);
    anyByIds.mockResolvedValue([fact('near-1', 'Cal ferries goods by night.'), { ...fact('other-book', 'Not this book.'), bookId: 'book-2' }]);
    const out = await assembleSourceContext(db, ctx, 'book-1', scope, { vector: [1, 0], revision: 'r' }, 3_000, [{ kind: 'CHARACTER', name: 'Cal', summary: 'A smuggler.' }]);
    expect(out.related).toEqual([{ kind: 'CHARACTER', name: 'Cal', summary: 'A smuggler.' }]);
    expect(out.facts.map((f) => f.statement)).toEqual(['Wren wants to cross the river.', 'Cal ferries goods by night.']);
    expect(out.facts[0].from).toBe('BIBLE');
    // A hit outside the book's allowed set is never shown, even if the store returned it.
    expect(out.facts.map((f) => f.statement)).not.toContain('Not this book.');
    expect(searches).toHaveLength(2);
    expect(searches[0].within).toEqual({ scope: 'facts-of-book', bookId: 'book-1', sourceIds: ['src-book', 'src-series'] });
    expect(searches[1].within).toEqual({ scope: 'chunks-of-sources', sourceIds: ['src-book', 'src-series'] });
});

it('keeps at most FACTS_TOP_K facts and the facts’ share of the budget, and says it cut', async () => {
    serve(Array.from({ length: FACTS_TOP_K + 10 }, (_, i) => fact(`f-${i}`, `Fact number ${i} about Wren.`)));
    anyByIds.mockResolvedValue([]);
    const out = await assembleSourceContext(db, ctx, 'book-1', scope, null, 3_000, null);
    expect(out.facts).toHaveLength(FACTS_TOP_K);
    expect(out.truncated).toBe(true);
    expect(out.related).toBeUndefined();
    const tight = await assembleSourceContext(db, ctx, 'book-1', scope, null, 40, null);
    expect(tight.facts.length).toBeLessThan(FACTS_TOP_K);
    expect(tight.truncated).toBe(true);
});

it('cuts the related summaries to their share before any fact is read in', async () => {
    serve([fact('own-1', 'Wren wants to cross the river.')]);
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'CHARACTER' as const, name: `Neighbour ${i}`, summary: 'x'.repeat(500) }));
    const out = await assembleSourceContext(db, ctx, 'book-1', scope, null, 3_000, many);
    expect(out.related!.length).toBeLessThan(40);
    expect(out.truncated).toBe(true);
    // The facts still have their own share.
    expect(out.facts).toHaveLength(1);
});

it('reads a vector hit back only while it is still CONFIRMED (the query’s own condition, asked again)', async () => {
    serve([]);
    anyByIds.mockResolvedValue([{ ...fact('near-1', 'Cal ferries goods by night.'), bookId: null, sourceId: 'src-book', status: 'REJECTED' }]);
    const out = await assembleSourceContext(db, ctx, 'book-1', scope, { vector: [1, 0], revision: 'r' }, 3_000, null);
    expect(out.facts).toEqual([]);
});

it('a bible fact whose quote is gone from its entry as it stands is not shown (the D27 addendum)', async () => {
    serve([fact('own-1', 'Wren wants to cross the river.'), fact('own-2', 'Wren keeps the lock.')]);
    entrySummary = 'Wren keeps the lock.';
    const out = await assembleSourceContext(db, ctx, 'book-1', scope, null, 3_000, null);
    expect(out.facts.map((f) => f.statement)).toEqual(['Wren keeps the lock.']);
});
