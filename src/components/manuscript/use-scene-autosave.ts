'use client';

/**
 * Autosave for one scene's text (Phase 5.1, D33). The editor reports every
 * edit (`edit(html)`); the hook sends the latest text, debounced, through
 * `PUT …/scenes/:id/text`, naming the revision it was based on.
 *
 * As the bible's `useElementAutosave`, the parts that are easy to get wrong:
 *
 *   - ONE SAVE AT A TIME; an edit made while one is in flight goes in the next.
 *   - AN ERROR LOSES NOTHING: the text stays queued (the newest text is always
 *     the one sent) and the next edit, or Retry, sends it.
 *   - A SAVE'S ANSWER NEVER OVERWRITES THE EDITOR: it moves the revision and
 *     the word count, nothing else.
 *   - A CONFLICT (409 VERSION_CONFLICT: the scene was saved elsewhere) HOLDS
 *     the edit and sends nothing more until the author chooses: `keepMine()`
 *     re-bases on the revision the scene is at and saves over it, knowingly;
 *     reloading is the page's. Never a silent overwrite.
 *
 * CHECKPOINTS (D33, owner decision 2026-11-27). Autosave keeps the text safe
 * continuously; a HISTORY VERSION is asked for when the author pauses or leaves:
 *
 *   - after `SCENE_IDLE_CHECKPOINT_MS` (about two minutes) with no edit, the
 *     next save is a checkpoint (or, with nothing unsaved, a bare checkpoint);
 *   - leaving the scene (the page unmounts), the tab hidden, or the page
 *     unloading: unsaved text is sent as a checkpoint, and with nothing unsaved
 *     a bare checkpoint goes with `keepalive` (a few bytes, so it survives the
 *     unload whatever the scene's length).
 *
 * The server decides whether a version is due (the text differs from the
 * newest version), and writes one anyway when the newest is older than its
 * bound, so a signal the network lost never leaves a long gap in history.
 * Unsaved text when the page unloads asks first.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BibleApiError, bibleFetch, reasonOf } from '@/lib/bible/api-client';
import { MANUSCRIPT_API, sendCheckpointOnLeave, type SceneTextResult } from '@/lib/manuscript/api-client';
import { SCENE_IDLE_CHECKPOINT_MS } from '@/lib/manuscript/vocabulary';

export type SceneSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

export interface UseSceneAutosaveOptions {
    workspaceSlug: string;
    bookId: string;
    sceneId: string;
    enabled: boolean;
    initialRevision: number;
    debounceMs?: number;
    /** The idle pause before a checkpoint (tests shorten it). */
    idleMs?: number;
    /** Every successful save's answer (the page updates counts and, when links changed, the side panel). */
    onSaved?: (result: SceneTextResult) => void;
}

export interface SceneAutosave {
    state: SceneSaveState;
    /** The refusal's reason when a save failed (null: a network failure). */
    errorReason: string | null;
    /** The revision the scene is at elsewhere, while a conflict is held. */
    conflictRevision: number | null;
    revision: number;
    edit: (html: string) => void;
    /** Send what is unsaved now (Retry). */
    flush: () => Promise<void>;
    /** Re-base the held edit on the scene's current revision and save over it (the author chose to keep theirs). */
    keepMine: () => void;
    /** A restore or a reload set a new base (the editor now holds that revision's text). */
    rebase: (revision: number) => void;
    /** Send what is unsaved, then let `work` save something else of the scene (its details) at the revision it returns. */
    alongside: <T extends { revision: number }>(work: (baseRevision: number) => Promise<T>) => Promise<T>;
}

export function useSceneAutosave(opts: UseSceneAutosaveOptions): SceneAutosave {
    const { workspaceSlug, bookId, sceneId, enabled } = opts;
    const debounceMs = opts.debounceMs ?? 1_000;
    const idleMs = opts.idleMs ?? SCENE_IDLE_CHECKPOINT_MS;
    const [state, setState] = useState<SceneSaveState>('idle');
    const [errorReason, setErrorReason] = useState<string | null>(null);
    const [conflictRevision, setConflictRevision] = useState<number | null>(null);
    const [revision, setRevision] = useState(opts.initialRevision);

    const pending = useRef<string | null>(null);
    const revisionRef = useRef(opts.initialRevision);
    const inFlight = useRef<Promise<void> | null>(null);
    const conflict = useRef(false);
    const mounted = useRef(true);
    const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
    const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** The author paused (idle) or is leaving: the next save asks for a version. */
    const checkpointDue = useRef(false);
    /** Text was saved since the last checkpoint, so a bare checkpoint may version it. */
    const savedSinceCheckpoint = useRef(false);
    const onSaved = useRef(opts.onSaved);
    useEffect(() => {
        onSaved.current = opts.onSaved;
    }, [opts.onSaved]);

    const textUrl = MANUSCRIPT_API.text(workspaceSlug, bookId, sceneId);
    const checkpointUrl = MANUSCRIPT_API.checkpoint(workspaceSlug, bookId, sceneId);

    const run = useCallback((): Promise<void> => {
        if (inFlight.current) return inFlight.current;
        const loop = async () => {
            while (pending.current !== null && !conflict.current) {
                const html = pending.current;
                const checkpoint = checkpointDue.current;
                pending.current = null;
                checkpointDue.current = false;
                if (mounted.current) setState('saving');
                try {
                    const result = await bibleFetch<SceneTextResult>(textUrl, { method: 'PUT', body: { html, baseRevision: revisionRef.current, checkpoint } });
                    revisionRef.current = result.revision;
                    savedSinceCheckpoint.current = !checkpoint;
                    if (mounted.current) {
                        setRevision(result.revision);
                        setErrorReason(null);
                    }
                    onSaved.current?.(result);
                } catch (err) {
                    // Put it back under anything typed since (the newer text wins).
                    if (pending.current === null) pending.current = html;
                    if (checkpoint) checkpointDue.current = true;
                    if (err instanceof BibleApiError && err.status === 409 && err.reason === 'VERSION_CONFLICT') {
                        conflict.current = true;
                        const current = (err.details as { currentRevision?: unknown } | null)?.currentRevision;
                        if (mounted.current) {
                            setConflictRevision(typeof current === 'number' ? current : null);
                            setState('conflict');
                        }
                    } else if (mounted.current) {
                        setErrorReason(reasonOf(err));
                        setState('error');
                    }
                    return;
                }
            }
            if (mounted.current && !conflict.current) setState(pending.current === null ? 'saved' : 'pending');
        };
        const p = loop().finally(() => {
            inFlight.current = null;
        });
        inFlight.current = p;
        return p;
    }, [textUrl]);

    /** The author paused, or is leaving: version what is unsaved, or (nothing unsaved) what was saved. */
    const checkpointNow = useCallback(
        (leaving: boolean) => {
            if (!enabled || conflict.current) return;
            if (debounce.current) clearTimeout(debounce.current);
            if (pending.current !== null) {
                checkpointDue.current = true;
                void run();
                return;
            }
            if (!savedSinceCheckpoint.current) return;
            savedSinceCheckpoint.current = false;
            if (leaving) {
                sendCheckpointOnLeave(checkpointUrl, revisionRef.current);
            } else {
                void bibleFetch(checkpointUrl, { method: 'POST', body: { revision: revisionRef.current } }).catch(() => {
                    savedSinceCheckpoint.current = true;
                });
            }
        },
        [enabled, run, checkpointUrl],
    );

    const edit = useCallback(
        (html: string) => {
            if (!enabled) return;
            pending.current = html;
            if (!conflict.current) setState('pending');
            if (debounce.current) clearTimeout(debounce.current);
            debounce.current = setTimeout(() => void run(), debounceMs);
            if (idle.current) clearTimeout(idle.current);
            idle.current = setTimeout(() => checkpointNow(false), idleMs);
        },
        [enabled, run, debounceMs, idleMs, checkpointNow],
    );

    const flush = useCallback(async () => {
        if (debounce.current) clearTimeout(debounce.current);
        await run();
    }, [run]);

    const keepMine = useCallback(() => {
        if (!conflict.current) return;
        conflict.current = false;
        if (conflictRevision !== null) revisionRef.current = conflictRevision;
        setConflictRevision(null);
        void run();
    }, [conflictRevision, run]);

    const rebase = useCallback((next: number) => {
        conflict.current = false;
        pending.current = null;
        revisionRef.current = next;
        setRevision(next);
        setConflictRevision(null);
        setState('idle');
    }, []);

    const alongside = useCallback(
        async <T extends { revision: number }>(work: (baseRevision: number) => Promise<T>): Promise<T> => {
            if (debounce.current) clearTimeout(debounce.current);
            await run();
            const result = await work(revisionRef.current);
            // The details save moved the revision; text typed meanwhile is saved on top of it.
            revisionRef.current = result.revision;
            if (mounted.current) setRevision(result.revision);
            return result;
        },
        [run],
    );

    // Leaving: the tab hidden or the page unloading checkpoints; unsaved text asks first.
    useEffect(() => {
        if (!enabled) return;
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') checkpointNow(true);
        };
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            const unsaved = pending.current !== null || conflict.current;
            checkpointNow(true);
            if (unsaved) e.preventDefault();
        };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('beforeunload', onBeforeUnload);
        };
    }, [enabled, checkpointNow]);

    // Leaving the scene in the app: send what is unsaved as a checkpoint, or a bare checkpoint.
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            if (debounce.current) clearTimeout(debounce.current);
            if (idle.current) clearTimeout(idle.current);
            checkpointNow(true);
        };
    }, [checkpointNow]);

    return { state, errorReason, conflictRevision, revision, edit, flush, keepMine, rebase, alongside };
}
