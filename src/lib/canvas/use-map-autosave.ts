'use client';

/**
 * Autosave for the story canvas: the debounced loop of `use-canvas-autosave`
 * composed with `saveMapCanvas`.
 *
 * Carved from inflect-compliance's `use-tldraw-canvas-autosave.ts`
 * (docs/carve-manifest.md), with the rename removed (a story map has no name).
 *
 * THE VERSION IS READ THROUGH A REF that a save updates the moment it lands.
 * The prop carrying the new version arrives only with the next render, and a
 * manual save that waits for an autosave already in flight and then saves
 * again would otherwise send the version the first save had just spent — a
 * 409 against nobody. After a conflict the host re-bases (`rebase`) only when
 * the author chooses to save over the newer version.
 *
 * The rows are serialised WHEN THE DEBOUNCE FIRES, not at render: the payload
 * is the canvas as it is at save time.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Editor } from 'tldraw';

import { serializeEditorCanvas } from '@/components/canvas/tldraw/editor-canvas';
import type { StoryMapSaveResult } from './api-client';
import { saveMapCanvas } from './map-save';
import { useCanvasAutosave, type CanvasAutosaveApi, type FlushResult } from './use-canvas-autosave';

export interface UseMapAutosaveOptions {
    /** `null` until tldraw's `onMount` fires. */
    editor: Editor | null;
    workspaceSlug: string;
    bookId: string;
    kind: string;
    /** The version last loaded or saved. */
    version: number;
    onConflict: (currentVersion: number | null, cause: 'version' | 'gone') => void;
    onSaved: (result: StoryMapSaveResult) => void;
    /** Told about a failed save before the autosave records it (the host words it from its reason). */
    onError?: (err: unknown) => void;
    /** Extra reason to hold off: a reader, or a conflict the author has not resolved. */
    enabled?: boolean;
    delayMs?: number;
}

export interface MapAutosaveApi extends CanvasAutosaveApi {
    /** Save now, through the autosave queue (the toolbar's Save). */
    saveNow: () => Promise<FlushResult>;
    /** Name a new base version (after a reload, or to save over a newer version on purpose). */
    rebase: (version: number) => void;
}

export function useMapAutosave({ editor, workspaceSlug, bookId, kind, version, onConflict, onSaved, onError, enabled = true, delayMs }: UseMapAutosaveOptions): MapAutosaveApi {
    const versionRef = useRef(version);
    useEffect(() => {
        versionRef.current = version;
    }, [version]);

    const save = useCallback(async () => {
        if (!editor) return;
        try {
            await saveMapCanvas({
            workspaceSlug,
            bookId,
            kind,
            expectedVersion: versionRef.current,
            canvas: serializeEditorCanvas(editor),
            onConflict,
            onSaved: (result) => {
                versionRef.current = result.map.version;
                onSaved(result);
            },
            });
        } catch (err) {
            onError?.(err);
            throw err;
        }
    }, [editor, workspaceSlug, bookId, kind, onConflict, onSaved, onError]);

    const autosave = useCanvasAutosave({ enabled: enabled && Boolean(editor), save, ...(delayMs !== undefined ? { delayMs } : {}) });
    const { flush } = autosave;
    const saveNow = useCallback(() => flush(), [flush]);
    const rebase = useCallback((next: number) => {
        versionRef.current = next;
    }, []);
    return useMemo(() => ({ ...autosave, saveNow, rebase }), [autosave, saveNow, rebase]);
}
