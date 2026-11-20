'use client';

/**
 * The story map's interactive surface: the tldraw canvas and everything that
 * needs the editor (adding an element, arranging, exporting, autosave, the
 * history and the diff, the conflict notice).
 *
 * LOADED ON DEMAND. `StoryMapWorkspace` imports this module with
 * `next/dynamic` and `ssr: false`, inside `CanvasErrorBoundary`, so tldraw
 * (a large renderer that needs a browser) is in no route's first load —
 * not even the map page's — and its failure cannot take the page down.
 * `scripts/check-build.js` fails a build that puts it in one.
 *
 * THE THREE MAPS (Phase 3.2). Each map draws its own kinds
 * (`MAP_ELEMENT_KINDS`: the picker offers no other). Every map:
 *
 *   • asks how two nodes are related when an arrow joins them with no
 *     relation to draw (`RelationTypePicker`), creates the BibleRelation and
 *     draws it;
 *   • removes the RELATION when the author deletes an edge, through the undo
 *     toast (the map is saved without the edge first, so the deletion's
 *     cascade does not move this tab's version under it);
 *   • opens an element in a `<Sheet>` (a double-click, or "Open" in the
 *     toolbar) and, after every save there, reads the map again so each card
 *     shows what the bible now says.
 *
 * The plot board and the timeline are DERIVED (`mapLayoutMode`): every card
 * sits where the bible's act and story order put it (`deriveLaneLayout`), a
 * dropped card is an ORDER MOVE in the bible (`dropTarget` → POST …/order),
 * and the cards are put back where the bible then places them
 * (`placeCards`, a remote change that is neither an edit nor an undo step).
 *
 * Carved in part from inflect-compliance's `TldrawProcessWorkspace.tsx`
 * (docs/carve-manifest.md): its wiring of autosave, the history, the diff and
 * export around the canvas, without the palette, inspector, run mode, drill
 * breadcrumb, document bar and rules.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Editor, TLShapeId } from 'tldraw';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useToast, useToastWithUndo } from '@/components/ui/hooks';
import { WorkspaceShell } from '@/components/layout/WorkspaceShell';
import { BIBLE_API, BibleApiError, bibleFetch, reasonOf, type CreatedRelationView, type ElementListItemView, type OrderMoveResult } from '@/lib/bible/api-client';
import type { FieldDef } from '@/lib/bible/template-schema';
import type { RelationOption } from '@/lib/bible/ui-model';
import { MAP_API, type MapRestoreResult, type StoryMapSaveResult, type StoryMapView } from '@/lib/canvas/api-client';
import { buildMapDisplay, nodeDetailFor, nodeDisplayFor, type BadgeWords } from '@/lib/canvas/display';
import { deriveLaneLayout, dropTarget, participantsByEvent, stepMove, type DropMove } from '@/lib/canvas/lanes';
import { MAP_ELEMENT_KINDS, mapLayoutMode, type StoryMapKindValue } from '@/lib/canvas/map-kinds';
import type { MapState } from '@/lib/canvas/map-state';
import { MapConflictError } from '@/lib/canvas/map-save';
import { relationPickerChoices, type PickerChoice } from '@/lib/canvas/relation-picker';
import { useMapAutosave } from '@/lib/canvas/use-map-autosave';
import { betweenSlots, type AcceptedStructure, type BetweenSlot } from '@/lib/canvas/structure-preview';
import type { PendingStructureView } from '@/lib/enrichment/api-client';
import type { InterviewTarget } from '@/lib/interview/setup';
import { InterviewSetupSheet } from '@/components/interview/InterviewSetupSheet';
import { AddElementPicker } from './AddElementPicker';
import { CanvasDiffOverlay } from './CanvasDiffOverlay';
import { CanvasExportMenu } from './CanvasExportMenu';
import { CanvasHistorySidebar } from './CanvasHistorySidebar';
import { BetweenPicker, GrillThisButton, useCanvasSelection, type CanvasSelection } from './CanvasInterviewControls';
import type { StructurePreviewValue } from './GhostLayer';
import { ElementSheet, type SheetOrderControls } from './ElementSheet';
import { MapConflictNotice } from './MapConflictNotice';
import { RelationTypePicker } from './RelationTypePicker';
import { StoryMapCanvas } from './StoryMapCanvas';
import { addElementNode } from './tldraw/add-element-node';
import { drawRelationEdge, type RelationRequest } from './tldraw/arrow-to-edge';
import { runAutoLayout } from './tldraw/auto-layout-host';
import { serializeEditorCanvas } from './tldraw/editor-canvas';
import type { KnownRelation } from './tldraw/edge-validation';
import { placeCards, showNodes } from './tldraw/lane-host';
import type { FreeformRecord } from './tldraw/serializer';
import { STORY_NODE_SHAPE_TYPE } from './tldraw/story-node-shape';

export interface StoryMapEditorProps {
    workspaceSlug: string;
    bookId: string;
    bookTitle: string;
    /** The map's kind, and its URL segment (`relationship`, `plot`, `timeline`). */
    mapKind: StoryMapKindValue;
    kindSlug: string;
    mapLabel: string;
    initialMap: StoryMapView;
    kindLabels: Readonly<Record<string, string>>;
    /** Template field counts per kind, for a node added from the picker. */
    fieldCounts: Readonly<Record<string, number>>;
    /** Each kind this map draws: its relation options (the type picker) and its template fields (the element sheet). */
    relationOptions: Readonly<Record<string, RelationOption[]>>;
    fieldDefs: Readonly<Record<string, FieldDef[]>>;
    canEdit: boolean;
    /** Phase 3.3: the book's pending new elements and relations (drawn as ghosts; the list beside the canvas is the record). */
    structure?: readonly PendingStructureView[];
    /** Phase 3.3: the ghosts could not be drawn (the list says so). */
    onPreviewFailed?: () => void;
    /** Phase 3.3: the list hands what the author accepted to the map, to add it through the map's own save. */
    onRegisterAccepted?: (handler: ((accepted: AcceptedStructure) => void) | null) => void;
}

const NO_STRUCTURE: readonly PendingStructureView[] = [];

/** The save refusals worded in `canvas.errors`; any other is the generic sentence. */
const SAVE_REFUSALS: ReadonlySet<string> = new Set([
    'FREEFORM_REFUSED',
    'UNKNOWN_ELEMENT',
    'UNKNOWN_RELATION',
    'DUPLICATE_NODE',
    'DUPLICATE_EDGE',
    'EDGE_ENDPOINT_NOT_ON_MAP',
    'RELATION_MISMATCH',
    'SELF_LOOP',
    'KIND_NOT_ON_MAP',
]);

/** The order refusals worded in `canvas.order`; any other is its generic sentence. */
const ORDER_REFUSALS: ReadonlySet<string> = new Set(['ORDER_STALE', 'VERSION_CONFLICT', 'ORDER_RANK_EXHAUSTED', 'FIELD_VALUES_REFUSED']);

type Conflict = { cause: 'version' | 'gone'; currentVersion: number | null } | null;

interface PendingRelation {
    request: RelationRequest;
    choices: PickerChoice[];
    names: { a: string; b: string };
}

export default function StoryMapEditor({
    workspaceSlug,
    bookId,
    bookTitle,
    mapKind,
    kindSlug,
    mapLabel,
    initialMap,
    kindLabels,
    fieldCounts,
    relationOptions,
    fieldDefs,
    canEdit,
    structure = NO_STRUCTURE,
    onPreviewFailed,
    onRegisterAccepted,
}: StoryMapEditorProps) {
    const t = useTranslations('canvas');
    const toast = useToast();
    const triggerUndo = useToastWithUndo();
    const layoutMode = mapLayoutMode(mapKind);
    const [map, setMap] = useState(initialMap);
    const [version, setVersion] = useState(initialMap.version);
    const [canvasKey, setCanvasKey] = useState(0);
    const [editor, setEditor] = useState<Editor | null>(null);
    const [conflict, setConflict] = useState<Conflict>(null);
    const [saveErrorReason, setSaveErrorReason] = useState<string | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [diff, setDiff] = useState<{ version: number; current: MapState } | null>(null);
    const [openElementId, setOpenElementId] = useState<string | null>(null);
    const [pending, setPending] = useState<PendingRelation | null>(null);
    // The map the canvas was seeded from: replaced only on a (re)load, never by a save's answer.
    const [seed, setSeed] = useState(initialMap);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const words: BadgeWords & { unplaced: string } = useMemo(
        () => ({ notAssessed: t('badge.notAssessed'), percent: (percent) => t('badge.percent', { percent }), unplaced: t('lanes.unplaced') }),
        [t],
    );
    const display = useMemo(() => buildMapDisplay(seed.nodes, [...seed.relations, ...seed.edges], kindLabels, words), [seed, kindLabels, words]);
    const rows = useMemo(() => ({ nodes: seed.nodes.map((n) => ({ elementId: n.elementId, x: n.x, y: n.y, w: n.w, h: n.h, lane: n.lane })), edges: seed.edges.map((e) => ({ relationId: e.relationId, sourceElementId: e.sourceElementId, targetElementId: e.targetElementId })) }), [seed]);
    const freeform = useMemo(() => seed.freeform as FreeformRecord[], [seed]);

    // ─── The derived maps' lanes, from the bible ────────────────────
    const lanes = useMemo(() => {
        const participants = participantsByEvent(map.participants);
        return deriveLaneLayout(
            mapKind,
            map.nodes.map((n) => ({ elementId: n.elementId, name: n.element.name, orderRank: n.element.orderRank, act: n.element.act })),
            { acts: map.acts, participants, words: { noAct: t('lanes.noAct'), unplaced: t('lanes.unplaced'), axis: t('lanes.axis') } },
        );
    }, [map, mapKind, t]);

    // Every card where the bible puts it, and showing what the bible says, whenever the map is read again.
    useEffect(() => {
        if (!editor) return;
        showNodes(editor, buildMapDisplay(map.nodes, [], kindLabels, words).nodes);
        if (lanes) placeCards(editor, lanes.positions);
    }, [editor, map, lanes, kindLabels, words]);

    // The book's relations as the arrow converter reads them (the latest view's, and any made here since).
    const madeHere = useRef<KnownRelation[]>([]);
    const relationsRef = useRef<readonly KnownRelation[]>(initialMap.relations);
    useEffect(() => {
        const known = new Set(map.relations.map((r) => r.relationId));
        madeHere.current = madeHere.current.filter((r) => !known.has(r.relationId));
        relationsRef.current = [...map.relations, ...madeHere.current];
    }, [map]);
    const relations = useCallback(() => relationsRef.current, []);
    const relationLabels = useMemo(() => new Map([...map.relations, ...map.edges].map((r) => [r.relationId, r.label])), [map]);

    // The kind of every element drawn (the view's, and any added here since).
    const addedKinds = useRef(new Map<string, string>());
    const kindOf = useCallback((elementId: string) => map.nodes.find((n) => n.elementId === elementId)?.element.kind ?? addedKinds.current.get(elementId) ?? null, [map]);

    const onConflict = useCallback((currentVersion: number | null) => setConflict({ cause: 'version', currentVersion }), []);
    const onSaved = useCallback((result: StoryMapSaveResult) => {
        setMap(result.map);
        setVersion(result.map.version);
        setSaveErrorReason(null);
    }, []);
    const onError = useCallback((err: unknown) => {
        if (err instanceof MapConflictError) return;
        setSaveErrorReason(err instanceof BibleApiError ? err.reason : null);
    }, []);

    const autosave = useMapAutosave({
        editor,
        workspaceSlug,
        bookId,
        kind: kindSlug,
        version,
        onConflict: useCallback((currentVersion: number | null, cause: 'version' | 'gone') => setConflict({ cause, currentVersion }), []),
        onSaved,
        onError,
        enabled: canEdit && conflict === null,
    });
    const { markClean, markDirty, rebase, saveNow } = autosave;
    const saveNowRef = useRef(saveNow);
    useEffect(() => {
        saveNowRef.current = saveNow;
    }, [saveNow]);

    /**
     * Read the map's bible facts again (names, completeness, acts, order,
     * relations) after a change made through the bible. The VERSION is not
     * taken from it: a save by someone else must still meet the conflict
     * notice, never be overwritten by a silent re-base.
     */
    const refresh = useCallback(async () => {
        try {
            const { map: fresh } = await bibleFetch<{ map: StoryMapView }>(MAP_API.map(workspaceSlug, bookId, kindSlug));
            if (mounted.current) setMap(fresh);
        } catch {
            // The next save or reload reads it; the cards stay where they are.
        }
    }, [workspaceSlug, bookId, kindSlug]);

    /** Load the map as it now stands and seed a fresh canvas from it. */
    const reload = useCallback(async () => {
        const { map: fresh } = await bibleFetch<{ map: StoryMapView }>(MAP_API.map(workspaceSlug, bookId, kindSlug));
        markClean();
        setMap(fresh);
        setSeed(fresh);
        setVersion(fresh.version);
        rebase(fresh.version);
        setConflict(null);
        setSaveErrorReason(null);
        setEditor(null);
        setCanvasKey((k) => k + 1);
    }, [workspaceSlug, bookId, kindSlug, markClean, rebase]);

    /** The author's explicit choice: save these edits over the newer version. */
    const saveMine = useCallback(async () => {
        let base = conflict?.currentVersion ?? null;
        if (base === null) base = (await bibleFetch<{ map: StoryMapView }>(MAP_API.map(workspaceSlug, bookId, kindSlug))).map.version;
        rebase(base);
        setVersion(base);
        setConflict(null);
        await saveNow();
    }, [conflict, workspaceSlug, bookId, kindSlug, rebase, saveNow]);

    const addElement = useCallback(
        (element: Pick<ElementListItemView, 'id' | 'name' | 'kind' | 'customLabel' | 'filledFieldCount' | 'orderRank'>) => {
            if (!editor) return;
            const shown = nodeDisplayFor(
                { name: element.name, kind: element.kind, customLabel: element.customLabel, filledFieldCount: element.filledFieldCount, fieldCount: fieldCounts[element.kind] ?? 0 },
                kindLabels,
                words,
                nodeDetailFor({ kind: element.kind, orderRank: element.orderRank }, words),
            );
            addedKinds.current.set(element.id, element.kind);
            const { added } = addElementNode(editor, element.id, shown);
            // A derived map's new card goes where the bible puts it: its save answers with that place.
            if (added && layoutMode === 'derived') void saveNow();
        },
        [editor, fieldCounts, kindLabels, words, layoutMode, saveNow],
    );

    // ─── Order moves (the plot board, the timeline) ─────────────────
    const nodeOf = useCallback((elementId: string) => map.nodes.find((n) => n.elementId === elementId) ?? null, [map]);

    /** Send one order move to the bible; answers the element's new version, or null when it was refused (worded). */
    const sendMove = useCallback(
        async (move: DropMove, baseVersion: number): Promise<OrderMoveResult | null> => {
            try {
                const { move: result } = await bibleFetch<{ move: OrderMoveResult }>(BIBLE_API.order(workspaceSlug, bookId, move.elementId), {
                    method: 'POST',
                    body: { baseVersion, after: move.after, before: move.before, ...(move.act !== undefined ? { act: move.act } : {}) },
                });
                return result;
            } catch (err) {
                const reason = reasonOf(err);
                toast.error(reason && ORDER_REFUSALS.has(reason) ? t(`order.${reason}`) : t('order.generic'));
                return null;
            } finally {
                await refresh();
            }
        },
        [workspaceSlug, bookId, toast, t, refresh],
    );

    const onCardsDropped = useCallback(
        (drops: Array<{ elementId: string; center: { x: number; y: number } }>) => {
            if (!editor || !lanes) return;
            const snapBack = () => placeCards(editor, lanes.positions);
            if (drops.length !== 1) {
                snapBack();
                toast.error(t('order.oneAtATime'));
                return;
            }
            const [drop] = drops;
            const node = nodeOf(drop.elementId);
            const move = node ? dropTarget(lanes, drop.elementId, drop.center, { act: node.element.act, orderRank: node.element.orderRank }) : null;
            if (!node || !move) {
                snapBack();
                return;
            }
            void sendMove(move, node.element.versionNumber);
        },
        [editor, lanes, nodeOf, sendMove, toast, t],
    );

    const sheetOrder: SheetOrderControls | null = useMemo(() => {
        if (!lanes || !openElementId || !canEdit) return null;
        return {
            canEarlier: stepMove(lanes, openElementId, 'earlier') !== null,
            canLater: stepMove(lanes, openElementId, 'later') !== null,
            move: async (direction, baseVersion) => {
                const move = stepMove(lanes, openElementId, direction);
                if (!move) return null;
                const result = await sendMove(move, baseVersion);
                return result?.versionNumber ?? null;
            },
        };
    }, [lanes, openElementId, canEdit, sendMove]);

    // ─── Relations drawn and removed on the canvas ──────────────────
    const nameOf = useCallback(
        (elementId: string) => {
            const shape = editor?.getCurrentPageShapes().find((s) => s.type === STORY_NODE_SHAPE_TYPE && (s.props as { elementId?: string }).elementId === elementId);
            return (shape?.props as { name?: string } | undefined)?.name ?? nodeOf(elementId)?.element.name ?? '';
        },
        [editor, nodeOf],
    );

    const onNeedsRelation = useCallback(
        (request: RelationRequest) => {
            const kindA = kindOf(request.fromElementId);
            const kindB = kindOf(request.toElementId);
            const between = relationsRef.current.flatMap((r) => {
                const full = map.relations.find((m) => m.relationId === r.relationId);
                return full ? [{ type: full.type, sourceElementId: full.sourceElementId, targetElementId: full.targetElementId }] : [];
            });
            const choices =
                kindA && kindB
                    ? relationPickerChoices({ a: { id: request.fromElementId, kind: kindA }, b: { id: request.toElementId, kind: kindB } }, relationOptions[kindA] ?? [], between)
                    : [];
            setPending({ request, choices, names: { a: nameOf(request.fromElementId), b: nameOf(request.toElementId) } });
        },
        [kindOf, map, relationOptions, nameOf],
    );

    const dropArrow = useCallback(
        (arrowId: string) => {
            if (editor?.getShape(arrowId as TLShapeId)) editor.deleteShapes([arrowId as TLShapeId]);
        },
        [editor],
    );

    const onRelationCreated = useCallback(
        (relation: CreatedRelationView) => {
            const arrowId = pending?.request.arrowId;
            setPending(null);
            const known = { relationId: relation.id, sourceElementId: relation.fromElementId, targetElementId: relation.toElementId };
            madeHere.current = [...madeHere.current, known];
            relationsRef.current = [...relationsRef.current, known];
            if (editor && drawRelationEdge(editor, known, relation.label, arrowId)) markDirty();
            void refresh();
        },
        [pending, editor, markDirty, refresh],
    );

    // ─── Canvas interviews and the structural preview (Phase 3.3) ──
    const drawnKinds = useMemo(() => new Set<string>(MAP_ELEMENT_KINDS[mapKind]), [mapKind]);

    /** Add what the author accepted from the map's list: a card, or an edge between two cards, saved like any edit. */
    const onAccepted = useCallback(
        (accepted: AcceptedStructure) => {
            if (editor && canEdit) {
                if (accepted.kind === 'NEW_ELEMENT') {
                    if (drawnKinds.has(accepted.elementKind)) {
                        addElement({ id: accepted.elementId, name: accepted.name, kind: accepted.elementKind as ElementListItemView['kind'], customLabel: null, filledFieldCount: accepted.filledFieldCount, orderRank: null });
                    }
                } else {
                    const known = { relationId: accepted.relationId, sourceElementId: accepted.sourceElementId, targetElementId: accepted.targetElementId };
                    madeHere.current = [...madeHere.current, known];
                    relationsRef.current = [...relationsRef.current, known];
                    if (drawRelationEdge(editor, known, accepted.label)) markDirty();
                }
            }
            void refresh();
        },
        [editor, canEdit, drawnKinds, addElement, markDirty, refresh],
    );
    useEffect(() => {
        if (!onRegisterAccepted) return;
        onRegisterAccepted(onAccepted);
        return () => onRegisterAccepted(null);
    }, [onRegisterAccepted, onAccepted]);

    const [interview, setInterview] = useState<{ target: InterviewTarget; title: string } | null>(null);
    const selection = useCanvasSelection(editor);
    const grill = useCallback(
        (chosen: CanvasSelection) =>
            setInterview({ target: { scope: 'SELECTION', elementIds: chosen.elementIds, relationIds: chosen.relationIds }, title: t('interview.grillTitle', { count: chosen.elementIds.length + chosen.relationIds.length }) }),
        [t],
    );
    const askBetween = useCallback(
        (slot: BetweenSlot) => setInterview({ target: { scope: 'BETWEEN', afterElementId: slot.afterElementId, beforeElementId: slot.beforeElementId }, title: t('interview.betweenTitle', { a: slot.afterName, b: slot.beforeName }) }),
        [t],
    );
    const slots = useMemo(() => betweenSlots(lanes), [lanes]);
    const preview: StructurePreviewValue = useMemo(
        () => ({
            pending: structure,
            drawnKinds,
            kindLabels,
            words: { proposed: t('ghost.proposed'), between: (a: string, b: string) => t('interview.betweenAria', { a, b }) },
            lanes,
            onSlot: canEdit ? askBetween : undefined,
            onPreviewFailed,
        }),
        [structure, drawnKinds, kindLabels, t, lanes, canEdit, askBetween, onPreviewFailed],
    );

    const onEdgeRemoved = useCallback(
        (edge: { relationId: string; sourceElementId: string; targetElementId: string }) => {
            if (!editor) return;
            const label = relationLabels.get(edge.relationId) ?? '';
            const redraw = () => {
                if (mounted.current && editor) drawRelationEdge(editor, edge, label);
            };
            const drawnAgain = () =>
                editor.store.allRecords().some((r) => r.typeName === 'binding' && (r as { props?: { relationId?: string } }).props?.relationId === edge.relationId);
            triggerUndo({
                message: t('edges.removed', { a: nameOf(edge.sourceElementId), label, b: nameOf(edge.targetElementId) }),
                undoMessage: t('edges.undo'),
                action: async () => {
                    // Put back meanwhile (the canvas's own undo): keep the relation.
                    if (mounted.current && drawnAgain()) return;
                    // The map saved without the edge first, so the bible's
                    // cascade does not move this tab's version under it.
                    if (mounted.current) await saveNowRef.current();
                    await bibleFetch(BIBLE_API.relation(workspaceSlug, bookId, edge.relationId), { method: 'DELETE' });
                    relationsRef.current = relationsRef.current.filter((r) => r.relationId !== edge.relationId);
                    if (mounted.current) await refresh();
                },
                undoAction: redraw,
                onError: () => {
                    toast.error(t('edges.removeFailed'));
                    redraw();
                },
            });
        },
        [editor, relationLabels, triggerUndo, t, nameOf, workspaceSlug, bookId, refresh, toast],
    );

    const openDiff = useCallback(
        (target: number) => {
            if (!editor) return;
            const canvas = serializeEditorCanvas(editor);
            setDiff({ version: target, current: { nodes: canvas.rows.nodes, edges: canvas.rows.edges, freeform: canvas.freeform as MapState['freeform'] } });
        },
        [editor],
    );

    const elementNames = useMemo(() => {
        const names = new Map(map.nodes.map((n) => [n.elementId, n.element.name]));
        if (editor) {
            for (const s of editor.getCurrentPageShapes()) {
                if (s.type !== STORY_NODE_SHAPE_TYPE) continue;
                const p = s.props as { elementId?: string; name?: string };
                if (p.elementId && p.name) names.set(p.elementId, p.name);
            }
        }
        return names;
        // `diff` is in the list so the names are read again when a comparison opens.
    }, [map, editor, diff]); // eslint-disable-line react-hooks/exhaustive-deps

    const onRestored = useCallback(
        (result: MapRestoreResult) => {
            setHistoryOpen(false);
            const { nodes, edges } = result.dropped;
            toast.success(nodes + edges > 0 ? t('history.restoredDropped', { version: result.restoredFromVersion, nodes, edges }) : t('history.restored', { version: result.restoredFromVersion }));
            markClean();
            setMap(result.map);
            setSeed(result.map);
            setVersion(result.map.version);
            rebase(result.map.version);
            setEditor(null);
            setCanvasKey((k) => k + 1);
        },
        [toast, t, markClean, rebase],
    );

    const onMap = useMemo(() => new Set(map.nodes.map((n) => n.elementId)), [map]);
    const openOptions: ComboboxOption<undefined>[] = useMemo(
        () => [...map.nodes].sort((a, b) => (a.element.name < b.element.name ? -1 : 1)).map((n) => ({ value: n.elementId, label: n.element.name })),
        [map],
    );
    const statusText = conflict ? t('autosave.error') : t(`autosave.${autosave.status === 'idle' ? 'idle' : autosave.status}`);

    return (
        <>
            {canEdit ? null : <p className="text-sm text-content-muted">{t('page.readOnly')}</p>}
            {map.relationsTruncated ? <p className="text-sm text-content-muted">{t('page.relationsTruncated')}</p> : null}
            {map.excludedNodes > 0 ? <p className="text-sm text-content-muted">{t('page.excluded', { count: map.excludedNodes })}</p> : null}
            {map.participantsTruncated ? <p className="text-sm text-content-muted">{t('page.participantsTruncated')}</p> : null}
            {conflict ? (
                <MapConflictNotice cause={conflict.cause} onReload={() => void reload()} onSaveMine={canEdit ? () => void saveMine() : undefined} />
            ) : null}
            <WorkspaceShell.Toolbar>
                <div className="flex flex-wrap items-center gap-tight" data-testid="map-toolbar">
                    {canEdit ? (
                        <AddElementPicker workspaceSlug={workspaceSlug} bookId={bookId} kinds={MAP_ELEMENT_KINDS[mapKind]} onMap={onMap} kindLabels={kindLabels} onPick={addElement} />
                    ) : null}
                    <Combobox<undefined, undefined>
                        id="map-open-element"
                        options={openOptions}
                        selected={null}
                        onSelect={(o) => setOpenElementId(o.value)}
                        placeholder={t('toolbar.open')}
                        searchPlaceholder={t('toolbar.openSearch')}
                        emptyState={t('toolbar.openNone')}
                    />
                    {canEdit ? <GrillThisButton selection={selection} onGrill={grill} /> : null}
                    {canEdit && mapKind === 'PLOT' ? <BetweenPicker slots={slots} onPick={askBetween} /> : null}
                    {canEdit && layoutMode === 'free' ? (
                        <>
                            <Button variant="secondary" size="sm" disabled={!editor} onClick={() => editor && runAutoLayout(editor, 'LR')} data-testid="map-arrange-lr">
                                {t('toolbar.arrangeLR')}
                            </Button>
                            <Button variant="secondary" size="sm" disabled={!editor} onClick={() => editor && runAutoLayout(editor, 'TB')} data-testid="map-arrange-tb">
                                {t('toolbar.arrangeTB')}
                            </Button>
                        </>
                    ) : null}
                    <CanvasExportMenu editor={editor} fileStem={`${bookTitle} ${mapLabel}`} />
                    <Button variant="secondary" size="sm" onClick={() => setHistoryOpen(true)} data-testid="map-history-open">
                        {t('toolbar.history')}
                    </Button>
                    {canEdit ? (
                        <>
                            <span className="text-xs text-content-muted" data-testid="map-save-status" data-status={conflict ? 'conflict' : autosave.status} aria-live="polite">
                                {statusText}
                            </span>
                            {autosave.status === 'error' && !conflict ? (
                                <span className="text-xs text-content-error" role="alert">
                                    {saveErrorReason && SAVE_REFUSALS.has(saveErrorReason) ? t(`errors.${saveErrorReason}`) : t('errors.generic')}
                                </span>
                            ) : null}
                            <Button variant="primary" size="sm" disabled={!editor || conflict !== null} onClick={() => void saveNow()} data-testid="map-save">
                                {t('toolbar.save')}
                            </Button>
                        </>
                    ) : null}
                </div>
            </WorkspaceShell.Toolbar>
            <WorkspaceShell.Body>
                {/* `isolate`: tldraw's own z-indexes stay inside the canvas, so a dialog opened over it (the type picker, the sheet) is never under its toolbar. */}
                <div className="relative isolate h-[70vh] min-h-96 w-full overflow-hidden rounded-md border border-border-default md:h-full" data-testid="story-map-surface" data-map-version={version} data-map-kind={mapKind}>
                    {seed.nodes.length === 0 && seed.freeform.length === 0 && map.nodes.length === 0 ? (
                        <p className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 text-sm text-content-muted">{t(`page.emptyOf.${mapKind}`)}</p>
                    ) : null}
                    <StoryMapCanvas
                        key={canvasKey}
                        rows={rows}
                        display={display}
                        freeform={freeform}
                        readOnly={!canEdit}
                        relations={relations}
                        layout={layoutMode}
                        lanes={lanes}
                        onDirty={markDirty}
                        onEdgeRefused={(v) => toast.error(t(`edges.${v.kind === 'no-relation' ? 'NO_RELATION' : (v.refusals[0]?.code ?? 'UNKNOWN_NODE')}`))}
                        onNeedsRelation={canEdit ? onNeedsRelation : undefined}
                        onEdgeRemoved={canEdit ? onEdgeRemoved : undefined}
                        onCardsDropped={canEdit ? onCardsDropped : undefined}
                        onNodeOpen={setOpenElementId}
                        onEditorReady={setEditor}
                        preview={preview}
                    />
                </div>
            </WorkspaceShell.Body>
            <ElementSheet
                open={openElementId !== null}
                onOpenChange={(next) => {
                    if (!next) setOpenElementId(null);
                }}
                workspaceSlug={workspaceSlug}
                bookId={bookId}
                elementId={openElementId}
                fieldDefs={fieldDefs}
                kindLabels={kindLabels}
                canEdit={canEdit}
                onSaved={() => void refresh()}
                order={sheetOrder}
            />
            {pending ? (
                <RelationTypePicker
                    open
                    workspaceSlug={workspaceSlug}
                    bookId={bookId}
                    names={pending.names}
                    choices={pending.choices}
                    onCreated={onRelationCreated}
                    onCancel={() => {
                        dropArrow(pending.request.arrowId);
                        setPending(null);
                    }}
                />
            ) : null}
            {interview ? (
                <InterviewSetupSheet
                    open
                    setOpen={(next) => {
                        if (!next) setInterview(null);
                    }}
                    workspaceSlug={workspaceSlug}
                    bookId={bookId}
                    target={interview.target}
                    title={interview.title}
                />
            ) : null}
            <CanvasHistorySidebar
                workspaceSlug={workspaceSlug}
                bookId={bookId}
                kind={kindSlug}
                currentVersion={version}
                canRestore={canEdit}
                open={historyOpen}
                onOpenChange={setHistoryOpen}
                onDiffRequest={(v) => {
                    setHistoryOpen(false);
                    openDiff(v);
                }}
                onRestored={onRestored}
                onConflict={onConflict}
            />
            {diff ? (
                <CanvasDiffOverlay
                    key={diff.version}
                    open
                    onOpenChange={(next) => {
                        if (!next) setDiff(null);
                    }}
                    workspaceSlug={workspaceSlug}
                    bookId={bookId}
                    kind={kindSlug}
                    targetVersion={diff.version}
                    current={diff.current}
                    elementNames={elementNames}
                    relationLabels={relationLabels}
                />
            ) : null}
        </>
    );
}
