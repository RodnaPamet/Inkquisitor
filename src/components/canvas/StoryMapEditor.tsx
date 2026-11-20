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
 * Carved in part from inflect-compliance's `TldrawProcessWorkspace.tsx`
 * (docs/carve-manifest.md): its wiring of autosave, the history, the diff and
 * export around the canvas, without the palette, inspector, run mode, drill
 * breadcrumb, document bar and rules.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Editor } from 'tldraw';

import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/hooks';
import { WorkspaceShell } from '@/components/layout/WorkspaceShell';
import { BibleApiError, bibleFetch, type ElementListItemView } from '@/lib/bible/api-client';
import { MAP_API, type MapRestoreResult, type StoryMapSaveResult, type StoryMapView } from '@/lib/canvas/api-client';
import { buildMapDisplay, nodeDisplayFor, type BadgeWords } from '@/lib/canvas/display';
import type { MapState } from '@/lib/canvas/map-state';
import { MapConflictError } from '@/lib/canvas/map-save';
import { useMapAutosave } from '@/lib/canvas/use-map-autosave';
import { AddElementPicker } from './AddElementPicker';
import { CanvasDiffOverlay } from './CanvasDiffOverlay';
import { CanvasExportMenu } from './CanvasExportMenu';
import { CanvasHistorySidebar } from './CanvasHistorySidebar';
import { MapConflictNotice } from './MapConflictNotice';
import { StoryMapCanvas } from './StoryMapCanvas';
import { addElementNode } from './tldraw/add-element-node';
import { runAutoLayout } from './tldraw/auto-layout-host';
import { serializeEditorCanvas } from './tldraw/editor-canvas';
import type { KnownRelation } from './tldraw/edge-validation';
import type { FreeformRecord } from './tldraw/serializer';
import { STORY_NODE_SHAPE_TYPE } from './tldraw/story-node-shape';

export interface StoryMapEditorProps {
    workspaceSlug: string;
    bookId: string;
    bookTitle: string;
    /** The map's URL segment (`relationship`, `plot`, `timeline`). */
    kindSlug: string;
    mapLabel: string;
    initialMap: StoryMapView;
    kindLabels: Readonly<Record<string, string>>;
    /** Template field counts per kind, for a node added from the picker. */
    fieldCounts: Readonly<Record<string, number>>;
    canEdit: boolean;
}

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
]);

type Conflict = { cause: 'version' | 'gone'; currentVersion: number | null } | null;

export default function StoryMapEditor({ workspaceSlug, bookId, bookTitle, kindSlug, mapLabel, initialMap, kindLabels, fieldCounts, canEdit }: StoryMapEditorProps) {
    const t = useTranslations('canvas');
    const toast = useToast();
    const [map, setMap] = useState(initialMap);
    const [version, setVersion] = useState(initialMap.version);
    const [canvasKey, setCanvasKey] = useState(0);
    const [editor, setEditor] = useState<Editor | null>(null);
    const [conflict, setConflict] = useState<Conflict>(null);
    const [saveErrorReason, setSaveErrorReason] = useState<string | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [diff, setDiff] = useState<{ version: number; current: MapState } | null>(null);
    // The map the canvas was seeded from: replaced only on a (re)load, never by a save's answer.
    const [seed, setSeed] = useState(initialMap);

    const words: BadgeWords = useMemo(() => ({ notAssessed: t('badge.notAssessed'), percent: (percent) => t('badge.percent', { percent }) }), [t]);
    const display = useMemo(() => buildMapDisplay(seed.nodes, [...seed.relations, ...seed.edges], kindLabels, words), [seed, kindLabels, words]);
    const rows = useMemo(() => ({ nodes: seed.nodes.map((n) => ({ elementId: n.elementId, x: n.x, y: n.y, w: n.w, h: n.h, lane: n.lane })), edges: seed.edges.map((e) => ({ relationId: e.relationId, sourceElementId: e.sourceElementId, targetElementId: e.targetElementId })) }), [seed]);
    const freeform = useMemo(() => seed.freeform as FreeformRecord[], [seed]);

    // The book's relations as the arrow converter reads them (the latest view's).
    const relationsRef = useRef<readonly KnownRelation[]>(initialMap.relations);
    useEffect(() => {
        relationsRef.current = map.relations;
    }, [map]);
    const relations = useCallback(() => relationsRef.current, []);
    const relationLabels = useMemo(() => new Map([...map.relations, ...map.edges].map((r) => [r.relationId, r.label])), [map]);

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
        (element: ElementListItemView) => {
            if (!editor) return;
            const shown = nodeDisplayFor(
                { name: element.name, kind: element.kind, customLabel: element.customLabel, filledFieldCount: element.filledFieldCount, fieldCount: fieldCounts[element.kind] ?? 0 },
                kindLabels,
                words,
            );
            addElementNode(editor, element.id, shown);
        },
        [editor, fieldCounts, kindLabels, words],
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
    const statusText = conflict ? t('autosave.error') : t(`autosave.${autosave.status === 'idle' ? 'idle' : autosave.status}`);

    return (
        <>
            {canEdit ? null : <p className="text-sm text-content-muted">{t('page.readOnly')}</p>}
            {map.relationsTruncated ? <p className="text-sm text-content-muted">{t('page.relationsTruncated')}</p> : null}
            {conflict ? (
                <MapConflictNotice cause={conflict.cause} onReload={() => void reload()} onSaveMine={canEdit ? () => void saveMine() : undefined} />
            ) : null}
            <WorkspaceShell.Toolbar>
                <div className="flex flex-wrap items-center gap-tight" data-testid="map-toolbar">
                    {canEdit ? <AddElementPicker workspaceSlug={workspaceSlug} bookId={bookId} onMap={onMap} kindLabels={kindLabels} onPick={addElement} /> : null}
                    {canEdit ? (
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
                <div className="relative h-[70vh] min-h-96 w-full overflow-hidden rounded-md border border-border-default md:h-full" data-testid="story-map-surface" data-map-version={version}>
                    {seed.nodes.length === 0 && seed.freeform.length === 0 && map.nodes.length === 0 ? (
                        <p className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 text-sm text-content-muted">{t('page.empty')}</p>
                    ) : null}
                    <StoryMapCanvas
                        key={canvasKey}
                        rows={rows}
                        display={display}
                        freeform={freeform}
                        readOnly={!canEdit}
                        relations={relations}
                        onDirty={markDirty}
                        onEdgeRefused={(v) => toast.error(t(`edges.${v.kind === 'no-relation' ? 'NO_RELATION' : (v.refusals[0]?.code ?? 'UNKNOWN_NODE')}`))}
                        onEditorReady={setEditor}
                    />
                </div>
            </WorkspaceShell.Body>
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
