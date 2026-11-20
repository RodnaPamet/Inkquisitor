/**
 * The bible's elements, fields, relations and versions. Workspace-scoped:
 * every query runs inside `runInWorkspaceContext` (the `workspace_isolation`
 * policy) AND filters by `workspaceId`, and every element query by its book.
 * No authorization and no validation here: the usecases
 * (`src/app-layer/usecases/bible-*.ts`) ask permission, sanitise and check
 * values against the templates first.
 *
 * The encrypted columns (`summary`, `value`, `note`, `snapshot`,
 * `changeSummary`) are sealed and opened by the field-encryption extension;
 * this module reads and writes plaintext and never filters on them.
 */
import type { BibleElementKind, BibleElementStatus, BibleVersionSource, Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

export const ELEMENT_SELECT = {
    id: true,
    bookId: true,
    kind: true,
    name: true,
    slug: true,
    status: true,
    summary: true,
    customLabel: true,
    createdAt: true,
    updatedAt: true,
} as const satisfies Prisma.BibleElementSelect;

/** An element as a list shows it: no encrypted column, so a page of a thousand decrypts nothing. */
export const ELEMENT_LIST_SELECT = {
    id: true,
    bookId: true,
    kind: true,
    name: true,
    slug: true,
    status: true,
    customLabel: true,
    updatedAt: true,
} as const satisfies Prisma.BibleElementSelect;

export type ElementListRow = Prisma.BibleElementGetPayload<{ select: typeof ELEMENT_LIST_SELECT }>;

const FIELD_SELECT = { key: true, value: true, order: true, updatedAt: true } as const satisfies Prisma.BibleFieldSelect;

const RELATION_SELECT = {
    id: true,
    fromElementId: true,
    toElementId: true,
    type: true,
    note: true,
    createdAt: true,
} as const satisfies Prisma.BibleRelationSelect;

const VERSION_META_SELECT = {
    id: true,
    elementId: true,
    versionNumber: true,
    changeSummary: true,
    source: true,
    restoredFromVersion: true,
    authorId: true,
    createdAt: true,
} as const satisfies Prisma.BibleEntryVersionSelect;

export interface ElementWrite {
    name?: string;
    slug?: string;
    status?: BibleElementStatus;
    summary?: string | null;
    customLabel?: string | null;
}

export const BibleElementRepository = {
    /**
     * Serialise every save of one element: a transaction-scoped advisory
     * lock, held to commit. Two saves of the same element queue here, so each
     * reads the state the other left and takes the next version number.
     */
    async lock(db: Db, elementId: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'bible-element:' + elementId}))`;
    },

    /**
     * Serialise every write that can give a book an element NAME — a create
     * (`createElementInTx`, the imports), a rename — with every check that
     * the book does not hold a name yet (`bookHoldsElementName`), until the
     * transaction ends (issues #39 item 5, #41 item 5). Names are compared by
     * `nameKey` (case, look-alikes, a leading article), which the database
     * cannot compute, so the guarantee is this lock rather than a unique
     * index: a check made under it reads every name a concurrent writer
     * committed before it. LOCK ORDER: take it BEFORE any element's `lock`
     * (a create locks only the element it has just inserted).
     */
    async lockNames(db: Db, bookId: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'bible-element-names:' + bookId}))`;
    },

    /**
     * One page of a book's elements, by name then id (keyset: `after` is the
     * last row of the previous page), optionally of some kinds and whose name
     * contains `q` (case-insensitive, literally: `%`, `_` and backslash are escaped). `take` bounds it; ask one more than you
     * show to know whether another page follows. Served by
     * (workspaceId, bookId, kind, name) when kinds are given.
     */
    page(
        db: Db,
        workspaceId: string,
        bookId: string,
        options: { kinds?: readonly BibleElementKind[]; q?: string; after?: { name: string; id: string }; take: number },
    ) {
        const { kinds, q, after, take } = options;
        return db.bibleElement.findMany({
            where: {
                workspaceId,
                bookId,
                ...(kinds ? { kind: { in: [...kinds] } } : {}),
                // `contains` is an ILIKE whose pattern Prisma does not escape: a
                // `%` or `_` the author types is a character to find, not a wildcard.
                ...(q ? { name: { contains: q.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' as const } } : {}),
                ...(after ? { OR: [{ name: { gt: after.name } }, { name: after.name, id: { gt: after.id } }] } : {}),
            },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take,
            select: ELEMENT_LIST_SELECT,
        });
    },

    /**
     * The first `perKind` elements of EACH kind, by name then id, in one
     * query (a window over the book's elements; the board, Phase 1.H). List
     * columns only: nothing is decrypted.
     */
    firstPerKind(db: Db, workspaceId: string, bookId: string, perKind: number): Promise<ElementListRow[]> {
        return db.$queryRaw<ElementListRow[]>`
            SELECT "id", "bookId", "kind", "name", "slug", "status", "customLabel", "updatedAt"
            FROM (
                SELECT e.*, row_number() OVER (PARTITION BY e."kind" ORDER BY e."name", e."id") AS rn
                FROM "BibleElement" e
                WHERE e."workspaceId" = ${workspaceId} AND e."bookId" = ${bookId}
            ) ranked
            WHERE rn <= ${perKind}
            ORDER BY "kind", "name", "id"`;
    },

    /** Every element of the book with its summary, by name then id (the export's read); `take` bounds it. */
    listForExport(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.bibleElement.findMany({ where: { workspaceId, bookId }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take, select: ELEMENT_SELECT });
    },

    /**
     * The book's elements as word search reads them (Phase 3.4): only the
     * columns it searches (the summary decrypted), by name. `take` bounds it;
     * ask one more to know the book was cut.
     */
    listForSearch(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.bibleElement.findMany({
            where: { workspaceId, bookId },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take,
            select: { id: true, kind: true, name: true, summary: true, customLabel: true },
        });
    },

    /** How many elements the book holds of each kind (an aggregate: no row is read out). */
    async countByKind(db: Db, workspaceId: string, bookId: string): Promise<Map<BibleElementKind, number>> {
        const rows = await db.bibleElement.groupBy({ by: ['kind'], where: { workspaceId, bookId }, _count: { _all: true } });
        return new Map(rows.map((r) => [r.kind, r._count._all]));
    },

    /**
     * The elements an interview questions (Phase 2.2): the book's elements,
     * optionally of one kind, in kind order and then creation order (the
     * order a session asks about them). `take` bounds it; ask one more to
     * know the scope was cut. With the summary (encrypted): the prompt reads it.
     */
    listForInterview(db: Db, workspaceId: string, bookId: string, options: { kind?: BibleElementKind; take: number }) {
        return db.bibleElement.findMany({
            where: { workspaceId, bookId, ...(options.kind ? { kind: options.kind } : {}) },
            orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            take: options.take,
            select: ELEMENT_SELECT,
        });
    },

    /** Some elements of the book with their summaries (an interview's related elements, Phase 2.2). */
    listByIds(db: Db, workspaceId: string, bookId: string, ids: readonly string[]) {
        if (ids.length === 0) return Promise.resolve([]);
        return db.bibleElement.findMany({ where: { workspaceId, bookId, id: { in: [...ids] } }, orderBy: [{ kind: 'asc' }, { name: 'asc' }], take: ids.length, select: ELEMENT_SELECT });
    },

    /** An element of a LIVE book: an element of a deleted book (Phase 1.H) is not found. */
    find(db: Db, workspaceId: string, bookId: string, elementId: string) {
        return db.bibleElement.findFirst({ where: { id: elementId, workspaceId, bookId, book: { deletedAt: null } }, select: ELEMENT_SELECT });
    },

    /** The book's elements holding any of `slugs` (an import's lookup, Phase 1.3). */
    findBySlugs(db: Db, workspaceId: string, bookId: string, slugs: readonly string[]) {
        if (slugs.length === 0) return Promise.resolve([]);
        return db.bibleElement.findMany({ where: { workspaceId, bookId, slug: { in: [...slugs] } }, select: ELEMENT_SELECT, take: slugs.length });
    },

    /** An element of the workspace, whatever its book (to tell "another book" from "no such element"). */
    findInWorkspace(db: Db, workspaceId: string, elementId: string) {
        return db.bibleElement.findFirst({ where: { id: elementId, workspaceId }, select: { id: true, bookId: true, kind: true } });
    },

    /** Which of `slugs` elements of the book already hold. */
    async slugsTaken(db: Db, workspaceId: string, bookId: string, slugs: readonly string[]) {
        const rows = await db.bibleElement.findMany({
            where: { workspaceId, bookId, slug: { in: [...slugs] } },
            select: { slug: true },
            take: slugs.length,
        });
        return new Set(rows.map((r) => r.slug));
    },

    slugTaken(db: Db, workspaceId: string, bookId: string, slug: string, exceptElementId?: string) {
        return db.bibleElement
            .findFirst({ where: { workspaceId, bookId, slug, ...(exceptElementId ? { id: { not: exceptElementId } } : {}) }, select: { id: true } })
            .then((r) => r !== null);
    },

    create(
        db: Db,
        workspaceId: string,
        bookId: string,
        data: { kind: BibleElementKind; name: string; slug: string; status?: BibleElementStatus; summary?: string | null; customLabel?: string | null },
    ) {
        return db.bibleElement.create({ data: { ...data, workspaceId, bookId }, select: ELEMENT_SELECT });
    },

    async update(db: Db, workspaceId: string, bookId: string, elementId: string, data: ElementWrite) {
        const res = await db.bibleElement.updateMany({ where: { id: elementId, workspaceId, bookId }, data });
        return res.count;
    },

    /** Mark the element changed (a fields-only save moves its `updatedAt`). */
    async touch(db: Db, workspaceId: string, bookId: string, elementId: string) {
        await db.bibleElement.updateMany({ where: { id: elementId, workspaceId, bookId }, data: { updatedAt: new Date() } });
    },

    async remove(db: Db, workspaceId: string, bookId: string, elementId: string) {
        const res = await db.bibleElement.deleteMany({ where: { id: elementId, workspaceId, bookId } });
        return res.count;
    },
};

export const BibleFieldRepository = {
    listForElement(db: Db, workspaceId: string, elementId: string) {
        return db.bibleField.findMany({ where: { workspaceId, elementId }, orderBy: [{ order: 'asc' }, { key: 'asc' }], take: 200, select: FIELD_SELECT });
    },

    /** The stored fields of every element asked for (an export's read, Phase 1.3). Bounded by the elements asked for times `perElement`. */
    listForElements(db: Db, workspaceId: string, elementIds: readonly string[], perElement: number) {
        if (elementIds.length === 0) return Promise.resolve([]);
        return db.bibleField.findMany({
            where: { workspaceId, elementId: { in: [...elementIds] } },
            orderBy: [{ elementId: 'asc' }, { order: 'asc' }, { key: 'asc' }],
            select: { elementId: true, key: true, value: true },
            take: elementIds.length * perElement,
        });
    },

    /**
     * How many stored bytes the fields word search would read hold, per
     * element (Phase 3.4): the sum of each value's `octet_length` (the
     * ciphertext's size, which bounds the plain text it decrypts to), every key
     * but `skipKeys`. Nothing is decrypted, and PostgreSQL answers the length
     * of a TOASTed value from its header without reading it. Elements with no
     * such field are absent. One row per element asked for, at most.
     */
    async storedBytesForSearch(db: Db, workspaceId: string, elementIds: readonly string[], skipKeys: readonly string[]): Promise<Map<string, number>> {
        if (elementIds.length === 0) return new Map();
        const rows = await db.$queryRaw<Array<{ elementId: string; bytes: number }>>`
            SELECT "elementId", sum(octet_length("value"))::float8 AS "bytes"
            FROM "BibleField"
            WHERE "workspaceId" = ${workspaceId}
              AND "elementId" = ANY(${[...elementIds]}::text[])
              AND NOT ("key" = ANY(${[...skipKeys]}::text[]))
            GROUP BY "elementId"`;
        return new Map(rows.map((r) => [r.elementId, Number(r.bytes)]));
    },

    /**
     * The stored fields of some elements that word search reads (Phase 3.4):
     * every key but `skipKeys` (keys that hold no text in any template, so
     * their values need not be decrypted). Bounded by the elements asked for
     * times `perElement`.
     */
    listForSearch(db: Db, workspaceId: string, elementIds: readonly string[], perElement: number, skipKeys: readonly string[]) {
        if (elementIds.length === 0) return Promise.resolve([]);
        return db.bibleField.findMany({
            where: { workspaceId, elementId: { in: [...elementIds] }, ...(skipKeys.length > 0 ? { key: { notIn: [...skipKeys] } } : {}) },
            select: { elementId: true, key: true, value: true },
            take: elementIds.length * perElement,
        });
    },

    /**
     * Which keys each element has a stored value for (no values: nothing is
     * decrypted). Bounded by the elements asked for times `perElement`.
     */
    keysForElements(db: Db, workspaceId: string, elementIds: readonly string[], perElement: number) {
        if (elementIds.length === 0) return Promise.resolve([]);
        return db.bibleField.findMany({
            where: { workspaceId, elementId: { in: [...elementIds] } },
            select: { elementId: true, key: true },
            take: elementIds.length * perElement,
        });
    },

    /**
     * How many of the book's elements of each kind have a stored value under
     * each key: an aggregate in the database (the board's completeness,
     * Phase 1.H), so nothing is decrypted and no field row is read out.
     *
     * The fields are read PER ELEMENT, through the (workspaceId, elementId)
     * index: the `LATERAL … OFFSET 0` keeps the planner from flattening the
     * subquery into a plain join. As a plain join its plan rested on the
     * statistics: for a book they did not yet know (a large import, before
     * autoanalyze), the book's elements were estimated at one row, and the
     * planner chose a nested loop that scanned EVERY field of the workspace
     * once per element — quadratic, 400 ms for 400 elements and growing with
     * the square of the book. Read this way it is one index probe per
     * element, whatever the estimate (the load test analyzes before seeding
     * to hold it to that).
     */
    async filledKeysByKind(db: Db, workspaceId: string, bookId: string): Promise<Array<{ kind: BibleElementKind; key: string; n: number }>> {
        return db.$queryRaw<Array<{ kind: BibleElementKind; key: string; n: number }>>`
            SELECT e."kind" AS "kind", f."key" AS "key", count(*)::int AS "n"
            FROM "BibleElement" e
            CROSS JOIN LATERAL (
                SELECT fi."key" FROM "BibleField" fi
                WHERE fi."workspaceId" = e."workspaceId" AND fi."elementId" = e."id"
                OFFSET 0
            ) f
            WHERE e."workspaceId" = ${workspaceId} AND e."bookId" = ${bookId}
            GROUP BY e."kind", f."key"`;
    },

    /** Set one field's stored value (JSON), creating its row if it has none. */
    upsert(db: Db, workspaceId: string, elementId: string, field: { key: string; value: string; order: number }) {
        return db.bibleField.upsert({
            where: { elementId_key: { elementId, key: field.key } },
            create: { workspaceId, elementId, key: field.key, value: field.value, order: field.order },
            update: { value: field.value, order: field.order },
            select: { key: true },
        });
    },

    async removeKeys(db: Db, workspaceId: string, elementId: string, keys: readonly string[]) {
        if (keys.length === 0) return 0;
        const res = await db.bibleField.deleteMany({ where: { workspaceId, elementId, key: { in: [...keys] } } });
        return res.count;
    },
};

export const BibleRelationRepository = {
    /** Relations touching the element, from either end, oldest first; `take` bounds it. */
    listForElement(db: Db, workspaceId: string, bookId: string, elementId: string, take: number) {
        return db.bibleRelation.findMany({
            where: { workspaceId, bookId, OR: [{ fromElementId: elementId }, { toElementId: elementId }] },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take,
            select: {
                ...RELATION_SELECT,
                from: { select: { id: true, kind: true, name: true, slug: true } },
                to: { select: { id: true, kind: true, name: true, slug: true } },
            },
        });
    },

    find(db: Db, workspaceId: string, bookId: string, relationId: string) {
        return db.bibleRelation.findFirst({ where: { id: relationId, workspaceId, bookId }, select: RELATION_SELECT });
    },

    /** Every relation of the book, with its ends' slugs (an export's read, Phase 1.3); `take` bounds it. */
    listForBook(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.bibleRelation.findMany({
            where: { workspaceId, bookId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take,
            select: {
                ...RELATION_SELECT,
                from: { select: { slug: true } },
                to: { select: { slug: true } },
            },
        });
    },

    /**
     * The book's relations that carry a note, the note decrypted, oldest
     * first, for word search (Phase 3.4). Only whether a note is set is asked
     * of the database, never what it says. `take` bounds it.
     */
    listNotesForBook(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.bibleRelation.findMany({
            where: { workspaceId, bookId, note: { not: null } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take,
            select: { id: true, fromElementId: true, toElementId: true, note: true },
        });
    },

    /** The relation from `from` to `to` of this type, as stored (one direction). */
    findExact(db: Db, workspaceId: string, bookId: string, from: string, to: string, type: string) {
        return db.bibleRelation.findFirst({
            where: { workspaceId, bookId, fromElementId: from, toElementId: to, type },
            select: { id: true, fromElementId: true, toElementId: true, note: true },
        });
    },

    /**
     * The SYMMETRIC relation between the two elements of this type, in either
     * direction (only a symmetric row: a directed one of the same key is
     * another fact). The key alone names the declaration: no two kinds may
     * each hold one key between the same two elements
     * (`relationLookupCollisions`, checked when the templates load).
     */
    findPair(db: Db, workspaceId: string, bookId: string, a: string, b: string, type: string) {
        return db.bibleRelation.findFirst({
            where: {
                workspaceId,
                bookId,
                type,
                symmetric: true,
                OR: [
                    { fromElementId: a, toElementId: b },
                    { fromElementId: b, toElementId: a },
                ],
            },
            select: { id: true, fromElementId: true, toElementId: true, note: true },
        });
    },

    create(
        db: Db,
        workspaceId: string,
        bookId: string,
        data: { fromElementId: string; toElementId: string; type: string; symmetric: boolean; note: string | null },
    ) {
        return db.bibleRelation.create({ data: { ...data, workspaceId, bookId }, select: RELATION_SELECT });
    },

    /** Replace a relation's note (sanitised by the caller), Phase 1.3's re-import of a changed note. */
    async updateNote(db: Db, workspaceId: string, bookId: string, relationId: string, note: string | null) {
        const res = await db.bibleRelation.updateMany({ where: { id: relationId, workspaceId, bookId }, data: { note } });
        return res.count;
    },

    async remove(db: Db, workspaceId: string, bookId: string, relationId: string) {
        const res = await db.bibleRelation.deleteMany({ where: { id: relationId, workspaceId, bookId } });
        return res.count;
    },
};

export const BibleVersionRepository = {
    async latestNumber(db: Db, workspaceId: string, elementId: string): Promise<number> {
        const row = await db.bibleEntryVersion.findFirst({
            where: { workspaceId, elementId },
            orderBy: { versionNumber: 'desc' },
            select: { versionNumber: true },
        });
        return row?.versionNumber ?? 0;
    },

    create(
        db: Db,
        workspaceId: string,
        data: {
            bookId: string;
            elementId: string;
            versionNumber: number;
            snapshot: string;
            changeSummary: string | null;
            source: BibleVersionSource;
            restoredFromVersion: number | null;
            authorId: string;
            /** The answers an INTERVIEW version is drawn from (Phase 2.5); empty for every other source (CHECK). */
            sourceAnswerIds?: string[];
            /** The findings (and proposal) a RESEARCH version is drawn from (Phase 2.6); empty for every other source (CHECK). */
            sourceFindingIds?: string[];
            sourceResearchProposalId?: string | null;
        },
    ) {
        return db.bibleEntryVersion.create({ data: { ...data, workspaceId }, select: VERSION_META_SELECT });
    },

    /** Newest first, without the snapshots. */
    list(db: Db, workspaceId: string, bookId: string, elementId: string, options: { take: number; beforeVersion?: number }) {
        return db.bibleEntryVersion.findMany({
            where: { workspaceId, bookId, elementId, ...(options.beforeVersion ? { versionNumber: { lt: options.beforeVersion } } : {}) },
            orderBy: { versionNumber: 'desc' },
            take: options.take,
            select: VERSION_META_SELECT,
        });
    },

    find(db: Db, workspaceId: string, bookId: string, elementId: string, versionNumber: number) {
        return db.bibleEntryVersion.findFirst({
            where: { workspaceId, bookId, elementId, versionNumber },
            select: { ...VERSION_META_SELECT, snapshot: true },
        });
    },
};
