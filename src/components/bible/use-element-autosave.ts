'use client';

/**
 * Debounced autosave for one bible element (Phase 1.2): its own columns
 * (name, status, summary, custom label) through `PATCH …/elements/:id` and
 * its template fields through `PUT …/elements/:id/fields`. Each request the
 * API answers with a change writes ONE version (1.1's versioned save), so the
 * debounce is what keeps a burst of typing to one version.
 *
 * The parts that are easy to get wrong:
 *
 *   - ONE SAVE AT A TIME. A second request sent while the first is in flight
 *     could be applied first and then overwritten by the older one. Edits made
 *     during a save wait in `pending` and go in the next request, which the
 *     running loop sends as soon as the first returns.
 *   - AN ERROR LOSES NOTHING. The batch that failed goes back into `pending`
 *     under any edit made since (the newer value wins), the inputs keep what
 *     the author typed, and the next edit, or Retry, sends it again.
 *   - The values a save sends are read from refs at send time, never from a
 *     render's closure.
 *   - Leaving the page sends what is unsaved (unmount flush: mid-debounce, in
 *     flight, or put back after a failure) and then calls
 *     `onSavedAfterUnmount`, because a client-side navigation has already
 *     rendered the next page without it; a browser unload with unsaved
 *     changes asks first.
 *   - An edit that may not be saved (an empty name) is DISCARDED from the
 *     queue, so a keystroke typed on the way to it is never saved instead.
 *
 * Conflict handling is 1.H's (an optimistic version check): `baseVersion`
 * holds the version the last answer named, which is what that check will
 * send; nothing reads it yet.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldValue } from '@/lib/bible/field-values';
import { BIBLE_API, bibleFetch, reasonOf, type ElementView, type FieldsSaveResult } from '@/lib/bible/api-client';

export type AutosaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export type DetailKey = 'name' | 'status' | 'summary' | 'customLabel';
export type DetailValue = string | null;

export interface AutosaveError {
    /** The API's `details.reason`, or null for a network failure or an unnamed refusal. */
    reason: string | null;
    /** Field keys the API refused, when it named them (`FIELD_VALUES_REFUSED`). */
    fieldKeys: string[];
}

export interface UseElementAutosaveOptions {
    workspaceSlug: string;
    bookId: string;
    elementId: string;
    /** False for a reader, or while the element is being deleted: every setter is a no-op. */
    enabled: boolean;
    /** The element's version when the page loaded. */
    initialVersion: number;
    debounceMs?: number;
    /** Every successful answer, with the element as the API now holds it. */
    onSaved?: (element: ElementView) => void;
    /**
     * Called once the edits that were still unsaved when the page unmounted
     * have been saved. A client-side navigation renders the next page BEFORE
     * this one unmounts, so that page was read without them; the element page
     * re-reads it here (`router.refresh()`).
     */
    onSavedAfterUnmount?: () => void;
}

export interface UseElementAutosaveResult {
    state: AutosaveState;
    error: AutosaveError | null;
    setDetail: (key: DetailKey, value: DetailValue) => void;
    setField: (key: string, value: FieldValue | null) => void;
    /**
     * Drop an edit to one of the element's own columns that has not been sent
     * (the input now holds a value that may not be saved, such as an empty
     * name): the last saved value stands, never a keystroke on the way.
     */
    discardDetail: (key: DetailKey) => void;
    /** Send what is pending now; resolves true once nothing is left unsaved. */
    flush: () => Promise<boolean>;
    /** True while an edit has not been saved (pending, in flight, or refused). */
    hasUnsaved: () => boolean;
    /** The version the API last named (for 1.H's optimistic check). */
    baseVersion: () => number;
}

/** Debounce before a save: long enough that steady typing is one version. */
export const AUTOSAVE_DEBOUNCE_MS = 1000;

function refusedKeys(details: unknown): string[] {
    const fields = (details as { fields?: unknown } | null)?.fields;
    if (!Array.isArray(fields)) return [];
    return fields.flatMap((f) => (f && typeof (f as { key?: unknown }).key === 'string' ? [(f as { key: string }).key] : []));
}

export function useElementAutosave(options: UseElementAutosaveOptions): UseElementAutosaveResult {
    const { workspaceSlug, bookId, elementId, enabled, initialVersion, debounceMs = AUTOSAVE_DEBOUNCE_MS } = options;
    const [state, setState] = useState<AutosaveState>('idle');
    const [error, setError] = useState<AutosaveError | null>(null);

    const details = useRef(new Map<DetailKey, DetailValue>());
    const fields = useRef(new Map<string, FieldValue | null>());
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const inFlight = useRef<Promise<boolean> | null>(null);
    const failed = useRef(false);
    /** The state to show when nothing is left to send: 'idle' until a save has succeeded. */
    const settled = useRef<'idle' | 'saved'>('idle');
    const version = useRef(initialVersion);
    const onSavedRef = useRef(options.onSaved);
    const onSavedAfterUnmountRef = useRef(options.onSavedAfterUnmount);
    const enabledRef = useRef(enabled);
    const mounted = useRef(true);
    useEffect(() => {
        onSavedRef.current = options.onSaved;
        onSavedAfterUnmountRef.current = options.onSavedAfterUnmount;
        enabledRef.current = enabled;
    });

    const target = useRef({ workspaceSlug, bookId, elementId });
    useEffect(() => {
        target.current = { workspaceSlug, bookId, elementId };
    }, [workspaceSlug, bookId, elementId]);

    const hasPending = () => details.current.size > 0 || fields.current.size > 0;
    const report = (next: AutosaveState) => {
        if (mounted.current) setState(next);
    };

    /** Send batches until nothing is pending, or one fails. */
    const drain = useCallback(async (): Promise<boolean> => {
        while (hasPending()) {
            const { workspaceSlug: slug, bookId: book, elementId: id } = target.current;
            const detailBatch = new Map(details.current);
            const fieldBatch = new Map(fields.current);
            details.current.clear();
            fields.current.clear();
            report('saving');
            let sentDetails = false;
            try {
                if (detailBatch.size > 0) {
                    const { element } = await bibleFetch<{ element: ElementView }>(BIBLE_API.element(slug, book, id), {
                        method: 'PATCH',
                        body: Object.fromEntries(detailBatch),
                    });
                    sentDetails = true;
                    version.current = element.versionNumber;
                    onSavedRef.current?.(element);
                }
                if (fieldBatch.size > 0) {
                    const { element } = await bibleFetch<{ element: FieldsSaveResult }>(BIBLE_API.fields(slug, book, id), {
                        method: 'PUT',
                        body: { fields: [...fieldBatch].map(([key, value]) => ({ key, value })) },
                    });
                    version.current = element.versionNumber;
                    onSavedRef.current?.(element);
                }
            } catch (err) {
                // Put the unsent batch back BENEATH anything typed since: the newer value wins.
                const requeue = <K, V>(batch: Map<K, V>, into: Map<K, V>) => {
                    for (const [k, v] of batch) if (!into.has(k)) into.set(k, v);
                };
                if (!sentDetails) requeue(detailBatch, details.current);
                requeue(fieldBatch, fields.current);
                failed.current = true;
                if (mounted.current) {
                    setError({ reason: reasonOf(err), fieldKeys: refusedKeys((err as { details?: unknown }).details) });
                    setState('error');
                }
                return false;
            }
        }
        failed.current = false;
        settled.current = 'saved';
        if (mounted.current) {
            setError(null);
            setState('saved');
        }
        return true;
    }, []);

    const run = useCallback((): Promise<boolean> => {
        if (!inFlight.current) {
            inFlight.current = drain().finally(() => {
                inFlight.current = null;
            });
        }
        return inFlight.current;
    }, [drain]);

    const flush = useCallback(async (): Promise<boolean> => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        // A loop already running picks up what was queued after it started.
        let ok = await run();
        if (ok && hasPending()) ok = await run();
        return ok && !hasPending();
    }, [run]);

    const schedule = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        if (!inFlight.current) report('pending');
        timer.current = setTimeout(() => {
            timer.current = null;
            void run();
        }, debounceMs);
    }, [debounceMs, run]);

    const setDetail = useCallback(
        (key: DetailKey, value: DetailValue) => {
            if (!enabledRef.current) return;
            details.current.set(key, value);
            schedule();
        },
        [schedule],
    );

    const setField = useCallback(
        (key: string, value: FieldValue | null) => {
            if (!enabledRef.current) return;
            fields.current.set(key, value);
            schedule();
        },
        [schedule],
    );

    const discardDetail = useCallback((key: DetailKey) => {
        if (!details.current.delete(key)) return;
        // Nothing else waiting: no save is due, and the state is what it was before the edit.
        if (!hasPending() && !inFlight.current) {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            report(failed.current ? 'error' : settled.current);
        }
    }, []);

    const hasUnsaved = useCallback(() => hasPending() || inFlight.current !== null || failed.current, []);

    // Leaving the page still saves what is unsaved (mid-debounce, in flight, or
    // put back after a failure), then has the page now shown re-read; a
    // browser unload asks first.
    useEffect(() => {
        mounted.current = true;
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (hasPending() || inFlight.current) e.preventDefault();
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', onBeforeUnload);
            mounted.current = false;
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            if (hasPending() || inFlight.current) {
                void (async () => {
                    let ok = await run();
                    if (ok && hasPending()) ok = await run();
                    if (ok && !hasPending()) onSavedAfterUnmountRef.current?.();
                })();
            }
        };
    }, [run]);

    return { state, error, setDetail, setField, discardDetail, flush, hasUnsaved, baseVersion: () => version.current };
}
