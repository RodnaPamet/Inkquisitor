/**
 * The story canvas's save — one PUT, under the version lock.
 *
 * Carved from inflect-compliance's `src/lib/processes/tldraw-save.ts`
 * (docs/carve-manifest.md). The rows come from the editor through
 * `serializeEditorCanvas`, INJECTED as a value so the concurrency logic is
 * testable without mounting anything.
 *
 * ═══ THE THROW IS THE CONTRACT ═══
 *
 * A failed save MUST reject: a save that swallowed its failure would put the
 * autosave in its saved branch, and "Saved" would show over unsaved work. A
 * 409 `VERSION_CONFLICT` rejects too (`MapConflictError`), after telling the
 * host the version the map is at, so the autosave stops in `error` rather
 * than retrying a write that can only be refused again; the host shows the
 * conflict notice, and nothing is sent until the author reloads or chooses
 * to save over the newer version.
 *
 * The freeform layer is always sent: `[]` erases it.
 */
import type { EditorCanvas } from '@/components/canvas/tldraw/editor-canvas';
import { BibleApiError, bibleFetch } from '@/lib/bible/api-client';
import { MAP_API, type MapSaveBody, type StoryMapSaveResult } from './api-client';

/** A save refused because the map moved on since it was read (HTTP 409 VERSION_CONFLICT). */
export class MapConflictError extends Error {
    constructor(readonly currentVersion: number | null) {
        super('map version conflict');
        this.name = 'MapConflictError';
    }
}

export interface SaveMapCanvasInput {
    workspaceSlug: string;
    bookId: string;
    kind: string;
    expectedVersion: number;
    canvas: EditorCanvas;
    /** The map moved on (`version`: someone saved; `gone`: the bible deleted something on it); called before the throw. */
    onConflict: (currentVersion: number | null, cause: 'version' | 'gone') => void;
    onSaved: (result: StoryMapSaveResult) => void;
    /** Seam for tests. */
    fetchJson?: typeof bibleFetch;
}

export async function saveMapCanvas({
    workspaceSlug,
    bookId,
    kind,
    expectedVersion,
    canvas,
    onConflict,
    onSaved,
    fetchJson = bibleFetch,
}: SaveMapCanvasInput): Promise<StoryMapSaveResult> {
    const body: MapSaveBody = { expectedVersion, nodes: canvas.rows.nodes, edges: canvas.rows.edges, freeform: canvas.freeform };
    try {
        const result = await fetchJson<StoryMapSaveResult>(MAP_API.map(workspaceSlug, bookId, kind), { method: 'PUT', body });
        onSaved(result);
        return result;
    } catch (err) {
        if (err instanceof BibleApiError && err.status === 409 && (err.reason === 'VERSION_CONFLICT' || err.reason === 'MAP_REFERENCE_GONE')) {
            const details = err.details as { currentVersion?: unknown } | null;
            const currentVersion = typeof details?.currentVersion === 'number' ? details.currentVersion : null;
            onConflict(currentVersion, err.reason === 'VERSION_CONFLICT' ? 'version' : 'gone');
            throw new MapConflictError(currentVersion);
        }
        throw err;
    }
}
