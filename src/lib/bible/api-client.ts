/**
 * The browser's side of the bible API (Phase 1.2): one URL table and one
 * `fetch` wrapper for the routes under `/api/w/<slug>/books/**`
 * (`src/app/api/w/[workspaceSlug]/books/`). The request and response shapes
 * are the 1.1 usecases' views, imported as TYPES only, so nothing server-side
 * reaches the client bundle.
 *
 * A non-2xx answer throws `BibleApiError`, carrying the status and the
 * `details.reason` the API names (`SLUG_TAKEN`, `RELATION_EXISTS`,
 * `FIELD_VALUES_REFUSED`, …). The UI words a refusal from its reason through
 * next-intl; it never shows the server's English message.
 *
 * Client-safe: no imports but types.
 */
import type { BookView } from '@/app-layer/usecases/books';
import type { ElementListItemView, ElementSummaryView, ElementView, FieldsSaveResult } from '@/app-layer/usecases/bible-elements';
import type { CreatedRelationView } from '@/app-layer/usecases/bible-relations';
import type { RestoreResult, VersionMetaView, VersionView } from '@/app-layer/usecases/bible-versions';

export type { BookView, ElementListItemView, ElementSummaryView, ElementView, FieldsSaveResult, CreatedRelationView, RestoreResult, VersionMetaView, VersionView };

const enc = encodeURIComponent;

export const BIBLE_API = {
    books: (slug: string) => `/api/w/${enc(slug)}/books`,
    book: (slug: string, bookId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}`,
    elements: (slug: string, bookId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/elements`,
    element: (slug: string, bookId: string, elementId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/elements/${enc(elementId)}`,
    fields: (slug: string, bookId: string, elementId: string) => `${BIBLE_API.element(slug, bookId, elementId)}/fields`,
    versions: (slug: string, bookId: string, elementId: string, query: { before?: number; take?: number } = {}) => {
        const params = new URLSearchParams();
        if (query.take !== undefined) params.set('take', String(query.take));
        if (query.before !== undefined) params.set('before', String(query.before));
        const qs = params.toString();
        return `${BIBLE_API.element(slug, bookId, elementId)}/versions${qs ? `?${qs}` : ''}`;
    },
    version: (slug: string, bookId: string, elementId: string, n: number) => `${BIBLE_API.element(slug, bookId, elementId)}/versions/${n}`,
    restore: (slug: string, bookId: string, elementId: string, n: number) => `${BIBLE_API.version(slug, bookId, elementId, n)}/restore`,
    relations: (slug: string, bookId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/relations`,
    relation: (slug: string, bookId: string, relationId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/relations/${enc(relationId)}`,
} as const;

export class BibleApiError extends Error {
    constructor(
        readonly status: number,
        readonly reason: string | null,
        readonly details: unknown,
    ) {
        super(`bible API answered ${status}${reason ? ` ${reason}` : ''}`);
        this.name = 'BibleApiError';
    }
}

/** The `details.reason` of an error, or null (a network failure has none). */
export function reasonOf(err: unknown): string | null {
    return err instanceof BibleApiError ? err.reason : null;
}

/** A JSON request to the bible API; throws `BibleApiError` on a non-2xx answer. */
export async function bibleFetch<T>(url: string, init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {}): Promise<T> {
    const res = await fetch(url, {
        method: init.method ?? 'GET',
        headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
    });
    if (!res.ok) {
        let details: unknown = null;
        try {
            const json = (await res.json()) as { error?: { details?: unknown } };
            details = json?.error?.details ?? null;
        } catch {
            // Not JSON: the status is all there is.
        }
        const reason =
            details && typeof details === 'object' && typeof (details as { reason?: unknown }).reason === 'string'
                ? (details as { reason: string }).reason
                : null;
        throw new BibleApiError(res.status, reason, details);
    }
    return (await res.json()) as T;
}
