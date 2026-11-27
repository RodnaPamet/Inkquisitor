'use client';

/**
 * One scene's draft notes for the editor (Phase 5.3, D35): what the nightly reading found at odds with the bible and
 * the threads it plants or pays off, read when the page opens (the reading runs at night, never on a save) and again
 * after the author decides one here. Each answer moves `token`, so the editor places the notes again — each only
 * where its own text still reads the quoted sentence. The hook never edits the text (D3).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { draftApi, type SceneDraftNotesView } from '@/lib/draft-facts/api-client';

export interface SceneDraftNotes {
    notes: SceneDraftNotesView | null;
    token: number;
    loadError: boolean;
    refresh: () => Promise<void>;
    fixDraft: (mismatchId: string) => Promise<void>;
    decideLink: (linkId: string, decision: 'CONFIRM' | 'REJECT') => Promise<void>;
}

export function useSceneDraftNotes({ workspaceSlug, bookId, sceneId }: { workspaceSlug: string; bookId: string; sceneId: string }): SceneDraftNotes {
    const t = useTranslations('manuscript.draft');
    const [notes, setNotes] = useState<SceneDraftNotesView | null>(null);
    const [token, setToken] = useState(0);
    const [loadError, setLoadError] = useState(false);
    const live = useRef(true);

    const refresh = useCallback(async () => {
        try {
            const { notes: fresh } = await draftApi.sceneNotes(workspaceSlug, bookId, sceneId);
            if (!live.current) return;
            setNotes(fresh);
            setLoadError(false);
            setToken((n) => n + 1);
        } catch {
            if (live.current) setLoadError(true);
        }
    }, [workspaceSlug, bookId, sceneId]);

    // Open: read after a tick, never inside the effect's own turn (as the prose notes do).
    useEffect(() => {
        live.current = true;
        const opening = setTimeout(() => void refresh(), 0);
        return () => {
            live.current = false;
            clearTimeout(opening);
        };
    }, [refresh]);

    const act = useCallback(
        async (work: () => Promise<unknown>, done: string) => {
            try {
                await work();
                toast.success(done);
            } catch {
                toast.error(t('failed'));
            }
            await refresh();
        },
        [refresh, t],
    );

    const fixDraft = useCallback((mismatchId: string) => act(() => draftApi.decideMismatch(workspaceSlug, bookId, mismatchId, 'FIX_DRAFT'), t('fixRecorded')), [act, workspaceSlug, bookId, t]);
    const decideLink = useCallback(
        (linkId: string, decision: 'CONFIRM' | 'REJECT') => act(() => draftApi.decideLink(workspaceSlug, bookId, linkId, decision), decision === 'CONFIRM' ? t('linkConfirmed') : t('linkRejected')),
        [act, workspaceSlug, bookId, t],
    );
    return { notes, token, loadError, refresh, fixDraft, decideLink };
}
