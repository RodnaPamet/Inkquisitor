'use client';

/**
 * A story map's page body (Phase 3.1): the header, and the canvas surface
 * LOADED WITH `next/dynamic` AND `ssr: false` INSIDE `CanvasErrorBoundary`.
 *
 * This module imports nothing from tldraw, so the page's own first load
 * carries none of it: the editor arrives as a chunk of its own when the
 * page mounts in a browser (tldraw needs one), with a quiet placeholder
 * meanwhile. If the chunk fails to load or the canvas throws, the boundary
 * says the map is safe and offers to try again; the rest of the page stays.
 *
 * Phase 3.3: below the canvas, OUTSIDE its boundary, the book's pending new
 * elements and relations (`PendingStructureList`), the record the canvas's
 * ghosts preview. The list reads them and hands them to the editor to draw;
 * what the author accepts there goes to the editor (if it loaded) to be added
 * through the map's own save.
 */
import dynamic from 'next/dynamic';
import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { PageHeader } from '@/components/layout/PageHeader';
import { WorkspaceShell } from '@/components/layout/WorkspaceShell';
import { APP_ROUTES } from '@/lib/app-routes';
import type { StoryMapView } from '@/lib/canvas/api-client';
import { MAP_ELEMENT_KINDS, type StoryMapKindValue } from '@/lib/canvas/map-kinds';
import type { AcceptedStructure } from '@/lib/canvas/structure-preview';
import type { PendingStructureView } from '@/lib/enrichment/api-client';
import { CanvasErrorBoundary } from './CanvasErrorBoundary';
import { PendingStructureList } from './PendingStructureList';
// Types only (erased): the editor's code arrives through `next/dynamic` below.
import type { StoryMapEditorProps } from './StoryMapEditor';

function CanvasLoading() {
    const t = useTranslations('canvas');
    return (
        <p className="p-default text-sm text-content-muted" data-testid="canvas-loading">
            {t('loading')}
        </p>
    );
}

/**
 * The editor chunk, loaded afresh by each mount. `next/dynamic` wraps its
 * loader in ONE `React.lazy`, and a lazy component that rejected rejects for
 * good: with the dynamic component made once at module scope, the boundary's
 * "Try again" after a failed chunk load remounted the same rejection and
 * could never show the canvas. The boundary remounts this component on each
 * attempt (a new key), so each attempt asks for the chunk again.
 */
function DynamicStoryMapEditor(props: StoryMapEditorProps) {
    const [Editor] = useState(() => dynamic(() => import('./StoryMapEditor'), { ssr: false, loading: () => <CanvasLoading /> }));
    return <Editor {...props} />;
}

export interface StoryMapWorkspaceProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    kind: StoryMapKindValue;
    kindSlug: string;
    initialMap: StoryMapView;
    kindLabels: Readonly<Record<string, string>>;
    fieldCounts: Readonly<Record<string, number>>;
    /** Each kind the map draws: its relation options (the type picker) and template fields (the element sheet). */
    relationOptions: StoryMapEditorProps['relationOptions'];
    fieldDefs: StoryMapEditorProps['fieldDefs'];
    canEdit: boolean;
}

export function StoryMapWorkspace({ workspaceSlug, book, kind, kindSlug, initialMap, kindLabels, fieldCounts, relationOptions, fieldDefs, canEdit }: StoryMapWorkspaceProps) {
    const t = useTranslations('canvas');
    const mapLabel = t(`kinds.${kind}`);
    const [structure, setStructure] = useState<readonly PendingStructureView[]>([]);
    const [previewFailed, setPreviewFailed] = useState(false);
    const acceptedHandler = useRef<((accepted: AcceptedStructure) => void) | null>(null);
    const onRegisterAccepted = useCallback((handler: ((accepted: AcceptedStructure) => void) | null) => {
        acceptedHandler.current = handler;
    }, []);
    const onAccepted = useCallback((accepted: AcceptedStructure) => acceptedHandler.current?.(accepted), []);
    const onPreviewFailed = useCallback(() => setPreviewFailed(true), []);
    return (
        <WorkspaceShell>
            <WorkspaceShell.Header>
                <PageHeader
                    back={{ href: APP_ROUTES.book(workspaceSlug, book.id), label: t('page.back') }}
                    title={mapLabel}
                    eyebrow={book.title}
                    description={t(`page.about.${kind}`)}
                />
            </WorkspaceShell.Header>
            <CanvasErrorBoundary>
                <DynamicStoryMapEditor
                    workspaceSlug={workspaceSlug}
                    bookId={book.id}
                    bookTitle={book.title}
                    mapKind={kind}
                    kindSlug={kindSlug}
                    mapLabel={mapLabel}
                    initialMap={initialMap}
                    kindLabels={kindLabels}
                    fieldCounts={fieldCounts}
                    relationOptions={relationOptions}
                    fieldDefs={fieldDefs}
                    canEdit={canEdit}
                    structure={structure}
                    onPreviewFailed={onPreviewFailed}
                    onRegisterAccepted={onRegisterAccepted}
                />
            </CanvasErrorBoundary>
            <div className="flex-shrink-0 md:max-h-[40vh] md:overflow-y-auto">
                <PendingStructureList
                    workspaceSlug={workspaceSlug}
                    bookId={book.id}
                    canEdit={canEdit}
                    kindLabels={kindLabels}
                    drawnKinds={MAP_ELEMENT_KINDS[kind]}
                    onLoaded={setStructure}
                    onAccepted={onAccepted}
                    previewFailed={previewFailed}
                />
            </div>
        </WorkspaceShell>
    );
}
