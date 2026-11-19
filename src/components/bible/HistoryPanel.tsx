'use client';

/**
 * An element's version history (Phase 1.2): every version, newest first, with
 * where it came from (`MANUAL`, `INTERVIEW`, `IMPORT`) and what it says about
 * itself; a `<VersionDiff>` between any two of them; and, for an author who
 * may edit, a restore that applies an old version as a NEW one (the API's
 * restore never rewrites history).
 *
 * The list API carries no snapshots, so the diff fetches the two versions it
 * compares when they are picked and keeps them (a version never changes), and
 * shows each as readable lines (`snapshotToDiffHtml`), not as JSON. Until both
 * have arrived the diff body is hidden, so a half-loaded comparison is never
 * shown as a change.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { VersionDiff } from '@/components/ui/VersionDiff';
import { formatDateTime } from '@inkquisitor/ui/lib/format-date';
import { cn } from '@inkquisitor/ui/lib/cn';
import { BIBLE_API, bibleFetch, type VersionMetaView, type VersionView } from '@/lib/bible/api-client';
import { snapshotToDiffHtml } from '@/lib/bible/snapshot-text';
import type { FieldDef } from '@/lib/bible/template-schema';
import { SCALE_STEPS } from './FieldEditor';

export interface HistoryPanelProps {
    workspaceSlug: string;
    bookId: string;
    elementId: string;
    fieldDefs: FieldDef[];
    versions: VersionMetaView[];
    /** True when older versions exist past the loaded page. */
    hasOlder: boolean;
    onLoadOlder: () => Promise<void>;
    canEdit: boolean;
    /** Restore version `n` as a new version; resolves once the page shows it. */
    onRestore: (versionNumber: number) => Promise<void>;
}

const SOURCE_VARIANT = { MANUAL: 'neutral', INTERVIEW: 'info', IMPORT: 'warning' } as const;

export function HistoryPanel({ workspaceSlug, bookId, elementId, fieldDefs, versions, hasOlder, onLoadOlder, canEdit, onRestore }: HistoryPanelProps) {
    const t = useTranslations('bible.history');
    const tStatus = useTranslations('bible.status');
    const tSource = useTranslations('bible.source');
    const tDetails = useTranslations('bible.details');
    const tFields = useTranslations('bible.fields');
    const [texts, setTexts] = useState<ReadonlyMap<number, string>>(new Map());
    // The versions whose last fetch failed: the comparison says so only while
    // one of ITS two versions is among them, and picking a version again
    // fetches it again.
    const [failedVersions, setFailedVersions] = useState<ReadonlySet<number>>(new Set());
    const [restoring, setRestoring] = useState<number | null>(null);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const requested = useRef(new Set<number>());

    const latest = versions[0]?.versionNumber ?? 0;
    const [selection, setSelection] = useState<{ from: number; to: number }>(() => ({ from: versions[1]?.versionNumber ?? latest, to: latest }));
    // A new latest version (a save or a restore) moves the comparison to "previous → latest".
    const [seenLatest, setSeenLatest] = useState(latest);
    if (seenLatest !== latest) {
        setSeenLatest(latest);
        setSelection({ from: versions[1]?.versionNumber ?? latest, to: latest });
    }

    const labels = useMemo(
        () => ({
            name: tDetails('name'),
            customLabel: tDetails('customLabel'),
            status: tDetails('status'),
            summary: tDetails('summary'),
            statusValue: (s: string) => tStatus(s),
            scaleValue: (v: number) => tFields('scaleOf', { value: String(v), max: SCALE_STEPS.length }),
        }),
        [tDetails, tStatus, tFields],
    );

    const load = useCallback(
        async (n: number) => {
            if (requested.current.has(n)) return;
            requested.current.add(n);
            setFailedVersions((s) => {
                if (!s.has(n)) return s;
                const next = new Set(s);
                next.delete(n);
                return next;
            });
            try {
                const { version } = await bibleFetch<{ version: VersionView }>(BIBLE_API.version(workspaceSlug, bookId, elementId, n));
                const html = snapshotToDiffHtml(version.snapshot, fieldDefs, labels);
                setTexts((m) => new Map(m).set(n, html));
            } catch {
                requested.current.delete(n);
                setFailedVersions((s) => new Set(s).add(n));
            }
        },
        [workspaceSlug, bookId, elementId, fieldDefs, labels],
    );

    // Fetch the two compared versions; their state lands when each answer does.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (selection.from) void load(selection.from);
        if (selection.to) void load(selection.to);
    }, [selection, load]);

    const ready = texts.has(selection.from) && texts.has(selection.to);
    const failed = failedVersions.has(selection.from) || failedVersions.has(selection.to);
    const diffVersions = versions.map((v) => ({
        id: String(v.versionNumber),
        versionNumber: v.versionNumber,
        contentType: 'HTML',
        text: texts.get(v.versionNumber) ?? '',
    }));

    async function restore(n: number) {
        setRestoring(n);
        try {
            await onRestore(n);
        } finally {
            setRestoring(null);
        }
    }

    return (
        <div className="space-y-section" data-testid="history-panel">
            <Card className="space-y-default p-5">
                <div className="space-y-tight">
                    <h2 className="text-base font-semibold text-content-emphasis">{t('compareTitle')}</h2>
                    <p className="text-sm text-content-muted">{t('compareHelp')}</p>
                </div>
                <div className={cn(!ready && '[&_[data-testid=version-diff-body]]:invisible')} aria-busy={!ready} data-testid="history-diff">
                    <VersionDiff
                        key={latest}
                        versions={diffVersions}
                        fromVersionId={String(selection.from)}
                        toVersionId={String(selection.to)}
                        onSelectionChange={({ fromId, toId }) => setSelection({ from: Number(fromId), to: Number(toId) })}
                    />
                </div>
                {!ready && versions.length > 1 ? (
                    <p className="text-xs text-content-muted" role="status">
                        {failed ? t('loadFailed') : t('loading')}
                    </p>
                ) : null}
            </Card>

            <Card className="p-0">
                <h2 className="px-5 pt-5 text-base font-semibold text-content-emphasis">{t('versionsTitle')}</h2>
                <ol className="divide-y divide-[var(--border-subtle)]" aria-label={t('versionsTitle')} data-testid="version-list">
                    {versions.map((v) => (
                        <li key={v.versionNumber} className="flex flex-wrap items-center justify-between gap-default px-5 py-3" data-version={v.versionNumber}>
                            <div className="min-w-0 space-y-tight">
                                <p className="flex flex-wrap items-center gap-tight text-sm font-medium text-content-emphasis">
                                    {t('versionLabel', { number: v.versionNumber })}
                                    <StatusBadge variant={SOURCE_VARIANT[v.source as keyof typeof SOURCE_VARIANT] ?? 'neutral'}>{tSource(v.source)}</StatusBadge>
                                    {v.versionNumber === latest ? <span className="text-xs text-content-muted">{t('current')}</span> : null}
                                </p>
                                <p className="text-xs text-content-muted">
                                    {formatDateTime(v.createdAt)}
                                    {v.restoredFromVersion !== null ? ` · ${t('restoredFrom', { number: v.restoredFromVersion })}` : v.changeSummary ? ` · ${v.changeSummary}` : ''}
                                </p>
                            </div>
                            {canEdit && v.versionNumber !== latest ? (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    icon={<RotateCcw className="size-3.5" aria-hidden="true" />}
                                    loading={restoring === v.versionNumber}
                                    disabled={restoring !== null}
                                    onClick={() => void restore(v.versionNumber)}
                                    aria-label={t('restoreAria', { number: v.versionNumber })}
                                    data-testid={`restore-${v.versionNumber}`}
                                >
                                    {t('restore')}
                                </Button>
                            ) : null}
                        </li>
                    ))}
                </ol>
                {hasOlder ? (
                    <div className="border-t border-border-subtle px-5 py-3">
                        <Button
                            variant="secondary"
                            size="sm"
                            loading={loadingOlder}
                            onClick={() => {
                                setLoadingOlder(true);
                                void onLoadOlder().finally(() => setLoadingOlder(false));
                            }}
                        >
                            {t('loadOlder')}
                        </Button>
                    </div>
                ) : null}
            </Card>
        </div>
    );
}
