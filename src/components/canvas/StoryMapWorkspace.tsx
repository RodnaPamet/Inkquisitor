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
 */
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';

import { PageHeader } from '@/components/layout/PageHeader';
import { WorkspaceShell } from '@/components/layout/WorkspaceShell';
import { APP_ROUTES } from '@/lib/app-routes';
import type { StoryMapView } from '@/lib/canvas/api-client';
import type { StoryMapKindValue } from '@/lib/canvas/map-kinds';
import { CanvasErrorBoundary } from './CanvasErrorBoundary';

function CanvasLoading() {
    const t = useTranslations('canvas');
    return (
        <p className="p-default text-sm text-content-muted" data-testid="canvas-loading">
            {t('loading')}
        </p>
    );
}

const StoryMapEditor = dynamic(() => import('./StoryMapEditor'), { ssr: false, loading: () => <CanvasLoading /> });

export interface StoryMapWorkspaceProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    kind: StoryMapKindValue;
    kindSlug: string;
    initialMap: StoryMapView;
    kindLabels: Readonly<Record<string, string>>;
    fieldCounts: Readonly<Record<string, number>>;
    canEdit: boolean;
}

export function StoryMapWorkspace({ workspaceSlug, book, kind, kindSlug, initialMap, kindLabels, fieldCounts, canEdit }: StoryMapWorkspaceProps) {
    const t = useTranslations('canvas');
    const mapLabel = t(`kinds.${kind}`);
    return (
        <WorkspaceShell>
            <WorkspaceShell.Header>
                <PageHeader
                    back={{ href: APP_ROUTES.book(workspaceSlug, book.id), label: t('page.back') }}
                    title={mapLabel}
                    eyebrow={book.title}
                    description={t('page.description')}
                />
            </WorkspaceShell.Header>
            <CanvasErrorBoundary>
                <StoryMapEditor
                    workspaceSlug={workspaceSlug}
                    bookId={book.id}
                    bookTitle={book.title}
                    kindSlug={kindSlug}
                    mapLabel={mapLabel}
                    initialMap={initialMap}
                    kindLabels={kindLabels}
                    fieldCounts={fieldCounts}
                    canEdit={canEdit}
                />
            </CanvasErrorBoundary>
        </WorkspaceShell>
    );
}
