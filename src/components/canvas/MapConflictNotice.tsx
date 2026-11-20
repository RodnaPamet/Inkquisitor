'use client';

/**
 * The notice a refused save leaves on the canvas (Phase 3.1): the map moved
 * on since it was read — another tab or person saved it, or the bible
 * deleted something it drew — and this tab's edits were NOT saved.
 *
 * Persistent, not a toast: the autosave sends nothing more until the author
 * answers, and a notice that faded would leave unsaved work looking saved.
 * Two answers: Reload (the map as it now stands; this tab's unsaved edits
 * are lost, and the notice says so) or, for a version conflict, save these
 * edits over the newer version — the author's explicit choice, never a retry.
 */
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

export interface MapConflictNoticeProps {
    /** `version`: someone saved since; `gone`: the bible deleted something on the map. */
    cause: 'version' | 'gone';
    onReload: () => void;
    /** Absent for `gone` (the edits name something that no longer exists) and for a reader. */
    onSaveMine?: () => void;
}

export function MapConflictNotice({ cause, onReload, onSaveMine }: MapConflictNoticeProps) {
    const t = useTranslations('canvas.conflict');
    return (
        <div role="alert" data-testid="map-conflict-notice" className="flex flex-col gap-tight rounded-md border border-border-warning bg-bg-warning p-compact md:flex-row md:items-center md:justify-between">
            <div className="flex flex-col gap-tight">
                <p className="text-sm font-medium text-content-emphasis">{t('title')}</p>
                <p className="text-sm text-content-default">{cause === 'version' ? t('body') : t('gone')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-tight">
                <Button variant="primary" size="sm" onClick={onReload} data-testid="map-conflict-reload">
                    {t('reload')}
                </Button>
                {cause === 'version' && onSaveMine ? (
                    <Button variant="secondary" size="sm" onClick={onSaveMine} data-testid="map-conflict-save-mine">
                        {t('saveMine')}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
