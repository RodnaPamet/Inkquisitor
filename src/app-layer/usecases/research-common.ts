/**
 * What the research usecases share (Phase 2.6): the brief lookup, the book's
 * stored text the egress check indexes, and the scope a run's fit step reads.
 *
 * The BOOK TEXT INDEX is built from all of the book's stored text — its title
 * and logline, every element's name, custom label, summary and stored field
 * values, every relation's note, and (Phase 5.1) the manuscript: every part's,
 * chapter's and scene's title and every scene's text, story time and note, so a
 * brief can quote neither the bible nor the manuscript (D9) — decrypted inside the workspace's
 * context, held in memory for the request or the run, and never stored or
 * logged. Past `BOOK_INDEX_ELEMENTS_MAX` elements or
 * `BOOK_INDEX_RELATIONS_MAX` relations the index is marked incomplete and the
 * egress check refuses every text, rather than vouching for text it never
 * read. Past `MANUSCRIPT_INDEX_SCENES_MAX` scenes the same.
 *
 * THE FIT STEP'S SCENES (Phase 5.1, `fitScenesOf`): the brief's scoped
 * chapters' scenes and its scoped scenes, in manuscript order, at most
 * `FIT_SCENES_MAX` (the rest counted, `scenesCut`), each with an opening
 * excerpt of its text. They reach the fit call only, never the gather request.
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
import { ManuscriptChapterRepository, ManuscriptPartRepository, ManuscriptRepository, ManuscriptSceneRepository } from '@/app-layer/repositories/manuscript.repository';
import { compareRanks } from '@/lib/bible/story-order';
import { scenePlainText } from '@/lib/manuscript/scene-html';
import { CHAPTERS_PER_MANUSCRIPT_MAX, PARTS_PER_MANUSCRIPT_MAX, SCENES_PER_MANUSCRIPT_MAX } from '@/lib/manuscript/vocabulary';
import { truncateGraphemes } from '@/lib/text/truncate';
import type { FitSceneInput } from '@/lib/research/run';

/** Elements indexed at most; past it the index is incomplete (fail closed). */
export const BOOK_INDEX_ELEMENTS_MAX = 2_000;
/** Relations (their notes) indexed at most; past it the index is incomplete (fail closed). */
export const BOOK_INDEX_RELATIONS_MAX = 10_000;
/** Stored fields read per element. */
export const FIELDS_PER_ELEMENT = 50;
/** Related elements a run's fit step reads at most. */
export const RELATED_ELEMENTS_MAX = 24;
/** Manuscript scenes indexed at most (every scene a manuscript can hold); past it the index is incomplete (fail closed). */
export const MANUSCRIPT_INDEX_SCENES_MAX = SCENES_PER_MANUSCRIPT_MAX;
/** Scenes a run's fit step is shown at most (Phase 5.1). */
export const FIT_SCENES_MAX = 24;
/** The opening of a scene's text the fit step is shown, characters (cut at a word). */
export const SCENE_EXCERPT_CHARS = 600;
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
    // Phase 5.1: the manuscript, so a brief quoting the prose is refused as one quoting the bible is (D9).
    const parts = await ManuscriptPartRepository.list(db, ctx.workspaceId, bookId, PARTS_PER_MANUSCRIPT_MAX);
    const chapters = await ManuscriptChapterRepository.list(db, ctx.workspaceId, bookId, CHAPTERS_PER_MANUSCRIPT_MAX);
    for (const r of [...parts, ...chapters]) if (r.title) texts.push(r.title);
    const scenes = await ManuscriptSceneRepository.listTextForIndex(db, ctx.workspaceId, bookId, MANUSCRIPT_INDEX_SCENES_MAX + 1);
    for (const s of scenes.slice(0, MANUSCRIPT_INDEX_SCENES_MAX)) {
        for (const t of [s.title, s.storyTime, s.note]) if (t) texts.push(t);
        if (s.text) texts.push(scenePlainText(s.text));
    }
    const index = buildBookTextIndex(texts);
    const cut = rows.length > BOOK_INDEX_ELEMENTS_MAX || relations.length > BOOK_INDEX_RELATIONS_MAX || scenes.length > MANUSCRIPT_INDEX_SCENES_MAX;
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

/** The opening of a scene's plain text, cut at a word (and between grapheme clusters). */
export function sceneExcerpt(text: string): string {
    const plain = scenePlainText(text).replace(/\s+/g, ' ').trim();
    if (plain.length <= SCENE_EXCERPT_CHARS) return plain;
    const cut = truncateGraphemes(plain, SCENE_EXCERPT_CHARS, '');
    const space = cut.lastIndexOf(' ');
    return `${space > SCENE_EXCERPT_CHARS / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * The scenes a run's fit step is shown (Phase 5.1): every scene of the brief's
 * chapters, then its named scenes, in manuscript order, de-duplicated, at most
 * `FIT_SCENES_MAX` (the rest counted). A chapter or scene since deleted is
 * left out.
 */
export async function fitScenesOf(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    scope: { chapterIds: readonly string[]; sceneIds: readonly string[] },
    book: BookTextRead,
): Promise<{ scenes: FitSceneInput[]; cut: number }> {
    if (scope.chapterIds.length === 0 && scope.sceneIds.length === 0) return { scenes: [], cut: 0 };
    if (!(await ManuscriptRepository.find(db, ctx.workspaceId, bookId))) return { scenes: [], cut: 0 };
    const parts = new Map((await ManuscriptPartRepository.list(db, ctx.workspaceId, bookId, PARTS_PER_MANUSCRIPT_MAX + 1)).map((p) => [p.id, p.rank] as const));
    const chapters = new Map((await ManuscriptChapterRepository.list(db, ctx.workspaceId, bookId, CHAPTERS_PER_MANUSCRIPT_MAX + 1)).map((c) => [c.id, c] as const));
    const inChapters = await ManuscriptSceneRepository.listForChapters(db, ctx.workspaceId, bookId, scope.chapterIds, SCENES_PER_MANUSCRIPT_MAX + 1);
    const named = await ManuscriptSceneRepository.findOutline(db, ctx.workspaceId, bookId, scope.sceneIds);
    const all = new Map([...inChapters, ...named].map((s) => [s.id, s] as const));
    const ordered = [...all.values()].sort((a, b) => {
        const ca = chapters.get(a.chapterId);
        const cb = chapters.get(b.chapterId);
        return compareRanks(parts.get(ca?.partId ?? '') ?? '', parts.get(cb?.partId ?? '') ?? '') || compareRanks(ca?.rank ?? '', cb?.rank ?? '') || compareRanks(a.rank, b.rank);
    });
    const shown = ordered.slice(0, FIT_SCENES_MAX);
    const full = new Map((await ManuscriptSceneRepository.findFull(db, ctx.workspaceId, bookId, shown.map((s) => s.id))).map((s) => [s.id, s] as const));
    const nameOf = (id: string | null) => (id ? (book.elements.get(id)?.name ?? null) : null);
    const scenes: FitSceneInput[] = [];
    for (const s of shown) {
        const row = full.get(s.id);
        if (!row) continue;
        scenes.push({
            sceneRef: `s${scenes.length + 1}`,
            sceneId: row.id,
            title: row.title,
            chapterTitle: chapters.get(row.chapterId)?.title ?? null,
            pov: nameOf(row.povElementId),
            setting: nameOf(row.settingElementId),
            storyTime: row.storyTime,
            excerpt: sceneExcerpt(row.text),
        });
    }
    return { scenes, cut: ordered.length - shown.length };
}
