'use client';

/**
 * The story canvas — a tldraw editor seeded from a map's rows, reporting
 * every edit worth saving.
 *
 * Carved from inflect-compliance's `TldrawProcessCanvas.tsx`
 * (docs/carve-manifest.md), without the palette drop, drill scopes, group
 * folding, automation chips, run overlays and step focus: nodes arrive from
 * the host (`StoryMapEditor` adds an element through `addElementNode`) and
 * edges from drawing an arrow between two nodes (`arrow-to-edge.ts`).
 *
 * ═══ SEEDING IS NOT AN EDIT ═══
 *
 * The store listener is registered AFTER the seed: `createShapes` arrives at
 * a listener as a user change like any other, so registering first would
 * mark every freshly opened map dirty and autosave a version nobody made.
 *
 * ═══ createShapes, NOT A STORE SNAPSHOT ═══
 *
 * Every record goes through the same ShapeUtil and BindingUtil validators the
 * live canvas uses, so a serializer bug throws at load naming the prop,
 * rather than landing in the store as a corrupt document.
 *
 * ═══ HISTORY IS THE EDITOR'S ═══
 *
 * tldraw keeps its own undo stack; the host marks dirty and pushes nothing.
 *
 * ═══ WHAT THE DEFAULT UI OFFERED THAT A MAP CANNOT KEEP ═══
 *
 *   • one page (`maxPages: 1`): a save serialises the current page only;
 *   • no media, embeds or bookmarks: an uploaded file or an unfurled link is
 *     an asset record no save carries, and an unfurl would send the URL to
 *     tldraw's service — so a pasted link becomes plain text, and a pasted
 *     SVG nothing;
 *   • no tldraw groups: a group could not be restored around nodes that are
 *     saved as rows;
 *   • a focused toolbar: select, hand, arrow (which draws an edge between
 *     two nodes), text, note, draw, eraser, frame.
 *
 * ═══ THE WATERMARK STAYS (decision D1) ═══
 *
 * No licence key is passed and nothing hides or restyles tldraw's watermark
 * (`tests/guards/tldraw-licence-and-watermark.test.ts`). Fonts, icons and the
 * translation come from our own origin (`canvasAssetUrls`), which the
 * content-security policy requires.
 */
import 'tldraw/tldraw.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowToolbarItem,
    DefaultToolbar,
    DrawToolbarItem,
    EraserToolbarItem,
    FrameToolbarItem,
    HandToolbarItem,
    NoteToolbarItem,
    SelectToolbarItem,
    TextToolbarItem,
    Tldraw,
    atom,
    createTLUser,
    toRichText,
    type Editor,
    type TLBindingId,
    type TLComponents,
    type TLShapeId,
    type TLUiOverrides,
    type TLUserPreferences,
} from 'tldraw';

import { batchIsSubstantive } from '@/lib/canvas/canvas-changes';
import { classifyTldrawStoreDiff } from '@/lib/canvas/canvas-changes-tldraw';
import { canvasAssetUrls } from '@/lib/canvas/tldraw-assets';
import { installArrowToEdgeConversion, installOneNodePerElement, type ArrowVerdict } from './tldraw/arrow-to-edge';
import type { KnownRelation } from './tldraw/edge-validation';
import { restoreFreeform } from './tldraw/restore-freeform';
import { rowsToTldraw, type FreeformRecord, type GraphRows, type MapDisplay } from './tldraw/serializer';
import { STORY_EDGE_SHAPE_TYPE, edgeLineGeometry, shapeIdForRelation } from './tldraw/story-edge-shape';
import { StoryEdgeBindingUtil } from './tldraw/StoryEdgeBindingUtil';
import { StoryEdgeShapeUtil } from './tldraw/StoryEdgeShapeUtil';
import { StoryNodeShapeUtil } from './tldraw/StoryNodeShapeUtil';

/** Registered once at module scope: a new array each render remounts the editor. */
const SHAPE_UTILS = [StoryNodeShapeUtil, StoryEdgeShapeUtil];
const BINDING_UTILS = [StoryEdgeBindingUtil];
const TLDRAW_OPTIONS = { maxPages: 1 } as const;
const NO_FILE_TYPES: readonly string[] = [];
const ASSET_URLS = canvasAssetUrls();
const KEPT_TOOLS = new Set(['select', 'hand', 'arrow', 'text', 'note', 'draw', 'eraser', 'frame']);
const REMOVED_ACTIONS = ['insert-media', 'insert-embed', 'group', 'ungroup'];
const TLDRAW_OVERRIDES: TLUiOverrides = {
    tools(_editor, tools) {
        for (const id of Object.keys(tools)) if (!KEPT_TOOLS.has(id)) delete tools[id];
        return tools;
    },
    actions(_editor, actions) {
        for (const id of REMOVED_ACTIONS) delete actions[id];
        return actions;
    },
};
function StoryToolbar() {
    return (
        <DefaultToolbar>
            <SelectToolbarItem />
            <HandToolbarItem />
            <ArrowToolbarItem />
            <TextToolbarItem />
            <NoteToolbarItem />
            <DrawToolbarItem />
            <EraserToolbarItem />
            <FrameToolbarItem />
        </DefaultToolbar>
    );
}
const TLDRAW_COMPONENTS: TLComponents = { Toolbar: StoryToolbar };

export interface StoryMapCanvasProps {
    /** The map's rows, exactly as the API returns them. */
    rows: GraphRows;
    /** What the nodes and edges show, resolved by the host from the bible. */
    display: MapDisplay;
    /** The freeform layer: opaque here, carried into the store and never inspected. */
    freeform?: FreeformRecord[];
    /** A reader's view: tldraw refuses every write (set after the seed). */
    readOnly?: boolean;
    /** The book's relations, read when an arrow is drawn (the host's list may grow). */
    relations: () => readonly KnownRelation[];
    /** Called once per store change that is an edit worth saving. */
    onDirty?: () => void;
    /** An arrow between two nodes did not become an edge, and why. */
    onEdgeRefused?: (verdict: Extract<ArrowVerdict, { kind: 'refuse' | 'no-relation' }>) => void;
    onEditorReady?: (editor: Editor) => void;
}

/** `shape:…`, checked rather than asserted: an id without it is a serializer bug. */
function asShapeId(id: string): TLShapeId {
    if (!id.startsWith('shape:')) throw new Error(`Not a tldraw shape id: ${id}`);
    return id as TLShapeId;
}

function asBindingId(id: string): TLBindingId {
    if (!id.startsWith('binding:')) throw new Error(`Not a tldraw binding id: ${id}`);
    return id as TLBindingId;
}

/** Seed an editor with a map: nodes, then edges and their lines, then the freeform layer. */
export function seedEditor(editor: Editor, rows: GraphRows, display: MapDisplay, freeform: FreeformRecord[]): void {
    const graph = rowsToTldraw(rows, display, freeform);
    if (graph.shapes.length > 0) {
        editor.createShapes(graph.shapes.map((s) => ({ id: asShapeId(s.id), type: s.type, x: s.x, y: s.y, props: s.props })));
    }
    if (graph.bindings.length > 0) {
        editor.createBindings(
            graph.bindings.map((b) => ({ id: asBindingId(b.id), type: b.type, fromId: asShapeId(b.fromId), toId: asShapeId(b.toId), props: b.props })),
        );
        // The drawn lines, derived from the bindings just created (their
        // geometry needs both endpoints' bounds).
        const lines = graph.bindings.flatMap((b) => {
            const from = editor.getShapePageBounds(asShapeId(b.fromId));
            const to = editor.getShapePageBounds(asShapeId(b.toId));
            if (!from || !to) return [];
            const g = edgeLineGeometry(from, to);
            return [
                {
                    id: shapeIdForRelation(b.props.relationId),
                    type: STORY_EDGE_SHAPE_TYPE,
                    x: g.x,
                    y: g.y,
                    props: { relationId: b.props.relationId, label: display.edgeLabels.get(b.props.relationId) ?? '', dx: g.dx, dy: g.dy },
                },
            ];
        });
        if (lines.length > 0) editor.createShapes(lines);
    }
    restoreFreeform(editor, graph.freeform);
}

export function StoryMapCanvas({ rows, display, freeform = [], readOnly = false, relations, onDirty, onEdgeRefused, onEditorReady }: StoryMapCanvasProps) {
    // Callbacks through refs: `onMount` runs once per editor, so a closure
    // would pin the first render's callbacks for the editor's whole life.
    const onDirtyRef = useRef(onDirty);
    const onEdgeRefusedRef = useRef(onEdgeRefused);
    const relationsRef = useRef(relations);
    const displayRef = useRef(display);
    useEffect(() => {
        onDirtyRef.current = onDirty;
        onEdgeRefusedRef.current = onEdgeRefused;
        relationsRef.current = relations;
        displayRef.current = display;
    }, [onDirty, onEdgeRefused, relations, display]);

    // The UI's locale is English (D12): pinned, so tldraw neither follows the
    // browser's language nor fetches another translation. ONE user for the
    // component's life, its preferences in a signal: a user rebuilt on a render
    // (an inline options object) re-runs tldraw's translation load, which
    // re-renders, which rebuilds the user — measured as an endless refetch of
    // the translation with the editor stuck on its loading screen.
    const [user] = useState(() => {
        const preferences = atom<TLUserPreferences>('story-canvas-user', { id: 'inkquisitor-author', locale: 'en', colorScheme: 'system' });
        return createTLUser({ userPreferences: preferences, setUserPreferences: (p) => preferences.set({ ...p, locale: 'en' }) });
    });

    const disposers = useRef<Array<() => void>>([]);
    useEffect(
        () => () => {
            disposers.current.forEach((d) => d());
            disposers.current = [];
        },
        [],
    );

    const handleMount = useCallback(
        (editor: Editor) => {
            seedEditor(editor, rows, displayRef.current, freeform);

            // A pasted link is plain text: a bookmark or embed would be an
            // asset no save carries, unfurled by tldraw's own service.
            editor.registerExternalContentHandler('url', (info) => {
                const point = info.point ?? editor.getViewportPageBounds().center;
                editor.createShape({ type: 'text', x: point.x, y: point.y, props: { richText: toRichText(info.url) } });
            });
            editor.registerExternalContentHandler('svg-text', () => {});

            if (!readOnly) {
                disposers.current.forEach((d) => d());
                disposers.current = [
                    installOneNodePerElement(editor),
                    installArrowToEdgeConversion(editor, {
                        relations: () => relationsRef.current(),
                        onRefuse: (v) => onEdgeRefusedRef.current?.(v),
                        onConverted: () => onDirtyRef.current?.(),
                        resolveLabel: (relationId) => displayRef.current.edgeLabels.get(relationId) ?? '',
                    }),
                ];
            }

            // Read-only LAST: the flag refuses writes, and the seed is writes.
            if (readOnly) editor.updateInstanceState({ isReadonly: true });
            // Frame the map once, so a map saved far from the origin opens in view.
            if (rows.nodes.length > 0 || freeform.length > 0) editor.zoomToFit({ animation: { duration: 0 } });

            onEditorReady?.(editor);

            // AFTER the seed — see the header.
            return editor.store.listen(
                (entry) => {
                    if (batchIsSubstantive(classifyTldrawStoreDiff(entry.changes))) onDirtyRef.current?.();
                },
                { scope: 'document', source: 'user' },
            );
        },
        [rows, freeform, readOnly, onEditorReady],
    );

    const components = useMemo(() => TLDRAW_COMPONENTS, []);

    return (
        <div className="h-full w-full" data-story-canvas="true">
            <Tldraw
                shapeUtils={SHAPE_UTILS}
                bindingUtils={BINDING_UTILS}
                onMount={handleMount}
                options={TLDRAW_OPTIONS}
                overrides={TLDRAW_OVERRIDES}
                components={components}
                assetUrls={ASSET_URLS}
                user={user}
                acceptedImageMimeTypes={NO_FILE_TYPES}
                acceptedVideoMimeTypes={NO_FILE_TYPES}
            />
        </div>
    );
}
