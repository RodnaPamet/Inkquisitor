'use client';

/**
 * Compare one saved version of a story map with the map as it stands.
 *
 * Carved from inflect-compliance's `CanvasDiffOverlay.tsx`
 * (docs/carve-manifest.md). A `<Modal>` rather than an overlay on the
 * canvas: the live surface stays as it is while the author reads. Rows are
 * named by element and relation (the names the map shows), never by id; an
 * element no longer on the map reads as such. Notes and drawings are one
 * line ("changed"), never listed: they are author text.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { bibleFetch } from '@/lib/bible/api-client';
import { MAP_API, type MapSnapshotView } from '@/lib/canvas/api-client';
import { computeCanvasDiff, diffChangeCount, type DiffClass } from '@/lib/canvas/canvas-diff';
import type { MapState } from '@/lib/canvas/map-state';

export interface CanvasDiffOverlayProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    workspaceSlug: string;
    bookId: string;
    kind: string;
    targetVersion: number;
    /** The map as it stands (what the canvas holds now). */
    current: MapState;
    /** Names to show: an element's by id, a relation's label by id. */
    elementNames: ReadonlyMap<string, string>;
    relationLabels: ReadonlyMap<string, string>;
}

const TONE: Record<Exclude<DiffClass, 'unchanged'>, string> = {
    added: 'bg-bg-success text-content-success',
    removed: 'bg-bg-error text-content-error',
    moved: 'bg-bg-info text-content-info',
    modified: 'bg-bg-warning text-content-warning',
};

export function CanvasDiffOverlay({ open, onOpenChange, workspaceSlug, bookId, kind, targetVersion, current, elementNames, relationLabels }: CanvasDiffOverlayProps) {
    const t = useTranslations('canvas.diff');
    const [snapshot, setSnapshot] = useState<MapSnapshotView | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (!open) return;
        // Mounted per comparison (the host keys it by version), so no reset here.
        let cancelled = false;
        bibleFetch<{ snapshot: MapSnapshotView }>(MAP_API.snapshot(workspaceSlug, bookId, kind, targetVersion))
            .then((body) => {
                if (!cancelled) setSnapshot(body.snapshot);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, [open, workspaceSlug, bookId, kind, targetVersion]);

    const diff = useMemo(() => (snapshot ? computeCanvasDiff(snapshot, current) : null), [snapshot, current]);
    const title = t('title', { version: targetVersion });

    const rows = (entries: Map<string, DiffClass>, nameOf: (id: string) => string, testid: string) =>
        [...entries.entries()]
            .filter((entry): entry is [string, Exclude<DiffClass, 'unchanged'>] => entry[1] !== 'unchanged')
            .map(([id, c]) => (
                <li key={id} data-testid={testid} data-class={c} className={`flex items-center justify-between gap-tight rounded-md px-2 py-1 text-xs ${TONE[c]}`}>
                    <span className="truncate">{nameOf(id)}</span>
                    <span className="shrink-0">{t(`classes.${c}`)}</span>
                </li>
            ));

    return (
        <Modal showModal={open} setShowModal={(next) => onOpenChange(typeof next === 'boolean' ? next : !open)} title={title} description={t('description')}>
            <Modal.Header title={title} description={t('description')} />
            <Modal.Body>
                <div data-testid="canvas-diff" className="flex flex-col gap-default">
                    {failed ? (
                        <p className="text-sm text-content-error" role="alert">
                            {t('loadError')}
                        </p>
                    ) : !diff ? (
                        <p className="text-sm text-content-muted">{t('loading')}</p>
                    ) : diffChangeCount(diff) === 0 ? (
                        <p className="text-sm text-content-muted" data-testid="canvas-diff-empty">
                            {t('noChanges')}
                        </p>
                    ) : (
                        <>
                            <ul data-testid="canvas-diff-summary" className="flex flex-wrap gap-tight text-xs text-content-muted">
                                {(
                                    [
                                        ['nodesAdded', diff.summary.nodesAdded],
                                        ['nodesRemoved', diff.summary.nodesRemoved],
                                        ['nodesMoved', diff.summary.nodesMoved],
                                        ['nodesModified', diff.summary.nodesModified],
                                        ['edgesAdded', diff.summary.edgesAdded],
                                        ['edgesRemoved', diff.summary.edgesRemoved],
                                        ['edgesModified', diff.summary.edgesModified],
                                    ] as const
                                )
                                    .filter(([, count]) => count > 0)
                                    .map(([key, count]) => (
                                        <li key={key} className="rounded-md border border-border-subtle px-2 py-1">
                                            {t(key, { count })}
                                        </li>
                                    ))}
                                {diff.freeformChanged ? <li className="rounded-md border border-border-subtle px-2 py-1">{t('freeformChanged')}</li> : null}
                            </ul>
                            <section className="flex flex-col gap-tight">
                                <h3 className="text-xs font-medium text-content-muted">{t('nodes')}</h3>
                                <ul className="flex flex-col gap-tight">{rows(diff.nodes, (id) => elementNames.get(id) ?? t('unknown'), 'canvas-diff-node')}</ul>
                            </section>
                            <section className="flex flex-col gap-tight">
                                <h3 className="text-xs font-medium text-content-muted">{t('edges')}</h3>
                                <ul className="flex flex-col gap-tight">{rows(diff.edges, (id) => relationLabels.get(id) ?? t('unknownEdge'), 'canvas-diff-edge')}</ul>
                            </section>
                        </>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button variant="secondary" onClick={() => onOpenChange(false)}>
                        {t('close')}
                    </Button>
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}
