/**
 * Fixtures for the bible UI's rendered tests (Phase 1.2): an element view as
 * the 1.1 API answers it, built from the REAL template registry (so a
 * template change reaches the tests), version snapshots, and a `fetch` mock
 * that answers by method and path and records every request.
 */
import type { BoardKindView, ElementListItemView, ElementView, VersionMetaView, VersionView } from '@/lib/bible/api-client';
import type { FieldValue } from '@/lib/bible/field-values';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { fieldDefsFor, kindSummaries, relationOptionsFor } from '@/lib/bible/ui-model';
import type { ElementPageProps } from '@/components/bible/ElementPage';

export const SLUG = 'ada';
export const BOOK = { id: 'book_1', title: 'The Salt Roads' };

export const KIND_LABELS = Object.fromEntries(kindSummaries().map((k) => [k.kind, k.label])) as Record<BibleKind, string>;

export function elementView(over: Partial<Omit<ElementView, 'fields'>> & { values?: Record<string, FieldValue> } = {}): ElementView {
    const kind = over.kind ?? 'CHARACTER';
    const values = over.values ?? {};
    return {
        id: 'el_1',
        bookId: BOOK.id,
        kind,
        name: 'Mara',
        slug: 'mara',
        status: 'DRAFT',
        customLabel: null,
        summary: null,
        orderRank: null,
        updatedAt: '2026-11-19T10:00:00.000Z',
        relations: [],
        relationsTruncated: false,
        versionNumber: 3,
        ...over,
        fields: fieldDefsFor(kind).map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, order: f.order, value: values[f.key] ?? null })),
    };
}

export function versionMeta(n: number, over: Partial<VersionMetaView> = {}): VersionMetaView {
    return {
        versionNumber: n,
        changeSummary: null,
        source: 'MANUAL',
        restoredFromVersion: null,
        movedInOrder: false,
        authorId: 'user_1',
        createdAt: `2026-11-1${n}T10:00:00.000Z`,
        ...over,
    };
}

export function versionView(n: number, values: Record<string, FieldValue>, over: { name?: string; status?: 'DRAFT' | 'IN_PROGRESS' | 'SETTLED' } = {}): VersionView {
    const defs = fieldDefsFor('CHARACTER');
    return {
        ...versionMeta(n),
        snapshot: {
            format: 1,
            element: { kind: 'CHARACTER', name: over.name ?? 'Mara', slug: 'mara', status: over.status ?? 'DRAFT', summary: null, customLabel: null },
            fields: defs.filter((d) => d.key in values).map((d) => ({ key: d.key, order: d.order, value: values[d.key] })),
        },
    };
}

export function pageProps(over: Partial<ElementPageProps> = {}): ElementPageProps {
    const element = over.element ?? elementView();
    return {
        workspaceSlug: SLUG,
        book: BOOK,
        element,
        fieldDefs: fieldDefsFor(element.kind),
        kindLabels: KIND_LABELS,
        relationOptions: relationOptionsFor(element.kind),
        initialVersions: [versionMeta(3), versionMeta(2), versionMeta(1)],
        versionPageSize: 50,
        canEdit: true,
        ...over,
    };
}

/** The book's elements, as the element list's search answers them (the relation picker's server search, Phase 1.H). */
export const BOOK_ELEMENTS: ReadonlyArray<{ id: string; name: string; kind: BibleKind }> = [
    { id: 'el_1', name: 'Mara', kind: 'CHARACTER' },
    { id: 'el_guild', name: 'The Tidewardens', kind: 'FACTION' },
    { id: 'el_jon', name: 'Jon', kind: 'CHARACTER' },
    { id: 'el_harbour', name: 'The Harbour', kind: 'SETTING' },
];

/**
 * A route answering the element list's search like the server: the elements
 * of the asked kinds whose name contains `q`, by name. Match it with
 * `mockFetch`'s prefix routes (`GET ${API}/elements?`).
 */
export function searchAnswer(url: string): { json: unknown } {
    const sp = new URL(url, 'http://x').searchParams;
    const kinds = sp.get('kinds')?.split(',') ?? null;
    const q = (sp.get('q') ?? '').toLowerCase();
    const take = Number(sp.get('take') ?? 100);
    const elements = BOOK_ELEMENTS.filter((e) => (!kinds || kinds.includes(e.kind)) && e.name.toLowerCase().includes(q))
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .slice(0, take)
        .map((e) => ({ ...e, bookId: BOOK.id, slug: e.id, status: 'DRAFT', customLabel: null, updatedAt: '2026-11-19T10:00:00.000Z', filledFieldCount: 0 }));
    return { json: { elements, nextCursor: null } };
}

export interface RecordedRequest {
    method: string;
    url: string;
    body: unknown;
}

type Reply = { status?: number; json: unknown };
type Answer = Reply | ((url: string) => Reply | Promise<Reply>);

/**
 * A `fetch` mock: `routes` maps `"METHOD /path"` (query string included when
 * the request has one) to an answer; a key ending in `?` matches every query
 * string on that path. Anything unrouted is a 404. Returns the mock and the
 * requests it saw, in order.
 */
export function mockFetch(routes: Record<string, Answer>) {
    const requests: RecordedRequest[] = [];
    const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        requests.push({ method, url, body });
        const route = routes[`${method} ${url}`] ?? (url.includes('?') ? routes[`${method} ${url.slice(0, url.indexOf('?') + 1)}`] : undefined);
        const answer = typeof route === 'function' ? await route(url) : route;
        // jsdom has no `Response`: the client reads only `ok`, `status` and `json()`.
        const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
        if (!answer) return reply(404, { error: { code: 'NOT_FOUND', message: 'unrouted' } });
        return reply(answer.status ?? 200, answer.json);
    });
    global.fetch = fn as unknown as typeof fetch;
    return { fn, requests };
}

export const API = `/api/w/${SLUG}/books/${BOOK.id}`;

/**
 * The board the server answers for these entries (Phase 1.H): per kind, the
 * aggregate count and filled fields and the entries. `over` sets a kind's
 * figures where a test needs the aggregate to exceed the page it shows.
 */
export function boardOf(entries: readonly ElementListItemView[], over: Partial<Record<BibleKind, Partial<BoardKindView>>> = {}): BoardKindView[] {
    return BIBLE_KINDS.map((kind) => {
        const of = entries.filter((e) => e.kind === kind);
        return { kind, entryCount: of.length, filledFieldCount: of.reduce((n, e) => n + e.filledFieldCount, 0), entries: of, nextCursor: null, ...over[kind] };
    });
}
