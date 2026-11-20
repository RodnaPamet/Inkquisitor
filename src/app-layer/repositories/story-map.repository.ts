/**
 * The story canvas's rows (Phase 3.1): a book's maps, their nodes and edges,
 * and one snapshot per save. Workspace-scoped: every query runs inside
 * `runInWorkspaceContext` AND filters by `workspaceId`. No authorization and
 * no validation here: `src/app-layer/usecases/story-maps.ts` asks permission,
 * checks every reference against the book and sanitises the freeform layer
 * first.
 *
 * `StoryMap.freeformJson` and `MapSnapshot.snapshot` are sealed and opened by
 * the field-encryption extension; this module reads and writes plaintext and
 * never filters on them.
 */
import type { Prisma, StoryMapKind } from '@prisma/client';

type Db = Prisma.TransactionClient;

export interface MapNodeWrite {
    bibleElementId: string;
    x: number;
    y: number;
    w: number;
    h: number;
    lane: string | null;
}

export const StoryMapRepository = {
    /**
     * Serialise every save and restore of one map: a transaction-scoped
     * advisory lock on (book, kind), held to commit. Keyed on the pair rather
     * than the row so the FIRST save of a map, which creates the row, is
     * serialised too.
     */
    async lock(db: Db, bookId: string, kind: StoryMapKind) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'story-map:' + bookId + ':' + kind}))`;
    },

    /**
     * Every map lock of a book, in one fixed order: what a deletion from the
     * bible takes BEFORE it deletes, so no save of any of the book's maps
     * interleaves with it (and the two never wait on each other's rows).
     */
    async lockAll(db: Db, bookId: string, kinds: readonly StoryMapKind[]) {
        for (const kind of kinds) await StoryMapRepository.lock(db, bookId, kind);
    },

    /** A book's maps (at most one of each kind, so three at most). */
    listForBook(db: Db, workspaceId: string, bookId: string) {
        return db.storyMap.findMany({
            where: { workspaceId, bookId },
            select: { id: true, kind: true, version: true, freeformJson: true },
            orderBy: { kind: 'asc' },
            take: 3,
        });
    },

    find(db: Db, workspaceId: string, bookId: string, kind: StoryMapKind) {
        return db.storyMap.findFirst({
            where: { workspaceId, bookId, kind },
            select: { id: true, version: true, freeformJson: true, updatedAt: true },
        });
    },

    /** A map's first save: the row at version 1. */
    create(db: Db, workspaceId: string, bookId: string, kind: StoryMapKind, data: { freeformJson: string | null }) {
        return db.storyMap.create({
            data: { workspaceId, bookId, kind, version: 1, freeformJson: data.freeformJson },
            select: { id: true, version: true },
        });
    },

    /**
     * The conditional version bump every later save makes: the freeform layer
     * written and the version moved only while it still reads
     * `expectedVersion`. A count of 0 is a lost race (the caller holds the
     * lock, so in practice a bible cascade that bumped the version).
     */
    commit(db: Db, workspaceId: string, mapId: string, expectedVersion: number, data: { freeformJson: string | null }) {
        return db.storyMap.updateMany({
            where: { id: mapId, workspaceId, version: expectedVersion },
            data: { freeformJson: data.freeformJson, version: { increment: 1 } },
        });
    },
};

export const MapNodeRepository = {
    /** A map's nodes. Bounded by the save's own ceiling plus one, so a cut read is visible. */
    list(db: Db, workspaceId: string, mapId: string, take: number) {
        return db.mapNode.findMany({
            where: { workspaceId, mapId },
            select: { bibleElementId: true, x: true, y: true, w: true, h: true, lane: true },
            orderBy: { bibleElementId: 'asc' },
            take,
        });
    },

    /** Replace a map's nodes with `nodes` (a save is the map's whole state). */
    async replace(db: Db, workspaceId: string, bookId: string, mapId: string, nodes: readonly MapNodeWrite[]) {
        await db.mapNode.deleteMany({ where: { workspaceId, mapId } });
        if (nodes.length === 0) return;
        await db.mapNode.createMany({
            data: nodes.map((n) => ({ workspaceId, bookId, mapId, bibleElementId: n.bibleElementId, x: n.x, y: n.y, w: n.w, h: n.h, lane: n.lane })),
        });
    },
};

export const MapEdgeRepository = {
    list(db: Db, workspaceId: string, mapId: string, take: number) {
        return db.mapEdge.findMany({
            where: { workspaceId, mapId },
            select: { bibleRelationId: true },
            orderBy: { bibleRelationId: 'asc' },
            take,
        });
    },

    async replace(db: Db, workspaceId: string, bookId: string, mapId: string, relationIds: readonly string[]) {
        await db.mapEdge.deleteMany({ where: { workspaceId, mapId } });
        if (relationIds.length === 0) return;
        await db.mapEdge.createMany({ data: relationIds.map((bibleRelationId) => ({ workspaceId, bookId, mapId, bibleRelationId })) });
    },
};

export const MapSnapshotRepository = {
    create(
        db: Db,
        workspaceId: string,
        data: {
            mapId: string;
            version: number;
            snapshot: string;
            nodeCount: number;
            edgeCount: number;
            restoredFromVersion: number | null;
            fromBibleDeletion?: boolean;
            createdById: string | null;
        },
    ) {
        return db.mapSnapshot.create({
            data: {
                workspaceId,
                mapId: data.mapId,
                version: data.version,
                snapshot: data.snapshot,
                nodeCount: data.nodeCount,
                edgeCount: data.edgeCount,
                restoredFromVersion: data.restoredFromVersion,
                fromBibleDeletion: data.fromBibleDeletion ?? false,
                createdById: data.createdById,
            },
            select: { id: true },
        });
    },

    /** A map's snapshots, newest first, without their contents. */
    list(db: Db, workspaceId: string, mapId: string, take: number) {
        return db.mapSnapshot.findMany({
            where: { workspaceId, mapId },
            select: {
                version: true,
                nodeCount: true,
                edgeCount: true,
                restoredFromVersion: true,
                fromBibleDeletion: true,
                createdAt: true,
                createdBy: { select: { name: true } },
            },
            orderBy: { version: 'desc' },
            take,
        });
    },

    find(db: Db, workspaceId: string, mapId: string, version: number) {
        return db.mapSnapshot.findFirst({
            where: { workspaceId, mapId, version },
            select: { version: true, snapshot: true, nodeCount: true, edgeCount: true, restoredFromVersion: true, fromBibleDeletion: true, createdAt: true },
        });
    },
};

/** The bible rows a map draws, read for the map (names and kinds only: no encrypted column). */
export const MapBibleReads = {
    elements(db: Db, workspaceId: string, bookId: string, ids: readonly string[]) {
        if (ids.length === 0) return Promise.resolve([]);
        return db.bibleElement.findMany({
            where: { workspaceId, bookId, id: { in: [...ids] } },
            select: { id: true, kind: true, name: true, customLabel: true, orderRank: true },
            take: ids.length,
        });
    },

    /**
     * The characters taking part in some timeline events (Phase 3.2: the
     * timeline's per-character lanes): `takes_part_in` relations from a
     * character to each event. `take` bounds it; ask one more to know it was cut.
     */
    participants(db: Db, workspaceId: string, bookId: string, eventIds: readonly string[], take: number) {
        if (eventIds.length === 0) return Promise.resolve([]);
        return db.bibleRelation.findMany({
            where: { workspaceId, bookId, type: 'takes_part_in', toElementId: { in: [...eventIds] }, from: { kind: 'CHARACTER' } },
            select: { toElementId: true, from: { select: { id: true, name: true } } },
            orderBy: { id: 'asc' },
            take,
        });
    },

    /** One field's stored value for some elements (decrypted by the extension), or none: an act, a story time. */
    fieldValues(db: Db, workspaceId: string, elementIds: readonly string[], key: string) {
        if (elementIds.length === 0) return Promise.resolve([]);
        return db.bibleField.findMany({ where: { workspaceId, elementId: { in: [...elementIds] }, key }, select: { elementId: true, value: true }, take: elementIds.length });
    },

    /** Each element's latest version number (a node's base for an order move). */
    async latestVersions(db: Db, workspaceId: string, elementIds: readonly string[]): Promise<Map<string, number>> {
        if (elementIds.length === 0) return new Map();
        const rows = await db.bibleEntryVersion.groupBy({ by: ['elementId'], where: { workspaceId, elementId: { in: [...elementIds] } }, _max: { versionNumber: true } });
        return new Map(rows.map((r) => [r.elementId, r._max.versionNumber ?? 0] as const));
    },

    relationsById(db: Db, workspaceId: string, bookId: string, ids: readonly string[]) {
        if (ids.length === 0) return Promise.resolve([]);
        return db.bibleRelation.findMany({
            where: { workspaceId, bookId, id: { in: [...ids] } },
            select: { id: true, fromElementId: true, toElementId: true, type: true, from: { select: { kind: true } } },
            take: ids.length,
        });
    },

    /** The book's relations, the arrow converter's candidates; `take` bounds it, one past the cap. */
    relationsOfBook(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.bibleRelation.findMany({
            where: { workspaceId, bookId },
            select: { id: true, fromElementId: true, toElementId: true, type: true, from: { select: { kind: true } } },
            orderBy: { id: 'asc' },
            take,
        });
    },
};
