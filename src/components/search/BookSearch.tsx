'use client';

/**
 * Word search on the book board (Phase 3.4, decision D21): a search box and
 * its ranked results, for every viewer (`bible.view`).
 *
 * The box searches as the author types (debounced; a request in flight is
 * aborted as soon as the box changes, and by the next request, so an answer
 * never lands under newer text) and at once on Enter. The query travels in a POST body (`BIBLE_API.search`) and
 * is never put in the page's URL, so it stays out of history and every log
 * that records a URL.
 *
 * Each result links to its element (the book's own result names where on the
 * board the words are) and shows its best matched sources, each a plain-text
 * snippet whose highlighted words are `<mark>` elements built from the
 * server's ranges — React text, never `innerHTML`, and the server never sends
 * HTML. The count of results is announced politely; a truncated list or a
 * partly searched book says so; a refusal is worded from its
 * `details.reason`.
 */
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BookOpen } from 'lucide-react';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { APP_ROUTES } from '@/lib/app-routes';
import { BIBLE_API, bibleFetch, reasonOf } from '@/lib/bible/api-client';
import { SEARCH_QUERY_MAX_CHARS, SEARCH_QUERY_REFUSALS, type BookSearchView, type SearchHitView, type SearchMatchView, type SearchSnippet } from '@/lib/search/vocabulary';

/** How long typing pauses before the box searches. */
export const SEARCH_DEBOUNCE_MS = 300;

export interface BookSearchProps {
    workspaceSlug: string;
    bookId: string;
    /** Element kind → its label, for the results' kind badges. */
    kindLabels: Readonly<Record<string, string>>;
}

type State =
    | { status: 'idle' }
    | { status: 'searching'; query: string; previous: BookSearchView | null }
    | { status: 'done'; query: string; result: BookSearchView }
    | { status: 'failed'; query: string; reason: string | null };

export function BookSearch({ workspaceSlug, bookId, kindLabels }: BookSearchProps) {
    const t = useTranslations('search');
    const [query, setQuery] = useState('');
    const [state, setState] = useState<State>({ status: 'idle' });
    const controller = useRef<AbortController | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resultsId = useId();

    useEffect(
        () => () => {
            controller.current?.abort();
            if (timer.current) clearTimeout(timer.current);
        },
        [],
    );

    async function run(text: string) {
        if (timer.current) clearTimeout(timer.current);
        controller.current?.abort();
        const q = text.trim();
        if (q === '') {
            setState({ status: 'idle' });
            return;
        }
        const ac = new AbortController();
        controller.current = ac;
        setState((s) => ({ status: 'searching', query: q, previous: s.status === 'done' ? s.result : s.status === 'searching' ? s.previous : null }));
        try {
            const result = await bibleFetch<BookSearchView>(BIBLE_API.search(workspaceSlug, bookId), { method: 'POST', body: { q }, signal: ac.signal });
            if (!ac.signal.aborted) setState({ status: 'done', query: q, result });
        } catch (err) {
            if (ac.signal.aborted) return;
            setState({ status: 'failed', query: q, reason: reasonOf(err) });
        }
    }

    function onChange(value: string) {
        setQuery(value);
        // The box no longer holds the query in flight: its answer must not land under the newer text.
        controller.current?.abort();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void run(value), SEARCH_DEBOUNCE_MS);
    }

    const shown = state.status === 'done' ? state.result : state.status === 'searching' ? state.previous : null;

    return (
        <div className="space-y-default" data-testid="book-search">
            <form
                role="search"
                onSubmit={(e) => {
                    e.preventDefault();
                    void run(query);
                }}
            >
                <FormField label={t('label')} description={t('help')}>
                    <Input
                        id="book-search-input"
                        type="search"
                        value={query}
                        maxLength={SEARCH_QUERY_MAX_CHARS}
                        placeholder={t('placeholder')}
                        aria-controls={resultsId}
                        onChange={(e) => onChange(e.target.value)}
                    />
                </FormField>
            </form>
            <div id={resultsId}>
                <p className="text-sm text-content-muted" role="status" aria-live="polite" data-testid="book-search-status">
                    {statusLine(t, state)}
                </p>
                {shown && shown.hits.length > 0 ? (
                    <ul className="mt-tight divide-y divide-[var(--border-subtle)]" aria-label={t('resultsAria')} data-testid="book-search-results">
                        {shown.hits.map((hit) => (
                            <SearchHit key={hit.elementId ?? 'book'} hit={hit} workspaceSlug={workspaceSlug} bookId={bookId} kindLabels={kindLabels} />
                        ))}
                    </ul>
                ) : null}
                {shown && shown.truncated ? <p className="mt-tight text-xs text-content-muted">{t('truncated', { shown: shown.hits.length, count: shown.totalHits })}</p> : null}
                {shown && !shown.emptyQuery && !shown.coverage.complete && shown.coverage.cut !== null ? (
                    <p className="mt-tight text-xs text-content-muted" data-testid="book-search-partial">
                        {t(`partial.${shown.coverage.cut}`, { searched: shown.coverage.searchedElements, count: shown.coverage.elements })}
                    </p>
                ) : null}
            </div>
        </div>
    );
}

type T = ReturnType<typeof useTranslations>;

function statusLine(t: T, state: State): string {
    switch (state.status) {
        case 'idle':
            return '';
        case 'searching':
            return t('searching');
        case 'failed':
            return state.reason && (SEARCH_QUERY_REFUSALS as readonly string[]).includes(state.reason) ? t(`errors.${state.reason}`) : t('failed');
        case 'done': {
            const r = state.result;
            if (r.emptyQuery) return t('emptyQuery');
            if (r.totalHits === 0) return t('none');
            return r.totalHits === 1 ? t('countOne') : t('count', { count: r.totalHits });
        }
    }
}

function SearchHit({ hit, workspaceSlug, bookId, kindLabels }: { hit: SearchHitView; workspaceSlug: string; bookId: string; kindLabels: Readonly<Record<string, string>> }) {
    const t = useTranslations('search');
    const more = hit.matchedSourceCount - hit.matches.length;
    return (
        <li className="space-y-tight py-3" data-testid="book-search-hit">
            <div className="flex flex-wrap items-baseline gap-tight">
                {hit.kind === 'element' && hit.elementId ? (
                    <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, hit.elementId)} className="text-sm font-medium text-content-emphasis hover:underline">
                        {hit.name}
                    </Link>
                ) : (
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-content-emphasis">
                        <BookOpen className="size-3.5" aria-hidden="true" />
                        {t('book', { title: hit.name })}
                    </span>
                )}
                {hit.customLabel ? <span className="text-xs text-content-muted">({hit.customLabel})</span> : null}
                {hit.elementKind ? <span className="text-xs text-content-muted">{kindLabels[hit.elementKind] ?? hit.elementKind}</span> : null}
            </div>
            <ul className="space-y-1">
                {hit.matches.map((m, i) => (
                    <li key={`${m.source}-${m.fieldKey ?? ''}-${i}`} className="text-sm text-content-default">
                        <span className="mr-1 text-xs font-medium text-content-muted">{sourceLabel(t, m)}</span>
                        <HighlightedSnippet snippet={m.snippet} />
                    </li>
                ))}
            </ul>
            {more > 0 ? <p className="text-xs text-content-muted">{more === 1 ? t('moreOne') : t('more', { count: more })}</p> : null}
        </li>
    );
}

function sourceLabel(t: T, m: SearchMatchView): string {
    switch (m.source) {
        case 'field':
            return m.fieldLabel ?? t('source.field');
        case 'relationNote':
            return m.otherElementName ? t('source.relationNote', { name: m.otherElementName }) : t('source.relationNoteUnnamed');
        case 'relationField':
            return m.otherElementName ? t('source.relationField', { field: m.fieldLabel ?? t('source.field'), name: m.otherElementName }) : t('source.relationFieldUnnamed', { field: m.fieldLabel ?? t('source.field') });
        default:
            return t(`source.${m.source}`);
    }
}

/** A snippet's text with its highlighted ranges as `<mark>`: React text only. */
export function HighlightedSnippet({ snippet }: { snippet: SearchSnippet }) {
    const parts: Array<{ text: string; mark: boolean }> = [];
    let at = 0;
    for (const h of [...snippet.highlights].sort((a, b) => a.start - b.start)) {
        const start = Math.max(at, Math.min(h.start, snippet.text.length));
        const end = Math.max(start, Math.min(h.end, snippet.text.length));
        if (start > at) parts.push({ text: snippet.text.slice(at, start), mark: false });
        if (end > start) parts.push({ text: snippet.text.slice(start, end), mark: true });
        at = end;
    }
    if (at < snippet.text.length) parts.push({ text: snippet.text.slice(at), mark: false });
    return (
        <span data-testid="book-search-snippet">
            {snippet.cutBefore ? '… ' : null}
            {parts.map((p, i) =>
                p.mark ? (
                    <mark key={i} className="rounded-sm bg-[var(--brand-subtle)] px-0.5 text-content-emphasis">
                        {p.text}
                    </mark>
                ) : (
                    <span key={i}>{p.text}</span>
                ),
            )}
            {snippet.cutAfter ? ' …' : null}
        </span>
    );
}

