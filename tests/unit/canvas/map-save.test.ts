/**
 * The canvas's save under the version lock (Phase 3.1); adapted from
 * inflect-compliance's `tldraw-save.test.ts` (docs/carve-manifest.md). The
 * fetch is injected: no network.
 */
import { BibleApiError } from '@/lib/bible/api-client';
import { MapConflictError, saveMapCanvas } from '@/lib/canvas/map-save';
import type { StoryMapSaveResult } from '@/lib/canvas/api-client';

const canvas = { rows: { nodes: [{ elementId: 'a', x: 1, y: 2, w: 3, h: 4, lane: null }], edges: [] }, freeform: [] };
const result = { saved: true, map: { version: 8 } } as unknown as StoryMapSaveResult;

it('PUTs the whole state named against the expected version, always with the freeform layer', async () => {
    const fetchJson = jest.fn().mockResolvedValue(result);
    const onSaved = jest.fn();
    await saveMapCanvas({ workspaceSlug: 'w s', bookId: 'b1', kind: 'plot', expectedVersion: 7, canvas, onConflict: jest.fn(), onSaved, fetchJson });
    expect(fetchJson).toHaveBeenCalledWith('/api/w/w%20s/books/b1/maps/plot', { method: 'PUT', body: { expectedVersion: 7, nodes: canvas.rows.nodes, edges: [], freeform: [] } });
    expect(onSaved).toHaveBeenCalledWith(result);
});

it('a 409 VERSION_CONFLICT tells the host the current version, then REJECTS (the autosave must not read it as saved)', async () => {
    const fetchJson = jest.fn().mockRejectedValue(new BibleApiError(409, 'VERSION_CONFLICT', { reason: 'VERSION_CONFLICT', currentVersion: 9 }));
    const onConflict = jest.fn();
    const onSaved = jest.fn();
    await expect(saveMapCanvas({ workspaceSlug: 'w', bookId: 'b', kind: 'plot', expectedVersion: 7, canvas, onConflict, onSaved, fetchJson })).rejects.toBeInstanceOf(MapConflictError);
    expect(onConflict).toHaveBeenCalledWith(9, 'version');
    expect(onSaved).not.toHaveBeenCalled();
});

it('a deleted element or relation (409 MAP_REFERENCE_GONE) is a conflict of its own cause', async () => {
    const fetchJson = jest.fn().mockRejectedValue(new BibleApiError(409, 'MAP_REFERENCE_GONE', { reason: 'MAP_REFERENCE_GONE' }));
    const onConflict = jest.fn();
    await expect(saveMapCanvas({ workspaceSlug: 'w', bookId: 'b', kind: 'plot', expectedVersion: 7, canvas, onConflict, onSaved: jest.fn(), fetchJson })).rejects.toBeInstanceOf(MapConflictError);
    expect(onConflict).toHaveBeenCalledWith(null, 'gone');
});

it('any other refusal rejects as itself, and is no conflict', async () => {
    const refusal = new BibleApiError(400, 'FREEFORM_REFUSED', { reason: 'FREEFORM_REFUSED' });
    const onConflict = jest.fn();
    await expect(saveMapCanvas({ workspaceSlug: 'w', bookId: 'b', kind: 'plot', expectedVersion: 7, canvas, onConflict, onSaved: jest.fn(), fetchJson: jest.fn().mockRejectedValue(refusal) })).rejects.toBe(refusal);
    expect(onConflict).not.toHaveBeenCalled();
});
