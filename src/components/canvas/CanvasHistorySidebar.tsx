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
 *
 * Paged (3.H): the newest page first, and "Show older" reads the page below
 * the last row shown, so every version stays reachable and no read grows with
 * the map's age.
 *
 * Unsaved edits (issue #45, item 2): a restore replaces the canvas, so edits
 * still waiting in the autosave debounce would be lost without a word. The
 * host says whether any are pending (`pendingEdits`); the confirmation then
 * says they will be saved first, and `beforeRestore` saves them (the restore
 * names the version that save reached). A save that fails stops the restore.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDateTime } from '@inkquisitor/ui/lib/format-date';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { BibleApiError, bibleFetch } from '@/lib/bible/api-client';
import { MAP_API, type MapRestoreResult, type MapSnapshotMetaView, type MapSnapshotPage } from '@/lib/canvas/api-client';

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
    /** True while edits are waiting to be saved (the confirmation says they will be saved first). */
    pendingEdits?: boolean;
    /**
     * Save the pending edits before a restore; answers the map's version after
     * it, or null when the save failed (the restore is then not sent).
     */
    beforeRestore?: () => Promise<number | null>;
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
    pendingEdits = false,
    beforeRestore,
}: CanvasHistorySidebarProps) {
    const t = useTranslations('canvas.history');
    const [rows, setRows] = useState<MapSnapshotMetaView[] | null>(null);
    const [nextBefore, setNextBefore] = useState<number | null>(null);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [confirming, setConfirming] = useState<number | null>(null);
    const [restoring, setRestoring] = useState<number | null>(null);
    const [restoreFailed, setRestoreFailed] = useState<false | 'restore' | 'unsaved'>(false);

    // Re-read on every version the map reaches, so a save lands at the top.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        bibleFetch<MapSnapshotPage>(MAP_API.snapshotPage(workspaceSlug, bookId, kind, null))
            .then((body) => {
                if (cancelled) return;
                setRows(body.snapshots);
                setNextBefore(body.nextBefore);
                setLoadFailed(false);
            })
            .catch(() => {
                if (!cancelled) setLoadFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, [open, workspaceSlug, bookId, kind, currentVersion]);

    async function loadOlder() {
        if (nextBefore === null) return;
        setLoadingOlder(true);
        try {
            const body = await bibleFetch<MapSnapshotPage>(MAP_API.snapshotPage(workspaceSlug, bookId, kind, nextBefore));
            setRows((prev) => [...(prev ?? []), ...body.snapshots.filter((r) => !(prev ?? []).some((p) => p.version === r.version))]);
            setNextBefore(body.nextBefore);
        } catch {
            setLoadFailed(true);
        } finally {
            setLoadingOlder(false);
        }
    }

    async function restore(version: number) {
        setRestoring(version);
        setRestoreFailed(false);
        try {
            // Edits waiting in the debounce are saved first, or the restore would drop them unsaid.
            let expectedVersion = currentVersion;
            if (pendingEdits && beforeRestore) {
                const saved = await beforeRestore();
                if (saved === null) {
                    setRestoreFailed('unsaved');
                    return;
                }
                expectedVersion = saved;
            }
            const result = await bibleFetch<MapRestoreResult>(MAP_API.restore(workspaceSlug, bookId, kind, version), {
                method: 'POST',
                body: { expectedVersion },
            });
            onRestored(result);
        } catch (err) {
            if (err instanceof BibleApiError && err.status === 409 && err.reason === 'VERSION_CONFLICT') {
                const details = err.details as { currentVersion?: unknown } | null;
                onConflict(typeof details?.currentVersion === 'number' ? details.currentVersion : null);
            } else {
                setRestoreFailed('restore');
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
                                            {r.fromBibleDeletion ? <span className="text-xs text-content-muted">{t('fromBibleDeletion')}</span> : null}
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
                        {nextBefore !== null && rows !== null ? (
                            <Button variant="secondary" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder} data-testid="canvas-history-older">
                                {loadingOlder ? t('loading') : t('older')}
                            </Button>
                        ) : null}
                        {restoreFailed ? (
                            <p className="text-sm text-content-error" role="alert">
                                {restoreFailed === 'unsaved' ? t('restoreUnsavedFailed') : t('restoreFailed')}
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
                    description={pendingEdits ? t('confirmBodyPending') : t('confirmBody')}
                >
                    <Modal.Header title={t('confirmTitle', { version: confirming })} description={pendingEdits ? t('confirmBodyPending') : t('confirmBody')} />
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
