/**
 * Hardening the story canvas's server side (Phase 3.H) against a real
 * PostgreSQL:
 *
 *   - a snapshot must name the map's CURRENT version, for every role (issue
 *     #45, item 1): one inserted ahead used to make every later save of that
 *     map a unique-key 500;
 *   - a bible deletion's once-per-transaction marker is ONE setting, not a
 *     setting named per map that a pooled backend kept for ever (#45, item 5);
 *   - the history after 200 saves: read a page at a time, every version
 *     reachable, and a restore of the oldest and of one in the middle gives
 *     back exactly what that save stored (item 6);
 *   - a full map (500 nodes, 1,500 edges) on each of the three maps saves and
 *     reads back, and the work is BOUNDED: a save and a view send the same
 *     number of statements for 500 nodes as for 50 (no per-node query; item 2).
 */
import { Client } from 'pg';
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { getMapSnapshot, getStoryMap, listMapSnapshots, restoreMapSnapshot, saveStoryMap } from '@/app-layer/usecases/story-maps';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { encodeFieldValue } from '@/lib/bible/field-values';
import { rankBetween } from '@/lib/bible/story-order';
import { MAX_MAP_EDGES, MAX_MAP_NODES, SNAPSHOT_PAGE_SIZE } from '@/lib/canvas/limits';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());
jest.setTimeout(300_000);

let ctx: WorkspaceRequestContext;

beforeAll(async () => {
    ctx = workspaceCtx(await createAccount({ workspaceName: 'Canvas hardening' }));
});

const node = (elementId: string, x = 0, y = 0) => ({ elementId, x, y, w: 220, h: 88, lane: null });

async function twoCharacters(marker: string) {
    const book = await createBook(ctx, { title: `Hardening ${marker}` });
    const a = await createElement(ctx, book.id, { kind: 'CHARACTER', name: `A ${marker}` });
    const b = await createElement(ctx, book.id, { kind: 'CHARACTER', name: `B ${marker}` });
    return { bookId: book.id, a: a.id, b: b.id };
}

const mapRow = (bookId: string, kind: 'RELATIONSHIP' | 'PLOT' | 'TIMELINE' = 'RELATIONSHIP') => prisma.storyMap.findFirstOrThrow({ where: { bookId, kind } });

describe('a snapshot names the map’s current version (issue #45, item 1)', () => {
    it('one inserted ahead of the map is refused, for app_user and the superuser alike, and the next save still works', async () => {
        const book = await twoCharacters('ahead');
        await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 0, nodes: [node(book.a)], edges: [], freeform: [] });
        const map = await mapRow(book.bookId);
        expect(map.version).toBe(1);
        const insertAt = (db: typeof prisma, version: number) =>
            db.$executeRaw`INSERT INTO "MapSnapshot" ("id", "workspaceId", "mapId", "version", "snapshot", "nodeCount", "edgeCount")
                           VALUES (${`ahead-${version}-${Math.random()}`}, ${ctx.workspaceId}, ${map.id}, ${version}, 'x', 0, 0)`;
        await expect(runInWorkspaceContext(ctx, (db) => insertAt(db as unknown as typeof prisma, 2))).rejects.toThrow(/MAP_SNAPSHOT_NOT_CURRENT/);
        await expect(insertAt(prisma, 2)).rejects.toThrow(/MAP_SNAPSHOT_NOT_CURRENT/);
        await expect(insertAt(prisma, 7)).rejects.toThrow(/MAP_SNAPSHOT_NOT_CURRENT/);
        // The current version already has its snapshot: a second is the unique key's.
        await expect(insertAt(prisma, 1)).rejects.toThrow();
        expect(await prisma.mapSnapshot.count({ where: { mapId: map.id } })).toBe(1);
        // The map's own next save writes version 2 (it would have hit a unique violation, every time).
        const next = await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: 1, nodes: [node(book.a, 50)], edges: [], freeform: [] });
        expect(next).toMatchObject({ saved: true, map: { version: 2 } });
    });
});

describe('the cascade marker is one setting (issue #45, item 5)', () => {
    const ROLLBACK = new Error('roll back on purpose');

    it('moving many maps in one transaction leaves at most ONE custom setting, and each map still moves once', async () => {
        const books = await Promise.all([0, 1, 2].map((i) => twoCharacters(`marker-${i}`)));
        for (const b of books) await saveStoryMap(ctx, b.bookId, 'relationship', { expectedVersion: 0, nodes: [node(b.a)], edges: [], freeform: [] });
        const maps = await Promise.all(books.map((b) => mapRow(b.bookId)));
        await expect(
            prisma.$transaction(async (tx) => {
                for (const m of maps) {
                    await tx.$executeRaw`SELECT map_bump_once_for_cascade(${m.id})`;
                    await tx.$executeRaw`SELECT map_bump_once_for_cascade(${m.id})`;
                }
                // Maps that do not exist (a purge's): nothing is remembered for them.
                for (let i = 0; i < 40; i++) await tx.$executeRaw`SELECT map_bump_once_for_cascade(${`gone-${i}`})`;
                const versions = await tx.storyMap.findMany({ where: { id: { in: maps.map((m) => m.id) } }, select: { version: true } });
                expect(versions.map((v) => v.version)).toEqual([2, 2, 2]);
                const settings = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_settings WHERE name LIKE 'inkquisitor.map_cascade%'`;
                expect(Number(settings[0].n)).toBeLessThanOrEqual(1);
                throw ROLLBACK;
            }),
        ).rejects.toBe(ROLLBACK);
        // Rolled back: the maps are where they were, and the next transaction moves them again.
        expect((await Promise.all(books.map((b) => mapRow(b.bookId)))).map((m) => m.version)).toEqual([1, 1, 1]);
    });
});

describe('the history after 200 saves (item 6)', () => {
    const SAVES = 200;
    let book: Awaited<ReturnType<typeof twoCharacters>>;

    beforeAll(async () => {
        book = await twoCharacters('two-hundred');
        for (let i = 1; i <= SAVES; i++) {
            const nodes = [node(book.a, i, -i), ...(i % 2 === 0 ? [node(book.b, 1000 + i)] : [])];
            const freeform = [{ id: 'shape:n', typeName: 'shape', type: 'note', x: 0, y: 0, props: { text: `save ${i} if a<b` } }];
            const r = await saveStoryMap(ctx, book.bookId, 'relationship', { expectedVersion: i - 1, nodes, edges: [], freeform });
            expect(r.map.version).toBe(i);
        }
    });

    it('is read a page at a time, newest first, and every version is reachable', async () => {
        const seen: number[] = [];
        let before: number | undefined;
        let pages = 0;
        for (;;) {
            const page = await listMapSnapshots(ctx, book.bookId, 'relationship', before);
            pages += 1;
            expect(page.snapshots.length).toBeLessThanOrEqual(SNAPSHOT_PAGE_SIZE);
            seen.push(...page.snapshots.map((s) => s.version));
            expect(page.truncated).toBe(page.nextBefore !== null);
            if (page.nextBefore === null) break;
            before = page.nextBefore;
        }
        expect(seen).toEqual(Array.from({ length: SAVES }, (_, i) => SAVES - i));
        expect(pages).toBe(Math.ceil(SAVES / SNAPSHOT_PAGE_SIZE));
        expect(await listMapSnapshots(ctx, book.bookId, 'relationship', String(SNAPSHOT_PAGE_SIZE + 1))).toMatchObject({ nextBefore: null });
        await expect(listMapSnapshots(ctx, book.bookId, 'relationship', 'not-a-version')).rejects.toThrow();
    });

    it('restoring the oldest save, and one in the middle, gives back exactly what each stored, as new saves', async () => {
        const v1 = await getMapSnapshot(ctx, book.bookId, 'relationship', '1');
        expect(v1.nodes).toEqual([node(book.a, 1, -1)]);
        const first = await restoreMapSnapshot(ctx, book.bookId, 'relationship', '1', { expectedVersion: SAVES });
        expect(first).toMatchObject({ saved: true, restoredFromVersion: 1, map: { version: SAVES + 1 } });
        expect(first.map.nodes.map((n) => [n.elementId, n.x, n.y])).toEqual([[book.a, 1, -1]]);
        expect(first.map.freeform).toEqual([{ id: 'shape:n', typeName: 'shape', type: 'note', x: 0, y: 0, props: { text: 'save 1 if a<b' } }]);

        const middle = await restoreMapSnapshot(ctx, book.bookId, 'relationship', '138', { expectedVersion: SAVES + 1 });
        expect(middle.map.version).toBe(SAVES + 2);
        expect(middle.map.nodes.map((n) => [n.elementId, n.x]).sort()).toEqual([
            [book.a, 138],
            [book.b, 1138],
        ]);
        // The history grew by two and lost nothing: append-only.
        const top = await listMapSnapshots(ctx, book.bookId, 'relationship');
        expect(top.snapshots.slice(0, 3).map((s) => [s.version, s.restoredFromVersion])).toEqual([
            [SAVES + 2, 138],
            [SAVES + 1, 1],
            [SAVES, null],
        ]);
        const map = await mapRow(book.bookId);
        expect(await prisma.mapSnapshot.count({ where: { mapId: map.id } })).toBe(SAVES + 2);
    });
});

// ─── A full map, and the statements it costs ─────────────────────────

/** Statements sent to PostgreSQL while `fn` runs (every pooled client's `query`). */
async function statements<T>(fn: () => Promise<T>): Promise<{ result: T; count: number }> {
    const spy = jest.spyOn(Client.prototype, 'query');
    try {
        const result = await fn();
        return { result, count: spy.mock.calls.length };
    } finally {
        spy.mockRestore();
    }
}

interface SeededMapBook {
    bookId: string;
    elementIds: string[];
    relationIds: string[];
}

/**
 * A book of `n` elements of one kind seeded through the fast path (createMany
 * in the workspace's own context: sealed as the product seals). Characters
 * are related in pairs (i, i+1..i+3, then i+4 for the rest) up to `edges`;
 * beats get an act and a rank; events a rank and characters taking part.
 */
async function seedMapBook(kind: 'CHARACTER' | 'PLOT_BEAT' | 'TIMELINE_EVENT', n: number, edges: number): Promise<SeededMapBook> {
    const book = await createBook(ctx, { title: `Full ${kind} ${n}` });
    const stamp = Math.random().toString(36).slice(2, 8);
    const ids = Array.from({ length: n }, (_, i) => `fm${stamp}${kind.slice(0, 2).toLowerCase()}${String(i).padStart(4, '0')}`);
    const relationIds: string[] = [];
    await runInWorkspaceContext(
        ctx,
        async (db) => {
            // Placed in order, every seventh not placed yet.
            let last: string | null = null;
            await db.bibleElement.createMany({
                data: ids.map((id, i) => {
                    let orderRank: string | null = null;
                    if (kind !== 'CHARACTER' && i % 7 !== 6) orderRank = last = rankBetween(last, null);
                    return { id, workspaceId: ctx.workspaceId, bookId: book.id, kind, name: `${kind} ${i}`, slug: `e-${i}`, orderRank };
                }),
            });
            if (kind === 'PLOT_BEAT') {
                const acts = ['opening', 'escalation', 'crisis', 'resolution'];
                await db.bibleField.createMany({ data: ids.map((id, i) => ({ workspaceId: ctx.workspaceId, elementId: id, key: 'act', value: encodeFieldValue(acts[i % 4]), order: 1 })) });
            }
            const pairs: Array<[number, number]> = [];
            for (let d = 1; d <= 4 && pairs.length < edges; d++) for (let i = 0; i + d < n && pairs.length < edges; i++) pairs.push([i, i + d]);
            if (pairs.length > 0) {
                const rows = pairs.map(([a, b], k) => ({ id: `fr${stamp}${String(k).padStart(5, '0')}`, workspaceId: ctx.workspaceId, bookId: book.id, fromElementId: ids[a], toElementId: ids[b], type: 'related_to', symmetric: true }));
                await db.bibleRelation.createMany({ data: rows });
                relationIds.push(...rows.map((r) => r.id));
            }
            if (kind === 'TIMELINE_EVENT') {
                // Twenty characters, each taking part in every tenth event (two characters an event): 1,000 links.
                const characters = Array.from({ length: 20 }, (_, c) => `fm${stamp}ch${c}`);
                await db.bibleElement.createMany({ data: characters.map((id, c) => ({ id, workspaceId: ctx.workspaceId, bookId: book.id, kind: 'CHARACTER' as const, name: `Character ${c}`, slug: `c-${c}` })) });
                await db.bibleRelation.createMany({
                    data: characters.flatMap((cid, c) => ids.filter((_, i) => i % 10 === c % 10).map((eid) => ({ workspaceId: ctx.workspaceId, bookId: book.id, fromElementId: cid, toElementId: eid, type: 'takes_part_in' }))),
                });
            }
        },
        { timeout: 120_000 },
    );
    return { bookId: book.id, elementIds: ids, relationIds };
}

async function fullMapOf(kind: 'CHARACTER' | 'PLOT_BEAT' | 'TIMELINE_EVENT', slug: string, n: number, edgeCount: number) {
    const seeded = await seedMapBook(kind, n, edgeCount);
    const relations = await prisma.bibleRelation.findMany({ where: { id: { in: seeded.relationIds } }, select: { id: true, fromElementId: true, toElementId: true }, take: seeded.relationIds.length });
    const body = {
        expectedVersion: 0,
        nodes: seeded.elementIds.map((id, i) => node(id, (i % 25) * 260, Math.floor(i / 25) * 140)),
        edges: relations.map((r) => ({ relationId: r.id, sourceElementId: r.fromElementId, targetElementId: r.toElementId })),
        freeform: [],
    };
    const save = await statements(() => saveStoryMap(ctx, seeded.bookId, slug, body));
    const view = await statements(() => getStoryMap(ctx, seeded.bookId, slug));
    const again = await statements(() => saveStoryMap(ctx, seeded.bookId, slug, { ...body, expectedVersion: 1 }));
    return { seeded, body, save, view, again };
}

describe.each([
    ['CHARACTER', 'relationship', MAX_MAP_EDGES],
    ['PLOT_BEAT', 'plot', MAX_MAP_EDGES],
    ['TIMELINE_EVENT', 'timeline', MAX_MAP_EDGES],
] as const)('a full %s map (%s): 500 nodes, 1,500 edges', (kind, slug, edges) => {
    let small: Awaited<ReturnType<typeof fullMapOf>>;
    let full: Awaited<ReturnType<typeof fullMapOf>>;

    beforeAll(async () => {
        small = await fullMapOf(kind, slug, MAX_MAP_NODES / 10, edges / 10);
        full = await fullMapOf(kind, slug, MAX_MAP_NODES, edges);
    });

    it('saves and reads back every node and edge; the same state again writes nothing', () => {
        expect(full.save.result).toMatchObject({ saved: true, map: { version: 1 } });
        expect(full.view.result.nodes).toHaveLength(MAX_MAP_NODES);
        expect(full.view.result.edges).toHaveLength(full.body.edges.length);
        expect(full.body.edges.length).toBe(edges);
        expect(full.again.result).toMatchObject({ saved: false, map: { version: 1 } });
        if (slug !== 'relationship') {
            // A derived map stores the bible's places, whatever the save sent.
            const sent = new Map(full.body.nodes.map((n) => [n.elementId, n]));
            expect(full.view.result.nodes.some((n) => n.x !== sent.get(n.elementId)!.x)).toBe(true);
            expect(new Set(full.view.result.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(MAX_MAP_NODES);
        }
        if (slug === 'timeline') expect(full.view.result.participants.length).toBe(2 * MAX_MAP_NODES);
    });

    it('costs the same number of statements at 500 nodes as at 50: no query per node or edge', () => {
        expect(full.save.count).toBeLessThanOrEqual(small.save.count + 2);
        expect(full.view.count).toBeLessThanOrEqual(small.view.count + 2);
        expect(full.again.count).toBeLessThanOrEqual(small.again.count + 2);
        // And a handful in absolute terms, not hundreds.
        expect(full.save.count).toBeLessThan(80);
        expect(full.view.count).toBeLessThan(40);
    });
});
