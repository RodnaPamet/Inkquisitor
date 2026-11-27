'use client';

/**
 * The signed-in person's deleted workspaces they may still restore (Phase 5.H-a, D36), on the page a person with no
 * workspace lands on: each with the date it is deleted for good, and Restore, which brings it back whole (and cancels
 * the account deletion asked with it) and opens it.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDate } from '@inkquisitor/ui/lib/format-date';
import type { RestorableWorkspaceView } from '@/app-layer/usecases/workspace-deletion';
import { APP_ROUTES } from '@/lib/app-routes';
import { BIBLE_API, bibleFetch } from '@/lib/bible/api-client';

export function RestorableWorkspaces({ workspaces }: { workspaces: RestorableWorkspaceView[] }) {
    const t = useTranslations('noWorkspace.deleted');
    const router = useRouter();
    const [busy, setBusy] = useState<string | null>(null);
    if (workspaces.length === 0) return null;

    async function restore(w: RestorableWorkspaceView) {
        setBusy(w.workspaceId);
        try {
            const { slug } = await bibleFetch<{ slug: string }>(BIBLE_API.restoreWorkspace(w.workspaceId), { method: 'POST' });
            router.push(APP_ROUTES.books(slug));
            router.refresh();
        } catch {
            toast.error(t('failed'));
            setBusy(null);
        }
    }

    return (
        <section className="space-y-tight" aria-labelledby="restorable-workspaces-heading" data-testid="restorable-workspaces">
            <h2 id="restorable-workspaces-heading" className="text-sm font-semibold text-content-emphasis">
                {t('title')}
            </h2>
            <ul className="space-y-tight">
                {workspaces.map((w) => (
                    <li key={w.workspaceId} className="flex flex-wrap items-center justify-between gap-tight text-sm">
                        <span>
                            <span className="font-medium text-content-emphasis">{w.name}</span>{' '}
                            <span className="text-content-muted">{w.accountDeletionRequested ? t('untilWithAccount', { date: formatDate(w.restorableUntil) }) : t('until', { date: formatDate(w.restorableUntil) })}</span>
                        </span>
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<RotateCcw className="size-3.5" aria-hidden="true" />}
                            loading={busy === w.workspaceId}
                            disabled={busy !== null}
                            onClick={() => void restore(w)}
                            aria-label={t('restoreAria', { name: w.name })}
                            data-testid={`restore-workspace-${w.workspaceId}`}
                        >
                            {t('restore')}
                        </Button>
                    </li>
                ))}
            </ul>
        </section>
    );
}
