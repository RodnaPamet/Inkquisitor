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

    list(db: Db, workspaceId: string, bookId: string, options: { kind?: BibleElementKind; take?: number } = {}) {
        return db.bibleElement.findMany({
            where: { workspaceId, bookId, ...(options.kind ? { kind: options.kind } : {}) },
            orderBy: [{ kind: 'asc' }, { name: 'asc' }, { id: 'asc' }],
            take: options.take ?? 500,
            select: ELEMENT_SELECT,
        });
    },

    find(db: Db, workspaceId: string, bookId: string, elementId: string) {
        return db.bibleElement.findFirst({ where: { id: elementId, workspaceId, bookId }, select: ELEMENT_SELECT });
    },

    /** An element of the workspace, whatever its book (to tell "another book" from "no such element"). */
    findInWorkspace(db: Db, workspaceId: string, elementId: string) {
        return db.bibleElement.findFirst({ where: { id: elementId, workspaceId }, select: { id: true, bookId: true, kind: true } });
    },

    /** Slugs in the book equal to `base` or starting `base-`, for picking a free one. */
    async slugsLike(db: Db, workspaceId: string, bookId: string, base: string) {
        const rows = await db.bibleElement.findMany({
            where: { workspaceId, bookId, OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
            select: { slug: true },
            take: 1_000,
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
    /** Every relation touching the element, from either end. */
    listForElement(db: Db, workspaceId: string, bookId: string, elementId: string) {
        return db.bibleRelation.findMany({
            where: { workspaceId, bookId, OR: [{ fromElementId: elementId }, { toElementId: elementId }] },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 1_000,
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

    /** The relation between the two elements of this type, in either direction. */
    findPair(db: Db, workspaceId: string, bookId: string, a: string, b: string, type: string) {
        return db.bibleRelation.findFirst({
            where: {
                workspaceId,
                bookId,
                type,
                OR: [
                    { fromElementId: a, toElementId: b },
                    { fromElementId: b, toElementId: a },
                ],
            },
            select: { id: true, fromElementId: true, toElementId: true },
        });
    },

    create(db: Db, workspaceId: string, bookId: string, data: { fromElementId: string; toElementId: string; type: string; note: string | null }) {
        return db.bibleRelation.create({ data: { ...data, workspaceId, bookId }, select: RELATION_SELECT });
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
