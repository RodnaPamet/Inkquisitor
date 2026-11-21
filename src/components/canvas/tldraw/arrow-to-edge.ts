/**
 * Drawing a story edge, by borrowing tldraw's arrow gesture.
 *
 * Carved from inflect-compliance's `arrow-to-edge.ts`
 * (docs/carve-manifest.md), with edge-kind inference gone and one rule new:
 * a story edge DRAWS A BIBLE RELATION, so an arrow between two nodes becomes
 * an edge only when the book holds a relation between those two elements.
 *
 * ═══ THE ARROW IS THE GESTURE ═══
 *
 * The default toolbar's arrow tool would otherwise draw something that looks
 * exactly like an edge and persists as freeform, invisible to the bible. So
 * an arrow bound at BOTH ends to story nodes is converted into a real edge
 * binding (plus its drawn line) and the arrow is removed. That buys tldraw's
 * whole targeting UX (snapping, the nearest shape under the handle) without
 * edges becoming arrows. An arrow bound at one end or neither is LEFT ALONE:
 * a callout pointing at a node is a real annotation.
 *
 * ═══ WHICH RELATION ═══
 *
 * The book's relations between the two elements, in the order the host
 * gives them, either direction; the first not already drawn is the edge, and
 * the edge runs the RELATION's way, whatever way the arrow was drawn. With
 * none — or with every one already drawn — the host is asked for a NEW
 * relation (Phase 3.2: `onNeedsRelation` opens the type picker, which creates
 * a BibleRelation and then draws it with `drawRelationEdge`); a host that
 * offers no picker refuses the arrow `NO_RELATION` / `DUPLICATE_EDGE`.
 *
 * ═══ WHY CONVERSION WAITS FOR THE POINTER ═══
 *
 * tldraw binds an arrow while its end merely HOVERS a shape, so converting on
 * binding creation would steal the gesture mid-drag. Candidates are collected
 * as their bindings appear and drained once `editor.inputs.isPointing` is false.
 */
import type { Editor, TLShapeId } from 'tldraw';

import { STORY_EDGE_BINDING_TYPE, bindingIdForRelation, edgeEndpointIds, type StoryEdgeBinding } from './story-edge-binding';
import { STORY_EDGE_SHAPE_TYPE, edgeLineGeometry, shapeIdForRelation } from './story-edge-shape';
import { STORY_NODE_SHAPE_TYPE } from './story-node-shape';
import { validateEdge, type EdgeRefusal, type KnownRelation } from './edge-validation';

/** tldraw's own arrow binding and arrow shape types: the same literal, two meanings. */
const ARROW_BINDING_TYPE = 'arrow';
const ARROW_SHAPE_TYPE = 'arrow';

/** One end of a candidate arrow, resolved to the element it is bound to. */
export interface ArrowEnd {
    terminal: 'start' | 'end';
    /** `null` when the bound shape is not a story node. */
    elementId: string | null;
}

export type ArrowVerdict =
    /** Both ends are nodes and a relation joins them: draw it, its own way round. */
    | { kind: 'convert'; relationId: string; sourceElementId: string; targetElementId: string }
    /** Not an edge at all — leave it on the annotation layer. */
    | { kind: 'annotation'; why: 'FEWER_THAN_TWO_ENDS' | 'END_IS_NOT_A_NODE' }
    /** Both ends are nodes, but the book holds no relation between them. */
    | { kind: 'no-relation'; sourceElementId: string; targetElementId: string }
    /** Both ends are nodes, but the edge is not allowed. */
    | { kind: 'refuse'; refusals: EdgeRefusal[] };

/**
 * Decide what an arrow is, without touching an editor.
 *
 * `relations` are the book's, in the host's (deterministic) order;
 * `drawnRelationIds` are the edges already on the map.
 */
export function classifyArrow(
    ends: readonly ArrowEnd[],
    elementIds: ReadonlySet<string>,
    drawnRelationIds: ReadonlySet<string>,
    relations: readonly KnownRelation[],
): ArrowVerdict {
    const start = ends.find((e) => e.terminal === 'start');
    const end = ends.find((e) => e.terminal === 'end');
    if (!start || !end) return { kind: 'annotation', why: 'FEWER_THAN_TWO_ENDS' };
    if (start.elementId === null || end.elementId === null) return { kind: 'annotation', why: 'END_IS_NOT_A_NODE' };

    const a = start.elementId;
    const b = end.elementId;
    if (a === b) return { kind: 'refuse', refusals: [{ code: 'SELF_LOOP', elementId: a }] };

    const between = relations.filter(
        (r) => (r.sourceElementId === a && r.targetElementId === b) || (r.sourceElementId === b && r.targetElementId === a),
    );
    if (between.length === 0) return { kind: 'no-relation', sourceElementId: a, targetElementId: b };
    const free = between.find((r) => !drawnRelationIds.has(r.relationId));
    if (!free) return { kind: 'refuse', refusals: [{ code: 'DUPLICATE_EDGE', relationId: between[0].relationId }] };

    const refusals = validateEdge(free, elementIds, drawnRelationIds, free);
    if (refusals.length > 0) return { kind: 'refuse', refusals };
    return { kind: 'convert', relationId: free.relationId, sourceElementId: free.sourceElementId, targetElementId: free.targetElementId };
}

/** Two story nodes an arrow joined with no undrawn relation between them (Phase 3.2: the type picker's question). */
export interface RelationRequest {
    /** The arrow, left on the canvas until the host draws the edge or drops it. */
    arrowId: string;
    /** The element the arrow STARTS at, and the one it ends at. */
    fromElementId: string;
    toElementId: string;
}

interface InstallOptions {
    /** The book's relations, read at conversion time (the host's list may change). */
    relations: () => readonly KnownRelation[];
    /**
     * Asked when the two nodes have no undrawn relation between them, before
     * any refusal: the host may create one (Phase 3.2's type picker). Answering
     * true takes the arrow on (the host resolves it); false, or no host, and
     * the arrow is refused as before.
     */
    onNeedsRelation?: (request: RelationRequest) => boolean;
    /** Told why an arrow between two nodes did not become an edge. */
    onRefuse?: (verdict: Extract<ArrowVerdict, { kind: 'refuse' | 'no-relation' }>) => void;
    /** Called after a conversion, so the host can mark the map dirty. */
    onConverted?: (relationId: string) => void;
    /** The label an edge of this relation shows; injected (the host has the bible's words). */
    resolveLabel?: (relationId: string) => string;
}

/** Every story node on the current page: shape id → element id. */
function nodesOnPage(editor: Editor): Map<string, string> {
    const out = new Map<string, string>();
    for (const s of editor.getCurrentPageShapes()) {
        if (s.type !== STORY_NODE_SHAPE_TYPE) continue;
        const elementId = (s.props as { elementId?: unknown }).elementId;
        if (typeof elementId === 'string' && elementId.length > 0) out.set(String(s.id), elementId);
    }
    return out;
}

/** The relations already drawn, read through the bound shapes. */
function drawnRelations(editor: Editor): Set<string> {
    return new Set(
        editor.store
            .allRecords()
            .filter((r) => r.typeName === 'binding' && (r as { type?: string }).type === STORY_EDGE_BINDING_TYPE)
            .map((r) => (r as unknown as StoryEdgeBinding).props.relationId),
    );
}

/**
 * Draw one relation as an edge between the two nodes of its elements — the
 * binding and its line — and, given one, remove the arrow that asked for it,
 * all in ONE undoable step (`editor.run`: loose writes inside a side-effect
 * handler never reach the undo stack; measured in inflect). False when either
 * element has no node on the page.
 */
export function drawRelationEdge(
    editor: Editor,
    relation: { relationId: string; sourceElementId: string; targetElementId: string },
    label: string,
    arrowId?: string,
): boolean {
    const nodes = nodesOnPage(editor);
    const shapeIdOf = (elementId: string) => [...nodes.entries()].find(([, el]) => el === elementId)?.[0];
    const fromId = shapeIdOf(relation.sourceElementId);
    const toId = shapeIdOf(relation.targetElementId);
    if (!fromId || !toId) return false;
    // The binding takes the id the rows give it (`bindingIdForRelation`), as a
    // loaded edge's does: one relation, one binding, found by id (3.H), and a
    // relation already drawn is not drawn twice.
    const bindingId = bindingIdForRelation(relation.relationId);
    if (editor.getBinding(bindingId as never)) return false;
    editor.run(
        () => {
            editor.createBindings([
                {
                    id: bindingId,
                    type: STORY_EDGE_BINDING_TYPE,
                    fromId: fromId as TLShapeId,
                    toId: toId as TLShapeId,
                    props: { relationId: relation.relationId, sourceElementId: relation.sourceElementId, targetElementId: relation.targetElementId },
                },
            ] as never);
            const from = editor.getShapePageBounds(fromId as TLShapeId);
            const to = editor.getShapePageBounds(toId as TLShapeId);
            if (from && to) {
                const g = edgeLineGeometry(from, to);
                editor.createShapes([
                    {
                        id: shapeIdForRelation(relation.relationId),
                        type: STORY_EDGE_SHAPE_TYPE,
                        x: g.x,
                        y: g.y,
                        props: { relationId: relation.relationId, label, dx: g.dx, dy: g.dy },
                    },
                ] as never);
            }
            // The arrow goes last, so its own binding hooks do not fire mid-create.
            if (arrowId && editor.getShape(arrowId as TLShapeId)) editor.deleteShapes([arrowId as TLShapeId]);
        },
        { history: 'record' },
    );
    return true;
}

/**
 * Watch for arrows worth converting, and convert them. Returns a disposer.
 */
export function installArrowToEdgeConversion(editor: Editor, opts: InstallOptions): () => void {
    const pending = new Set<string>();

    const convert = (arrowId: string): void => {
        if (!editor.getShape(arrowId as TLShapeId)) return;
        const nodes = nodesOnPage(editor);
        const arrowBindings = editor.getBindingsInvolvingShape(arrowId as TLShapeId, ARROW_BINDING_TYPE) as unknown as Array<{
            fromId: string;
            toId: string;
            props: { terminal: 'start' | 'end' };
        }>;
        const ends: ArrowEnd[] = arrowBindings.map((b) => ({
            terminal: b.props.terminal,
            // The arrow is one side of its binding; the NODE is the other.
            elementId: nodes.get(b.fromId === arrowId ? b.toId : b.fromId) ?? null,
        }));
        const verdict = classifyArrow(ends, new Set(nodes.values()), drawnRelations(editor), opts.relations());
        if (verdict.kind === 'annotation') return;
        const allDrawn = verdict.kind === 'refuse' && verdict.refusals.length === 1 && verdict.refusals[0].code === 'DUPLICATE_EDGE';
        if (verdict.kind === 'no-relation' || allDrawn) {
            const start = ends.find((e) => e.terminal === 'start')!.elementId!;
            const end = ends.find((e) => e.terminal === 'end')!.elementId!;
            if (opts.onNeedsRelation?.({ arrowId, fromElementId: start, toElementId: end })) return;
        }
        if (verdict.kind !== 'convert') {
            opts.onRefuse?.(verdict);
            return;
        }
        if (drawRelationEdge(editor, verdict, opts.resolveLabel?.(verdict.relationId) ?? '', arrowId)) opts.onConverted?.(verdict.relationId);
    };

    const offCreate = editor.sideEffects.registerAfterCreateHandler('binding', (binding) => {
        const b = binding as unknown as { type?: string; fromId: string; toId: string };
        if (b.type !== ARROW_BINDING_TYPE) return;
        pending.add(b.fromId);
        pending.add(b.toId);
    });

    const offComplete = editor.sideEffects.registerOperationCompleteHandler(() => {
        if (pending.size === 0) return;
        if (editor.inputs.isPointing) return;
        const ids = [...pending];
        pending.clear();
        for (const id of ids) {
            const s = editor.getShape(id as TLShapeId);
            if (s && (s as { type?: string }).type === ARROW_SHAPE_TYPE) convert(id);
        }
    });

    return () => {
        offCreate();
        offComplete();
        pending.clear();
    };
}

/**
 * One node per element. A duplicated or pasted node names an element already
 * on the map, which a MapNode cannot hold twice; the copy is removed (with
 * the copied bindings and lines tldraw and the binding util remove with it).
 * Returns a disposer.
 */
export function installOneNodePerElement(editor: Editor): () => void {
    // Collected on create and removed once the operation completes: a
    // duplicate creates the shapes first and their bindings after, and a shape
    // removed in between would leave those bindings nothing to bind.
    const copies = new Set<TLShapeId>();
    const offCreate = editor.sideEffects.registerAfterCreateHandler('shape', (shape) => {
        if (shape.type !== STORY_NODE_SHAPE_TYPE) return;
        const elementId = (shape.props as { elementId?: unknown }).elementId;
        const twin = editor
            .getCurrentPageShapes()
            .some((s) => s.id !== shape.id && !copies.has(s.id) && s.type === STORY_NODE_SHAPE_TYPE && (s.props as { elementId?: unknown }).elementId === elementId);
        if (twin) copies.add(shape.id);
    });
    const offComplete = editor.sideEffects.registerOperationCompleteHandler(() => {
        if (copies.size === 0) return;
        const ids = [...copies].filter((id) => editor.getShape(id));
        copies.clear();
        if (ids.length > 0) editor.deleteShapes(ids);
    });
    return () => {
        offCreate();
        offComplete();
        copies.clear();
    };
}

/**
 * Deleting an edge's line deletes the edge. The line is the only part of an
 * edge an author can select (the binding is invisible), and tldraw deletes
 * just the shape: the binding stayed behind, so the edge vanished from view,
 * nothing was marked dirty, every later save still carried it, and a reload
 * drew it back. The binding goes in the same store operation, so the change
 * is one undoable step and the store listener sees an edge removed. A line
 * removed because its node went (the binding util's own hook) finds the
 * binding already on its way out and removes nothing more. Returns a disposer.
 */
export function installEdgeLineRemovesEdge(
    editor: Editor,
    opts: {
        /**
         * Told, once the operation completes, of every edge the AUTHOR removed
         * (Phase 3.2): its line went while both its nodes stayed on the page.
         * An edge that went with its node is not one (the node left the map;
         * the relation stays in the bible).
         */
        onAuthorRemoved?: (edge: { relationId: string; sourceElementId: string; targetElementId: string }) => void;
    } = {},
): () => void {
    const removed = new Map<string, { relationId: string; sourceElementId: string; targetElementId: string }>();
    const offDelete = editor.sideEffects.registerAfterDeleteHandler('shape', (shape, source) => {
        if (shape.type !== STORY_EDGE_SHAPE_TYPE) return;
        const relationId = (shape.props as { relationId?: unknown }).relationId;
        // By id, never a scan of the store: a node with many edges, or a
        // selection of hundreds, deletes a line per edge (3.H). Every edge's
        // binding carries `bindingIdForRelation`'s id, loaded or drawn.
        const own = typeof relationId === 'string' ? (editor.getBinding(bindingIdForRelation(relationId) as never) as StoryEdgeBinding | undefined) : undefined;
        const bindings = own && own.type === STORY_EDGE_BINDING_TYPE ? [own] : [];
        if (source === 'user' && typeof relationId === 'string' && bindings[0]) {
            const p = bindings[0].props;
            removed.set(relationId, { relationId, sourceElementId: p.sourceElementId, targetElementId: p.targetElementId });
        }
        if (bindings.length > 0) editor.deleteBindings(bindings.map((b) => b.id) as never);
    });
    const offComplete = editor.sideEffects.registerOperationCompleteHandler(() => {
        if (removed.size === 0) return;
        const edges = [...removed.values()];
        removed.clear();
        if (!opts.onAuthorRemoved) return;
        const onPage = new Set(nodesOnPage(editor).values());
        for (const edge of edges) {
            if (onPage.has(edge.sourceElementId) && onPage.has(edge.targetElementId)) opts.onAuthorRemoved(edge);
        }
    });
    return () => {
        offDelete();
        offComplete();
        removed.clear();
    };
}

export { edgeEndpointIds };
