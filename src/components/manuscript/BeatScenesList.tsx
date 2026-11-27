'use client';

/**
 * The manuscript scenes that dramatise a plot beat (Phase 5.1, D33 item 2), read
 * only: shown on the beat's element page and in the plot board's element sheet,
 * never drawn on the canvas (the map's rows are the bible's alone). Each scene
 * links to its editor; a beat no scene names says so.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { APP_ROUTES } from '@/lib/app-routes';
import { bibleFetch } from '@/lib/bible/api-client';
import { MANUSCRIPT_API, type BeatSceneView } from '@/lib/manuscript/api-client';

export function BeatScenesList({ workspaceSlug, bookId, elementId }: { workspaceSlug: string; bookId: string; elementId: string }) {
    const t = useTranslations('manuscript.beatScenes');
    const [data, setData] = useState<{ scenes: BeatSceneView[]; truncated: boolean } | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let live = true;
        bibleFetch<{ scenes: BeatSceneView[]; truncated: boolean }>(MANUSCRIPT_API.beatScenes(workspaceSlug, bookId, elementId))
            .then((d) => {
                if (live) setData(d);
            })
            .catch(() => {
                if (live) setFailed(true);
            });
        return () => {
            live = false;
        };
    }, [workspaceSlug, bookId, elementId]);

    return (
        <section className="space-y-tight" aria-labelledby={`beat-scenes-${elementId}`} data-testid="beat-scenes">
            <h3 id={`beat-scenes-${elementId}`} className="text-sm font-semibold text-content-emphasis">
                {t('title')}
            </h3>
            {failed ? (
                <p className="text-sm text-content-muted">{t('failed')}</p>
            ) : !data ? (
                <p className="text-sm text-content-muted">{t('loading')}</p>
            ) : data.scenes.length === 0 ? (
                <p className="text-sm text-content-muted">{t('none')}</p>
            ) : (
                <ul className="space-y-tight">
                    {data.scenes.map((s) => (
                        <li key={s.sceneId} className="text-sm">
                            <Link className="text-content-brand hover:underline" href={APP_ROUTES.scene(workspaceSlug, bookId, s.sceneId)}>
                                {s.title ?? t('untitledScene')}
                            </Link>
                            <span className="text-content-muted"> · {s.chapterTitle ?? t('untitledChapter')}</span>
                        </li>
                    ))}
                </ul>
            )}
            {data?.truncated ? <p className="text-xs text-content-muted">{t('truncated')}</p> : null}
        </section>
    );
}
