'use client';

/**
 * A scene's prose notes for the editor's margin (Phase 5.2, D34): the stored
 * check, read through `GET …/prose-checks`, and the author's acts on it.
 *
 *   on open        the check is read; a scene NEVER CHECKED, or checked under an
 *                  older style sheet or rules, is asked to be checked (an editor
 *                  only), and read again until it is
 *   after a save   the worker checks the text a few seconds after the author
 *                  stops (D34 item 1): the hook waits that long and reads again,
 *                  while the check is still of an older text, a bounded number
 *                  of times; nothing here ever blocks typing
 *   each answer    hands the editor a new `token`, and the editor places each
 *                  note only where its own text still reads what was checked
 *   dismiss        one note (it stays dismissed while its sentence is unchanged),
 *                  removed at once and recorded on the server
 *   rule off       the rule turned off for the book (the settings replaced whole)
 *
 * The hook never applies an edit: accepting a suggestion is the editor's own
 * edit, saved by its autosave like a keystroke.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { bibleFetch } from '@/lib/bible/api-client';
import { MANUSCRIPT_API } from '@/lib/manuscript/api-client';
import { PROSE_CHECK_DEBOUNCE_MS, type ProseCheckSettingsView, type ProseRuleId, type SceneProseChecksView } from '@/lib/prose-checks/vocabulary';

/** How long after a save the first read waits: the debounce, then a moment for the worker. */
export const FIRST_READ_AFTER_SAVE_MS = PROSE_CHECK_DEBOUNCE_MS + 1_500;
/** Reads while the check is still of an older text, at most, each `REREAD_MS` apart. */
export const REREADS_MAX = 8;
export const REREAD_MS = 2_500;

export type ScheduleState = 'SCHEDULED' | 'UNAVAILABLE' | 'OFF' | null;

export interface UseProseNotesOptions {
    workspaceSlug: string;
    bookId: string;
    sceneId: string;
    canEdit: boolean;
    /** The scene's revision as the autosave knows it: a change means a save landed. */
    revision: number;
    /** Test seam: the waits (ms). */
    firstReadMs?: number;
    rereadMs?: number;
}

export interface ProseNotes {
    view: SceneProseChecksView | null;
    /** Moves whenever there are findings to (re)place. */
    token: number;
    loadError: boolean;
    scheduled: ScheduleState;
    refresh: () => Promise<void>;
    checkNow: () => Promise<void>;
    dismiss: (findingId: string) => Promise<boolean>;
    turnRuleOff: (ruleId: ProseRuleId) => Promise<boolean>;
    /** Forget a note the editor applied (its text changed; the next check decides). */
    forget: (findingId: string) => void;
}

export function useProseNotes(opts: UseProseNotesOptions): ProseNotes {
    const { workspaceSlug, bookId, sceneId, canEdit, revision } = opts;
    const firstReadMs = opts.firstReadMs ?? FIRST_READ_AFTER_SAVE_MS;
    const rereadMs = opts.rereadMs ?? REREAD_MS;
    const [view, setView] = useState<SceneProseChecksView | null>(null);
    const [token, setToken] = useState(0);
    const [loadError, setLoadError] = useState(false);
    const [scheduled, setScheduled] = useState<ScheduleState>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rereads = useRef(0);
    const asked = useRef(false);
    const live = useRef(true);
    const checkNowRef = useRef<(() => Promise<void>) | null>(null);

    const read = useCallback(async (): Promise<SceneProseChecksView | null> => {
        try {
            const v = await bibleFetch<SceneProseChecksView>(MANUSCRIPT_API.proseChecks(workspaceSlug, bookId, sceneId));
            if (!live.current) return null;
            setLoadError(false);
            setView(v);
            if (v.status === 'CHECKED' || v.status === 'OUTDATED') setToken((t) => t + 1);
            return v;
        } catch {
            if (live.current) setLoadError(true);
            return null;
        }
    }, [workspaceSlug, bookId, sceneId]);

    const clearTimer = () => {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
    };

    /** Read after `ms`; read again while the check is behind the text, at most `REREADS_MAX` times. */
    const readSoon = useCallback(
        (ms: number) => {
            clearTimer();
            let wait = ms;
            const tick = () => {
                timer.current = null;
                void read().then((v) => {
                    if (!v || !live.current) return;
                    const behind = v.status === 'PENDING' || v.status === 'NOT_CHECKED' || v.status === 'OUTDATED';
                    if (behind && rereads.current < REREADS_MAX) {
                        rereads.current++;
                        wait = rereadMs;
                        timer.current = setTimeout(tick, wait);
                    } else if (behind && canEdit && !asked.current) {
                        // Still behind after every reread (its check was never queued): ask for one, once.
                        asked.current = true;
                        void checkNowRef.current?.();
                    }
                });
            };
            timer.current = setTimeout(tick, wait);
        },
        [read, rereadMs, canEdit],
    );

    const checkNow = useCallback(async () => {
        try {
            const r = await bibleFetch<{ scheduled: Exclude<ScheduleState, null> }>(MANUSCRIPT_API.proseChecks(workspaceSlug, bookId, sceneId), { method: 'POST' });
            if (!live.current) return;
            setScheduled(r.scheduled);
            if (r.scheduled === 'SCHEDULED') {
                rereads.current = 0;
                readSoon(rereadMs);
            }
        } catch {
            if (live.current) setScheduled('UNAVAILABLE');
        }
    }, [workspaceSlug, bookId, sceneId, readSoon, rereadMs]);

    useEffect(() => {
        checkNowRef.current = checkNow;
    }, [checkNow]);

    // Open: read (after a tick, never inside the effect's own turn), and ask for a check of a scene never checked or out of date.
    useEffect(() => {
        live.current = true;
        const opening = setTimeout(() => {
            void read().then((v) => {
                if (!v || !live.current) return;
                // A check of an older text is on its way (a save just before the page opened): read again until it lands.
                if (v.status === 'PENDING') {
                    rereads.current = 0;
                    readSoon(rereadMs);
                    return;
                }
                if (!canEdit || asked.current) return;
                if (v.status === 'NOT_CHECKED' || v.status === 'OUTDATED') {
                    asked.current = true;
                    void checkNow();
                }
            });
        }, 0);
        return () => {
            clearTimeout(opening);
            live.current = false;
            clearTimer();
        };
    }, [read, canEdit, checkNow, readSoon, rereadMs]);

    // A save landed: the worker checks it after the debounce.
    const lastRevision = useRef(revision);
    useEffect(() => {
        if (revision === lastRevision.current) return;
        lastRevision.current = revision;
        rereads.current = 0;
        readSoon(firstReadMs);
    }, [revision, readSoon, firstReadMs]);

    const dismiss = useCallback(
        async (findingId: string) => {
            // The page takes the note off the editor itself (`removeNote`): its place there has moved with the text.
            setView((v) => (v ? { ...v, findings: v.findings.filter((f) => f.id !== findingId), dismissed: v.dismissed + 1 } : v));
            try {
                await bibleFetch(MANUSCRIPT_API.proseDismissals(workspaceSlug, bookId), { method: 'POST', body: { findingId } });
                return true;
            } catch {
                void read();
                return false;
            }
        },
        [workspaceSlug, bookId, read],
    );

    const turnRuleOff = useCallback(
        async (ruleId: ProseRuleId) => {
            try {
                const current = await bibleFetch<ProseCheckSettingsView>(MANUSCRIPT_API.proseSettings(workspaceSlug, bookId));
                await bibleFetch(MANUSCRIPT_API.proseSettings(workspaceSlug, bookId), {
                    method: 'PUT',
                    body: { alexEnabled: current.alexEnabled, rulesOff: [...new Set([...current.rulesOff, ruleId])] },
                });
                await read();
                return true;
            } catch {
                return false;
            }
        },
        [workspaceSlug, bookId, read],
    );

    const forget = useCallback((findingId: string) => {
        setView((v) => (v ? { ...v, findings: v.findings.filter((f) => f.id !== findingId) } : v));
    }, []);

    return { view, token, loadError, scheduled, refresh: async () => void (await read()), checkNow, dismiss, turnRuleOff, forget };
}
