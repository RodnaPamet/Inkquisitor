/**
 * THE RETRIEVER, AND THE FRONTIER'S SOURCE CHECK (Phase 4.0, D23; rule 5).
 *
 * ISOLATION FIRST. Everything here reads only the sources a book draws on
 * (`bookSourceSet`: its own library and the series sources it opted into),
 * inside the workspace's RLS. A vector search is asked for the workspace's
 * `SourceChunk` vectors and every hit is read back through that set, so a
 * vector of another book's source, or of a series source this book did not
 * choose, is dropped before its text is ever read.
 *
 * THE CHECK (`sourceFactsCheck`): a CONFIRMED fact answers a field when its
 * subject is a scope element — its stored link, else the one scope element the
 * book names so (`nameKey`) — and the predicate table maps its predicate to a
 * field of that element's kind. A PENDING or REJECTED fact never answers
 * anything (D23). A book's override of an inherited fact answers the same
 * field: the book's own answer wins for it.
 *
 * THE CONTEXT (`assembleSourceContext`): the scope elements' confirmed facts
 * (an override's text in place of an overridden fact's), then the most
 * relevant passages — the vector store's nearest chunks to the scope's names
 * and the 3.4 lexical ranker's best over a bounded scan of the book's chunks,
 * fused by rank — each cut to fit, under `SOURCE_CONTEXT_TOKEN_BUDGET`. It is
 * author text: the question generator gets it ONLY as fenced data blocks.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { SourceChunkRepository, StoryFactOverrideRepository, StoryFactRepository } from '@/app-layer/repositories/source.repository';
import { getVectorRepository } from '@/app-layer/repositories/vector.repository';
import { getFieldDef } from '@/lib/bible/templates';
import type { BibleKind } from '@/lib/bible/kinds';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { nameKey } from '@/lib/enrichment/validate';
import { PENDING_SUBJECT_ID } from '@/lib/interview/subjects';
import { refsCheck, type AlreadyAnsweredCheck, type FieldRef } from '@/lib/interview/frontier';
import { createAnalyzer } from '@/lib/search/analyse';
import { parseQuery } from '@/lib/search/query';
import { rankDocuments, type SearchDocument } from '@/lib/search/rank';
import { decodeHeadingPath } from '@/lib/sources/storage';
import { CHARS_PER_TOKEN, fieldAnsweredBy, SOURCE_CHUNK_MODEL } from '@/lib/sources/vocabulary';
import { bookSourceSet } from './source-common';

/** Tokens the source context may add to a generation call. */
export const SOURCE_CONTEXT_TOKEN_BUDGET = 3_000;
/** Confirmed facts read for a book at most (the check and the context). */
export const CONFIRMED_FACTS_READ_MAX = 2_000;
/** Chunks the lexical ranker scans at most; a larger library is ranked over this many and the cut is said. */
export const LEXICAL_SCAN_CHUNKS_MAX = 300;
/** Nearest chunks the vector store is asked for. */
export const VECTOR_CANDIDATES = 20;
/** A passage is shown at most this long. */
export const PASSAGE_SHOWN_MAX_CHARS = 1_600;

export interface ScopeElement {
    readonly elementId: string;
    readonly kind: BibleKind;
    readonly name: string;
}

export interface SourceContext {
    readonly facts: ReadonlyArray<{ subject: string; statement: string; from: 'BOOK' | 'SERIES' | 'OVERRIDE' }>;
    readonly passages: ReadonlyArray<{ headings: string; text: string }>;
    /** Something relevant did not fit the budget, or the scan was cut. */
    readonly truncated: boolean;
}

export const EMPTY_SOURCE_CONTEXT: SourceContext = Object.freeze({ facts: [], passages: [], truncated: false });

interface ResolvedFact {
    elementId: string;
    kind: BibleKind;
    fieldKey: string | null;
    subject: string;
    statement: string;
    from: 'BOOK' | 'SERIES' | 'OVERRIDE';
}

/** The confirmed facts of the book's sources about scope elements (the header's resolution). */
async function resolvedFacts(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elements: readonly ScopeElement[]): Promise<ResolvedFact[]> {
    const real = elements.filter((e) => e.elementId !== PENDING_SUBJECT_ID);
    if (real.length === 0) return [];
    const set = await bookSourceSet(db, ctx, bookId);
    const series = new Set(set.seriesSourceIds);
    const facts = await StoryFactRepository.listConfirmed(db, ctx.workspaceId, [...set.bookSourceIds, ...set.seriesSourceIds], CONFIRMED_FACTS_READ_MAX);
    if (facts.length === 0) return [];
    const overrides = new Map((await StoryFactOverrideRepository.listForBook(db, ctx.workspaceId, bookId, facts.filter((f) => series.has(f.sourceId)).map((f) => f.id))).map((o) => [o.factId, o.text] as const));
    const byId = new Map(real.map((e) => [e.elementId, e] as const));
    const byKey = new Map<string, ScopeElement | null>();
    for (const e of real) {
        const key = nameKey(e.name);
        byKey.set(key, byKey.has(key) ? null : e);
    }
    const out: ResolvedFact[] = [];
    for (const f of facts) {
        // A series fact's stored link is never this book's: only a book library's fact carries one.
        const element = (f.subjectElementId ? byId.get(f.subjectElementId) : undefined) ?? byKey.get(nameKey(f.subjectName)) ?? null;
        if (!element) continue;
        const key = fieldAnsweredBy(element.kind, f.predicate);
        const override = overrides.get(f.id);
        out.push({
            elementId: element.elementId,
            kind: element.kind,
            fieldKey: key && getFieldDef(element.kind, key) ? key : null,
            subject: element.name,
            statement: override ?? f.statement,
            from: override !== undefined ? 'OVERRIDE' : series.has(f.sourceId) ? 'SERIES' : 'BOOK',
        });
    }
    return out;
}

/** The fields the book's confirmed source facts answer for these elements (rule 5). */
export async function sourceFactRefs(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elements: readonly ScopeElement[]): Promise<FieldRef[]> {
    return (await resolvedFacts(db, ctx, bookId, elements)).filter((f) => f.fieldKey !== null).map((f) => ({ elementId: f.elementId, fieldKey: f.fieldKey! }));
}

/** The frontier's source check (the header), named `source-facts` in `answered[].by`. */
export async function sourceFactsCheck(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elements: readonly ScopeElement[]): Promise<AlreadyAnsweredCheck> {
    return refsCheck('source-facts', await sourceFactRefs(db, ctx, bookId, elements));
}

function fitsBudget(used: number, text: string, budgetChars: number): boolean {
    return used + text.length <= budgetChars;
}

/** The context (the header). `query` is the scope's names embedded, when an embedder could; without it the passages are lexical alone. */
export async function assembleSourceContext(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    elements: readonly ScopeElement[],
    query: { vector: readonly number[]; revision: string } | null = null,
    budgetTokens: number = SOURCE_CONTEXT_TOKEN_BUDGET,
): Promise<SourceContext> {
    const set = await bookSourceSet(db, ctx, bookId);
    const allowed = [...set.bookSourceIds, ...set.seriesSourceIds];
    if (allowed.length === 0) return EMPTY_SOURCE_CONTEXT;
    const budgetChars = budgetTokens * CHARS_PER_TOKEN;
    let used = 0;
    let truncated = false;

    const facts: Array<SourceContext['facts'][number]> = [];
    for (const f of await resolvedFacts(db, ctx, bookId, elements)) {
        const entry = { subject: f.subject, statement: f.statement, from: f.from };
        const size = f.subject.length + f.statement.length + 16;
        if (used + size > budgetChars / 2) {
            truncated = true;
            break;
        }
        used += size;
        facts.push(entry);
    }

    // Passages: the vector store's nearest, read back through the book's set, and the lexical ranker's best.
    const allowedSet = new Set(allowed);
    const ranks = new Map<string, number>();
    const fuse = (id: string, rank: number) => ranks.set(id, (ranks.get(id) ?? 0) + 1 / (60 + rank));
    if (query) {
        const hits = await getVectorRepository().search(db, ctx.workspaceId, { embeddingRevision: query.revision, embedding: query.vector, k: VECTOR_CANDIDATES, sourceModels: [SOURCE_CHUNK_MODEL] });
        const rows = await SourceChunkRepository.listByIds(db, ctx.workspaceId, hits.map((h) => h.sourceId));
        const inSet = new Set(rows.filter((r) => allowedSet.has(r.sourceId)).map((r) => r.id));
        hits.filter((h) => inSet.has(h.sourceId)).forEach((h, i) => fuse(h.sourceId, i));
    }
    const names = [...new Set(elements.map((e) => e.name).filter((n) => n.trim() !== ''))];
    const scanned = await SourceChunkRepository.listForSources(db, ctx.workspaceId, allowed, LEXICAL_SCAN_CHUNKS_MAX + 1);
    if (scanned.length > LEXICAL_SCAN_CHUNKS_MAX) truncated = true;
    const pool = new Map(scanned.slice(0, LEXICAL_SCAN_CHUNKS_MAX).map((c) => [c.id, c] as const));
    if (names.length > 0) {
        const analyzer = createAnalyzer('en');
        const parsed = parseQuery(names.join(' ').slice(0, 400), analyzer);
        if (parsed.ok && !parsed.query.empty) {
            const docs: SearchDocument[] = [...pool.values()].map((c) => ({ kind: 'element', elementId: c.id, elementKind: null, name: '', customLabel: null, sources: [{ kind: 'field', text: c.text }] }));
            rankDocuments(docs, parsed.query, analyzer, { limit: VECTOR_CANDIDATES }).hits.forEach((h, i) => h.elementId && fuse(h.elementId, i));
        }
    }
    const missing = [...ranks.keys()].filter((id) => !pool.has(id));
    for (const c of await SourceChunkRepository.listByIds(db, ctx.workspaceId, missing)) if (allowedSet.has(c.sourceId)) pool.set(c.id, c);
    const ordered = [...ranks.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => pool.get(id)).filter((c): c is NonNullable<typeof c> => c !== undefined);
    const passages: Array<SourceContext['passages'][number]> = [];
    for (const c of ordered) {
        const text = c.text.length > PASSAGE_SHOWN_MAX_CHARS ? `${c.text.slice(0, PASSAGE_SHOWN_MAX_CHARS)}…` : c.text;
        const headings = decodeHeadingPath(c.headingPath).join(' › ');
        if (!fitsBudget(used, text + headings, budgetChars)) {
            truncated = true;
            break;
        }
        used += text.length + headings.length;
        passages.push({ headings, text });
    }
    return { facts, passages, truncated };
}
