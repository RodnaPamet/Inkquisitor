/**
 * The three maps' server side against a real PostgreSQL (Phase 3.2, decision
 * D22): the story order kept in the bible (a move writes the one element moved
 * and one version; two moves at once never take one place; a stale move is
 * refused), each map's kinds, the derived maps' positions taken from the
 * bible, relations made and removed from the canvas, the timeline's
 * participants, PLOT_BEAT through the bundle round trip, and its pack.
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, getElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { addRelation, removeRelation } from '@/app-layer/usecases/bible-relations';
import { moveElementInOrder } from '@/app-layer/usecases/bible-order';
import { getStoryMap, restoreMapSnapshot, saveStoryMap } from '@/app-layer/usecases/story-maps';
import { listVersions, getVersion, restoreVersion } from '@/app-layer/usecases/bible-versions';
import { exportBibleBundle } from '@/app-layer/usecases/bible-export';
import { importBibleBundle, type ImportDeps } from '@/app-layer/usecases/bible-import';
import { listInterviewPacks } from '@/app-layer/usecases/interview-packs';
import { readZip, writeZip } from '@/lib/archive/zip';
import { compareRanks } from '@/lib/bible/story-order';
import { deriveLaneLayout } from '@/lib/canvas/lanes';
import type { ScanResult } from '@/lib/storage/av-scan';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const clean: ImportDeps = { scan: async (): Promise<ScanResult> => ({ status: 'CLEAN', engine: 'test', durationMs: 0 }) };

let ctx: WorkspaceRequestContext;

beforeAll(async () => {
    ctx = workspaceCtx(await createAccount({ workspaceName: 'Three maps' }));
});

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason?: string; details: Record<string, unknown> }> {
    try {
        await p;
    } catch (err) {
        const e = err as { status?: number; details?: Record<string, unknown> };
        return { status: e.status ?? 0, reason: e.details?.reason as string | undefined, details: e.details ?? {} };
    }
    throw new Error('expected a refusal');
}

const versionOf = async (bookId: string, id: string) => (await getElement(ctx, bookId, id)).versionNumber;
const rankOf = async (id: string) => (await prisma.bibleElement.findUniqueOrThrow({ where: { id }, select: { orderRank: true } })).orderRank;

/** Move `id` between `after` and `before`, on its current version. */
async function move(bookId: string, id: string, after: string | null, before: string | null, act?: string) {
    return moveElementInOrder(ctx, bookId, id, { baseVersion: await versionOf(bookId, id), after, before, ...(act ? { act } : {}) });
}

async function timelineBook(marker: string, names: string[]) {
    const book = await createBook(ctx, { title: `Timeline ${marker}` });
    const events = [];
    for (const name of names) events.push(await createElement(ctx, book.id, { kind: 'TIMELINE_EVENT', name, fields: [{ key: 'story_time', value: `When ${name}` }] }));
    return { bookId: book.id, ids: events.map((e) => e.id) };
}

describe('the story order is the bible’s', () => {
    it('a move writes the moved element alone: its rank and ONE version marked as a move; nobody else’s row', async () => {
        const { bookId, ids } = await timelineBook('move', ['First', 'Second', 'Third']);
        const [a, b, c] = ids;
        const placedA = await move(bookId, a, null, null);
        expect(placedA).toMatchObject({ moved: true, versionNumber: 2 });
        await move(bookId, b, a, null);
        const before = await prisma.bibleElement.findMany({ where: { bookId }, select: { id: true, orderRank: true, updatedAt: true } });

        // c goes between a and b.
        const r = await move(bookId, c, a, b);
        expect(r.moved).toBe(true);
        expect(compareRanks((await rankOf(a))!, r.orderRank!)).toBeLessThan(0);
        expect(compareRanks(r.orderRank!, (await rankOf(b))!)).toBeLessThan(0);
        const after = await prisma.bibleElement.findMany({ where: { bookId }, select: { id: true, orderRank: true, updatedAt: true } });
        for (const row of after.filter((x) => x.id !== c)) expect(row).toEqual(before.find((x) => x.id === row.id));

        const versions = await listVersions(ctx, bookId, c, { take: 10 });
        expect(versions.map((v) => [v.versionNumber, v.movedInOrder, v.changeSummary])).toEqual([
            [2, true, null],
            [1, false, null],
        ]);
        expect((await getVersion(ctx, bookId, c, 2)).snapshot.element.orderRank).toBe(r.orderRank);
        // A snapshot of an element never placed carries no rank at all.
        expect(Object.keys((await getVersion(ctx, bookId, c, 1)).snapshot.element)).not.toContain('orderRank');
    });

    it('a move that leaves the element where it stands writes nothing', async () => {
        const { bookId, ids } = await timelineBook('noop', ['One', 'Two']);
        await move(bookId, ids[0], null, null);
        await move(bookId, ids[1], ids[0], null);
        const again = await move(bookId, ids[1], ids[0], null);
        expect(again).toMatchObject({ moved: false, versionNumber: 2 });
        expect(await prisma.bibleEntryVersion.count({ where: { elementId: ids[1] } })).toBe(2);
    });

    it('refuses a stale base, a neighbour that is not placed or no longer in that order, itself, and a kind with no order', async () => {
        const { bookId, ids } = await timelineBook('refuse', ['A', 'B', 'C']);
        await move(bookId, ids[0], null, null);
        await move(bookId, ids[1], ids[0], null);
        expect(await refusal(moveElementInOrder(ctx, bookId, ids[2], { baseVersion: 9, after: null, before: null }))).toMatchObject({ status: 409, reason: 'VERSION_CONFLICT' });
        expect(await refusal(move(bookId, ids[1], ids[2], null))).toMatchObject({ status: 409, reason: 'ORDER_STALE' });
        expect(await refusal(move(bookId, ids[2], ids[1], ids[0]))).toMatchObject({ status: 409, reason: 'ORDER_STALE' });
        expect(await refusal(move(bookId, ids[2], ids[2], null))).toMatchObject({ status: 400, reason: 'ORDER_SELF' });
        const ch = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Nobody in order' });
        expect(await refusal(move(bookId, ch.id, null, null))).toMatchObject({ status: 400, reason: 'ORDER_NOT_ALLOWED' });
        expect(await refusal(move(bookId, ids[2], null, null, 'crisis'))).toMatchObject({ status: 400, reason: 'ORDER_ACT_NOT_ALLOWED' });
        // Nothing of those wrote a version.
        expect(await prisma.bibleEntryVersion.count({ where: { elementId: ids[2] } })).toBe(1);
    });

    it('two moves into one gap at once take two places, both inside it, and the unique index holds', async () => {
        const { bookId, ids } = await timelineBook('race', ['A', 'B', 'C', 'D', 'E']);
        const [a, b, c, d, e] = ids;
        await move(bookId, a, null, null);
        await move(bookId, b, a, null);
        const results = await Promise.all([move(bookId, c, a, b), move(bookId, d, a, b), move(bookId, e, a, b)]);
        const ranks = results.map((r) => r.orderRank!);
        expect(new Set(ranks).size).toBe(3);
        const ra = (await rankOf(a))!;
        const rb = (await rankOf(b))!;
        for (const r of ranks) expect(compareRanks(ra, r) < 0 && compareRanks(r, rb) < 0).toBe(true);
    });

    it('two moves of ONE element from one base: one wins, the other is refused VERSION_CONFLICT and writes nothing', async () => {
        const { bookId, ids } = await timelineBook('same', ['A', 'B', 'C']);
        await move(bookId, ids[0], null, null);
        await move(bookId, ids[1], ids[0], null);
        const base = await versionOf(bookId, ids[2]);
        const outcomes = await Promise.allSettled([
            moveElementInOrder(ctx, bookId, ids[2], { baseVersion: base, after: null, before: ids[0] }),
            moveElementInOrder(ctx, bookId, ids[2], { baseVersion: base, after: ids[1], before: null }),
        ]);
        expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
        const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
        expect((rejected.reason as { details?: { reason?: string } }).details?.reason).toBe('VERSION_CONFLICT');
        expect(await prisma.bibleEntryVersion.count({ where: { elementId: ids[2] } })).toBe(2);
    });

    it('a beat moved into another act changes its act field and rank in one version; a restore keeps its place', async () => {
        const book = await createBook(ctx, { title: 'Acts' });
        const b1 = await createElement(ctx, book.id, { kind: 'PLOT_BEAT', name: 'Opens', fields: [{ key: 'act', value: 'opening' }] });
        const b2 = await createElement(ctx, book.id, { kind: 'PLOT_BEAT', name: 'Turns', fields: [{ key: 'act', value: 'crisis' }] });
        await move(book.id, b1.id, null, null);
        await move(book.id, b2.id, null, null);
        const moved = await move(book.id, b1.id, null, b2.id, 'crisis');
        expect(moved).toMatchObject({ moved: true, act: 'crisis' });
        const view = await getElement(ctx, book.id, b1.id);
        expect(view.fields.find((f) => f.key === 'act')!.value).toBe('crisis');
        expect(await prisma.bibleEntryVersion.count({ where: { elementId: b1.id } })).toBe(3);
        expect(await refusal(move(book.id, b1.id, null, null, 'no_such_act'))).toMatchObject({ status: 400, reason: 'FIELD_VALUES_REFUSED' });

        // Restoring version 1 (no act change since? act was opening) brings the act back, never the place.
        const rank = await rankOf(b1.id);
        await restoreVersion(ctx, book.id, b1.id, 1, { baseVersion: view.versionNumber });
        expect(await rankOf(b1.id)).toBe(rank);
        expect((await getElement(ctx, book.id, b1.id)).fields.find((f) => f.key === 'act')!.value).toBe('opening');
    });

    it('a stranger cannot move another workspace’s element, and a reader cannot move at all', async () => {
        const { bookId, ids } = await timelineBook('authz', ['A']);
        const stranger = workspaceCtx(await createAccount({ workspaceName: 'Elsewhere' }));
        expect((await refusal(moveElementInOrder(stranger, bookId, ids[0], { baseVersion: 1, after: null, before: null }))).status).toBe(404);
        const reader = await createBareUser();
        await addMember(ctx.workspaceId, reader.id, 'READER');
        const readerCtx = workspaceCtx({ userId: reader.id, workspaceId: ctx.workspaceId, workspaceSlug: ctx.workspaceSlug }, 'READER');
        expect((await refusal(moveElementInOrder(readerCtx, bookId, ids[0], { baseVersion: 1, after: null, before: null }))).status).toBe(403);
        expect(await rankOf(ids[0])).toBeNull();
    });
});

describe('each map draws its own kinds', () => {
    it('a save naming another kind is refused KIND_NOT_ON_MAP, writing nothing', async () => {
        const book = await createBook(ctx, { title: 'Kinds' });
        const ch = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Ada' });
        const r = await refusal(saveStoryMap(ctx, book.id, 'plot', { expectedVersion: 0, nodes: [{ elementId: ch.id, x: 0, y: 0, w: 220, h: 88, lane: null }], edges: [], freeform: [] }));
        expect(r).toMatchObject({ status: 400, reason: 'KIND_NOT_ON_MAP', details: { elementIds: [ch.id], allowedKinds: ['PLOT_BEAT'] } });
        expect(await prisma.storyMap.count({ where: { bookId: book.id } })).toBe(0);
        const ok = await saveStoryMap(ctx, book.id, 'relationship', { expectedVersion: 0, nodes: [{ elementId: ch.id, x: 10, y: 20, w: 220, h: 88, lane: null }], edges: [], freeform: [] });
        expect(ok.map.nodes[0]).toMatchObject({ x: 10, y: 20, lane: null });
    });

    it('the relationship map keeps no lane: a lane in the save is not stored (a lane makes a card the bible’s, never resizable)', async () => {
        const book = await createBook(ctx, { title: 'Free lanes' });
        const ch = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Ada' });
        const saved = await saveStoryMap(ctx, book.id, 'relationship', { expectedVersion: 0, nodes: [{ elementId: ch.id, x: 10, y: 20, w: 220, h: 88, lane: 'opening' }], edges: [], freeform: [] });
        expect(saved.map.nodes[0]).toMatchObject({ x: 10, y: 20, lane: null });
        expect((await prisma.mapNode.findFirstOrThrow({ where: { bibleElementId: ch.id } })).lane).toBeNull();
    });

    it('a map saved before 3.2 holding another kind shows without it, says so, and its next save leaves it out', async () => {
        const book = await createBook(ctx, { title: 'Old map' });
        const ev = await createElement(ctx, book.id, { kind: 'TIMELINE_EVENT', name: 'Flood' });
        const ch = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Ada' });
        await saveStoryMap(ctx, book.id, 'timeline', { expectedVersion: 0, nodes: [{ elementId: ev.id, x: 0, y: 0, w: 220, h: 88, lane: null }], edges: [], freeform: [] });
        // As 3.1 would have stored it: a character's node on the timeline (written as the superuser).
        const map = await prisma.storyMap.findFirstOrThrow({ where: { bookId: book.id, kind: 'TIMELINE' } });
        await prisma.mapNode.create({ data: { workspaceId: ctx.workspaceId, bookId: book.id, mapId: map.id, bibleElementId: ch.id, x: 0, y: 0, w: 220, h: 88 } });
        const view = await getStoryMap(ctx, book.id, 'timeline');
        expect(view.nodes.map((n) => n.elementId)).toEqual([ev.id]);
        expect(view.excludedNodes).toBe(1);
        // A restore of a snapshot is held to the same rule.
        const restored = await restoreMapSnapshot(ctx, book.id, 'timeline', 1, { expectedVersion: 1 });
        expect(restored.map.nodes.map((n) => n.elementId)).toEqual([ev.id]);
        expect(await prisma.mapNode.count({ where: { mapId: map.id } })).toBe(1);
    });
});

describe('the derived maps take their positions from the bible', () => {
    it('the plot board stores what the bible gives (act lane, order), whatever the save carried; a move re-lays it with no map version', async () => {
        const book = await createBook(ctx, { title: 'Board' });
        const b1 = await createElement(ctx, book.id, { kind: 'PLOT_BEAT', name: 'One', fields: [{ key: 'act', value: 'opening' }] });
        const b2 = await createElement(ctx, book.id, { kind: 'PLOT_BEAT', name: 'Two', fields: [{ key: 'act', value: 'opening' }] });
        const b3 = await createElement(ctx, book.id, { kind: 'PLOT_BEAT', name: 'Three' });
        const saved = await saveStoryMap(ctx, book.id, 'plot', {
            expectedVersion: 0,
            nodes: [b1, b2, b3].map((b, i) => ({ elementId: b.id, x: 999 + i, y: -5, w: 50, h: 50, lane: 'made-up' })),
            edges: [],
            freeform: [],
        });
        const stored = await prisma.mapNode.findMany({ where: { bookId: book.id }, select: { bibleElementId: true, x: true, y: true, w: true, h: true, lane: true } });
        const layout = deriveLaneLayout('PLOT', saved.map.nodes.map((n) => ({ elementId: n.elementId, name: n.element.name, orderRank: n.element.orderRank, act: n.element.act })), { acts: saved.map.acts })!;
        for (const row of stored) expect(row).toMatchObject({ ...layout.positions.get(row.bibleElementId)! });
        expect(stored.find((r) => r.bibleElementId === b3.id)!.lane).toBe('no-act');
        expect(saved.map.acts.map((a) => a.value)).toEqual(['opening', 'escalation', 'crisis', 'resolution']);

        await move(book.id, b2.id, null, null);
        await move(book.id, b1.id, b2.id, null);
        const view = await getStoryMap(ctx, book.id, 'plot');
        expect(view.version).toBe(saved.map.version);
        const y = (id: string) => view.nodes.find((n) => n.elementId === id)!.y;
        expect(y(b2.id)).toBeLessThan(y(b1.id));
        expect(view.nodes.find((n) => n.elementId === b1.id)!.element).toMatchObject({ act: 'opening', orderRank: expect.any(String), versionNumber: 2 });
    });

    it('the timeline names each event’s time and the characters taking part', async () => {
        const { bookId, ids } = await timelineBook('people', ['Wedding', 'Funeral']);
        const ada = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ada' });
        await addRelation(ctx, bookId, { fromElementId: ada.id, toElementId: ids[1], type: 'takes_part_in' });
        // related_to says nothing about taking part: no lane from it.
        const bo = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Bo' });
        await addRelation(ctx, bookId, { fromElementId: bo.id, toElementId: ids[0], type: 'related_to' });
        await saveStoryMap(ctx, bookId, 'timeline', { expectedVersion: 0, nodes: ids.map((id) => ({ elementId: id, x: 0, y: 0, w: 220, h: 88, lane: null })), edges: [], freeform: [] });
        const view = await getStoryMap(ctx, bookId, 'timeline');
        expect(view.participants).toEqual([{ eventId: ids[1], characterId: ada.id, characterName: 'Ada' }]);
        expect(view.nodes.find((n) => n.elementId === ids[0])!.element.storyTime).toBe('When Wedding');
        expect(view.nodes.every((n) => n.lane === 'unplaced')).toBe(true);
    });
});

describe('relations from the canvas', () => {
    it('an arrow’s relation is created, then drawn: the map saves it as an edge with its label', async () => {
        const book = await createBook(ctx, { title: 'Arrows' });
        const a = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Ada' });
        const g = await createElement(ctx, book.id, { kind: 'FACTION', name: 'Guild' });
        const nodes = [a, g].map((e, i) => ({ elementId: e.id, x: i * 300, y: 0, w: 220, h: 88, lane: null }));
        await saveStoryMap(ctx, book.id, 'relationship', { expectedVersion: 0, nodes, edges: [], freeform: [] });
        // The picker's choice for a faction drawn to a character: `member_of`, stored from the character.
        const rel = await addRelation(ctx, book.id, { fromElementId: a.id, toElementId: g.id, type: 'member_of' });
        const saved = await saveStoryMap(ctx, book.id, 'relationship', { expectedVersion: 1, nodes, edges: [{ relationId: rel.id, sourceElementId: a.id, targetElementId: g.id }], freeform: [] });
        expect(saved.map.edges).toEqual([{ relationId: rel.id, sourceElementId: a.id, targetElementId: g.id, type: 'member_of', label: 'member of' }]);
        expect(saved.map.relations.map((r) => r.relationId)).toContain(rel.id);
    });

    it('an edge deleted on the canvas: the map is saved without it first, so removing the relation does not move this tab’s version', async () => {
        const book = await createBook(ctx, { title: 'Removal' });
        const a = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Ada' });
        const b = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Bo' });
        const rel = await addRelation(ctx, book.id, { fromElementId: a.id, toElementId: b.id, type: 'loves' });
        const nodes = [a, b].map((e, i) => ({ elementId: e.id, x: i * 300, y: 0, w: 220, h: 88, lane: null }));
        const edge = { relationId: rel.id, sourceElementId: a.id, targetElementId: b.id };
        await saveStoryMap(ctx, book.id, 'relationship', { expectedVersion: 0, nodes, edges: [edge], freeform: [] });
        const without = await saveStoryMap(ctx, book.id, 'relationship', { expectedVersion: 1, nodes, edges: [], freeform: [] });
        await removeRelation(ctx, book.id, rel.id);
        expect((await getStoryMap(ctx, book.id, 'relationship')).version).toBe(without.map.version);
        // The tab saves on, on the version it holds.
        expect((await saveStoryMap(ctx, book.id, 'relationship', { expectedVersion: without.map.version, nodes: [nodes[0]], edges: [], freeform: [] })).saved).toBe(true);
        expect(await prisma.bibleRelation.count({ where: { id: rel.id } })).toBe(0);
    });
});

describe('PLOT_BEAT and the story order in the bundle', () => {
    async function beatsBook(title: string) {
        const book = await createBook(ctx, { title });
        const b1 = await createElement(ctx, book.id, { kind: 'PLOT_BEAT', name: 'The pardon refused', fields: [{ key: 'what_happens', value: '<p>She tears up the writ.</p>' }, { key: 'act', value: 'escalation' }] });
        const b2 = await createElement(ctx, book.id, { kind: 'PLOT_BEAT', name: 'The ferry seized', fields: [{ key: 'act', value: 'escalation' }, { key: 'stakes_shift', value: 4 }] });
        const b3 = await createElement(ctx, book.id, { kind: 'PLOT_BEAT', name: 'Not placed' });
        const ev = await createElement(ctx, book.id, { kind: 'TIMELINE_EVENT', name: 'The flood', fields: [{ key: 'story_time', value: 'Spring' }] });
        await addRelation(ctx, book.id, { fromElementId: b1.id, toElementId: b2.id, type: 'causes' });
        await move(book.id, b1.id, null, null);
        await move(book.id, b2.id, b1.id, null);
        await move(book.id, ev.id, null, null);
        return { book, b1, b2, b3, ev };
    }

    it('export → import into an empty book → export is byte-identical, ranks and acts included', async () => {
        const { book } = await beatsBook('Beats out');
        const first = await exportBibleBundle(ctx, book.id);
        const files = readZip(first.bytes, { maxEntries: 100, maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 22, maxRatio: 1000 });
        const beatFile = new TextDecoder().decode(files.get('plot_beat/the-pardon-refused.md')!);
        expect(beatFile).toMatch(/^order: [0-9a-z]+$/m);
        expect(new TextDecoder().decode(files.get('plot_beat/not-placed.md')!)).not.toMatch(/^order:/m);

        const empty = await createBook(ctx, { title: 'Beats in' });
        const report = await importBibleBundle(ctx, empty.id, first.bytes, { bookDetails: 'apply' }, clean);
        expect(report.elements.created).toBe(4);
        const second = await exportBibleBundle(ctx, empty.id);
        expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    });

    it('an import refuses a rank on a kind with no order, a rank twice in the bundle, and one another element keeps; it swaps two ranks', async () => {
        const { book, b1, b2 } = await beatsBook('Beats ranks');
        const exported = readZip((await exportBibleBundle(ctx, book.id)).bytes, { maxEntries: 100, maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 22, maxRatio: 1000 });
        const text = (p: string) => new TextDecoder().decode(exported.get(p)!);
        const rank1 = (await rankOf(b1.id))!;
        const rank2 = (await rankOf(b2.id))!;
        const rezip = (changes: Record<string, string>) => {
            const out = new Map<string, Uint8Array>(exported);
            for (const [p, t] of Object.entries(changes)) out.set(p, new TextEncoder().encode(t));
            return writeZip(out);
        };

        // Swap the two beats' places: both vacate, then both land.
        const swapped = rezip({
            'plot_beat/the-pardon-refused.md': text('plot_beat/the-pardon-refused.md').replace(`order: ${rank1}`, `order: ${rank2}`),
            'plot_beat/the-ferry-seized.md': text('plot_beat/the-ferry-seized.md').replace(`order: ${rank2}`, `order: ${rank1}`),
        });
        const report = await importBibleBundle(ctx, book.id, swapped, {}, clean);
        expect(report.elements.updated).toBe(2);
        expect([await rankOf(b1.id), await rankOf(b2.id)]).toEqual([rank2, rank1]);

        const problems = async (zip: Uint8Array) =>
            ((await refusal(importBibleBundle(ctx, book.id, zip, {}, clean))).details.problems as Array<{ path: string; reason: string }>).map((p) => [p.path, p.reason]);
        expect(await problems(rezip({ 'plot_beat/not-placed.md': text('plot_beat/not-placed.md').replace('status: DRAFT', `status: DRAFT\norder: ${rank1}`) }))).toEqual([
            ['plot_beat/the-pardon-refused.md', 'ORDER_DUPLICATE'],
        ]);
        const evRank = (await prisma.bibleElement.findFirstOrThrow({ where: { bookId: book.id, kind: 'TIMELINE_EVENT' } })).orderRank!;
        const taken = await createElement(ctx, book.id, { kind: 'TIMELINE_EVENT', name: 'Later' });
        await move(book.id, taken.id, null, null);
        const takenRank = (await rankOf(taken.id))!;
        expect(await problems(rezip({ 'timeline_event/the-flood.md': text('timeline_event/the-flood.md').replace(`order: ${evRank}`, `order: ${takenRank}`) }))).toEqual([
            ['timeline_event/the-flood.md', 'ORDER_TAKEN'],
        ]);
        expect(await problems(rezip({ 'plot_beat/not-placed.md': text('plot_beat/not-placed.md').replace('status: DRAFT', 'status: DRAFT\norder: A0') }))).toEqual([['plot_beat/not-placed.md', 'ORDER_INVALID']]);
    });

    it('the plot beat’s craft pack mounts, as every kind’s does', async () => {
        const view = await listInterviewPacks(ctx);
        const beat = view.craft.find((p) => p.key === 'PLOT_BEAT');
        expect(beat).toMatchObject({ name: 'craft-plot_beat', mountable: true, refusal: null });
        expect(view).toMatchObject({ mountable: view.total });
    });

    it('fields saved in the sheet are the bible’s: the map reads them back', async () => {
        const { book, b2 } = await beatsBook('Sheet');
        await saveStoryMap(ctx, book.id, 'plot', { expectedVersion: 0, nodes: [{ elementId: b2.id, x: 0, y: 0, w: 220, h: 88, lane: null }], edges: [], freeform: [] });
        await updateElementFields(ctx, book.id, b2.id, { baseVersion: await versionOf(book.id, b2.id), fields: [{ key: 'act', value: 'resolution' }] });
        const view = await getStoryMap(ctx, book.id, 'plot');
        expect(view.nodes[0]).toMatchObject({ lane: 'resolution', element: { act: 'resolution' } });
    });
});
