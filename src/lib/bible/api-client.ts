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
import type { BookListView, BookView, DeletedBookView } from '@/app-layer/usecases/books';
import type { BoardKindView, ElementListItemView, ElementPageView, ElementSummaryView, ElementView, FieldsSaveResult } from '@/app-layer/usecases/bible-elements';
import type { CreatedRelationView, RelationView } from '@/app-layer/usecases/bible-relations';
import type { OrderMoveResult } from '@/app-layer/usecases/bible-order';
import type { RestoreResult, VersionMetaView, VersionView } from '@/app-layer/usecases/bible-versions';
import type { BundleImportReport, ConceptNoteReport, ImportProblem } from '@/app-layer/usecases/bible-import';

export type {
    BookListView,
    BookView,
    DeletedBookView,
    BoardKindView,
    ElementPageView,
    ElementListItemView,
    ElementSummaryView,
    ElementView,
    FieldsSaveResult,
    CreatedRelationView,
    RelationView,
    OrderMoveResult,
    RestoreResult,
    VersionMetaView,
    VersionView,
    BundleImportReport,
    ConceptNoteReport,
    ImportProblem,
};

const enc = encodeURIComponent;

export const BIBLE_API = {
    books: (slug: string) => `/api/w/${enc(slug)}/books`,
    book: (slug: string, bookId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}`,
    /** The element list; with a query, one page of it (`kind` or `kinds`, `q`, `after`, `take`). */
    elements: (slug: string, bookId: string, query: { kind?: string; kinds?: readonly string[]; q?: string; after?: string; take?: number } = {}) => {
        const params = new URLSearchParams();
        if (query.kind) params.set('kind', query.kind);
        if (query.kinds && query.kinds.length > 0) params.set('kinds', query.kinds.join(','));
        if (query.q) params.set('q', query.q);
        if (query.after) params.set('after', query.after);
        if (query.take !== undefined) params.set('take', String(query.take));
        const qs = params.toString();
        return `/api/w/${enc(slug)}/books/${enc(bookId)}/elements${qs ? `?${qs}` : ''}`;
    },
    element: (slug: string, bookId: string, elementId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/elements/${enc(elementId)}`,
    fields: (slug: string, bookId: string, elementId: string) => `${BIBLE_API.element(slug, bookId, elementId)}/fields`,
    /** Move a plot beat or a timeline event in its story order (Phase 3.2). */
    order: (slug: string, bookId: string, elementId: string) => `${BIBLE_API.element(slug, bookId, elementId)}/order`,
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
    /** Phase 3.3 (D24): a relation's fields, a versioned save. */
    relationFields: (slug: string, bookId: string, relationId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/relations/${enc(relationId)}/fields`,
    exportBundle: (slug: string, bookId: string) => `${BIBLE_API.book(slug, bookId)}/export/bundle`,
    exportPdf: (slug: string, bookId: string) => `${BIBLE_API.book(slug, bookId)}/export/pdf`,
    importBundle: (slug: string, bookId: string, options: { applyBookDetails?: boolean } = {}) =>
        `${BIBLE_API.book(slug, bookId)}/import/bundle${options.applyBookDetails ? '?bookDetails=apply' : ''}`,
    importConceptNote: (slug: string, bookId: string) => `${BIBLE_API.book(slug, bookId)}/import/concept-note`,
    /** Word search (Phase 3.4): POST `{ q }`, never a query string (the query is author text). */
    search: (slug: string, bookId: string) => `${BIBLE_API.book(slug, bookId)}/search`,
    deletedBooks: (slug: string) => `/api/w/${enc(slug)}/deleted-books`,
    restoreBook: (slug: string, bookId: string) => `/api/w/${enc(slug)}/deleted-books/${enc(bookId)}/restore`,
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
export async function bibleFetch<T>(url: string, init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const res = await fetch(url, {
        signal: init.signal,
        method: init.method ?? 'GET',
        headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
    });
    return answerOf<T>(res);
}

/** A file POSTed as the request body itself (the bundle import, Phase 1.3); throws `BibleApiError` on a non-2xx answer. */
export async function bibleUpload<T>(url: string, file: Blob, contentType: string): Promise<T> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: file,
        credentials: 'same-origin',
        cache: 'no-store',
    });
    return answerOf<T>(res);
}

/**
 * A file the API answers with (an export, Phase 1.3), saved by the browser
 * only when the answer is the file (Phase 1.H, #27): a refusal throws
 * `BibleApiError` with its reason for the page to show, rather than the JSON
 * error being saved as the "export". Answers the file name it saved.
 */
export async function bibleDownload(url: string, fallbackName: string): Promise<string> {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) await refusalOf(res);
    const blob = await res.blob();
    const name = fileNameOf(res.headers.get('content-disposition')) ?? fallbackName;
    const href = URL.createObjectURL(blob);
    try {
        const a = document.createElement('a');
        a.href = href;
        a.download = name;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
    } finally {
        // After the click has handed the blob to the download.
        setTimeout(() => URL.revokeObjectURL(href), 0);
    }
    return name;
}

/** The file name a Content-Disposition header gives (RFC 6266: `filename*` first), or null. */
export function fileNameOf(header: string | null): string | null {
    if (!header) return null;
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (star) {
        try {
            return decodeURIComponent(star[1].trim());
        } catch {
            // fall back to the plain parameter
        }
    }
    const plain = /filename\s*=\s*"([^"]*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
    return plain ? plain[1].trim() || null : null;
}

async function refusalOf(res: Response): Promise<never> {
    let details: unknown = null;
    try {
        const json = (await res.json()) as { error?: { details?: unknown } };
        details = json?.error?.details ?? null;
    } catch {
        // Not JSON: the status is all there is.
    }
    const reason =
        details && typeof details === 'object' && typeof (details as { reason?: unknown }).reason === 'string' ? (details as { reason: string }).reason : null;
    throw new BibleApiError(res.status, reason, details);
}

export async function answerOf<T>(res: Response): Promise<T> {
    if (!res.ok) await refusalOf(res);
    return (await res.json()) as T;
}
