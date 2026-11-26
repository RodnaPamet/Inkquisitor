/**
 * THE RETRIEVER, AND THE FRONTIER'S FACT CHECKS (Phase 4.0, D23; extended in
 * 4.1, D27; rule 5).
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
 * THE BIBLE CHECK (`bibleFactsCheck`, 4.1): a live fact drawn from an accepted
 * version (an element's or a relation's) answers the field the same table maps
 * its predicate to, on the scope element it is about. Such a fact counts at
 * once (D27); the bible's stored values are still read first.
 *
 * THE CONTEXT (`assembleSourceContext`), under ONE token budget
 * (`SOURCE_CONTEXT_TOKEN_BUDGET`), in this order: the target element in full
 * is the prompt's own `element.N` block and is never cut here; then the
 * directly related elements' summaries (cut to their share); then the top-k
 * facts (`FACTS_TOP_K`: the scope elements' bible facts, their confirmed
 * source facts — an override's text in place of an overridden fact's — then,
 * with a query vector, the nearest of the book's other facts); then the most
 * relevant passages — the vector store's nearest chunks and the 3.4 lexical
 * ranker's best over a bounded scan of the book's chunks, fused by rank. Every
 * vector search names its allowed set INSIDE the query (`within`, #57 item 3):
 * the book's own sources and its opted-in series sources, and for facts the
 * book's own bible facts — never a workspace's top k cut down afterwards. It
 * is author text: the question generator gets it ONLY as fenced data blocks.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { BibleVersionReadRepository } from '@/app-layer/repositories/fact-layer.repository';
import { BibleFactRepository, type BibleFactRow, SourceChunkRepository, StoryFactOverrideRepository, StoryFactRepository } from '@/app-layer/repositories/source.repository';
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
import { locateQuote } from '@/lib/sources/quote';
import { entryText, renderElementEntry, renderRelationEntry } from '@/lib/facts/entry-text';
import { parseSnapshot } from '@/lib/bible/snapshot';
import { parseRelationSnapshot } from '@/lib/bible/relation-snapshot';
import { CHARS_PER_TOKEN, fieldAnsweredBy } from '@/lib/sources/vocabulary';
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
/** Facts the context carries at most (the roadmap's top k). */
export const FACTS_TOP_K = 24;
/** Entries whose current text a scope's bible facts are read back against at most (one snapshot decrypted each). */
export const BIBLE_FACT_OWNERS_VERIFIED_MAX = 64;
/** Live bible facts read for a scope at most (the check and the context). */
export const BIBLE_FACTS_READ_MAX = 2_000;
/** The related elements' summaries take at most this share of the budget; the facts at most half of it. */
export const RELATED_BUDGET_SHARE = 0.25;
export const FACTS_BUDGET_SHARE = 0.5;
/** A related element's summary is shown at most this long. */
export const RELATED_SUMMARY_MAX_CHARS = 600;

/** A related element as the prompt's `related-elements` block carries it. */
export interface RelatedSummary {
    readonly kind: BibleKind;
    readonly name: string;
    readonly summary: string | null;
}

export interface ScopeElement {
    readonly elementId: string;
    readonly kind: BibleKind;
    readonly name: string;
}

export interface SourceContext {
    /** BIBLE: drawn from an accepted version (counts at once); BOOK / SERIES / OVERRIDE: a confirmed source fact. */
    readonly facts: ReadonlyArray<{ subject: string; statement: string; from: 'BIBLE' | 'BOOK' | 'SERIES' | 'OVERRIDE' }>;
    readonly passages: ReadonlyArray<{ headings: string; text: string }>;
    /** The related elements' summaries that fit (in the order given); absent when none were given. */
    readonly related?: ReadonlyArray<RelatedSummary>;
    /** Something relevant did not fit the budget, or the scan was cut. */
    readonly truncated: boolean;
    /** Phase 4.3: the rows behind `facts` and `passages`, in the same order (a stress test cites them by id). */
    readonly factIds?: readonly string[];
    readonly passageIds?: readonly string[];
}

export const EMPTY_SOURCE_CONTEXT: SourceContext = Object.freeze({ facts: [], passages: [], truncated: false });

/**
 * The entries' CURRENT text, for the facts drawn from them (owner decision, 2026-11-21; the D27 addendum): each
 * owning element's or relation's newest version rendered as extraction renders it, at most
 * `BIBLE_FACT_OWNERS_VERIFIED_MAX` entries, one snapshot decrypted each. An entry past the bound is not read, and
 * its facts are not vouched for.
 */
async function currentEntryTexts(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, facts: readonly BibleFactRow[]): Promise<Map<string, string>> {
    const owners: string[] = [];
    for (const f of facts) {
        const key = f.elementId ? `e:${f.elementId}` : f.relationId ? `r:${f.relationId}` : null;
        if (key && !owners.includes(key) && owners.length < BIBLE_FACT_OWNERS_VERIFIED_MAX) owners.push(key);
    }
    const elementIds = owners.filter((k) => k.startsWith('e:')).map((k) => k.slice(2));
    const relationIds = owners.filter((k) => k.startsWith('r:')).map((k) => k.slice(2));
    const out = new Map<string, string>();
    for (const [id, snapshot] of await BibleVersionReadRepository.newestElementSnapshots(db, ctx.workspaceId, elementIds)) out.set(`e:${id}`, entryText(renderElementEntry(parseSnapshot(snapshot))));
    if (relationIds.length > 0) {
        const snapshots = await BibleVersionReadRepository.newestRelationSnapshots(db, ctx.workspaceId, relationIds);
        for (const r of await BibleRelationRepository.listByIdsWithEnds(db, ctx.workspaceId, bookId, relationIds)) {
            const snapshot = snapshots.get(r.id);
            if (snapshot) out.set(`r:${r.id}`, entryText(renderRelationEntry(parseRelationSnapshot(snapshot), { fromKind: r.from.kind as BibleKind, fromName: r.from.name, toName: r.to.name })));
        }
    }
    return out;
}

/**
 * The scope's live bible facts, resolved to the field each answers (4.1) — and only those whose quote is STILL in
 * their entry as it stands (owner decision, 2026-11-21; the D27 addendum): a field the author cleared is asked
 * again at once, though the fact itself stays live until the author decides its NO_LONGER_STATED proposal
 * (rule 1). With `answering`, only facts that answer a field are read back against their entries (the frontier's
 * check), so no entry is decrypted for a fact that answers nothing.
 */
async function resolvedBibleFacts(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elements: readonly ScopeElement[], answering = false): Promise<ResolvedFact[]> {
    const real = elements.filter((e) => e.elementId !== PENDING_SUBJECT_ID);
    if (real.length === 0) return [];
    const byId = new Map(real.map((e) => [e.elementId, e] as const));
    const facts = await BibleFactRepository.listLiveAbout(db, ctx.workspaceId, bookId, real.map((e) => e.elementId), BIBLE_FACTS_READ_MAX);
    const candidates: Array<{ fact: BibleFactRow; resolved: ResolvedFact }> = [];
    for (const f of facts) {
        const element = f.subjectElementId ? byId.get(f.subjectElementId) : undefined;
        if (!element) continue;
        const key = fieldAnsweredBy(element.kind, f.predicate);
        const fieldKey = key && getFieldDef(element.kind, key) ? key : null;
        if (answering && fieldKey === null) continue;
        candidates.push({ fact: f, resolved: { elementId: element.elementId, kind: element.kind, fieldKey, subject: element.name, statement: f.statement, from: 'BIBLE', id: f.id } });
    }
    if (candidates.length === 0) return [];
    const texts = await currentEntryTexts(db, ctx, bookId, candidates.map((c) => c.fact));
    const out: ResolvedFact[] = [];
    for (const { fact, resolved } of candidates) {
        const text = texts.get(fact.elementId ? `e:${fact.elementId}` : `r:${fact.relationId}`);
        if (text !== undefined && locateQuote(fact.quote, text)) out.push(resolved);
    }
    return out;
}

/** The fields the book's live bible facts answer for these elements (rule 5, 4.1). */
export async function bibleFactRefs(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elements: readonly ScopeElement[]): Promise<FieldRef[]> {
    return (await resolvedBibleFacts(db, ctx, bookId, elements, true)).filter((f) => f.fieldKey !== null).map((f) => ({ elementId: f.elementId, fieldKey: f.fieldKey! }));
}

/** The frontier's bible check (the header), named `bible-facts` in `answered[].by`. */
export async function bibleFactsCheck(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elements: readonly ScopeElement[]): Promise<AlreadyAnsweredCheck> {
    return refsCheck('bible-facts', await bibleFactRefs(db, ctx, bookId, elements));
}

interface ResolvedFact {
    id: string;
    elementId: string;
    kind: BibleKind;
    fieldKey: string | null;
    subject: string;
    statement: string;
    from: 'BIBLE' | 'BOOK' | 'SERIES' | 'OVERRIDE';
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
            id: f.id,
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

/** The query a context's vector searches use: the scope's names (and the round's targets) embedded once, outside every transaction. */
export interface ContextQuery {
    readonly vector: readonly number[];
    readonly revision: string;
}

/** The context (the header). Without a query vector the passages are lexical alone and the facts the scope's own. */
export async function assembleSourceContext(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    elements: readonly ScopeElement[],
    query: ContextQuery | null = null,
    budgetTokens: number = SOURCE_CONTEXT_TOKEN_BUDGET,
    related: readonly RelatedSummary[] | null = null,
): Promise<SourceContext> {
    const set = await bookSourceSet(db, ctx, bookId);
    const allowed = [...set.bookSourceIds, ...set.seriesSourceIds];
    const budgetChars = budgetTokens * CHARS_PER_TOKEN;
    let used = 0;
    let truncated = false;

    // 1. The directly related elements' summaries, in the order given, cut to their share.
    const relatedOut: RelatedSummary[] = [];
    for (const r of related ?? []) {
        const summary = r.summary && r.summary.length > RELATED_SUMMARY_MAX_CHARS ? `${r.summary.slice(0, RELATED_SUMMARY_MAX_CHARS)}…` : r.summary;
        const size = r.name.length + (summary?.length ?? 0) + 24;
        if (used + size > budgetChars * RELATED_BUDGET_SHARE) {
            truncated = true;
            break;
        }
        used += size;
        relatedOut.push({ kind: r.kind, name: r.name, summary });
    }

    // 2. The top k facts: the scope's bible facts, its confirmed source facts, then the nearest of the book's others.
    const facts: Array<SourceContext['facts'][number]> = [];
    const factIds = new Set<string>();
    const factOrder: string[] = [];
    const factBudget = used + budgetChars * FACTS_BUDGET_SHARE;
    const addFact = (f: { id: string; subject: string; statement: string; from: SourceContext['facts'][number]['from'] }): boolean => {
        if (factIds.has(f.id)) return true;
        if (facts.length >= FACTS_TOP_K) {
            truncated = true;
            return false;
        }
        const size = f.subject.length + f.statement.length + 16;
        if (used + size > factBudget) {
            truncated = true;
            return false;
        }
        used += size;
        factIds.add(f.id);
        factOrder.push(f.id);
        facts.push({ subject: f.subject, statement: f.statement, from: f.from });
        return true;
    };
    let room = true;
    for (const f of [...(await resolvedBibleFacts(db, ctx, bookId, elements)), ...(allowed.length > 0 ? await resolvedFacts(db, ctx, bookId, elements) : [])]) {
        if (!(room = addFact(f))) break;
    }
    if (room && query) {
        const hits = await getVectorRepository().search(db, ctx.workspaceId, {
            embeddingRevision: query.revision,
            embedding: query.vector,
            k: FACTS_TOP_K,
            within: { scope: 'facts-of-book', bookId, sourceIds: allowed },
        });
        const rows = new Map((await BibleFactRepository.listAnyByIds(db, ctx.workspaceId, hits.map((h) => h.sourceId))).map((r) => [r.id, r] as const));
        // A series fact this book overrode is shown as the book's own answer, never the series' words (4.0's rule,
        // as `resolvedFacts` applies it to the scope's facts).
        const seriesHits = hits.map((h) => rows.get(h.sourceId)).filter((r): r is NonNullable<typeof r> => r !== undefined && r.sourceId !== null && set.seriesSourceIds.includes(r.sourceId));
        const overrides = new Map((await StoryFactOverrideRepository.listForBook(db, ctx.workspaceId, bookId, seriesHits.map((r) => r.id))).map((o) => [o.factId, o.text] as const));
        for (const h of hits) {
            const r = rows.get(h.sourceId);
            // Read back through the same allowed set the query named (the book's own facts, its sources' confirmed ones).
            if (!r || r.supersededAt !== null || r.status !== 'CONFIRMED' || !(r.bookId === bookId || (r.sourceId !== null && allowed.includes(r.sourceId)))) continue;
            const override = overrides.get(r.id);
            const from = r.bookId === bookId ? 'BIBLE' : override !== undefined ? 'OVERRIDE' : set.seriesSourceIds.includes(r.sourceId ?? '') ? 'SERIES' : 'BOOK';
            if (!addFact({ id: r.id, subject: r.subjectName, statement: override ?? r.statement, from })) break;
        }
    }

    // 3. Passages: the vector store's nearest (filtered to the book's sources in the query) and the lexical ranker's best.
    const passages: Array<SourceContext['passages'][number]> = [];
    const passageIds: string[] = [];
    if (allowed.length > 0) {
        const allowedSet = new Set(allowed);
        const ranks = new Map<string, number>();
        const fuse = (id: string, rank: number) => ranks.set(id, (ranks.get(id) ?? 0) + 1 / (60 + rank));
        if (query) {
            const hits = await getVectorRepository().search(db, ctx.workspaceId, {
                embeddingRevision: query.revision,
                embedding: query.vector,
                k: VECTOR_CANDIDATES,
                within: { scope: 'chunks-of-sources', sourceIds: allowed },
            });
            hits.forEach((h, i) => fuse(h.sourceId, i));
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
        // Read back through the book's set as well: the query's filter is the guarantee, this the second line.
        for (const c of await SourceChunkRepository.listByIds(db, ctx.workspaceId, missing)) if (allowedSet.has(c.sourceId)) pool.set(c.id, c);
        const ordered = [...ranks.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => pool.get(id)).filter((c): c is NonNullable<typeof c> => c !== undefined);
        for (const c of ordered) {
            const text = c.text.length > PASSAGE_SHOWN_MAX_CHARS ? `${c.text.slice(0, PASSAGE_SHOWN_MAX_CHARS)}…` : c.text;
            const headings = decodeHeadingPath(c.headingPath).join(' › ');
            if (!fitsBudget(used, text + headings, budgetChars)) {
                truncated = true;
                break;
            }
            used += text.length + headings.length;
            passages.push({ headings, text });
            passageIds.push(c.id);
        }
    }
    return { facts, passages, ...(related ? { related: relatedOut } : {}), truncated, factIds: factOrder, passageIds };
}
