'use client';

/**
 * A story map's history: one row per save, newest first, each with Compare
 * (the diff overlay against the map as it stands) and Restore (a NEW save of
 * that version's state; nothing in the history is lost).
 *
 * Carved from inflect-compliance's `CanvasHistorySidebar.tsx`
 * (docs/carve-manifest.md), on the UI platform's `<Sheet>` and `<Modal>`
 * (inflect's AsidePanel and ConfirmDialog are not carried). A reader sees the
 * history and Compare, never Restore.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDateTime } from '@inkquisitor/ui/lib/format-date';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { BibleApiError, bibleFetch } from '@/lib/bible/api-client';
import { MAP_API, type MapRestoreResult, type MapSnapshotMetaView } from '@/lib/canvas/api-client';

export interface CanvasHistorySidebarProps {
    workspaceSlug: string;
    bookId: string;
    /** The map's URL segment. */
    kind: string;
    /** The map's version now: flags the current row, and is the restore's lock. */
    currentVersion: number;
    canRestore: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDiffRequest: (version: number) => void;
    onRestored: (result: MapRestoreResult) => void;
    /** A restore refused because the map moved on (409); the host shows its conflict notice. */
    onConflict: (currentVersion: number | null) => void;
}

export function CanvasHistorySidebar({
    workspaceSlug,
    bookId,
    kind,
    currentVersion,
    canRestore,
    open,
    onOpenChange,
    onDiffRequest,
    onRestored,
    onConflict,
}: CanvasHistorySidebarProps) {
    const t = useTranslations('canvas.history');
    const [rows, setRows] = useState<MapSnapshotMetaView[] | null>(null);
    const [truncated, setTruncated] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [confirming, setConfirming] = useState<number | null>(null);
    const [restoring, setRestoring] = useState<number | null>(null);
    const [restoreFailed, setRestoreFailed] = useState(false);

    // Re-read on every version the map reaches, so a save lands at the top.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        bibleFetch<{ snapshots: MapSnapshotMetaView[]; truncated: boolean }>(MAP_API.snapshots(workspaceSlug, bookId, kind))
            .then((body) => {
                if (cancelled) return;
                setRows(body.snapshots);
                setTruncated(body.truncated);
                setLoadFailed(false);
            })
            .catch(() => {
                if (!cancelled) setLoadFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, [open, workspaceSlug, bookId, kind, currentVersion]);

    async function restore(version: number) {
        setRestoring(version);
        setRestoreFailed(false);
        try {
            const result = await bibleFetch<MapRestoreResult>(MAP_API.restore(workspaceSlug, bookId, kind, version), {
                method: 'POST',
                body: { expectedVersion: currentVersion },
            });
            onRestored(result);
        } catch (err) {
            if (err instanceof BibleApiError && err.status === 409 && err.reason === 'VERSION_CONFLICT') {
                const details = err.details as { currentVersion?: unknown } | null;
                onConflict(typeof details?.currentVersion === 'number' ? details.currentVersion : null);
            } else {
                setRestoreFailed(true);
            }
        } finally {
            setRestoring(null);
        }
    }

    return (
        <>
            <Sheet open={open} onOpenChange={onOpenChange} size="md" title={t('title')}>
                <Sheet.Body>
                    <div data-testid="canvas-history" className="flex flex-col gap-default">
                        {loadFailed ? (
                            <p className="text-sm text-content-error" role="alert">
                                {t('loadError')}
                            </p>
                        ) : rows === null ? (
                            <p className="text-sm text-content-muted">{t('loading')}</p>
                        ) : rows.length === 0 ? (
                            <p className="text-sm text-content-muted" data-testid="canvas-history-empty">
                                {t('empty')}
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-tight">
                                {rows.map((r) => {
                                    const isCurrent = r.version === currentVersion;
                                    return (
                                        <li key={r.version} data-testid="canvas-history-row" data-version={r.version} className="flex flex-col gap-tight rounded-md border border-border-subtle p-compact">
                                            <div className="flex items-center justify-between gap-tight">
                                                <span className="text-sm font-medium text-content-emphasis">{t('version', { version: r.version })}</span>
                                                {isCurrent ? <span className="text-xs text-content-brand">{t('current')}</span> : null}
                                            </div>
                                            <span className="text-xs text-content-muted">
                                                {formatDateTime(r.createdAt)}
                                                {r.createdByName ? ` · ${r.createdByName}` : ''}
                                            </span>
                                            <span className="text-xs text-content-muted">{t('counts', { nodes: r.nodeCount, edges: r.edgeCount })}</span>
                                            {r.restoredFromVersion !== null ? (
                                                <span className="text-xs text-content-muted">{t('restoredFrom', { version: r.restoredFromVersion })}</span>
                                            ) : null}
                                            {!isCurrent ? (
                                                <div className="flex items-center gap-tight">
                                                    <Button variant="secondary" size="xs" onClick={() => onDiffRequest(r.version)} data-testid="canvas-history-diff">
                                                        {t('diff')}
                                                    </Button>
                                                    {canRestore ? (
                                                        <Button
                                                            variant="secondary"
                                                            size="xs"
                                                            onClick={() => setConfirming(r.version)}
                                                            disabled={restoring !== null}
                                                            data-testid="canvas-history-restore"
                                                        >
                                                            {restoring === r.version ? t('restoring') : t('restore')}
                                                        </Button>
                                                    ) : null}
                                                </div>
                                            ) : null}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                        {truncated ? <p className="text-xs text-content-muted">{t('truncated')}</p> : null}
                        {restoreFailed ? (
                            <p className="text-sm text-content-error" role="alert">
                                {t('restoreFailed')}
                            </p>
                        ) : null}
                    </div>
                </Sheet.Body>
            </Sheet>
            {confirming !== null ? (
                <Modal
                    showModal
                    setShowModal={(next) => {
                        if (!next) setConfirming(null);
                    }}
                    title={t('confirmTitle', { version: confirming })}
                    description={t('confirmBody')}
                >
                    <Modal.Header title={t('confirmTitle', { version: confirming })} description={t('confirmBody')} />
                    <Modal.Footer>
                        <Modal.Actions>
                            <Button variant="secondary" onClick={() => setConfirming(null)}>
                                {t('cancel')}
                            </Button>
                            <Button
                                variant="primary"
                                data-testid="canvas-history-confirm-restore"
                                onClick={() => {
                                    const version = confirming;
                                    setConfirming(null);
                                    void restore(version);
                                }}
                            >
                                {t('restore')}
                            </Button>
                        </Modal.Actions>
                    </Modal.Footer>
                </Modal>
            ) : null}
        </>
    );
}
