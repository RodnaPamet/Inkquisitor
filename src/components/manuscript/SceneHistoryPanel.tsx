'use client';

/**
 * A scene's text history (Phase 5.1, D33): every version, newest first, a page
 * at a time; a `<VersionDiff>` between any two; and, for an author who may
 * edit, a restore that applies an old version as a NEW one. Versions are
 * written when the author pauses or leaves (a checkpoint) and by the server's
 * bound, so the list is a writing history, not every keystroke.
 *
 * The list carries no text: the diff fetches the versions it compares as they
 * are picked and keeps them (a version never changes).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { VersionDiff } from '@/components/ui/VersionDiff';
import { formatDateTime } from '@inkquisitor/ui/lib/format-date';
import { cn } from '@inkquisitor/ui/lib/cn';
import { bibleFetch } from '@/lib/bible/api-client';
import { MANUSCRIPT_API, type SceneVersionMetaView, type SceneVersionPage } from '@/lib/manuscript/api-client';

export interface SceneHistoryPanelProps {
    workspaceSlug: string;
    bookId: string;
    sceneId: string;
    /** Moves when a version is written (the list reads again). */
    latestVersion: number;
    canEdit: boolean;
    onRestore: (versionNumber: number) => Promise<void>;
}

const SOURCE_VARIANT = { EDIT: 'neutral', RESTORE: 'info', IMPORT: 'warning' } as const;

export function SceneHistoryPanel({ workspaceSlug, bookId, sceneId, latestVersion, canEdit, onRestore }: SceneHistoryPanelProps) {
    const t = useTranslations('manuscript.history');
    const [versions, setVersions] = useState<SceneVersionMetaView[]>([]);
    const [nextBefore, setNextBefore] = useState<number | null>(null);
    const [failed, setFailed] = useState(false);
    const [texts, setTexts] = useState<ReadonlyMap<number, string>>(new Map());
    const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);
    const [restoring, setRestoring] = useState<number | null>(null);
    const requested = useRef(new Set<number>());

    useEffect(() => {
        let live = true;
        bibleFetch<SceneVersionPage>(MANUSCRIPT_API.versions(workspaceSlug, bookId, sceneId))
            .then((page) => {
                if (!live) return;
                setVersions(page.versions);
                setNextBefore(page.nextBefore);
                setFailed(false);
                const [a, b] = page.versions;
                setSelection(a ? { from: (b ?? a).versionNumber, to: a.versionNumber } : null);
            })
            .catch(() => {
                if (live) setFailed(true);
            });
        return () => {
            live = false;
        };
    }, [workspaceSlug, bookId, sceneId, latestVersion]);

    const load = useCallback(
        async (n: number) => {
            if (requested.current.has(n)) return;
            requested.current.add(n);
            try {
                const { version } = await bibleFetch<{ version: { text: string } }>(MANUSCRIPT_API.version(workspaceSlug, bookId, sceneId, n));
                setTexts((m) => new Map(m).set(n, version.text));
            } catch {
                requested.current.delete(n);
            }
        },
        [workspaceSlug, bookId, sceneId],
    );

    useEffect(() => {
        if (!selection) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load(selection.from);
        void load(selection.to);
    }, [selection, load]);

    async function older() {
        if (nextBefore === null) return;
        const page = await bibleFetch<SceneVersionPage>(MANUSCRIPT_API.versions(workspaceSlug, bookId, sceneId, nextBefore));
        setVersions((v) => [...v, ...page.versions]);
        setNextBefore(page.nextBefore);
    }

    async function restore(n: number) {
        setRestoring(n);
        try {
            await onRestore(n);
        } finally {
            setRestoring(null);
        }
    }

    if (failed) return <p className="text-sm text-content-muted" role="alert">{t('loadFailed')}</p>;
    if (versions.length === 0) return <p className="text-sm text-content-muted" data-testid="scene-history-empty">{t('none')}</p>;
    const latest = versions[0].versionNumber;
    const ready = selection !== null && texts.has(selection.from) && texts.has(selection.to);
    return (
        <div className="space-y-default" data-testid="scene-history">
            {selection && versions.length > 1 ? (
                <div className={cn(!ready && '[&_[data-testid=version-diff-body]]:invisible')} aria-busy={!ready}>
                    <VersionDiff
                        key={latest}
                        versions={versions.map((v) => ({ id: String(v.versionNumber), versionNumber: v.versionNumber, contentType: 'HTML', text: texts.get(v.versionNumber) ?? '' }))}
                        fromVersionId={String(selection.from)}
                        toVersionId={String(selection.to)}
                        onSelectionChange={({ fromId, toId }) => setSelection({ from: Number(fromId), to: Number(toId) })}
                    />
                </div>
            ) : null}
            <ol className="divide-y divide-[var(--border-subtle)]" aria-label={t('title')} data-testid="scene-version-list">
                {versions.map((v) => (
                    <li key={v.versionNumber} className="flex flex-wrap items-center justify-between gap-tight py-2" data-version={v.versionNumber}>
                        <div className="min-w-0">
                            <p className="flex flex-wrap items-center gap-tight text-sm font-medium text-content-emphasis">
                                {t('version', { number: v.versionNumber })}
                                <StatusBadge variant={SOURCE_VARIANT[v.source]}>{t(`source.${v.source}`)}</StatusBadge>
                                {v.versionNumber === latest ? <span className="text-xs text-content-muted">{t('current')}</span> : null}
                            </p>
                            <p className="text-xs text-content-muted">
                                {formatDateTime(v.createdAt)} · {t('words', { count: v.wordCount })}
                                {v.restoredFromVersion !== null ? ` · ${t('restoredFrom', { number: v.restoredFromVersion })}` : ''}
                            </p>
                        </div>
                        {canEdit && v.versionNumber !== latest ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                icon={<RotateCcw className="size-4" aria-hidden="true" />}
                                loading={restoring === v.versionNumber}
                                disabled={restoring !== null}
                                onClick={() => void restore(v.versionNumber)}
                                aria-label={t('restoreVersion', { number: v.versionNumber })}
                            >
                                {t('restore')}
                            </Button>
                        ) : null}
                    </li>
                ))}
            </ol>
            {nextBefore !== null ? (
                <Button variant="secondary" size="sm" onClick={() => void older()}>
                    {t('older')}
                </Button>
            ) : null}
        </div>
    );
}
