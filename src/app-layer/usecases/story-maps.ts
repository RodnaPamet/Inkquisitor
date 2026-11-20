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
 * EACH MAP DRAWS ITS OWN KINDS (Phase 3.2): the relationship map characters
 * and factions, the plot board plot beats, the timeline timeline events
 * (`MAP_ELEMENT_KINDS`). A save naming any other is refused 400
 * `KIND_NOT_ON_MAP`; a map saved before 3.2 that holds one shows without it
 * (`excludedNodes` counts them) and its next save leaves it out, as a restore
 * does.
 *
 * THE DERIVED MAPS' POSITIONS ARE THE BIBLE'S (Phase 3.2, decision D22). On
 * the plot board and the timeline a node's lane and position come from its
 * element's act and story order (`deriveLaneLayout`, `src/lib/canvas/lanes.ts`):
 * the view hands the canvas the derived positions, and a save stores what it
 * derives, whatever the request carried — so the map never holds a second
 * opinion about an order the bible keeps. Moving a card is an order move
 * (`bible-order.ts`), not a map save.
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
import { decodeFieldValue } from '@/lib/bible/field-values';
import { getFieldDef, getRelationType, getTemplate } from '@/lib/bible/templates';
import { assertFreeformIdsFree, parseStoredFreeform, sanitiseFreeformForStorage } from '@/lib/canvas/freeform';
import { MAX_MAP_EDGES, MAX_MAP_NODES, SNAPSHOT_LIST_MAX } from '@/lib/canvas/limits';
import { deriveLaneLayout, type ActOption, type LaneNodeInput, type Participant } from '@/lib/canvas/lanes';
import { MAP_ELEMENT_KINDS, STORY_MAP_KINDS, mapKindFromSlug, mapLayoutMode, mapTakesKind, type StoryMapKindValue } from '@/lib/canvas/map-kinds';
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
    /** The element's place in its story order (a plot beat, a timeline event), or null. */
    orderRank: string | null;
    /** A plot beat's act (its `act` field's option value), or null. */
    act: string | null;
    /** A timeline event's "when it happens" (its `story_time` field, author text), shown as its label; or null. */
    storyTime: string | null;
    /** The element's latest version: an order move's base. */
    versionNumber: number;
}

export interface MapNodeView extends MapNodeRow {
    element: MapElementView;
}

export interface MapRelationView extends MapEdgeRow {
    /** The relation type's key (Phase 3.2: the type picker leaves out a relation the pair already holds). */
    type: string;
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
    /** Nodes stored on the map whose element is of a kind this map does not draw (a map saved before 3.2), left out. */
    excludedNodes: number;
    /** The plot board's acts, in order (the `act` field's options); empty on the other maps. */
    acts: ActOption[];
    /** The timeline's per-character lanes: the characters taking part in each event on it. Empty on the other maps. */
    participants: Array<{ eventId: string; characterId: string; characterName: string }>;
    /** True when the participants were cut at their bound. */
    participantsTruncated: boolean;
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
/** Participant links the timeline reads at most (characters × events). */
export const MAP_PARTICIPANTS_MAX = MAX_MAP_NODES * 20;
/** The template field a plot beat's act lives in, and a timeline event's label. */
const ACT_FIELD = 'act';
const STORY_TIME_FIELD = 'story_time';
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

/** The plot board's acts: the template's `act` options, in order (empty when the field is not a choice). */
function actOptions(): ActOption[] {
    const def = getFieldDef('PLOT_BEAT', ACT_FIELD);
    return def?.type === 'choice' ? def.options.map((o) => ({ value: o.value, label: o.label })) : [];
}

interface ElementFacts {
    id: string;
    kind: BibleElementKind;
    name: string;
    customLabel: string | null;
    orderRank: string | null;
    act: string | null;
    storyTime: string | null;
}

/** What a map needs of its elements: names, kinds, ranks, and a beat's act and an event's story time (decrypted). */
async function elementFacts(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, ids: readonly string[]): Promise<Map<string, ElementFacts>> {
    const rows = await MapBibleReads.elements(db, ctx.workspaceId, bookId, ids);
    const beats = rows.filter((r) => r.kind === 'PLOT_BEAT').map((r) => r.id);
    const events = rows.filter((r) => r.kind === 'TIMELINE_EVENT').map((r) => r.id);
    const text = (value: string) => {
        const v = decodeFieldValue(value);
        return typeof v === 'string' ? v : null;
    };
    const acts = new Map((await MapBibleReads.fieldValues(db, ctx.workspaceId, beats, ACT_FIELD)).map((f) => [f.elementId, text(f.value)] as const));
    const times = new Map((await MapBibleReads.fieldValues(db, ctx.workspaceId, events, STORY_TIME_FIELD)).map((f) => [f.elementId, text(f.value)] as const));
    return new Map(
        rows.map((r) => [r.id, { id: r.id, kind: r.kind, name: r.name, customLabel: r.customLabel, orderRank: r.orderRank, act: acts.get(r.id) ?? null, storyTime: times.get(r.id) ?? null }] as const),
    );
}

/** The timeline's participants: characters taking part in each of `eventIds`, by event. */
async function participantsOf(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, eventIds: readonly string[]) {
    const rows = await MapBibleReads.participants(db, ctx.workspaceId, bookId, eventIds, MAP_PARTICIPANTS_MAX + 1);
    const shown = rows.slice(0, MAP_PARTICIPANTS_MAX);
    const byEvent = new Map<string, Participant[]>();
    for (const r of shown) {
        const list = byEvent.get(r.toElementId) ?? [];
        if (!list.some((p) => p.id === r.from.id)) list.push({ id: r.from.id, name: r.from.name });
        byEvent.set(r.toElementId, list);
    }
    return { byEvent, rows: shown, truncated: rows.length > MAP_PARTICIPANTS_MAX };
}

/**
 * A state's nodes as THIS map draws them: only the kinds it takes, and on a
 * derived map at the place the bible gives each (`deriveLaneLayout`), whatever
 * position the state carried. The relationship map's nodes keep theirs.
 */
async function drawnNodes(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    kind: StoryMapKind,
    nodes: readonly MapNodeRow[],
    facts: ReadonlyMap<string, ElementFacts>,
): Promise<{ nodes: MapNodeRow[]; excluded: number; participants: Awaited<ReturnType<typeof participantsOf>> | null }> {
    const kept = nodes.filter((n) => {
        const f = facts.get(n.elementId);
        return f !== undefined && mapTakesKind(kind, f.kind);
    });
    const excluded = nodes.filter((n) => facts.has(n.elementId)).length - kept.length;
    if (mapLayoutMode(kind) === 'free') return { nodes: kept, excluded, participants: null };
    const inputs: LaneNodeInput[] = kept.map((n) => {
        const f = facts.get(n.elementId)!;
        return { elementId: n.elementId, name: f.name, orderRank: f.orderRank, act: f.act };
    });
    const participants = kind === 'TIMELINE' ? await participantsOf(db, ctx, bookId, kept.map((n) => n.elementId)) : null;
    const layout = deriveLaneLayout(kind, inputs, { acts: actOptions(), participants: participants?.byEvent })!;
    return {
        nodes: kept.map((n) => {
            const at = layout.positions.get(n.elementId)!;
            return { elementId: n.elementId, x: at.x, y: at.y, w: at.w, h: at.h, lane: at.lane };
        }),
        excluded,
        participants,
    };
}

async function buildView(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, kind: StoryMapKind): Promise<StoryMapView> {
    const map = await StoryMapRepository.find(db, ctx.workspaceId, bookId, kind);
    const stored: MapState = map ? await readState(db, ctx, bookId, map) : { nodes: [], edges: [], freeform: [] };

    const facts = await elementFacts(db, ctx, bookId, stored.nodes.map((n) => n.elementId));
    const drawn = await drawnNodes(db, ctx, bookId, kind, stored.nodes, facts);
    const onMap = new Set(drawn.nodes.map((n) => n.elementId));
    const state: MapState = {
        nodes: drawn.nodes,
        edges: stored.edges.filter((e) => onMap.has(e.sourceElementId) && onMap.has(e.targetElementId)),
        freeform: stored.freeform,
    };

    const elementIds = state.nodes.map((n) => n.elementId);
    const keys = await BibleFieldRepository.keysForElements(db, ctx.workspaceId, elementIds, FIELD_KEYS_PER_ELEMENT);
    const filled = new Map<string, number>();
    for (const { elementId, key } of keys) {
        const k = facts.get(elementId)?.kind;
        if (k && getFieldDef(k, key)) filled.set(elementId, (filled.get(elementId) ?? 0) + 1);
    }
    const versions = await MapBibleReads.latestVersions(db, ctx.workspaceId, elementIds);

    const candidates = await MapBibleReads.relationsOfBook(db, ctx.workspaceId, bookId, MAP_RELATION_CANDIDATES_MAX + 1);
    const relationView = (r: (typeof candidates)[number]): MapRelationView => ({
        relationId: r.id,
        sourceElementId: r.fromElementId,
        targetElementId: r.toElementId,
        type: r.type,
        label: relationLabel(r.from.kind, r.type),
    });
    const drawnRelations = await MapBibleReads.relationsById(
        db,
        ctx.workspaceId,
        bookId,
        state.edges.map((e) => e.relationId),
    );
    const drawnById = new Map(drawnRelations.map((r) => [r.id, relationView(r)]));

    return {
        kind,
        version: map?.version ?? 0,
        nodes: state.nodes.map((n) => {
            const e = facts.get(n.elementId)!;
            return {
                ...n,
                element: {
                    name: e.name,
                    kind: e.kind,
                    customLabel: e.customLabel,
                    filledFieldCount: filled.get(e.id) ?? 0,
                    fieldCount: getTemplate(e.kind).fields.length,
                    orderRank: e.orderRank,
                    act: e.act,
                    storyTime: e.storyTime,
                    versionNumber: versions.get(e.id) ?? 0,
                },
            };
        }),
        edges: state.edges.flatMap((e) => {
            const v = drawnById.get(e.relationId);
            return v ? [v] : [];
        }),
        freeform: state.freeform,
        relations: candidates.slice(0, MAP_RELATION_CANDIDATES_MAX).map(relationView),
        relationsTruncated: candidates.length > MAP_RELATION_CANDIDATES_MAX,
        excludedNodes: drawn.excluded,
        acts: kind === 'PLOT' ? actOptions() : [],
        participants: (drawn.participants?.rows ?? []).map((r) => ({ eventId: r.toElementId, characterId: r.from.id, characterName: r.from.name })),
        participantsTruncated: drawn.participants?.truncated ?? false,
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

/**
 * Every reference belongs to this book and is of a kind this map draws, and
 * every edge is its relation's own pair.
 */
async function assertReferences(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, kind: StoryMapKind, state: Pick<MapState, 'nodes' | 'edges'>): Promise<void> {
    const elementIds = state.nodes.map((n) => n.elementId);
    const elements = await MapBibleReads.elements(db, ctx.workspaceId, bookId, elementIds);
    const found = new Set(elements.map((e) => e.id));
    const unknownElements = elementIds.filter((id) => !found.has(id));
    if (unknownElements.length > 0) {
        throw new ValidationError('The map names an element this book does not hold.', { reason: 'UNKNOWN_ELEMENT', elementIds: unknownElements });
    }
    const wrongKind = elements.filter((e) => !mapTakesKind(kind, e.kind));
    if (wrongKind.length > 0) {
        throw new ValidationError('The map names an element of a kind it does not draw.', {
            reason: 'KIND_NOT_ON_MAP',
            elementIds: wrongKind.map((e) => e.id),
            allowedKinds: [...MAP_ELEMENT_KINDS[kind]],
        });
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
    // A freeform record named like a node or edge would be drawn over it (save and restore alike).
    assertFreeformIdsFree(state.freeform, state.nodes, state.edges);
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
            await assertReferences(db, ctx, bookId, kind, state);
            // A derived map stores the positions the bible gives (the header).
            const facts = await elementFacts(db, ctx, bookId, state.nodes.map((n) => n.elementId));
            const drawn = { ...state, nodes: (await drawnNodes(db, ctx, bookId, kind, state.nodes, facts)).nodes };
            const { saved } = await applyState(db, ctx, bookId, kind, map, drawn, freeformJson, { restoredFromVersion: null });
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

            // Live elements of a kind this map draws, at the place the bible gives them on a derived map.
            const facts = await elementFacts(db, ctx, bookId, stored.nodes.map((n) => n.elementId));
            const nodes = (await drawnNodes(db, ctx, bookId, kind, stored.nodes, facts)).nodes;
            const liveElements = new Set(nodes.map((n) => n.elementId));
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
