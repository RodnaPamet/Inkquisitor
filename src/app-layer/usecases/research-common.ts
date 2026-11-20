/**
 * What the research usecases share (Phase 2.6): the brief lookup, the book's
 * stored text the egress check indexes, and the scope a run's fit step reads.
 *
 * The BOOK TEXT INDEX is built from all of the book's stored text — its title
 * and logline, every element's name, custom label, summary and stored field
 * values, and every relation's note — decrypted inside the workspace's
 * context, held in memory for the request or the run, and never stored or
 * logged. Past `BOOK_INDEX_ELEMENTS_MAX` elements or
 * `BOOK_INDEX_RELATIONS_MAX` relations the index is marked incomplete and the
 * egress check refuses every text, rather than vouching for text it never
 * read.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { BibleElementRepository, BibleFieldRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { BookRepository } from '@/app-layer/repositories/book.repository';
import { ResearchBriefRepository } from '@/app-layer/repositories/research.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { NotFoundError, ValidationError } from '@/lib/errors/types';
import { decodeFieldValue, type FieldValue } from '@/lib/bible/field-values';
import { getFieldDef, getTemplate } from '@/lib/bible/templates';
import { valueAsText } from '@/lib/enrichment/validate';
import { buildBookTextIndex, outgoingTextRefusal, type BookTextIndex } from '@/lib/research/query-egress';
import type { ScopeElementInput } from '@/lib/research/run';
import { requireBook } from './bible-common';

/** Elements indexed at most; past it the index is incomplete (fail closed). */
export const BOOK_INDEX_ELEMENTS_MAX = 2_000;
/** Relations (their notes) indexed at most; past it the index is incomplete (fail closed). */
export const BOOK_INDEX_RELATIONS_MAX = 10_000;
/** Stored fields read per element. */
export const FIELDS_PER_ELEMENT = 50;
/** Related elements a run's fit step reads at most. */
export const RELATED_ELEMENTS_MAX = 24;
/** Relations of one scope element read. */
const RELATIONS_PER_ELEMENT = 100;

export async function requireBrief(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, briefId: string) {
    await requireBook(db, ctx, bookId);
    const brief = await ResearchBriefRepository.find(db, ctx.workspaceId, bookId, briefId);
    if (!brief) throw new NotFoundError('Research brief not found.');
    return brief;
}

export interface BookTextRead {
    readonly index: BookTextIndex;
    /** Element id → its row, values decoded (the scope is read from here). */
    readonly elements: ReadonlyMap<string, { id: string; kind: ScopeElementInput['kind']; name: string; summary: string | null; stored: Map<string, FieldValue> }>;
    readonly names: readonly string[];
}

/** Read the book's stored text, and index it for the egress check. */
export async function readBookText(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<BookTextRead> {
    const book = await BookRepository.find(db, ctx.workspaceId, bookId);
    if (!book) throw new NotFoundError('Book not found.');
    const rows = await BibleElementRepository.listForExport(db, ctx.workspaceId, bookId, BOOK_INDEX_ELEMENTS_MAX + 1);
    const kept = rows.slice(0, BOOK_INDEX_ELEMENTS_MAX);
    const elements = new Map<string, { id: string; kind: ScopeElementInput['kind']; name: string; summary: string | null; stored: Map<string, FieldValue> }>();
    for (const r of kept) elements.set(r.id, { id: r.id, kind: r.kind, name: r.name, summary: r.summary, stored: new Map() });
    for (const f of await BibleFieldRepository.listForElements(db, ctx.workspaceId, [...elements.keys()], FIELDS_PER_ELEMENT)) {
        elements.get(f.elementId)?.stored.set(f.key, decodeFieldValue(f.value));
    }
    const texts: string[] = [book.title];
    if (book.logline) texts.push(book.logline);
    for (const r of kept) if (r.customLabel) texts.push(r.customLabel);
    const relations = await BibleRelationRepository.listForBook(db, ctx.workspaceId, bookId, BOOK_INDEX_RELATIONS_MAX + 1);
    for (const r of relations.slice(0, BOOK_INDEX_RELATIONS_MAX)) if (r.note) texts.push(r.note);
    for (const e of elements.values()) {
        texts.push(e.name);
        if (e.summary) texts.push(e.summary);
        for (const [key, value] of e.stored) {
            const def = getFieldDef(e.kind, key);
            texts.push(def ? valueAsText(def, value) : Array.isArray(value) ? value.join('\n') : String(value));
        }
    }
    const index = buildBookTextIndex(texts);
    const cut = rows.length > BOOK_INDEX_ELEMENTS_MAX || relations.length > BOOK_INDEX_RELATIONS_MAX;
    return { index: cut ? { ...index, incomplete: true } : index, elements, names: kept.map((r) => r.name) };
}

/** Refuse a brief whose question, purpose or a URL quotes the book's stored text (D9): 422 BRIEF_QUOTES_BIBLE, naming which part. */
export function assertBriefLeavesNoBookText(brief: { question: string; purpose: string; urls: readonly string[] }, index: BookTextIndex): void {
    const parts: Array<[string, string]> = [['question', brief.question], ['purpose', brief.purpose], ...brief.urls.map((u, i) => [`url.${i + 1}`, u] as [string, string])];
    for (const [part, text] of parts) {
        const refusal = outgoingTextRefusal(text, index);
        if (refusal) throw new ValidationError('The brief repeats text from your book; research queries never carry it. Rephrase it in your own words.', { reason: 'BRIEF_QUOTES_BIBLE', part, check: refusal });
    }
}

/** The scope a run's fit step reads: the brief's elements in full, then the elements related to them (summary and filled keys only). */
export async function scopeOf(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, scopeIds: readonly string[], book: BookTextRead): Promise<ScopeElementInput[]> {
    const scope = scopeIds.map((id) => book.elements.get(id)).filter((e): e is NonNullable<typeof e> => e !== undefined);
    const out: ScopeElementInput[] = scope.map((e) => ({ elementId: e.id, kind: e.kind, name: e.name, summary: e.summary, role: 'scope', fields: getTemplate(e.kind).fields, stored: e.stored }));
    const seen = new Set(scope.map((e) => e.id));
    for (const e of scope) {
        for (const r of await BibleRelationRepository.listForElement(db, ctx.workspaceId, bookId, e.id, RELATIONS_PER_ELEMENT)) {
            const other = r.from.id === e.id ? r.to.id : r.from.id;
            if (seen.has(other) || out.length >= scope.length + RELATED_ELEMENTS_MAX) continue;
            const rel = book.elements.get(other);
            if (!rel) continue;
            seen.add(other);
            out.push({ elementId: rel.id, kind: rel.kind, name: rel.name, summary: rel.summary, role: 'related', fields: getTemplate(rel.kind).fields, stored: rel.stored });
        }
    }
    return out;
}
