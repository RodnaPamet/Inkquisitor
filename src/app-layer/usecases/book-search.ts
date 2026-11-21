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
 * the notes of its relations (a note belongs to both of its ends) and, since
 * Phase 3.3 (D24), its relations' fields, from both ends too; and the
 * book itself: its title and logline. Interview answers and research are
 * not searched yet (the 3.4 note lists them as later candidates). An element
 * belongs to one book, so a term from another book, or another workspace,
 * can never match; a deleted book is not found (`requireBook`), and a deleted
 * element has no rows left to read.
 *
 * BOUNDS (`src/lib/search/vocabulary.ts`). At most `SEARCH_ELEMENTS_MAX`
 * elements, by name, and `SEARCH_RELATIONS_MAX` relations are read; every
 * encrypted text — summaries, fields, relation notes and relation fields
 * (Phase 3.H) — is read and decrypted `SEARCH_FIELD_READ_CHUNK` elements and
 * at most `SEARCH_FIELD_READ_BYTES` stored bytes at a time (sized from the
 * values' lengths before any is read; a relation's text is read once, with
 * the first of its ends), and
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
import { BibleElementRepository, BibleFieldRepository, BibleRelationFieldRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { BookSearchRequest } from '@/app-layer/schemas/search';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ValidationError } from '@/lib/errors/types';
import { decodeFieldValue } from '@/lib/bible/field-values';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { RELATION_FIELDS_MAX } from '@/lib/bible/template-schema';
import { getFieldDef, getRelationFieldDef, getTemplate } from '@/lib/bible/templates';
import { createAnalyzer, SEARCH_ANALYZER_VERSION, type Analyzer, type SearchLanguage } from '@/lib/search/analyse';
import { fieldValuePlainText, HtmlTextReader, tidyPlainText } from '@/lib/search/plain-text';
import { parseQuery } from '@/lib/search/query';
import { rankDocuments, type SearchDocument, type SearchSource, type SearchWork } from '@/lib/search/rank';
import {
    SEARCH_ELEMENTS_MAX,
    SEARCH_FIELD_READ_BYTES,
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

/** A relation's note or one of its fields, sized and not yet read: what an end's search document will carry. */
interface RelationRef {
    ref: string;
    kind: 'relationNote' | 'relationField';
    relationId: string;
    key: string | null;
    bytes: number;
    fromElementId: string;
    toElementId: string;
    type: string | null;
    fromKind: BibleKind | null;
}

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
    /** Stored field bytes read per query (a chunk ends before the element that would pass it). */
    fieldChunkBytes: number;
    textChars: number;
}

export const SEARCH_READ_LIMITS: SearchReadLimits = {
    elements: SEARCH_ELEMENTS_MAX,
    relations: SEARCH_RELATIONS_MAX,
    fieldChunk: SEARCH_FIELD_READ_CHUNK,
    fieldChunkBytes: SEARCH_FIELD_READ_BYTES,
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

    // What is ENCRYPTED and long — summaries, relation notes, relation fields and fields — is sized first (stored
    // bytes, nothing decrypted) and decrypted a chunk at a time with the fields (Phase 3.H, issue #48 item 1): read
    // whole up front, 2,001 summaries and 10,001 notes alone could be some 30 million characters, past the budget.
    const relationRefs: RelationRef[] = [];
    const notes = await BibleRelationRepository.noteBytesForBook(db, ctx.workspaceId, book.id, limits.relations + 1);
    if (notes.length > limits.relations) cut ??= 'RELATIONS_CAP';
    for (const n of notes.slice(0, limits.relations)) {
        if (names.has(n.fromElementId) || names.has(n.toElementId)) relationRefs.push({ ref: `note:${n.id}`, kind: 'relationNote', relationId: n.id, key: null, bytes: n.bytes, fromElementId: n.fromElementId, toElementId: n.toElementId, type: null, fromKind: null });
    }
    // Phase 3.3: the relations' fields (D24), read like the notes — from both ends, the relation cap applying to them too.
    const fieldCap = limits.relations * RELATION_FIELDS_MAX;
    const relationFields = await BibleRelationFieldRepository.bytesForBookSearch(db, ctx.workspaceId, book.id, fieldCap + 1);
    if (relationFields.length > fieldCap) cut ??= 'RELATIONS_CAP';
    for (const f of relationFields.slice(0, fieldCap)) {
        if (names.has(f.fromElementId) || names.has(f.toElementId)) {
            relationRefs.push({ ref: `field:${f.relationId}:${f.key}`, kind: 'relationField', relationId: f.relationId, key: f.key, bytes: f.bytes, fromElementId: f.fromElementId, toElementId: f.toElementId, type: f.type, fromKind: f.fromKind as BibleKind });
        }
    }
    const refsOf = new Map<string, RelationRef[]>();
    for (const r of relationRefs) {
        for (const end of new Set([r.fromElementId, r.toElementId])) if (names.has(end)) refsOf.set(end, [...(refsOf.get(end) ?? []), r]);
    }
    const ids = elements.map((e) => e.id);
    const fieldBytes = await BibleFieldRepository.storedBytesForSearch(db, ctx.workspaceId, ids, NON_TEXT_FIELD_KEYS);
    const summaryBytes = await BibleElementRepository.summaryBytesForSearch(db, ctx.workspaceId, ids);

    const html = new HtmlTextReader();
    // A relation's text once read (it belongs to both of its ends), by ref.
    const relationText = new Map<string, string>();
    // Each chunk is at most `fieldChunk` elements AND `fieldChunkBytes` stored bytes (one element alone may pass
    // it): its summaries, fields and the relation notes and fields not read yet, all sized before any is read. A
    // chunk is decrypted whole before the text budget can stop the read, so the bytes bound is what bounds the
    // memory one search holds.
    let searched = 0;
    for (let i = 0; i < elements.length && budget > 0; ) {
        const start = i;
        let bytes = 0;
        const scheduled = new Set<string>();
        while (i < elements.length && (i === start || i - start < limits.fieldChunk)) {
            const id = elements[i].id;
            const pending = (refsOf.get(id) ?? []).filter((r) => !relationText.has(r.ref) && !scheduled.has(r.ref));
            const b = (fieldBytes.get(id) ?? 0) + (summaryBytes.get(id) ?? 0) + pending.reduce((n, r) => n + r.bytes, 0);
            if (i > start && bytes + b > limits.fieldChunkBytes) break;
            bytes += b;
            for (const r of pending) scheduled.add(r.ref);
            i++;
        }
        const chunk = elements.slice(start, i);
        const chunkIds = chunk.map((e) => e.id);
        const withFields = chunkIds.filter((id) => (fieldBytes.get(id) ?? 0) > 0);
        const fields = withFields.length === 0 ? [] : await BibleFieldRepository.listForSearch(db, ctx.workspaceId, withFields, SEARCH_FIELDS_PER_ELEMENT, NON_TEXT_FIELD_KEYS);
        const fieldsOf = new Map<string, Array<(typeof fields)[number]>>();
        for (const f of fields) {
            const list = fieldsOf.get(f.elementId);
            if (list) list.push(f);
            else fieldsOf.set(f.elementId, [f]);
        }
        const summaries = new Map(
            (await BibleElementRepository.summariesForSearch(db, ctx.workspaceId, book.id, chunkIds.filter((id) => summaryBytes.has(id)))).map((r) => [r.id, r.summary] as const),
        );
        const due = relationRefs.filter((r) => scheduled.has(r.ref));
        for (const n of await BibleRelationRepository.notesByIds(db, ctx.workspaceId, book.id, due.filter((r) => r.kind === 'relationNote').map((r) => r.relationId))) {
            relationText.set(`note:${n.id}`, n.note ? tidyPlainText(n.note) : '');
        }
        const dueFields = due.filter((r) => r.kind === 'relationField');
        const fieldRefs = new Map(dueFields.map((r) => [r.ref, r] as const));
        for (const f of await BibleRelationFieldRepository.valuesForSearch(db, ctx.workspaceId, [...new Set(dueFields.map((r) => r.relationId))], RELATION_FIELDS_MAX)) {
            const r = fieldRefs.get(`field:${f.relationId}:${f.key}`);
            if (!r) continue;
            const def = getRelationFieldDef(r.fromKind!, r.type!, f.key);
            const value = decodeFieldValue(f.value);
            relationText.set(r.ref, def ? fieldValuePlainText(def, value, html) : tidyPlainText(typeof value === 'string' ? value : ''));
        }
        for (const e of chunk) {
            if (budget <= 0) break;
            const kind = e.kind as BibleKind;
            const sources: SearchSource[] = [{ kind: 'name', text: take(tidyPlainText(e.name)) }];
            if (e.customLabel) sources.push({ kind: 'label', text: take(tidyPlainText(e.customLabel)) });
            const summary = summaries.get(e.id);
            if (summary) sources.push({ kind: 'summary', text: take(tidyPlainText(summary)) });
            for (const f of fieldsOf.get(e.id) ?? []) {
                const def = getFieldDef(kind, f.key);
                const value = decodeFieldValue(f.value);
                const text = def ? fieldValuePlainText(def, value, html) : tidyPlainText(Array.isArray(value) ? value.join('\n') : String(value));
                if (text !== '') sources.push({ kind: 'field', text: take(text), fieldKey: f.key, fieldLabel: def?.label ?? null });
            }
            // Its relations' notes, then their fields (both ends hold them), in the order they were sized.
            const refs = refsOf.get(e.id) ?? [];
            for (const r of [...refs.filter((x) => x.kind === 'relationNote'), ...refs.filter((x) => x.kind === 'relationField')]) {
                const text = relationText.get(r.ref) ?? '';
                if (text === '') continue;
                const other = r.fromElementId === e.id ? r.toElementId : r.fromElementId;
                const otherElementName = names.get(other) ?? null;
                if (r.kind === 'relationNote') sources.push({ kind: 'relationNote', text: take(text), otherElementName });
                else sources.push({ kind: 'relationField', text: take(text), fieldKey: r.key, fieldLabel: getRelationFieldDef(r.fromKind!, r.type!, r.key!)?.label ?? null, otherElementName });
            }
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
