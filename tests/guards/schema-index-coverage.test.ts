/**
 * Every list query has an index, every workspace table leads with its
 * workspace, every foreign key is indexed (Phase 1.H, item 4).
 *
 * Ported from inflect-compliance's
 * `tests/guardrails/schema-index-coverage.test.ts` (docs/carve-manifest.md):
 * the four layers, read from the LIVE schema through the structured parser
 * (`tests/helpers/prisma-schema-models.ts`), never a migration file.
 *
 *   Layer A  [auto]     every model with a `workspaceId` has an index, unique
 *                       or id LED by `workspaceId` (Postgres uses an index's
 *                       leftmost prefix; every repository query filters by it).
 *   Layer B  [auto]     every foreign key is indexed: some index leads with one
 *                       of its columns other than `workspaceId`, or with
 *                       `workspaceId` and then one of them, so the reverse
 *                       lookup (and its cascade) is no sequential scan. A key
 *                       of `workspaceId` alone is Layer A's.
 *   Layer C  [curated]  `LIST_QUERY_INDEXES`: the composite index each list
 *                       query's filter and order stand on, asserted to exist
 *                       exactly.
 *   C-completeness      every model a `findMany` or `groupBy` in `src/` reads
 *            [auto]     is in Layer C or in `LIST_MODELS_INDEX_SUFFICIENT`
 *                       with a reason: a new list query on a new model fails
 *                       until somebody looks at its index.
 *
 * Every exemption carries a reason and fails when stale. inflect's baseline
 * maps (dozens of exempt foreign keys) are not carried: Inkquisitor starts at
 * zero, so every map below is empty or curated.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { leadingIndexedFields, parseSchemaModels, type SchemaModel } from '../helpers/prisma-schema-models';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const MODELS = parseSchemaModels();
const MODEL_BY_NAME = new Map(MODELS.map((m) => [m.name, m]));

/** Foreign keys allowed without an index, `Model.field` → why. Empty: every key is indexed. */
const FK_INDEX_EXEMPT: Readonly<Record<string, string>> = {};

/** The index each list query stands on. */
interface ListQueryIndex {
    model: string;
    fields: readonly string[];
    justification: string;
}

const LIST_QUERY_INDEXES: readonly ListQueryIndex[] = [
    { model: 'Book', fields: ['workspaceId', 'updatedAt'], justification: 'the books list: live books, most recently updated first' },
    { model: 'Book', fields: ['workspaceId', 'deletedAt'], justification: 'the recently-deleted list, newest deletion first' },
    { model: 'Book', fields: ['deletedAt'], justification: 'the purge’s discovery across workspaces: deleted at or before the cutoff' },
    { model: 'BibleElement', fields: ['workspaceId', 'bookId', 'kind', 'name'], justification: 'the board and its pages: a kind’s elements by name; the count per kind' },
    { model: 'BibleElement', fields: ['bookId', 'slug'], justification: 'slug lookups: import matching, free-slug candidates' },
    { model: 'BibleField', fields: ['workspaceId', 'elementId'], justification: 'an element’s fields, and the keys of a page of elements' },
    { model: 'BibleRelation', fields: ['fromElementId', 'toElementId', 'type'], justification: 'an element’s relations from its own end' },
    { model: 'BibleRelation', fields: ['bookId', 'toElementId'], justification: 'an element’s relations from the other end' },
    { model: 'BibleRelation', fields: ['workspaceId', 'bookId'], justification: 'a book’s relations (the export)' },
    { model: 'BibleEntryVersion', fields: ['elementId', 'versionNumber'], justification: 'the history newest first, and the latest number every save reads' },
    { model: 'BibleRelationField', fields: ['workspaceId', 'relationId'], justification: 'a relation’s fields, and those of the relations a page reads (Phase 3.3)' },
    { model: 'BibleRelationVersion', fields: ['relationId', 'versionNumber'], justification: 'a relation’s history newest first, and the latest number every save reads (Phase 3.3)' },
    { model: 'Question', fields: ['bookId', 'relationId', 'createdAt'], justification: 'earlier sessions’ questions about a relation (book-wide deduplication, Phase 3.3)' },
    { model: 'EnrichmentProposal', fields: ['relationId', 'fieldKey'], justification: 'the other pending proposals for one relation field (superseded on an acceptance, Phase 3.3)' },
    { model: 'InterviewSession', fields: ['workspaceId', 'bookId', 'createdAt'], justification: 'a book’s interviews, newest first (Phase 2.2)' },
    { model: 'InterviewRound', fields: ['sessionId', 'number'], justification: 'a session’s rounds by number' },
    { model: 'Question', fields: ['roundId', 'position'], justification: 'a round’s questions in their order' },
    { model: 'Question', fields: ['workspaceId', 'sessionId', 'id'], justification: 'a session’s questions; a question by id within its session' },
    { model: 'Question', fields: ['bookId', 'elementId', 'createdAt'], justification: 'earlier sessions’ questions about an element (book-wide deduplication)' },
    { model: 'Question', fields: ['workspaceId', 'bookId', 'dedupeKey'], justification: 'exact repeats anywhere in the book, by keyed dedupe key' },
    { model: 'Answer', fields: ['workspaceId', 'sessionId', 'questionId'], justification: 'a session’s answers, every revision, by question' },
    { model: 'ReconcileRun', fields: ['workspaceId', 'sessionId'], justification: 'a session’s reconcile runs (Phase 2.5)' },
    { model: 'EnrichmentProposal', fields: ['workspaceId', 'sessionId', 'createdAt'], justification: 'a session’s proposals in the order they were made (the review)' },
    { model: 'EnrichmentProposal', fields: ['workspaceId', 'bookId', 'status'], justification: 'a book’s pending proposals: counts per session, pending new-element names' },
    { model: 'EnrichmentProposal', fields: ['elementId', 'fieldKey'], justification: 'the other pending proposals for one field (superseded on an acceptance)' },
    { model: 'ResearchBrief', fields: ['workspaceId', 'bookId', 'createdAt'], justification: 'a book’s research briefs, newest first (Phase 2.6, the Research page)' },
    { model: 'ResearchSource', fields: ['workspaceId', 'briefId'], justification: 'a brief’s attached files' },
    { model: 'ResearchRun', fields: ['workspaceId', 'briefId', 'createdAt'], justification: 'a brief’s runs, newest first (and the latest run of each brief)' },
    { model: 'ResearchFinding', fields: ['workspaceId', 'runId', 'position'], justification: 'a run’s findings in order' },
    { model: 'ResearchProposal', fields: ['workspaceId', 'runId', 'createdAt'], justification: 'a run’s proposals in the order they were made' },
    { model: 'ResearchProposal', fields: ['elementId', 'fieldKey'], justification: 'the other pending research proposals for one field (superseded on an acceptance)' },
    { model: 'ResearchEgress', fields: ['workspaceId', 'runId', 'position'], justification: 'a run’s queries and fetch URLs in order (decision D15, the run’s result page)' },
    { model: 'Source', fields: ['workspaceId', 'libraryId', 'createdAt'], justification: 'a library’s sources, newest first (Phase 4.0: the Sources and Series pages, the book’s source set)' },
    { model: 'SourceChunk', fields: ['workspaceId', 'sourceId', 'position'], justification: 'a source’s chunks in order (the ingestion’s cursor, embedding, the retriever’s bounded scan)' },
    { model: 'StoryFact', fields: ['workspaceId', 'sourceId', 'status', 'chunkId', 'position'], justification: 'a view’s facts by source and status in chunk order (the Facts page, the confirmed facts the frontier reads)' },
    { model: 'BookSeriesSource', fields: ['workspaceId', 'bookId'], justification: 'a book’s opted-in series sources (D26)' },
    { model: 'StoryFact', fields: ['workspaceId', 'bookId', 'subjectElementId'], justification: 'a book’s live bible facts about some elements (Phase 4.1: the frontier’s check, the retriever, an extraction’s resolve)' },
    { model: 'StoryFact', fields: ['workspaceId', 'bookId', 'elementId', 'supersededAt'], justification: 'the live facts one element’s versions state (Phase 4.1: NO_LONGER_STATED)' },
    { model: 'StoryFactProvenance', fields: ['workspaceId', 'factId'], justification: 'a fact’s provenance (Phase 4.1)' },
    { model: 'StoryFactProposal', fields: ['workspaceId', 'bookId', 'status', 'createdAt'], justification: 'a book’s pending proposals, newest first (Phase 4.1: the Facts page)' },
    { model: 'StoryFactProposal', fields: ['workspaceId', 'bookId', 'status', 'reason', 'createdAt'], justification: 'a book’s pending proposals of one reason, newest first, and their counts (4.H-b: the Continuity page at 10,000 facts)' },
    { model: 'BibleFactExtraction', fields: ['origin', 'status', 'createdAt'], justification: 'the dispatchers’ scans for due extractions across workspaces, by origin (Phase 4.1; 4.H-b: SAVE minutely, BACKFILL hourly)' },
    { model: 'BibleFactExtraction', fields: ['origin', 'workspaceId', 'status'], justification: 'the minutely discovery’s distinct workspaces with due rows, in workspace order from its cursor (4.H-b, #60.4)' },
    { model: 'BibleFactExtraction', fields: ['workspaceId', 'bookId', 'createdAt'], justification: 'a book’s extractions, newest first (Phase 4.1)' },
    { model: 'EmbeddingTask', fields: ['createdAt'], justification: 'the minutely dispatcher’s scan for workspaces with vectors due (Phase 4.1)' },
    { model: 'EmbeddingTask', fields: ['workspaceId', 'createdAt'], justification: 'a workspace’s oldest embedding tasks (Phase 4.1)' },
    { model: 'StoryFactOverride', fields: ['workspaceId', 'bookId', 'factId'], justification: 'a book’s overrides of the facts on one page (D26)' },
    { model: 'ContinuityRun', fields: ['workspaceId', 'bookId', 'createdAt'], justification: 'a book’s nightly runs, newest first (Phase 4.2: the Continuity page’s last run)' },
    { model: 'StoryThread', fields: ['workspaceId', 'bookId', 'updatedAt'], justification: 'a book’s threads, most recently changed first (Phase 4.2: the Continuity page)' },
    { model: 'StoryThread', fields: ['workspaceId', 'bookId', 'state', 'createdAt'], justification: 'a book’s open threads, oldest first (Phase 4.2: what a bible fact extraction is shown)' },
    { model: 'StoryThreadProposal', fields: ['workspaceId', 'bookId', 'status', 'createdAt'], justification: 'a book’s pending thread proposals, newest first (Phase 4.2: the Continuity page)' },
    { model: 'StaleFlag', fields: ['workspaceId', 'bookId', 'status', 'raisedAt'], justification: 'a book’s open stale flags, newest first (Phase 4.2: the Continuity page, the nightly sweep)' },
    { model: 'StressTest', fields: ['workspaceId', 'bookId', 'createdAt'], justification: 'a book’s stress tests, newest first (Phase 4.3: the Interrogate page; a live one refuses a second)' },
    { model: 'GapHunt', fields: ['workspaceId', 'bookId', 'createdAt'], justification: 'a book’s gap hunts, newest first (Phase 4.3: the newest is read; older ones beyond the kept few are pruned)' },
    { model: 'StressWeakPoint', fields: ['workspaceId', 'stressTestId'], justification: 'the weak points of the listed stress tests (Phase 4.3)' },
    { model: 'InterviewCompaction', fields: ['workspaceId', 'sessionId'], justification: 'a session’s summaries of its earlier rounds (Phase 4.3)' },
    { model: 'StoryMap', fields: ['bookId', 'kind'], justification: 'a book’s maps, one of each kind, which a bible deletion locks and snapshots (Phase 3.1, D20)' },
    { model: 'MapNode', fields: ['mapId', 'bibleElementId'], justification: 'a story map’s nodes, by element (Phase 3.1)' },
    { model: 'MapEdge', fields: ['mapId', 'bibleRelationId'], justification: 'a story map’s edges, by relation (Phase 3.1)' },
    { model: 'MapSnapshot', fields: ['mapId', 'version'], justification: 'a story map’s history, newest save first (Phase 3.1)' },
    { model: 'WorkspaceMembership', fields: ['userId'], justification: 'a person’s workspaces' },
    { model: 'WorkspaceMembership', fields: ['workspaceId', 'userId'], justification: 'a workspace’s members' },
    { model: 'UserSession', fields: ['userId', 'revokedAt'], justification: 'a person’s live sessions' },
];

/** Models read by a list query whose index the model's leading ones already give, → why. */
const LIST_MODELS_INDEX_SUFFICIENT: Readonly<Record<string, string>> = {
    AiSpendReservation:
        'the expired-reservation sweep (2.H, issue #30 item 9): a workspace holds one row per call in flight, so `[workspaceId, periodStart, expiresAt]`, led by the workspace, bounds the read to a handful of rows',
};

// ─── The checks (pure, so the negative controls can drive them) ─────

export function fkCovered(model: SchemaModel, group: readonly string[]): boolean {
    const constructs = [...model.blockIndexes, ...model.blockUniques, ...(model.blockId ? [model.blockId] : [])];
    const singles = [...(model.fieldIdName ? [model.fieldIdName] : []), ...model.fieldUniqueNames];
    const own = group.filter((f) => f !== 'workspaceId');
    return (
        own.some((f) => singles.includes(f)) ||
        constructs.some((c) => (c[0] !== 'workspaceId' && own.includes(c[0])) || (c[0] === 'workspaceId' && own.includes(c[1])))
    );
}

export function fkViolations(models: readonly SchemaModel[]): string[] {
    const out: string[] = [];
    for (const m of models) {
        for (const group of m.relationFkFieldGroups) {
            if (group.every((f) => f === 'workspaceId')) continue; // Layer A's.
            if (!fkCovered(m, group)) out.push(`${m.name}.${group.filter((f) => f !== 'workspaceId').join('+')}`);
        }
    }
    return out;
}

/** Layer A: the workspace-scoped models (a `workspaceId` column) no index, unique or id leads with `workspaceId`. */
export function workspaceLeadViolations(models: readonly SchemaModel[]): string[] {
    return models.filter((m) => m.scalarFieldNames.includes('workspaceId') && !leadingIndexedFields(m).has('workspaceId')).map((m) => m.name);
}

/** Every index, unique and id a model declares, each as its column list. */
function declaredIndexes(m: SchemaModel): string[][] {
    return [...m.blockIndexes, ...m.blockUniques, ...(m.blockId ? [m.blockId] : []), ...m.fieldUniqueNames.map((f) => [f])];
}

/** Layer C: the curated list indexes the schema does not declare EXACTLY (model unknown, or no index with these columns in this order). */
export function listIndexViolations(indexes: readonly ListQueryIndex[], byName: ReadonlyMap<string, SchemaModel>): string[] {
    return indexes
        .filter((i) => {
            const m = byName.get(i.model);
            return !m || !declaredIndexes(m).some((c) => c.length === i.fields.length && c.every((f, n) => f === i.fields[n]));
        })
        .map((i) => `${i.model}(${i.fields.join(', ')})`);
}

/** Models a `<accessor>.findMany(` / `.groupBy(` call names, in the given sources. */
export function listQueriedModels(sources: readonly string[], known: ReadonlySet<string>): Set<string> {
    const found = new Set<string>();
    for (const text of sources) {
        for (const m of text.matchAll(/\b([a-z][A-Za-z0-9]*)\.(?:findMany|groupBy)\s*\(/g)) {
            const name = m[1][0].toUpperCase() + m[1].slice(1);
            if (known.has(name)) found.add(name);
        }
    }
    return found;
}

// ─── Against the schema ─────────────────────────────────────────────

describe('parser sanity (a parser that broke would pass every layer vacuously)', () => {
    it('reads every model, with its indexes and foreign keys', () => {
        expect(MODELS.length).toBeGreaterThanOrEqual(12);
        expect(MODEL_BY_NAME.get('BibleElement')?.blockIndexes).toContainEqual(['workspaceId', 'bookId', 'kind', 'name']);
        expect(MODEL_BY_NAME.get('BibleRelation')?.relationFkFieldGroups).toContainEqual(['bookId', 'fromElementId']);
        expect(MODEL_BY_NAME.get('Book')?.fieldIdName).toBe('id');
        expect(MODELS.reduce((n, m) => n + m.relationFkFieldGroups.length, 0)).toBeGreaterThanOrEqual(12);
    });
});

describe('Layer A: every workspace-scoped model leads an index with workspaceId', () => {
    const scoped = MODELS.filter((m) => m.scalarFieldNames.includes('workspaceId'));
    it('finds the workspace-scoped models', () => {
        expect(scoped.length).toBeGreaterThanOrEqual(8);
    });
    it('each has an index led by workspaceId', () => {
        expect(workspaceLeadViolations(MODELS)).toEqual([]);
    });
});

describe('Layer B: every foreign key is indexed', () => {
    const violations = fkViolations(MODELS);
    it('no foreign key without an index (FK_INDEX_EXEMPT names any with a reason)', () => {
        expect(violations.filter((v) => !(v in FK_INDEX_EXEMPT))).toEqual([]);
    });
    it('no stale exemption', () => {
        expect(Object.keys(FK_INDEX_EXEMPT).filter((k) => !violations.includes(k))).toEqual([]);
    });
});

describe('Layer C: the index of every list query exists, exactly', () => {
    it('every curated index is declared, exactly', () => {
        expect(listIndexViolations(LIST_QUERY_INDEXES, MODEL_BY_NAME)).toEqual([]);
    });
    it('every curated entry says why', () => {
        expect(LIST_QUERY_INDEXES.filter((i) => i.justification.trim().length < 10)).toEqual([]);
    });
});

describe('Layer C-completeness: every model a list query reads is triaged', () => {
    const sources = repoRelativeFiles()
        .filter((f) => /^src\/.*\.tsx?$/.test(f))
        .map((f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'));
    const queried = listQueriedModels(sources, new Set(MODEL_BY_NAME.keys()));
    const curated = new Set(LIST_QUERY_INDEXES.map((i) => i.model));

    it('finds the list queries (a scan that found none would pass vacuously)', () => {
        expect([...queried]).toEqual(expect.arrayContaining(['Book', 'BibleElement', 'BibleEntryVersion']));
    });
    it('each is in LIST_QUERY_INDEXES or LIST_MODELS_INDEX_SUFFICIENT', () => {
        expect([...queried].filter((m) => !curated.has(m) && !(m in LIST_MODELS_INDEX_SUFFICIENT)).sort()).toEqual([]);
    });
    it('no stale entry: every curated model is still list-queried', () => {
        expect([...curated, ...Object.keys(LIST_MODELS_INDEX_SUFFICIENT)].filter((m) => !queried.has(m))).toEqual([]);
    });
});

// ─── The checks catch what they should ──────────────────────────────

describe('negative controls', () => {
    const model = (over: Partial<SchemaModel>): SchemaModel => ({
        name: 'X',
        tableName: 'X',
        fields: [],
        scalarFieldNames: [],
        blockIndexes: [],
        blockUniques: [],
        blockId: null,
        fieldIdName: 'id',
        fieldUniqueNames: [],
        relationFkFieldGroups: [],
        relations: [],
        hasField: () => false,
        ...over,
    });

    it('flags a foreign key no index leads, and passes one a composite covers', () => {
        expect(fkViolations([model({ relationFkFieldGroups: [['workspaceId', 'bookId']] })])).toEqual(['X.bookId']);
        expect(fkViolations([model({ relationFkFieldGroups: [['workspaceId', 'bookId']], blockIndexes: [['workspaceId', 'bookId', 'kind']] })])).toEqual([]);
        expect(fkViolations([model({ relationFkFieldGroups: [['authorId']], blockIndexes: [['createdAt', 'authorId']] })])).toEqual(['X.authorId']);
        expect(fkViolations([model({ relationFkFieldGroups: [['bookId', 'fromId']], blockUniques: [['fromId', 'toId']] })])).toEqual([]);
        // The workspace key alone is Layer A's, not B's.
        expect(fkViolations([model({ relationFkFieldGroups: [['workspaceId']] })])).toEqual([]);
    });

    // Issue #29 item 5: Layers A and C were checked by hand only.
    it('Layer A flags a workspace-scoped model no index leads with workspaceId', () => {
        const scoped = { scalarFieldNames: ['id', 'workspaceId', 'bookId'] };
        expect(workspaceLeadViolations([model({ ...scoped, blockIndexes: [['bookId', 'workspaceId']] })])).toEqual(['X']);
        expect(workspaceLeadViolations([model({ ...scoped, blockUniques: [['bookId', 'workspaceId']], fieldUniqueNames: ['bookId'] })])).toEqual(['X']);
        expect(workspaceLeadViolations([model({ ...scoped, blockIndexes: [['workspaceId', 'bookId']] })])).toEqual([]);
        expect(workspaceLeadViolations([model({ ...scoped, blockId: ['workspaceId', 'id'], fieldIdName: null })])).toEqual([]);
        // A model with no workspace column is not Layer A's.
        expect(workspaceLeadViolations([model({ scalarFieldNames: ['id', 'bookId'] })])).toEqual([]);
    });

    it('Layer C flags a curated index that is missing, a prefix, a superset, reordered, or on an unknown model', () => {
        const byName = new Map([['X', model({ blockIndexes: [['workspaceId', 'bookId', 'createdAt']], blockUniques: [['bookId', 'slug']], fieldUniqueNames: ['code'] })]]);
        const entry = (m: string, fields: string[]): ListQueryIndex => ({ model: m, fields, justification: 'a planted control' });
        expect(listIndexViolations([entry('X', ['workspaceId', 'bookId', 'createdAt']), entry('X', ['bookId', 'slug']), entry('X', ['code'])], byName)).toEqual([]);
        expect(
            listIndexViolations(
                [entry('X', ['workspaceId', 'bookId']), entry('X', ['workspaceId', 'bookId', 'createdAt', 'id']), entry('X', ['bookId', 'workspaceId', 'createdAt']), entry('X', ['status']), entry('Y', ['workspaceId'])],
                byName,
            ),
        ).toEqual(['X(workspaceId, bookId)', 'X(workspaceId, bookId, createdAt, id)', 'X(bookId, workspaceId, createdAt)', 'X(status)', 'Y(workspaceId)']);
    });

    it('finds the models list queries name, and only real ones', () => {
        const found = listQueriedModels(['db.bibleElement.findMany({ take: 1 })', 'tx.book.groupBy({ by: ["stage"] })', 'delegate.findMany()'], new Set(['BibleElement', 'Book']));
        expect([...found].sort()).toEqual(['BibleElement', 'Book']);
    });
});
