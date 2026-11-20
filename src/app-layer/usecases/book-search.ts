/**
 * Word search within one book (Phase 3.4, decision D21: "option A", decrypt
 * and scan).
 *
 * THE DESIGN. Nothing new is stored: no token table, no tsvector, no blind
 * index, no cache that outlives the request. Each search reads the book's
 * bible inside the workspace's own context (`runInWorkspaceContext`, so the
 * encryption extension decrypts it and row-level security bounds it), turns
 * every source into plain text (`src/lib/search/plain-text.ts`), and ranks
 * it in memory (`src/lib/search/rank.ts`) after the transaction has closed,
 * so the connection is not held while words are counted. A blind index
 * (option B) is deferred.
 *
 * WHAT IS SEARCHED, per element: its name, custom label and summary, every
 * stored field of every template type (rich text through the HTML reader, a
 * list's items, a choice's label; a scale is a number and is not text) and
 * the notes of its relations (a note belongs to both of its ends); and the
 * book itself: its title and logline. Interview answers and research are
 * not searched yet (the 3.4 note lists them as later candidates). An element
 * belongs to one book, so a term from another book, or another workspace,
 * can never match; a deleted book is not found (`requireBook`), and a deleted
 * element has no rows left to read.
 *
 * BOUNDS (`src/lib/search/vocabulary.ts`). At most `SEARCH_ELEMENTS_MAX`
 * elements, by name, and `SEARCH_RELATIONS_MAX` relations are read; fields
 * are read and decrypted `SEARCH_FIELD_READ_CHUNK` elements at a time, and
 * reading stops once `SEARCH_TEXT_MAX_CHARS` of plain text are in hand.
 * Whichever cut the read is named in `coverage`, and `truncated` says when
 * more results matched than `SEARCH_RESULTS_MAX`.
 *
 * PRIVACY (rule 4). The query and the snippets are author text: neither is
 * logged, traced, reported or audited here, and the route takes the query in
 * a POST body so it is never part of a URL
 * (`tests/integration/privacy-sinks.test.ts` plants one). `bible.view` reads.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleFieldRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { BookSearchRequest } from '@/app-layer/schemas/search';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ValidationError } from '@/lib/errors/types';
import { decodeFieldValue } from '@/lib/bible/field-values';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { getFieldDef, getTemplate } from '@/lib/bible/templates';
import { createAnalyzer, SEARCH_ANALYZER_VERSION, type Analyzer, type SearchLanguage } from '@/lib/search/analyse';
import { fieldValuePlainText, HtmlTextReader, tidyPlainText } from '@/lib/search/plain-text';
import { parseQuery } from '@/lib/search/query';
import { rankDocuments, type SearchDocument, type SearchSource, type SearchWork } from '@/lib/search/rank';
import {
    SEARCH_ELEMENTS_MAX,
    SEARCH_FIELD_READ_CHUNK,
    SEARCH_FIELDS_PER_ELEMENT,
    SEARCH_RELATIONS_MAX,
    SEARCH_RESULTS_MAX,
    SEARCH_TEXT_MAX_CHARS,
    type BookSearchView,
    type SearchCoverageCut,
    type SearchCoverageView,
    type SearchQueryRefusal,
} from '@/lib/search/vocabulary';
import { requireBook } from './bible-common';

const REFUSAL_MESSAGES: Record<SearchQueryRefusal, string> = {
    QUERY_TOO_LONG: 'The search is too long.',
    QUERY_TOO_MANY_TERMS: 'The search has too many words.',
    QUERY_TOO_MANY_PHRASES: 'The search has too many quoted phrases.',
};

/**
 * The language a book is analysed in. `Book` carries no language yet, so
 * every book is English (decision D12); when it gains one, a book in any
 * other language matches surface forms with no stemming (`'other'`).
 */
export function searchLanguageOf(language: string | null | undefined): SearchLanguage {
    return language === undefined || language === null || language.toLowerCase().startsWith('en') ? 'en' : 'other';
}

/**
 * Field keys that hold no searchable text in ANY template that declares them
 * (scales: a number from 1 to 5). Their values are not read, so not
 * decrypted. A key that is a scale in one template and text in another is
 * read.
 */
export const NON_TEXT_FIELD_KEYS: readonly string[] = (() => {
    const types = new Map<string, Set<string>>();
    for (const kind of BIBLE_KINDS) for (const f of getTemplate(kind).fields) types.set(f.key, (types.get(f.key) ?? new Set()).add(f.type));
    return [...types].filter(([, t]) => t.size === 1 && t.has('scale')).map(([key]) => key).sort();
})();

/** The book read as search documents, with what the read covered. */
export interface BookSearchDocuments {
    documents: SearchDocument[];
    coverage: SearchCoverageView;
}

/** The read bounds (`vocabulary.ts`); a test passes smaller ones to cross them with a small book. */
export interface SearchReadLimits {
    elements: number;
    relations: number;
    fieldChunk: number;
    textChars: number;
}

export const SEARCH_READ_LIMITS: SearchReadLimits = {
    elements: SEARCH_ELEMENTS_MAX,
    relations: SEARCH_RELATIONS_MAX,
    fieldChunk: SEARCH_FIELD_READ_CHUNK,
    textChars: SEARCH_TEXT_MAX_CHARS,
};

/** Read and decrypt the book's searchable text as plain-text documents, within the bounds. */
export async function readSearchDocuments(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    book: { id: string; title: string; logline: string | null },
    limits: SearchReadLimits = SEARCH_READ_LIMITS,
): Promise<BookSearchDocuments> {
    let budget = limits.textChars;
    let cut: SearchCoverageCut | null = null;
    const take = (text: string): string => {
        budget -= text.length;
        return text;
    };

    const bookSources: SearchSource[] = [{ kind: 'title', text: take(tidyPlainText(book.title)) }];
    if (book.logline) bookSources.push({ kind: 'logline', text: take(tidyPlainText(book.logline)) });
    const documents: SearchDocument[] = [{ kind: 'book', elementId: null, elementKind: null, name: book.title, customLabel: null, sources: bookSources }];

    const counts = await BibleElementRepository.countByKind(db, ctx.workspaceId, book.id);
    const elementCount = [...counts.values()].reduce((n, c) => n + c, 0);
    const rows = await BibleElementRepository.listForSearch(db, ctx.workspaceId, book.id, limits.elements + 1);
    if (rows.length > limits.elements) cut = 'ELEMENTS_CAP';
    const elements = rows.slice(0, limits.elements);
    const names = new Map(elements.map((e) => [e.id, e.name]));

    const relations = await BibleRelationRepository.listNotesForBook(db, ctx.workspaceId, book.id, limits.relations + 1);
    if (relations.length > limits.relations) cut ??= 'RELATIONS_CAP';
    const notesOf = new Map<string, SearchSource[]>();
    for (const r of relations.slice(0, limits.relations)) {
        if (!r.note) continue;
        const text = tidyPlainText(r.note);
        if (text === '') continue;
        for (const [self, other] of [
            [r.fromElementId, r.toElementId],
            [r.toElementId, r.fromElementId],
        ] as const) {
            if (!names.has(self)) continue;
            const list = notesOf.get(self) ?? [];
            list.push({ kind: 'relationNote', text, otherElementName: names.get(other) ?? null });
            notesOf.set(self, list);
        }
    }

    const html = new HtmlTextReader();
    let searched = 0;
    for (let i = 0; i < elements.length && budget > 0; i += limits.fieldChunk) {
        const chunk = elements.slice(i, i + limits.fieldChunk);
        const fields = await BibleFieldRepository.listForSearch(db, ctx.workspaceId, chunk.map((e) => e.id), SEARCH_FIELDS_PER_ELEMENT, NON_TEXT_FIELD_KEYS);
        const fieldsOf = new Map<string, Array<(typeof fields)[number]>>();
        for (const f of fields) {
            const list = fieldsOf.get(f.elementId);
            if (list) list.push(f);
            else fieldsOf.set(f.elementId, [f]);
        }
        for (const e of chunk) {
            if (budget <= 0) break;
            const kind = e.kind as BibleKind;
            const sources: SearchSource[] = [{ kind: 'name', text: take(tidyPlainText(e.name)) }];
            if (e.customLabel) sources.push({ kind: 'label', text: take(tidyPlainText(e.customLabel)) });
            if (e.summary) sources.push({ kind: 'summary', text: take(tidyPlainText(e.summary)) });
            for (const f of fieldsOf.get(e.id) ?? []) {
                const def = getFieldDef(kind, f.key);
                const value = decodeFieldValue(f.value);
                const text = def ? fieldValuePlainText(def, value, html) : tidyPlainText(Array.isArray(value) ? value.join('\n') : String(value));
                if (text !== '') sources.push({ kind: 'field', text: take(text), fieldKey: f.key, fieldLabel: def?.label ?? null });
            }
            for (const note of notesOf.get(e.id) ?? []) sources.push({ ...note, text: take(note.text) });
            documents.push({ kind: 'element', elementId: e.id, elementKind: e.kind, name: e.name, customLabel: e.customLabel, sources });
            searched++;
        }
    }
    if (searched < elements.length) cut ??= 'TEXT_BUDGET';
    return { documents, coverage: { elements: elementCount, searchedElements: searched, complete: cut === null && searched === elementCount, cut } };
}

export interface BookSearchOptions {
    /** The analyzer to use (tests read its counted work); a fresh English one by default. */
    analyzer?: Analyzer;
    /** Told the counted work of the ranking (the performance test). */
    onWork?: (work: SearchWork) => void;
    /** Smaller read bounds (tests only; the defaults are `SEARCH_READ_LIMITS`). */
    limits?: SearchReadLimits;
}

/** Search one book for words (`bible.view`). */
export async function searchBook(ctx: WorkspaceRequestContext, bookId: string, input: unknown, options: BookSearchOptions = {}): Promise<BookSearchView> {
    await assertPermission(ctx, 'bible.view');
    const { q } = BookSearchRequest.parse(input);
    const read = await runInWorkspaceContext(ctx, async (db) => {
        const book = await requireBook(db, ctx, bookId);
        // `Book` has no language column yet: every book reads as English (D12).
        const analyzer = options.analyzer ?? createAnalyzer(searchLanguageOf(null));
        const parsed = parseQuery(q, analyzer);
        if (!parsed.ok) throw new ValidationError(REFUSAL_MESSAGES[parsed.reason], { reason: parsed.reason });
        if (parsed.query.empty) return { analyzer, query: parsed.query, documents: null };
        return { analyzer, query: parsed.query, documents: await readSearchDocuments(db, ctx, book, options.limits) };
    });
    const { analyzer, query, documents } = read;
    if (documents === null) {
        return {
            emptyQuery: true,
            hits: [],
            totalHits: 0,
            truncated: false,
            coverage: { elements: 0, searchedElements: 0, complete: false, cut: null },
            language: analyzer.language,
            analyzerVersion: SEARCH_ANALYZER_VERSION,
        };
    }
    const ranked = rankDocuments(documents.documents, query, analyzer, { limit: SEARCH_RESULTS_MAX });
    options.onWork?.(ranked.work);
    return {
        emptyQuery: false,
        hits: ranked.hits,
        totalHits: ranked.totalHits,
        truncated: ranked.truncated,
        coverage: documents.coverage,
        language: analyzer.language,
        analyzerVersion: SEARCH_ANALYZER_VERSION,
    };
}
