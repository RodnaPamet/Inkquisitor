/**
 * The browser's side of the story canvas API (Phase 3.1): the URL table for
 * `/api/w/<slug>/books/<bookId>/maps/<kind>/**` and the views, imported as
 * TYPES only from the usecases. Requests go through the bible's JSON client
 * (`bibleFetch`), so a refusal is a `BibleApiError` carrying the status and
 * `details.reason` the UI words (`canvas.errors`), never the server's English.
 *
 * Client-safe: no imports but types and the shared fetch wrapper.
 */
import type {
    MapRelationView,
    MapNodeView,
    MapRestoreResult,
    MapSnapshotMetaView,
    MapSnapshotPage,
    MapSnapshotView,
    StoryMapSaveResult,
    StoryMapView,
} from '@/app-layer/usecases/story-maps';
import type { MapEdgeRow, MapNodeRow } from './map-state';

export type { MapRelationView, MapNodeView, MapRestoreResult, MapSnapshotMetaView, MapSnapshotPage, MapSnapshotView, StoryMapSaveResult, StoryMapView };

const enc = encodeURIComponent;

export const MAP_API = {
    map: (slug: string, bookId: string, kind: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/maps/${enc(kind)}`,
    snapshots: (slug: string, bookId: string, kind: string) => `${MAP_API.map(slug, bookId, kind)}/snapshots`,
    /** A page of the history: the newest, or the one below `before` (3.H). */
    snapshotPage: (slug: string, bookId: string, kind: string, before: number | null) =>
        before === null ? MAP_API.snapshots(slug, bookId, kind) : `${MAP_API.snapshots(slug, bookId, kind)}?before=${before}`,
    snapshot: (slug: string, bookId: string, kind: string, version: number) => `${MAP_API.snapshots(slug, bookId, kind)}/${version}`,
    restore: (slug: string, bookId: string, kind: string, version: number) => `${MAP_API.snapshot(slug, bookId, kind, version)}/restore`,
} as const;

/** The save request: the map's whole state, named against the version it was read at. */
export interface MapSaveBody {
    expectedVersion: number;
    nodes: MapNodeRow[];
    edges: MapEdgeRow[];
    freeform: unknown[];
}
