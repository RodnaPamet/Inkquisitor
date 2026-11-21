/**
 * The story canvas's server side against a real PostgreSQL (Phase 3.1):
 * lazy creation, the version lock (a stale save is a 409 and loses no
 * write), one snapshot per save, restore, references kept inside the book,
 * the bible's deletions cascading and moving the version, the snapshot
 * table's append-only trigger, encryption of the freeform layer, and the
 * one-map-per-kind constraint (decision D18).
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, deleteElement } from '@/app-layer/usecases/bible-elements';
import { addRelation, removeRelation } from '@/app-layer/usecases/bible-relations';
import { getMapSnapshot, getStoryMap, listMapSnapshots, restoreMapSnapshot, saveStoryMap } from '@/app-layer/usecases/story-maps';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { seedBible, type SeededBible } from '../helpers/bible';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let ctx: WorkspaceRequestContext;
let seeded: SeededBible;
let otherBook: SeededBible;

beforeAll(async () => {
    const account = await createAccount({ workspaceName: 'Maps' });
    ctx = workspaceCtx(account);
    seeded = await seedBible(ctx, 'maps');
    otherBook = await seedBible(ctx, 'maps-other');
});

const node = (elementId: string, x = 0, y = 0) => ({ elementId, x, y, w: 220, h: 88, lane: null });
const note = (id: string, text: string) => ({ id, typeName: 'shape', type: 'note', x: 5, y: 5, props: { text } });

async function freshBook(marker: string) {
    const book = await createBook(ctx, { title: `Map book ${marker}` });
    const a = await createElement(ctx, book.id, { kind: 'CHARACTER', name: `A ${marker}` });
    const b = await createElement(ctx, book.id, { kind: 'FACTION', name: `B ${marker}` });
    const rel = await addRelation(ctx, book.id, { fromElementId: a.id, toElementId: b.id, type: 'member_of' });
    return { bookId: book.id, a: a.id, b: b.id, rel: rel.id };
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason?: string; details: Record<string, unknown> }> {
    try {
        await p;
    } catch (err) {
        const e = err as { status?: number; statusCode?: number; details?: Record<string, unknown> };
        return { status: e.statusCode ?? e.status ?? 0, reason: e.details?.reason as string | undefined, details: e.details ?? {} };
    }
    throw new Error('expected a refusal');
}

const mapRow = (bookId: string) => prisma.storyMap.findFirst({ where: { bookId, kind: 'RELATIONSHIP' } });

describe('a map nobody has saved', () => {
    it('reads as empty at version 0 and creates nothing (a read never writes)', async () => {
        const book = await freshBook('lazy');
        const map = await getStoryMap(ctx, book.bookId, 'relationship');
        expect(map).toMatchObject({ kind: 'RELATIONSHIP', version: 0, nodes: [], edges: [], freeform: [] });
        expect(map.relations.map((r) => r.relationId)).toEqual([book.rel]);
        expect(await prisma.storyMap.count({ where: { bookId: book.bookId } })).toBe(0);
        expect(await listMapSnapshots(ctx, book.bookId, 'relationship')).toEqual({ snapshots: [], truncated: false, nextBefore: null });
    });

    it('an unknown kind and a deleted or foreign book are 404', async () => {
        expect((await refusal(getStoryMap(ctx, seeded.bookId, 'scenes'))).status).toBe(404);
        expect((await refusal(getStoryMap(ctx, 'no-such-book', 'relationship'))).status).toBe(404);
        const stranger = workspaceCtx(await createAccount({ workspaceName: 'Stranger' }));
        expect((await refusal(getStoryMap(stranger, seeded.bookId, 'relationship'))).status).toBe(404);
    });

    it('its first save creates it at version 1 with one snapshot; an empty first save writes nothing', async () => {
        const book = await freshBook('first');
        expect(await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [], edges: [], freeform: [] })).toMatchObject({ saved: false, map: { version: 0 } });
        expect(await mapRow(book.bookId)).toBeNull();
        const first = await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a), node(book.b, 400)], edges: [{ relationId: book.rel, sourceElementId: book.a, targetElementId: book.b }], freeform: [] });
        expect(first.saved).toBe(true);
        expect(first.map.version).toBe(1);
        expect(first.map.nodes.map((n) => n.element.name).sort()).toEqual(['A first', 'B first']);
        expect(first.map.edges).toEqual([{ relationId: book.rel, sourceElementId: book.a, targetElementId: book.b, type: 'member_of', label: expect.any(String) }]);
        expect(await prisma.mapSnapshot.count({ where: { mapId: (await mapRow(book.bookId))!.id } })).toBe(1);
    });
});

describe('the version lock', () => {
    it('a stale save is refused 409 naming the current version, and writes nothing', async () => {
        const book = await freshBook('stale');
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a)], edges: [], freeform: [] });
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 1, nodes: [node(book.a, 50)], edges: [], freeform: [] });
        const before = await prisma.mapNode.findMany({ where: { bookId: book.bookId } });
        const r = await refusal(saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 1, nodes: [node(book.a, 999), node(book.b)], edges: [], freeform: [] }));
        expect(r).toMatchObject({ status: 409, reason: 'VERSION_CONFLICT', details: { currentVersion: 2, expectedVersion: 1 } });
        expect((await mapRow(book.bookId))!.version).toBe(2);
        expect(await prisma.mapNode.findMany({ where: { bookId: book.bookId } })).toEqual(before);
        expect(await prisma.mapSnapshot.count({ where: { mapId: (await mapRow(book.bookId))!.id } })).toBe(2);
    });

    it('two tabs saving the same version at once: exactly one wins, the other is 409, and the winner’s map is what is stored', async () => {
        const book = await freshBook('race');
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a)], edges: [], freeform: [] });
        const tab1 = saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 1, nodes: [node(book.a, 111)], edges: [], freeform: [] });
        const tab2 = saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 1, nodes: [node(book.a, 222), node(book.b)], edges: [], freeform: [] });
        const results = await Promise.allSettled([tab1, tab2]);
        const won = results.filter((r) => r.status === 'fulfilled');
        const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect((lost[0].reason as { details?: { reason?: string } }).details?.reason).toBe('VERSION_CONFLICT');
        const winner = results[0].status === 'fulfilled' ? 111 : 222;
        const stored = await getStoryMap(ctx, book.bookId, 'relationship');
        expect(stored.version).toBe(2);
        expect(stored.nodes.find((n) => n.elementId === book.a)?.x).toBe(winner);
        expect(await prisma.mapSnapshot.count({ where: { mapId: (await mapRow(book.bookId))!.id } })).toBe(2);
    });

    it('a save that changes nothing writes no version and no snapshot', async () => {
        const book = await freshBook('noop');
        const state = { nodes: [node(book.a, 7.5, -3.25)], edges: [], freeform: [note('shape:n1', 'kept')] };
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, ...state });
        // The same state in another order is the same state.
        const again = await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 1, ...state });
        expect(again).toMatchObject({ saved: false, map: { version: 1 } });
        expect(await prisma.mapSnapshot.count({ where: { mapId: (await mapRow(book.bookId))!.id } })).toBe(1);
    });
});

describe('references stay inside the book', () => {
    it('an element of another book is refused UNKNOWN_ELEMENT, a relation of another book UNKNOWN_RELATION', async () => {
        const r1 = await refusal(saveStoryMap(ctx, seeded.bookId, 'relationship', { expectedVersion: 0, nodes: [node(seeded.characterId), node(otherBook.characterId)], edges: [], freeform: [] }));
        expect(r1).toMatchObject({ status: 400, reason: 'UNKNOWN_ELEMENT', details: { elementIds: [otherBook.characterId] } });
        const r2 = await refusal(
            saveStoryMap(ctx, seeded.bookId, 'relationship', {
                expectedVersion: 0,
                nodes: [node(seeded.characterId), node(seeded.factionId)],
                edges: [{ relationId: otherBook.relationId, sourceElementId: seeded.characterId, targetElementId: seeded.factionId }],
                freeform: [],
            }),
        );
        expect(r2).toMatchObject({ status: 400, reason: 'UNKNOWN_RELATION' });
        expect(await prisma.storyMap.count({ where: { bookId: seeded.bookId } })).toBe(0);
    });

    it('an edge must join its relation’s own two elements, both on the map', async () => {
        const reversed = await refusal(
            saveStoryMap(ctx, seeded.bookId, 'relationship', {
                expectedVersion: 0,
                nodes: [node(seeded.characterId), node(seeded.factionId)],
                edges: [{ relationId: seeded.relationId, sourceElementId: seeded.factionId, targetElementId: seeded.characterId }],
                freeform: [],
            }),
        );
        expect(reversed.reason).toBe('RELATION_MISMATCH');
        const offMap = await refusal(
            saveStoryMap(ctx, seeded.bookId, 'relationship', {
                expectedVersion: 0,
                nodes: [node(seeded.characterId)],
                edges: [{ relationId: seeded.relationId, sourceElementId: seeded.characterId, targetElementId: seeded.factionId }],
                freeform: [],
            }),
        );
        expect(offMap.reason).toBe('EDGE_ENDPOINT_NOT_ON_MAP');
        const twice = await refusal(saveStoryMap(ctx, seeded.bookId, 'relationship', { expectedVersion: 0, nodes: [node(seeded.characterId), node(seeded.characterId, 9)], edges: [], freeform: [] }));
        expect(twice.reason).toBe('DUPLICATE_NODE');
    });

    it('the database refuses a node drawing another book’s element, whoever writes it', async () => {
        const book = await freshBook('fk');
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a)], edges: [], freeform: [] });
        const map = (await mapRow(book.bookId))!;
        await expect(
            prisma.mapNode.create({ data: { workspaceId: ctx.workspaceId, bookId: book.bookId, mapId: map.id, bibleElementId: otherBook.characterId, x: 0, y: 0, w: 10, h: 10 } }),
        ).rejects.toThrow();
        await expect(
            prisma.mapNode.create({ data: { workspaceId: ctx.workspaceId, bookId: otherBook.bookId, mapId: map.id, bibleElementId: otherBook.characterId, x: 0, y: 0, w: 10, h: 10 } }),
        ).rejects.toThrow();
    });

    it('one map of each kind per book (D18): a second row of a kind is refused by the database', async () => {
        const book = await freshBook('d18');
        const ev = await createElement(ctx, book.bookId, { kind: 'TIMELINE_EVENT', name: 'Event d18' });
        await saveStoryMap(ctx, book.bookId, 'timeline', { expectedVersion: 0, nodes: [node(ev.id)], edges: [], freeform: [] });
        await expect(prisma.storyMap.create({ data: { workspaceId: ctx.workspaceId, bookId: book.bookId, kind: 'TIMELINE' } })).rejects.toThrow(/Unique constraint/);
        // The three kinds are three maps.
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.b)], edges: [], freeform: [] });
        expect(await prisma.storyMap.count({ where: { bookId: book.bookId } })).toBe(2);
    });
});

async function snapshotVersions(bookId: string) {
    const map = (await mapRow(bookId))!;
    return (await prisma.mapSnapshot.findMany({ where: { mapId: map.id }, orderBy: { version: 'asc' }, select: { version: true } })).map((s) => s.version);
}

/** Every version 1..current has exactly one snapshot (D20: history never skips a version). */
async function expectUnbrokenHistory(bookId: string) {
    const map = (await mapRow(bookId))!;
    expect(await snapshotVersions(bookId)).toEqual(Array.from({ length: map.version }, (_, i) => i + 1));
}

/** Resolve when some backend is waiting on an advisory lock (the usecase reached the map lock). */
async function untilWaitingOnAdvisoryLock() {
    for (let i = 0; i < 200; i++) {
        const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        if (Number(row.n) > 0) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('nothing waited on the map lock');
}

describe('the bible’s deletions', () => {
    it('deleting an element removes its node and edges and moves the version ONCE, with a snapshot of the map as it now stands (D20)', async () => {
        const book = await freshBook('cascade');
        const c = await createElement(ctx, book.bookId, { kind: 'CHARACTER', name: 'C cascade' });
        await saveStoryMap(ctx, book.bookId, 'relationship', {
            expectedVersion: 0,
            nodes: [node(book.a), node(book.b), node(c.id)],
            edges: [{ relationId: book.rel, sourceElementId: book.a, targetElementId: book.b }],
            freeform: [note('shape:n1', 'kept through the cascade')],
        });
        await deleteElement(ctx, book.bookId, book.b);
        const after = await getStoryMap(ctx, book.bookId, 'relationship');
        expect(after.nodes.map((n) => n.elementId).sort()).toEqual([book.a, c.id].sort());
        expect(after.edges).toEqual([]);
        // A node and an edge went: one deletion, one version.
        expect(after.version).toBe(2);
        await expectUnbrokenHistory(book.bookId);
        const snapshot = await getMapSnapshot(ctx, book.bookId, 'relationship', '2');
        expect(snapshot).toMatchObject({ fromBibleDeletion: true, restoredFromVersion: null, nodeCount: 2, edgeCount: 0 });
        expect(snapshot.nodes.map((n) => n.elementId).sort()).toEqual([book.a, c.id].sort());
        expect(snapshot.freeform).toEqual([note('shape:n1', 'kept through the cascade')]);
        const row = await prisma.mapSnapshot.findFirst({ where: { mapId: (await mapRow(book.bookId))!.id, version: 2 } });
        expect(row?.createdById).toBe(ctx.userId);
        const listed = (await listMapSnapshots(ctx, book.bookId, 'relationship')).snapshots[0];
        expect(listed).toMatchObject({ version: 2, fromBibleDeletion: true });
        const stale = await refusal(saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 1, nodes: [node(book.a), node(book.b)], edges: [], freeform: [] }));
        expect(stale).toMatchObject({ status: 409, reason: 'VERSION_CONFLICT' });
    });

    it('removing a relation removes its edge, moves the version and writes its snapshot too', async () => {
        const book = await freshBook('rel-cascade');
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a), node(book.b)], edges: [{ relationId: book.rel, sourceElementId: book.a, targetElementId: book.b }], freeform: [] });
        await removeRelation(ctx, book.bookId, book.rel);
        const after = await getStoryMap(ctx, book.bookId, 'relationship');
        expect(after.edges).toEqual([]);
        expect(after.nodes).toHaveLength(2);
        expect(after.version).toBe(2);
        await expectUnbrokenHistory(book.bookId);
        expect(await getMapSnapshot(ctx, book.bookId, 'relationship', '2')).toMatchObject({ fromBibleDeletion: true, edges: [], nodeCount: 2 });
    });

    it('a deletion that touches no map writes nothing to it; one map moved leaves the others alone', async () => {
        const book = await freshBook('untouched');
        const c = await createElement(ctx, book.bookId, { kind: 'TIMELINE_EVENT', name: 'C untouched' });
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a)], edges: [], freeform: [] });
        await saveStoryMap(ctx, book.bookId, 'timeline', { expectedVersion: 0, nodes: [node(c.id)], edges: [], freeform: [] });
        await deleteElement(ctx, book.bookId, c.id);
        expect((await getStoryMap(ctx, book.bookId, 'relationship')).version).toBe(1);
        expect((await getStoryMap(ctx, book.bookId, 'timeline')).version).toBe(2);
        await expectUnbrokenHistory(book.bookId);
    });

    it('a deletion waits for a save of the book’s maps in progress, and its snapshot follows that save', async () => {
        const book = await freshBook('serialised');
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a), node(book.b)], edges: [], freeform: [] });
        // Stand in for a save holding the map's lock.
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let locked!: () => void;
        const lockTaken = new Promise<void>((r) => (locked = r));
        const holder = prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'story-map:' + book.bookId + ':PLOT'}))`;
                locked();
                await held;
            },
            { timeout: 20_000 },
        );
        await lockTaken;
        let deleted = false;
        const deletion = deleteElement(ctx, book.bookId, book.b).then(() => (deleted = true));
        await untilWaitingOnAdvisoryLock();
        expect(deleted).toBe(false);
        release();
        await holder;
        await deletion;
        expect((await getStoryMap(ctx, book.bookId, 'relationship')).version).toBe(2);
        await expectUnbrokenHistory(book.bookId);
    });

    it('a save and a deletion racing: whichever wins, every version has one snapshot and the map is its latest snapshot', async () => {
        for (let round = 0; round < 4; round++) {
            const book = await freshBook(`race-del-${round}`);
            await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a), node(book.b)], edges: [{ relationId: book.rel, sourceElementId: book.a, targetElementId: book.b }], freeform: [] });
            const results = await Promise.allSettled([
                saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 1, nodes: [node(book.a, 50), node(book.b, 60)], edges: [{ relationId: book.rel, sourceElementId: book.a, targetElementId: book.b }], freeform: [] }),
                deleteElement(ctx, book.bookId, book.b),
            ]);
            expect(results[1].status).toBe('fulfilled');
            if (results[0].status === 'rejected') expect((results[0].reason as { details?: { reason?: string } }).details?.reason).toBe('VERSION_CONFLICT');
            await expectUnbrokenHistory(book.bookId);
            const map = await getStoryMap(ctx, book.bookId, 'relationship');
            const latest = await getMapSnapshot(ctx, book.bookId, 'relationship', String(map.version));
            expect(latest.nodes).toEqual(map.nodes.map((n) => ({ elementId: n.elementId, x: n.x, y: n.y, w: n.w, h: n.h, lane: n.lane })));
            expect(map.nodes.map((n) => n.elementId)).toEqual([book.a]);
        }
    });

    it('the database refuses a deletion that leaves a map at a version with no snapshot, whoever deletes', async () => {
        const book = await freshBook('no-snapshot');
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a), node(book.b)], edges: [], freeform: [] });
        await expect(prisma.$executeRaw`DELETE FROM "BibleElement" WHERE "id" = ${book.b}`).rejects.toThrow(/MAP_VERSION_WITHOUT_SNAPSHOT/);
        expect(await prisma.bibleElement.count({ where: { id: book.b } })).toBe(1);
        expect((await mapRow(book.bookId))!.version).toBe(1);
    });

    it('the map’s own save deleting a node does NOT move the version twice', async () => {
        const book = await freshBook('own-delete');
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a), node(book.b)], edges: [], freeform: [] });
        const r = await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 1, nodes: [node(book.a)], edges: [], freeform: [] });
        expect(r.map.version).toBe(2);
    });
});

describe('snapshots', () => {
    it('lists one per save newest first, reads one back, and restores it as a NEW save naming what it restored', async () => {
        const book = await freshBook('restore');
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a, 1, 1)], edges: [], freeform: [note('shape:n1', 'first')] });
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 1, nodes: [node(book.a, 2, 2), node(book.b)], edges: [], freeform: [] });
        const list = await listMapSnapshots(ctx, book.bookId, 'relationship');
        expect(list.snapshots.map((s) => [s.version, s.nodeCount])).toEqual([
            [2, 2],
            [1, 1],
        ]);
        const v1 = await getMapSnapshot(ctx, book.bookId, 'relationship', '1');
        expect(v1.nodes).toEqual([node(book.a, 1, 1)]);
        expect(v1.freeform).toEqual([note('shape:n1', 'first')]);

        const stale = await refusal(restoreMapSnapshot(ctx, book.bookId, 'relationship', '1', { expectedVersion: 1 }));
        expect(stale).toMatchObject({ status: 409, reason: 'VERSION_CONFLICT' });

        const restored = await restoreMapSnapshot(ctx, book.bookId, 'relationship', '1', { expectedVersion: 2 });
        expect(restored).toMatchObject({ saved: true, restoredFromVersion: 1, dropped: { nodes: 0, edges: 0 }, map: { version: 3 } });
        expect(restored.map.nodes.map((n) => [n.elementId, n.x])).toEqual([[book.a, 1]]);
        expect(restored.map.freeform).toEqual([note('shape:n1', 'first')]);
        const top = (await listMapSnapshots(ctx, book.bookId, 'relationship')).snapshots[0];
        expect(top).toMatchObject({ version: 3, restoredFromVersion: 1 });
    });

    it('a restore leaves out, and counts, what the bible no longer holds', async () => {
        const book = await freshBook('restore-dropped');
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a), node(book.b)], edges: [{ relationId: book.rel, sourceElementId: book.a, targetElementId: book.b }], freeform: [] });
        await deleteElement(ctx, book.bookId, book.b);
        const version = (await getStoryMap(ctx, book.bookId, 'relationship')).version;
        expect(version).toBe(2);
        const restored = await restoreMapSnapshot(ctx, book.bookId, 'relationship', '1', { expectedVersion: version });
        expect(restored.dropped).toEqual({ nodes: 1, edges: 1 });
        expect(restored.map.nodes.map((n) => n.elementId)).toEqual([book.a]);
        // What survives of version 1 IS the map the deletion left (version 2): nothing to write.
        expect(restored).toMatchObject({ saved: false, map: { version: 2 } });
        await expectUnbrokenHistory(book.bookId);
    });

    it('is append-only for every role: UPDATE and DELETE refused even to the superuser; a book’s purge takes them with it', async () => {
        const book = await freshBook('append-only');
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a)], edges: [], freeform: [] });
        const map = (await mapRow(book.bookId))!;
        await expect(prisma.$executeRaw`UPDATE "MapSnapshot" SET "nodeCount" = 9 WHERE "mapId" = ${map.id}`).rejects.toThrow(/MAP_SNAPSHOT_APPEND_ONLY/);
        await expect(prisma.$executeRaw`DELETE FROM "MapSnapshot" WHERE "mapId" = ${map.id}`).rejects.toThrow(/MAP_SNAPSHOT_APPEND_ONLY/);
        await expect(prisma.$executeRaw`TRUNCATE "MapSnapshot"`).rejects.toThrow(/MAP_SNAPSHOT_APPEND_ONLY/);
        // app_user cannot reach the cascade exception by deleting the map itself.
        await expect(runInWorkspaceContext(ctx, (db) => db.$executeRaw`DELETE FROM "StoryMap" WHERE "id" = ${map.id}`)).rejects.toThrow(/permission denied/);
        await expect(runInWorkspaceContext(ctx, (db) => db.$executeRaw`DELETE FROM "MapSnapshot" WHERE "mapId" = ${map.id}`)).rejects.toThrow(/permission denied/);
        expect(await prisma.mapSnapshot.count({ where: { mapId: map.id } })).toBe(1);
        // The purge: a book deleted long enough ago goes, with its maps and their history.
        await prisma.book.update({ where: { id: book.bookId }, data: { deletedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) } });
        await prisma.$executeRaw`DELETE FROM "Book" WHERE "id" = ${book.bookId}`;
        expect(await prisma.mapSnapshot.count({ where: { mapId: map.id } })).toBe(0);
        expect(await prisma.mapNode.count({ where: { mapId: map.id } })).toBe(0);
    });
});

describe('author text in the freeform layer', () => {
    it('is sanitised on the way in and encrypted at rest, in the map and in its snapshot', async () => {
        const book = await freshBook('freeform');
        const saved = await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [], edges: [], freeform: [note('shape:n1', 'FREEFORM-MARKER <script>alert(1)</script>')] });
        expect(saved.map.freeform).toEqual([note('shape:n1', 'FREEFORM-MARKER ')]);
        const [raw] = await prisma.$queryRaw<Array<{ freeformJson: string }>>`SELECT "freeformJson" FROM "StoryMap" WHERE "bookId" = ${book.bookId}`;
        expect(raw.freeformJson.startsWith('v2:')).toBe(true);
        expect(raw.freeformJson).not.toContain('FREEFORM-MARKER');
        const [snap] = await prisma.$queryRaw<Array<{ snapshot: string }>>`SELECT s."snapshot" FROM "MapSnapshot" s JOIN "StoryMap" m ON m."id" = s."mapId" WHERE m."bookId" = ${book.bookId}`;
        expect(snap.snapshot.startsWith('v2:')).toBe(true);
        expect(snap.snapshot).not.toContain('FREEFORM-MARKER');
    });

    it('a record of the canvas’s own types, or a prototype key, is refused FREEFORM_REFUSED and nothing is written', async () => {
        const book = await freshBook('freeform-refused');
        const r = await refusal(saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [], edges: [], freeform: [{ id: 'shape:x', typeName: 'shape', type: 'story-node' }] }));
        expect(r).toMatchObject({ status: 400, reason: 'FREEFORM_REFUSED', details: { problem: 'STRUCTURED_TYPE' } });
        expect(await mapRow(book.bookId)).toBeNull();
    });

    it('a record carrying a node’s or an edge’s id is refused RESERVED_ID, on a save and on a restore, writing nothing', async () => {
        const book = await freshBook('freeform-reserved');
        const edge = { relationId: book.rel, sourceElementId: book.a, targetElementId: book.b };
        for (const id of [`shape:${book.a}`, `shape:edge-${book.rel}`, `binding:${book.rel}`]) {
            const r = await refusal(saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a), node(book.b, 400)], edges: [edge], freeform: [note(id, 'over the row')] }));
            expect([id, r]).toMatchObject([id, { status: 400, reason: 'FREEFORM_REFUSED', details: { problem: 'RESERVED_ID' } }]);
        }
        expect(await mapRow(book.bookId)).toBeNull();
        // A snapshot carrying one (written before the rule) is not restored over the live map either.
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a)], edges: [], freeform: [] });
        const map = (await mapRow(book.bookId))!;
        // The version first, then its snapshot, as every product path writes them (3.H: a snapshot names the map's current version).
        await runInWorkspaceContext(ctx, async (db) => {
            await db.storyMap.update({ where: { id: map.id }, data: { version: 2 } });
            await db.mapSnapshot.create({
                data: { workspaceId: ctx.workspaceId, mapId: map.id, version: 2, nodeCount: 1, edgeCount: 0, snapshot: JSON.stringify({ nodes: [node(book.a)], edges: [], freeform: [note(`shape:${book.a}`, 'x')] }) },
            });
        });
        const r = await refusal(restoreMapSnapshot(ctx, book.bookId, 'relationship', 2, { expectedVersion: 2 }));
        expect(r).toMatchObject({ status: 400, reason: 'FREEFORM_REFUSED', details: { problem: 'RESERVED_ID' } });
        expect((await mapRow(book.bookId))!.version).toBe(2);
    });
});

describe('permissions', () => {
    it('a READER reads a map and is refused a save and a restore', async () => {
        const owner = await createAccount({ workspaceName: 'Reader maps' });
        const ownerCtx = workspaceCtx(owner);
        const book = await createBook(ownerCtx, { title: 'Reader book' });
        const reader = await createBareUser();
        await addMember(owner.workspaceId, reader.id, 'READER');
        const readerCtx = workspaceCtx({ userId: reader.id, workspaceId: owner.workspaceId, workspaceSlug: owner.workspaceSlug }, 'READER');
        expect((await getStoryMap(readerCtx, book.id, 'relationship')).version).toBe(0);
        expect((await refusal(saveStoryMap(readerCtx, book.id, 'relationship', { expectedVersion: 0, nodes: [], edges: [], freeform: [] }))).status).toBe(403);
        expect((await refusal(restoreMapSnapshot(readerCtx, book.id, 'relationship', '1', { expectedVersion: 0 }))).status).toBe(403);
    });
});
