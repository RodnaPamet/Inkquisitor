/**
 * What the manuscript usecases share (Phase 5.1, D33): the outline read, a
 * new row's place among its siblings, the elements a scene may name, and the
 * mapping of sanitiser refusals to 400s.
 *
 * Not a public usecase module: every function here runs inside a transaction
 * a usecase opened with `runInWorkspaceContext` after asking its permission.
 *
 * ORDER (D33). A part's, chapter's or scene's place is a fractional rank among
 * its siblings (`story-order.ts`), compared in code. A new or moved row names
 * the sibling it goes after or before (by id, as the author saw it); `placeRank`
 * puts it strictly between, and a named sibling that is gone or moved is 409
 * ORDER_STALE. A gap spent past the rank bound REBALANCES the parent's rows
 * (`placeAmong`, as the bible's order does: short, evenly spaced ranks in the
 * same order, no version, one audit row), and only a rank still past the
 * bound is 409 ORDER_RANK_EXHAUSTED. An import gives its new rows fresh, evenly
 * spaced ranks (`appendRanks`), so a five-thousand-scene chapter never
 * lengthens a key past its bound.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import {
    ManuscriptChapterRepository,
    ManuscriptOrderRepository,
    ManuscriptPartRepository,
    ManuscriptRepository,
    ManuscriptSceneRepository,
    type ChapterRow,
    type RankedLevel,
    type PartRow,
    type SceneOutlineRow,
} from '@/app-layer/repositories/manuscript.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { compareRanks, placeRank, rankBetween, rebalancedRanks, RankExhaustedError, ORDER_RANK_MAX, type RankDecision } from '@/lib/bible/story-order';
import { ManuscriptTextTooLongError } from '@/lib/manuscript/storage';
import { CHAPTERS_PER_MANUSCRIPT_MAX, OUTLINE_READ_MAX, PARTS_PER_MANUSCRIPT_MAX } from '@/lib/manuscript/vocabulary';
import { requireBook } from './bible-common';

// ─── Lookups ────────────────────────────────────────────────────────

export async function requireScene(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sceneId: string) {
    const scene = await ManuscriptSceneRepository.head(db, ctx.workspaceId, bookId, sceneId);
    if (!scene) throw new NotFoundError('Scene not found.');
    return scene;
}

export async function requireChapter(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, chapterId: string): Promise<ChapterRow> {
    const chapter = await ManuscriptChapterRepository.find(db, ctx.workspaceId, bookId, chapterId);
    if (!chapter) throw new NotFoundError('Chapter not found.');
    return chapter;
}

export async function requirePart(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, partId: string): Promise<PartRow> {
    const part = await ManuscriptPartRepository.find(db, ctx.workspaceId, bookId, partId);
    if (!part) throw new NotFoundError('Part not found.');
    return part;
}

/** The book's manuscript, made on its first structural write (the caller holds the structure lock). */
export async function ensureManuscript(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<{ id: string }> {
    await requireBook(db, ctx, bookId);
    return (await ManuscriptRepository.find(db, ctx.workspaceId, bookId)) ?? ManuscriptRepository.create(db, ctx.workspaceId, bookId);
}

// ─── Order ──────────────────────────────────────────────────────────

export interface Placement {
    after?: string | null;
    before?: string | null;
}

export const ORDER_STALE = { reason: 'ORDER_STALE' } as const;

/**
 * The rank for a row placed among `siblings` (each `{ id, rank }`; the row's
 * own entry, when it is a move within its parent, is left out by the caller).
 */
export function rankAmong(siblings: ReadonlyArray<{ id: string; rank: string }>, placement: Placement): string {
    const decision = placementDecision(siblings, placement);
    if (decision.ok) return decision.rank;
    if (decision.reason === 'ORDER_RANK_EXHAUSTED') throw exhausted();
    throw new ConflictError('The place you chose has changed; look again.', ORDER_STALE);
}

function exhausted(): ConflictError {
    return new ConflictError('This gap is full; place it elsewhere.', { reason: 'ORDER_RANK_EXHAUSTED' });
}

function placementDecision(siblings: ReadonlyArray<{ id: string; rank: string }>, placement: Placement): RankDecision {
    const rankOf = (id: string | null | undefined) => {
        if (!id) return null;
        const s = siblings.find((x) => x.id === id);
        if (!s) throw new ConflictError('The place you chose has changed; look again.', ORDER_STALE);
        return s.rank;
    };
    return placeRank(
        siblings.map((s) => s.rank),
        { after: rankOf(placement.after), before: rankOf(placement.before) },
    );
}

/**
 * Temporary ranks for a rebalance's first pass: `count` keys, each a valid
 * rank, clear of every rank in `taken` (the parent's old ranks and its new
 * ones), so the first pass never lands on a rank a row still holds.
 */
export function temporaryRanks(count: number, taken: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (let k = 0; out.length < count; k++) {
        const candidate = `z${k.toString(36)}z`;
        if (!taken.has(candidate)) out.push(candidate);
    }
    return out;
}

/**
 * The rank a row takes at `placement` among the rows of ONE parent, under the
 * structure lock the CALLER holds — as `rankAmong`, but a gap spent past the
 * rank's bound is not refused at once: every row of the parent (`rows`, the
 * moving row's own entry included when it is already there) is given short,
 * evenly spaced ranks in the same order (`rebalancedRanks`), and the place is
 * computed again; only a rank still past the bound is 409
 * ORDER_RANK_EXHAUSTED. Repeated inserts at one spot, or a scene moved up and
 * down past its neighbour, spend a gap in about three hundred moves, which a
 * long-lived manuscript reaches. A rebalance changes no row's place relative
 * to another and writes no version; its one audit row (`recordManuscriptRebalance`)
 * is the CALLER's to write, after its own row writes ("audit last").
 */
export async function placeAmong(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    level: RankedLevel,
    rows: ReadonlyArray<{ id: string; rank: string }>,
    selfId: string | null,
    placement: Placement,
): Promise<{ rank: string; rebalanced: number }> {
    const others = (list: ReadonlyArray<{ id: string; rank: string }>) => list.filter((r) => r.id !== selfId);
    const first = placementDecision(others(rows), placement);
    if (first.ok) return { rank: first.rank, rebalanced: 0 };
    if (first.reason !== 'ORDER_RANK_EXHAUSTED') throw new ConflictError('The place you chose has changed; look again.', ORDER_STALE);
    const sorted = byRank(rows);
    const fresh = rebalancedRanks(sorted.length);
    const temporary = temporaryRanks(sorted.length, new Set([...sorted.map((r) => r.rank), ...fresh]));
    await ManuscriptOrderRepository.rebalanceRanks(
        db,
        ctx.workspaceId,
        level,
        sorted.map((r) => r.id),
        temporary,
        fresh,
    );
    const again = placementDecision(
        others(sorted.map((r, i) => ({ id: r.id, rank: fresh[i] }))),
        placement,
    );
    if (!again.ok) throw again.reason === 'ORDER_RANK_EXHAUSTED' ? exhausted() : new ConflictError('The place you chose has changed; look again.', ORDER_STALE);
    return { rank: again.rank, rebalanced: sorted.length };
}

/** A rebalance's one audit row (ids and a count), written by the caller after its row writes. */
export async function recordManuscriptRebalance(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, level: RankedLevel, parentId: string, rowCount: number): Promise<void> {
    if (rowCount === 0) return;
    await logEvent(ctx, { action: 'MANUSCRIPT_ORDER_REBALANCED', entityType: 'Manuscript', entityId: bookId, details: { bookId, level, parentId, rowCount } }, { db });
}

/**
 * `count` fresh ranks, ascending, all after `last` (null: an empty parent):
 * evenly spaced and short (`rebalancedRanks`), each behind the shortest key
 * above `last`, so they sort after it and before nothing else.
 */
export function appendRanks(last: string | null, count: number): string[] {
    const fresh = rebalancedRanks(count);
    if (last === null) return fresh;
    const base = rankBetween(last, null);
    const out = fresh.map((s) => base + s);
    if (out.some((r) => r.length > ORDER_RANK_MAX)) throw new RankExhaustedError();
    return out;
}

/** The last rank among rows (code-unit order), or null. */
export function lastRank(rows: ReadonlyArray<{ rank: string }>): string | null {
    let last: string | null = null;
    for (const r of rows) if (last === null || compareRanks(r.rank, last) > 0) last = r.rank;
    return last;
}

export function byRank<T extends { rank: string }>(rows: readonly T[]): T[] {
    return [...rows].sort((a, b) => compareRanks(a.rank, b.rank));
}

// ─── The outline ────────────────────────────────────────────────────

export interface OutlineSceneView {
    id: string;
    title: string | null;
    wordCount: number;
    povElementId: string | null;
}
export interface OutlineChapterView {
    id: string;
    title: string | null;
    wordCount: number;
    scenes: OutlineSceneView[];
}
export interface OutlinePartView {
    id: string;
    title: string | null;
    wordCount: number;
    chapters: OutlineChapterView[];
}
export interface OutlineView {
    manuscriptId: string | null;
    /** True when the manuscript holds one untitled part: the outline shows no part level (the 5.1 note). */
    singleDefaultPart: boolean;
    parts: OutlinePartView[];
    totals: { parts: number; chapters: number; scenes: number; words: number };
}

export interface OutlineRows {
    manuscriptId: string | null;
    parts: PartRow[];
    chapters: ChapterRow[];
    scenes: SceneOutlineRow[];
}

/** Every part, chapter and scene of the book (no text): three bounded reads. */
export async function readOutlineRows(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<OutlineRows> {
    const manuscript = await ManuscriptRepository.find(db, ctx.workspaceId, bookId);
    if (!manuscript) return { manuscriptId: null, parts: [], chapters: [], scenes: [] };
    const [parts, chapters, scenes] = [
        await ManuscriptPartRepository.list(db, ctx.workspaceId, bookId, PARTS_PER_MANUSCRIPT_MAX + 1),
        await ManuscriptChapterRepository.list(db, ctx.workspaceId, bookId, CHAPTERS_PER_MANUSCRIPT_MAX + 1),
        await ManuscriptSceneRepository.listOutline(db, ctx.workspaceId, bookId, OUTLINE_READ_MAX),
    ];
    return { manuscriptId: manuscript.id, parts, chapters, scenes };
}

/** The rows as the outline: ordered by rank at every level, words summed up the tree. */
export function outlineView(rows: OutlineRows): OutlineView {
    const scenesBy = new Map<string, SceneOutlineRow[]>();
    for (const s of rows.scenes) scenesBy.set(s.chapterId, [...(scenesBy.get(s.chapterId) ?? []), s]);
    const chaptersBy = new Map<string, ChapterRow[]>();
    for (const c of rows.chapters) chaptersBy.set(c.partId, [...(chaptersBy.get(c.partId) ?? []), c]);
    let words = 0;
    const parts = byRank(rows.parts).map((p) => {
        const chapters = byRank(chaptersBy.get(p.id) ?? []).map((c) => {
            const scenes = byRank(scenesBy.get(c.id) ?? []).map((s) => ({ id: s.id, title: s.title, wordCount: s.wordCount, povElementId: s.povElementId }));
            const wordCount = scenes.reduce((n, s) => n + s.wordCount, 0);
            return { id: c.id, title: c.title, wordCount, scenes };
        });
        const wordCount = chapters.reduce((n, c) => n + c.wordCount, 0);
        words += wordCount;
        return { id: p.id, title: p.title, wordCount, chapters };
    });
    return {
        manuscriptId: rows.manuscriptId,
        singleDefaultPart: parts.length === 1 && parts[0].title === null,
        parts,
        totals: { parts: rows.parts.length, chapters: rows.chapters.length, scenes: rows.scenes.length, words },
    };
}

// ─── Refusals ───────────────────────────────────────────────────────

/** A sanitiser's "too long" as the 400 the author reads (naming the part). */
export function tooLong(err: unknown): never {
    if (err instanceof ManuscriptTextTooLongError) throw new ValidationError('That is too long to store.', { reason: 'TOO_LONG', field: err.what });
    throw err;
}
