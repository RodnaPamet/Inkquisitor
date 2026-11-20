/**
 * The story canvas's usecases (Phase 3.1): read a map, save it under its
 * optimistic lock, list and read its snapshots, restore one.
 *
 * ROWS ARE THE SOURCE OF TRUTH. A save carries the map's whole state — every
 * node (a BibleElement drawn), every edge (a BibleRelation drawn) and the
 * freeform layer — and is stored as rows; the canvas is a view rebuilt from
 * them (`src/components/canvas/tldraw/serializer.ts`).
 *
 * ONE MAP OF EACH KIND PER BOOK (decision D18), created on its FIRST SAVE:
 * a map nobody has saved reads as empty at version 0, so a read never
 * writes (a READER opening the timeline creates nothing) and no book needed
 * a backfill. The unique (bookId, kind) is the guarantee; the advisory lock
 * on (book, kind) serialises the first save with every other.
 *
 * THE VERSION LOCK. Every save and restore names the version it read
 * (`expectedVersion`). Under the map's lock a different current version is
 * refused 409 `VERSION_CONFLICT` with `currentVersion`, writing nothing; the
 * conditional bump (`StoryMapRepository.commit`) is the second line. A save
 * whose state equals the stored state writes nothing at all — no version,
 * no snapshot — so an autosave with nothing to say leaves no trace. Each
 * save that changes something writes exactly one `MapSnapshot` (the
 * canonical state, encrypted) in the same transaction.
 *
 * REFERENCES STAY IN THE BOOK. Every node's element and every edge's
 * relation must belong to this book (the composite foreign keys refuse it in
 * the database too); an edge's two elements must be the relation's own ends
 * and must both be on the map. An element or relation deleted meanwhile is a
 * 409 `MAP_REFERENCE_GONE` (its cascade also moved the version).
 *
 * Permissions: `bible.view` reads, `bible.edit` saves and restores — the
 * canvas and the bible are one dataset.
 */
import type { BibleElementKind, StoryMapKind } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleFieldRepository } from '@/app-layer/repositories/bible.repository';
import {
    MapBibleReads,
    MapEdgeRepository,
    MapNodeRepository,
    MapSnapshotRepository,
    StoryMapRepository,
} from '@/app-layer/repositories/story-map.repository';
import { MapRestoreInput, MapSaveInput } from '@/app-layer/schemas/canvas';
import { VersionNumberParam } from '@/app-layer/schemas/bible';
import { getFieldDef, getRelationType, getTemplate } from '@/lib/bible/templates';
import { parseStoredFreeform, sanitiseFreeformForStorage } from '@/lib/canvas/freeform';
import { MAX_MAP_EDGES, MAX_MAP_NODES, SNAPSHOT_LIST_MAX } from '@/lib/canvas/limits';
import { STORY_MAP_KINDS, mapKindFromSlug, type StoryMapKindValue } from '@/lib/canvas/map-kinds';
import { parseMapState, serialiseMapState, type MapEdgeRow, type MapNodeRow, type MapState } from '@/lib/canvas/map-state';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { requireBook } from './bible-common';

// ─── Views ──────────────────────────────────────────────────────────

export interface MapElementView {
    name: string;
    kind: BibleElementKind;
    customLabel: string | null;
    /** Template fields holding a value, and the template's field count (for `completeness()`). */
    filledFieldCount: number;
    fieldCount: number;
}

export interface MapNodeView extends MapNodeRow {
    element: MapElementView;
}

export interface MapRelationView extends MapEdgeRow {
    /** The relation type's label, read from its source element's template. */
    label: string;
}

export interface StoryMapView {
    kind: StoryMapKindValue;
    /** 0 for a map nobody has saved yet. */
    version: number;
    nodes: MapNodeView[];
    edges: MapRelationView[];
    freeform: Record<string, unknown>[];
    /**
     * The book's relations, the candidates an arrow drawn between two nodes
     * becomes an edge of. Bounded; `relationsTruncated` says when cut.
     */
    relations: MapRelationView[];
    relationsTruncated: boolean;
}

export interface StoryMapSaveResult {
    map: StoryMapView;
    /** False when the state equalled the stored one and nothing was written. */
    saved: boolean;
}

export interface MapRestoreResult extends StoryMapSaveResult {
    restoredFromVersion: number;
    /** Nodes and edges of the snapshot left out because their element or relation is gone. */
    dropped: { nodes: number; edges: number };
}

export interface MapSnapshotMetaView {
    version: number;
    nodeCount: number;
    edgeCount: number;
    restoredFromVersion: number | null;
    /** No save wrote this version: a bible deletion took nodes or edges off the map (D20). */
    fromBibleDeletion: boolean;
    createdAt: string;
    createdByName: string | null;
}

export interface MapSnapshotView extends MapSnapshotMetaView {
    nodes: MapNodeRow[];
    edges: MapEdgeRow[];
    freeform: Record<string, unknown>[];
}

/** Relations the map view carries as candidates at most. */
export const MAP_RELATION_CANDIDATES_MAX = MAX_MAP_EDGES * 2;
/** Stored field rows read per element when counting (a template has a few dozen fields). */
const FIELD_KEYS_PER_ELEMENT = 200;

function kindOf(slug: string): StoryMapKind {
    const kind = mapKindFromSlug(slug);
    if (!kind) throw new NotFoundError('Map not found.');
    return kind;
}

function isForeignKeyViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2003';
}

function relationLabel(fromKind: BibleElementKind, type: string): string {
    return getRelationType(fromKind, type)?.label ?? type;
}

// ─── Reads ──────────────────────────────────────────────────────────

async function readState(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, map: { id: string; freeformJson: string | null }): Promise<MapState> {
    const [nodes, edges] = await Promise.all([
        MapNodeRepository.list(db, ctx.workspaceId, map.id, MAX_MAP_NODES + 1),
        MapEdgeRepository.list(db, ctx.workspaceId, map.id, MAX_MAP_EDGES + 1),
    ]);
    // Edge endpoints are the relation's own ends, read through it.
    const relations = await MapBibleReads.relationsById(
        db,
        ctx.workspaceId,
        bookId,
        edges.map((e) => e.bibleRelationId),
    );
    const byId = new Map(relations.map((r) => [r.id, r]));
    return {
        nodes: nodes.map((n) => ({ elementId: n.bibleElementId, x: n.x, y: n.y, w: n.w, h: n.h, lane: n.lane })),
        edges: edges.flatMap((e) => {
            const r = byId.get(e.bibleRelationId);
            return r ? [{ relationId: r.id, sourceElementId: r.fromElementId, targetElementId: r.toElementId }] : [];
        }),
        freeform: parseStoredFreeform(map.freeformJson),
    };
}

async function buildView(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, kind: StoryMapKind): Promise<StoryMapView> {
    const map = await StoryMapRepository.find(db, ctx.workspaceId, bookId, kind);
    const state: MapState = map ? await readState(db, ctx, bookId, map) : { nodes: [], edges: [], freeform: [] };

    const elementIds = state.nodes.map((n) => n.elementId);
    const elements = await MapBibleReads.elements(db, ctx.workspaceId, bookId, elementIds);
    const keys = await BibleFieldRepository.keysForElements(db, ctx.workspaceId, elementIds, FIELD_KEYS_PER_ELEMENT);
    const kindById = new Map(elements.map((e) => [e.id, e.kind] as const));
    const filled = new Map<string, number>();
    for (const { elementId, key } of keys) {
        const k = kindById.get(elementId);
        if (k && getFieldDef(k, key)) filled.set(elementId, (filled.get(elementId) ?? 0) + 1);
    }
    const elementById = new Map(elements.map((e) => [e.id, e]));

    const candidates = await MapBibleReads.relationsOfBook(db, ctx.workspaceId, bookId, MAP_RELATION_CANDIDATES_MAX + 1);
    const relationView = (r: (typeof candidates)[number]): MapRelationView => ({
        relationId: r.id,
        sourceElementId: r.fromElementId,
        targetElementId: r.toElementId,
        label: relationLabel(r.from.kind, r.type),
    });
    const drawn = await MapBibleReads.relationsById(
        db,
        ctx.workspaceId,
        bookId,
        state.edges.map((e) => e.relationId),
    );
    const drawnById = new Map(drawn.map((r) => [r.id, relationView(r)]));

    return {
        kind,
        version: map?.version ?? 0,
        nodes: state.nodes.flatMap((n) => {
            const e = elementById.get(n.elementId);
            if (!e) return [];
            return [
                {
                    ...n,
                    element: {
                        name: e.name,
                        kind: e.kind,
                        customLabel: e.customLabel,
                        filledFieldCount: filled.get(e.id) ?? 0,
                        fieldCount: getTemplate(e.kind).fields.length,
                    },
                },
            ];
        }),
        edges: state.edges.flatMap((e) => {
            const v = drawnById.get(e.relationId);
            return v ? [v] : [];
        }),
        freeform: state.freeform,
        relations: candidates.slice(0, MAP_RELATION_CANDIDATES_MAX).map(relationView),
        relationsTruncated: candidates.length > MAP_RELATION_CANDIDATES_MAX,
    };
}

export async function getStoryMap(ctx: WorkspaceRequestContext, bookId: string, kindSlug: string): Promise<StoryMapView> {
    await assertPermission(ctx, 'bible.view');
    const kind = kindOf(kindSlug);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        return buildView(db, ctx, bookId, kind);
    });
}

// ─── Save ───────────────────────────────────────────────────────────

/** The checks a state needs before any row is read: one node per element, one edge per relation, edges between nodes. */
function assertStructure(state: Pick<MapState, 'nodes' | 'edges'>): void {
    const elementIds = new Set<string>();
    for (const n of state.nodes) {
        if (elementIds.has(n.elementId)) throw new ValidationError('An element appears on the map twice.', { reason: 'DUPLICATE_NODE', elementId: n.elementId });
        elementIds.add(n.elementId);
    }
    const relationIds = new Set<string>();
    for (const e of state.edges) {
        if (relationIds.has(e.relationId)) throw new ValidationError('A relation appears on the map twice.', { reason: 'DUPLICATE_EDGE', relationId: e.relationId });
        relationIds.add(e.relationId);
        if (e.sourceElementId === e.targetElementId) throw new ValidationError('An edge cannot join an element to itself.', { reason: 'SELF_LOOP', relationId: e.relationId });
        if (!elementIds.has(e.sourceElementId) || !elementIds.has(e.targetElementId)) {
            throw new ValidationError('An edge joins an element that is not on the map.', { reason: 'EDGE_ENDPOINT_NOT_ON_MAP', relationId: e.relationId });
        }
    }
}

/** Every reference belongs to this book, and every edge is its relation's own pair. */
async function assertReferences(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, state: Pick<MapState, 'nodes' | 'edges'>): Promise<void> {
    const elementIds = state.nodes.map((n) => n.elementId);
    const found = new Set((await MapBibleReads.elements(db, ctx.workspaceId, bookId, elementIds)).map((e) => e.id));
    const unknownElements = elementIds.filter((id) => !found.has(id));
    if (unknownElements.length > 0) {
        throw new ValidationError('The map names an element this book does not hold.', { reason: 'UNKNOWN_ELEMENT', elementIds: unknownElements });
    }
    const relations = new Map(
        (await MapBibleReads.relationsById(db, ctx.workspaceId, bookId, state.edges.map((e) => e.relationId))).map((r) => [r.id, r] as const),
    );
    const unknownRelations = state.edges.filter((e) => !relations.has(e.relationId)).map((e) => e.relationId);
    if (unknownRelations.length > 0) {
        throw new ValidationError('The map names a relation this book does not hold.', { reason: 'UNKNOWN_RELATION', relationIds: unknownRelations });
    }
    for (const e of state.edges) {
        const r = relations.get(e.relationId)!;
        if (r.fromElementId !== e.sourceElementId || r.toElementId !== e.targetElementId) {
            throw new ValidationError('An edge does not join its relation’s two elements.', { reason: 'RELATION_MISMATCH', relationId: e.relationId });
        }
    }
}

/**
 * Store `state` as the map's new state, under the map's lock (held by the
 * caller) and after its version check. Writes nothing when the state equals
 * the stored one, or when a map nobody saved is saved empty.
 */
async function applyState(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    kind: StoryMapKind,
    map: { id: string; version: number; freeformJson: string | null } | null,
    state: MapState,
    freeformJson: string | null,
    meta: { restoredFromVersion: number | null },
): Promise<{ saved: boolean; version: number }> {
    const next = serialiseMapState(state);
    if (map) {
        if (serialiseMapState(await readState(db, ctx, bookId, map)) === next) return { saved: false, version: map.version };
    } else if (state.nodes.length === 0 && state.edges.length === 0 && state.freeform.length === 0) {
        return { saved: false, version: 0 };
    }

    let mapId: string;
    let version: number;
    if (map) {
        const updated = await StoryMapRepository.commit(db, ctx.workspaceId, map.id, map.version, { freeformJson });
        if (updated.count === 0) {
            const current = await StoryMapRepository.find(db, ctx.workspaceId, bookId, kind);
            throw new ConflictError('This map was changed since your edit began.', {
                reason: 'VERSION_CONFLICT',
                currentVersion: current?.version ?? map.version,
                expectedVersion: map.version,
            });
        }
        mapId = map.id;
        version = map.version + 1;
    } else {
        const created = await StoryMapRepository.create(db, ctx.workspaceId, bookId, kind, { freeformJson });
        mapId = created.id;
        version = created.version;
    }

    await MapNodeRepository.replace(db, ctx.workspaceId, bookId, mapId, state.nodes.map((n) => ({ bibleElementId: n.elementId, x: n.x, y: n.y, w: n.w, h: n.h, lane: n.lane })));
    await MapEdgeRepository.replace(db, ctx.workspaceId, bookId, mapId, state.edges.map((e) => e.relationId));
    await MapSnapshotRepository.create(db, ctx.workspaceId, {
        mapId,
        version,
        snapshot: next,
        nodeCount: state.nodes.length,
        edgeCount: state.edges.length,
        restoredFromVersion: meta.restoredFromVersion,
        createdById: ctx.userId,
    });
    await logEvent(
        ctx,
        {
            action: meta.restoredFromVersion === null ? 'STORY_MAP_SAVED' : 'STORY_MAP_RESTORED',
            entityType: 'StoryMap',
            entityId: mapId,
            details: {
                bookId,
                kind,
                version,
                nodeCount: state.nodes.length,
                edgeCount: state.edges.length,
                freeformRecords: state.freeform.length,
                ...(meta.restoredFromVersion !== null ? { restoredFromVersion: meta.restoredFromVersion } : {}),
            },
        },
        { db },
    );
    return { saved: true, version };
}

function assertExpectedVersion(map: { version: number } | null, expectedVersion: number): void {
    const currentVersion = map?.version ?? 0;
    if (currentVersion !== expectedVersion) {
        throw new ConflictError('This map was changed since your edit began.', { reason: 'VERSION_CONFLICT', currentVersion, expectedVersion });
    }
}

function mapReferenceGone(err: unknown): never {
    if (isForeignKeyViolation(err)) {
        throw new ConflictError('An element or relation on the map was deleted meanwhile.', { reason: 'MAP_REFERENCE_GONE' });
    }
    throw err;
}

export async function saveStoryMap(ctx: WorkspaceRequestContext, bookId: string, kindSlug: string, input: unknown): Promise<StoryMapSaveResult> {
    await assertPermission(ctx, 'bible.edit');
    const kind = kindOf(kindSlug);
    const parsed = MapSaveInput.parse(input);
    const freeformJson = sanitiseFreeformForStorage(parsed.freeform);
    const state: MapState = { nodes: parsed.nodes, edges: parsed.edges, freeform: parseStoredFreeform(freeformJson) };
    assertStructure(state);
    try {
        return await runInWorkspaceContext(ctx, async (db) => {
            await requireBook(db, ctx, bookId);
            await StoryMapRepository.lock(db, bookId, kind);
            const map = await StoryMapRepository.find(db, ctx.workspaceId, bookId, kind);
            assertExpectedVersion(map, parsed.expectedVersion);
            await assertReferences(db, ctx, bookId, state);
            const { saved } = await applyState(db, ctx, bookId, kind, map, state, freeformJson, { restoredFromVersion: null });
            return { map: await buildView(db, ctx, bookId, kind), saved };
        });
    } catch (err) {
        return mapReferenceGone(err);
    }
}

// ─── Snapshots ──────────────────────────────────────────────────────

async function requireMap(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, kind: StoryMapKind) {
    const map = await StoryMapRepository.find(db, ctx.workspaceId, bookId, kind);
    if (!map) throw new NotFoundError('Map not found.');
    return map;
}

export async function listMapSnapshots(
    ctx: WorkspaceRequestContext,
    bookId: string,
    kindSlug: string,
): Promise<{ snapshots: MapSnapshotMetaView[]; truncated: boolean }> {
    await assertPermission(ctx, 'bible.view');
    const kind = kindOf(kindSlug);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const map = await StoryMapRepository.find(db, ctx.workspaceId, bookId, kind);
        // A map nobody has saved has no history: an empty list, not a 404.
        if (!map) return { snapshots: [], truncated: false };
        const rows = await MapSnapshotRepository.list(db, ctx.workspaceId, map.id, SNAPSHOT_LIST_MAX + 1);
        return {
            snapshots: rows.slice(0, SNAPSHOT_LIST_MAX).map((r) => ({
                version: r.version,
                nodeCount: r.nodeCount,
                edgeCount: r.edgeCount,
                restoredFromVersion: r.restoredFromVersion,
                fromBibleDeletion: r.fromBibleDeletion,
                createdAt: r.createdAt.toISOString(),
                createdByName: r.createdBy?.name ?? null,
            })),
            truncated: rows.length > SNAPSHOT_LIST_MAX,
        };
    });
}

export async function getMapSnapshot(ctx: WorkspaceRequestContext, bookId: string, kindSlug: string, versionParam: unknown): Promise<MapSnapshotView> {
    await assertPermission(ctx, 'bible.view');
    const kind = kindOf(kindSlug);
    const version = VersionNumberParam.parse(versionParam);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const map = await requireMap(db, ctx, bookId, kind);
        const row = await MapSnapshotRepository.find(db, ctx.workspaceId, map.id, version);
        if (!row) throw new NotFoundError('Snapshot not found.');
        const state = parseMapState(row.snapshot) ?? { nodes: [], edges: [], freeform: [] };
        return {
            version: row.version,
            nodeCount: row.nodeCount,
            edgeCount: row.edgeCount,
            restoredFromVersion: row.restoredFromVersion,
            fromBibleDeletion: row.fromBibleDeletion,
            createdAt: row.createdAt.toISOString(),
            createdByName: null,
            ...state,
        };
    });
}

/**
 * Apply a snapshot as a NEW save (its own version and snapshot, naming the
 * version it restored). Nodes whose element and edges whose relation the
 * bible no longer holds are left out and counted (`dropped`): an old
 * snapshot stays restorable after its book moved on.
 */
export async function restoreMapSnapshot(
    ctx: WorkspaceRequestContext,
    bookId: string,
    kindSlug: string,
    versionParam: unknown,
    input: unknown,
): Promise<MapRestoreResult> {
    await assertPermission(ctx, 'bible.edit');
    const kind = kindOf(kindSlug);
    const version = VersionNumberParam.parse(versionParam);
    const { expectedVersion } = MapRestoreInput.parse(input);
    try {
        return await runInWorkspaceContext(ctx, async (db) => {
            await requireBook(db, ctx, bookId);
            await StoryMapRepository.lock(db, bookId, kind);
            const map = await requireMap(db, ctx, bookId, kind);
            assertExpectedVersion(map, expectedVersion);
            const row = await MapSnapshotRepository.find(db, ctx.workspaceId, map.id, version);
            if (!row) throw new NotFoundError('Snapshot not found.');
            const stored = parseMapState(row.snapshot);
            if (!stored) throw new ConflictError('That snapshot cannot be read.', { reason: 'SNAPSHOT_UNREADABLE' });

            const liveElements = new Set(
                (await MapBibleReads.elements(db, ctx.workspaceId, bookId, stored.nodes.map((n) => n.elementId))).map((e) => e.id),
            );
            const nodes = stored.nodes.filter((n) => liveElements.has(n.elementId));
            const liveRelations = new Map(
                (await MapBibleReads.relationsById(db, ctx.workspaceId, bookId, stored.edges.map((e) => e.relationId))).map((r) => [r.id, r] as const),
            );
            const edges = stored.edges.filter((e) => {
                const r = liveRelations.get(e.relationId);
                return r !== undefined && liveElements.has(r.fromElementId) && liveElements.has(r.toElementId) && r.fromElementId === e.sourceElementId && r.toElementId === e.targetElementId;
            });
            // Re-sanitised on the way back in, as every write of the layer is.
            const freeformJson = sanitiseFreeformForStorage(stored.freeform);
            const state: MapState = { nodes, edges, freeform: parseStoredFreeform(freeformJson) };
            const { saved } = await applyState(db, ctx, bookId, kind, map, state, freeformJson, { restoredFromVersion: version });
            return {
                map: await buildView(db, ctx, bookId, kind),
                saved,
                restoredFromVersion: version,
                dropped: { nodes: stored.nodes.length - nodes.length, edges: stored.edges.length - edges.length },
            };
        });
    } catch (err) {
        return mapReferenceGone(err);
    }
}

// ─── Deletions from the bible ───────────────────────────────────────

/** A book's maps as they stood before a bible deletion, by id. */
export type BookMapVersions = ReadonlyMap<string, number>;

/**
 * Take every map lock of the book (the same locks a save takes, in one fixed
 * order) and read the maps' versions. A usecase that deletes a bible element
 * or relation calls this BEFORE the delete, inside its transaction, and
 * `recordMapsAfterBibleDeletion` after it. Holding the locks first means no
 * save of these maps runs between the two (so the snapshot written is exactly
 * the state at the version the cascade reached), and the deletion never holds
 * a row a save is waiting for while it waits on that save's rows (no
 * deadlock).
 */
export async function lockMapsForBibleDeletion(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<BookMapVersions> {
    await StoryMapRepository.lockAll(db, bookId, STORY_MAP_KINDS);
    const maps = await StoryMapRepository.listForBook(db, ctx.workspaceId, bookId);
    return new Map(maps.map((m) => [m.id, m.version] as const));
}

/**
 * After a bible deletion, write the snapshot of every map its cascade moved
 * (decision D20: history never skips a version). The cascade's trigger moved
 * each such map's version once; the snapshot is the map as it now stands,
 * attributed to the person who deleted, marked `fromBibleDeletion`. The
 * deferred `story_map_version_has_snapshot` trigger refuses the transaction
 * at commit if a moved map is left without one.
 */
export async function recordMapsAfterBibleDeletion(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, before: BookMapVersions): Promise<void> {
    const maps = await StoryMapRepository.listForBook(db, ctx.workspaceId, bookId);
    for (const map of maps) {
        const was = before.get(map.id);
        if (was === undefined || map.version === was) continue;
        const state = await readState(db, ctx, bookId, map);
        await MapSnapshotRepository.create(db, ctx.workspaceId, {
            mapId: map.id,
            version: map.version,
            snapshot: serialiseMapState(state),
            nodeCount: state.nodes.length,
            edgeCount: state.edges.length,
            restoredFromVersion: null,
            fromBibleDeletion: true,
            createdById: ctx.userId ?? null,
        });
        await logEvent(
            ctx,
            {
                action: 'STORY_MAP_CASCADED',
                entityType: 'StoryMap',
                entityId: map.id,
                details: { bookId, kind: map.kind, version: map.version, nodeCount: state.nodes.length, edgeCount: state.edges.length },
            },
            { db },
        );
    }
}

// ─── The page ───────────────────────────────────────────────────────

export interface StoryMapPageData {
    book: { id: string; title: string };
    kind: StoryMapKindValue;
    map: StoryMapView;
}

/** What a map's page reads: the book and the map (a missing book or an unknown kind is a 404). */
export async function loadStoryMapPage(ctx: WorkspaceRequestContext, bookId: string, kindSlug: string): Promise<StoryMapPageData> {
    await assertPermission(ctx, 'bible.view');
    const kind = kindOf(kindSlug);
    return runInWorkspaceContext(ctx, async (db) => {
        const book = await requireBook(db, ctx, bookId);
        return { book: { id: book.id, title: book.title }, kind, map: await buildView(db, ctx, bookId, kind) };
    });
}
