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
 * none the arrow is refused `NO_RELATION` (3.2 adds the type picker that
 * creates one); with every one drawn, `DUPLICATE_EDGE`.
 *
 * ═══ WHY CONVERSION WAITS FOR THE POINTER ═══
 *
 * tldraw binds an arrow while its end merely HOVERS a shape, so converting on
 * binding creation would steal the gesture mid-drag. Candidates are collected
 * as their bindings appear and drained once `editor.inputs.isPointing` is false.
 */
import type { Editor, TLShapeId } from 'tldraw';

import { STORY_EDGE_BINDING_TYPE, edgeEndpointIds, type StoryEdgeBinding } from './story-edge-binding';
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

interface InstallOptions {
    /** The book's relations, read at conversion time (the host's list may change). */
    relations: () => readonly KnownRelation[];
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
        if (verdict.kind !== 'convert') {
            opts.onRefuse?.(verdict);
            return;
        }

        const shapeIdOf = (elementId: string) => [...nodes.entries()].find(([, el]) => el === elementId)?.[0];
        const fromId = shapeIdOf(verdict.sourceElementId);
        const toId = shapeIdOf(verdict.targetElementId);
        if (!fromId || !toId) return;

        // `editor.run` makes the swap one undoable step (loose writes inside a
        // side-effect handler never reach the undo stack; measured in inflect).
        editor.run(
            () => {
                editor.createBindings([
                    {
                        type: STORY_EDGE_BINDING_TYPE,
                        fromId: fromId as TLShapeId,
                        toId: toId as TLShapeId,
                        props: { relationId: verdict.relationId, sourceElementId: verdict.sourceElementId, targetElementId: verdict.targetElementId },
                    },
                ] as never);
                const from = editor.getShapePageBounds(fromId as TLShapeId);
                const to = editor.getShapePageBounds(toId as TLShapeId);
                if (from && to) {
                    const g = edgeLineGeometry(from, to);
                    editor.createShapes([
                        {
                            id: shapeIdForRelation(verdict.relationId),
                            type: STORY_EDGE_SHAPE_TYPE,
                            x: g.x,
                            y: g.y,
                            props: { relationId: verdict.relationId, label: opts.resolveLabel?.(verdict.relationId) ?? '', dx: g.dx, dy: g.dy },
                        },
                    ] as never);
                }
                // The arrow goes last, so its own binding hooks do not fire mid-create.
                editor.deleteShapes([arrowId as TLShapeId]);
            },
            { history: 'record' },
        );
        opts.onConverted?.(verdict.relationId);
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

export { edgeEndpointIds };
