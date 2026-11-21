/**
 * REVIEWING SOURCE FACTS (Phase 4.0, D23 and D26). A fact waits for the
 * author; only a CONFIRMED one counts as answered (rule 5), and only through
 * the predicate → field table.
 *
 *   read       `bible.view`. A book's view holds its own library's facts and
 *              the facts of the series sources it opted into, each with its
 *              provenance (the source, the passage around the quote, its
 *              headings, BOOK or SERIES) and, for an inherited fact, the book's
 *              override. The series view holds the series library's facts.
 *              At most `FACTS_PER_VIEW_MAX` a page (keyset by chunk; a cut is
 *              said, `nextCursor`). The response OFFERS the shown facts that
 *              may be bulk-confirmed — pending and unflagged — with a signed
 *              token (`view-token.ts`).
 *   decide     `bible.edit`; confirm or reject one fact (a decision may be
 *              changed). A flagged fact (D14) is decided only here, one by one.
 *   bulk       `bible.edit`; confirm the facts named, which must ALL be among
 *              the ids the token says the view offered (409 FACTS_NOT_OFFERED
 *              otherwise, nothing written); a bad or old token is 409
 *              VIEW_EXPIRED. Each is confirmed only while it is still pending,
 *              unflagged and in the view; the rest are counted, never written.
 *   override   `bible.edit`; a book's own answer in place of a CONFIRMED fact
 *              it inherits from an opted-in series source (409
 *              OVERRIDE_NOT_INHERITED for any other). The series fact is not
 *              touched. Clearing it is the same key.
 *
 * Nothing here writes the bible, and nothing calls a model.
 */
import type { StoryFactStatus } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { SourceChunkRepository, SourceLibraryRepository, SourceRepository, StoryFactOverrideRepository, StoryFactRepository, type StoryFactRow } from '@/app-layer/repositories/source.repository';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { nameKey } from '@/lib/enrichment/validate';
import { getFieldDef } from '@/lib/bible/templates';
import type { BibleKind } from '@/lib/bible/kinds';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { decodeHeadingPath, sanitiseOverrideForStorage, SourceTextNotStorableError } from '@/lib/sources/storage';
import { signViewToken, verifyViewToken, type FactsViewScope } from '@/lib/sources/view-token';
import { FACT_STATUSES, FACTS_PER_VIEW_MAX, fieldAnsweredBy, type FactStatus } from '@/lib/sources/vocabulary';
import { OverrideInput } from '@/app-layer/schemas/sources';
import { requireBook } from './bible-common';
import { bookSourceSet, LIBRARY_READ_MAX, requireSource } from './source-common';
import { factCounts } from './source-library';

/** Characters of the passage shown either side of a quote. */
export const PASSAGE_CONTEXT_CHARS = 240;

export interface FactView {
    id: string;
    subjectName: string;
    predicate: string;
    objectLiteral: string | null;
    statement: string;
    status: FactStatus;
    flags: string[];
    storyTimeFrom: string | null;
    storyTimeTo: string | null;
    /** The passage around the quote: before it, the quote itself (the chunk's exact span), after it. */
    passage: { before: string; quote: string; after: string };
    headingPath: string[];
    provenance: { sourceId: string; filename: string; version: number; scope: 'BOOK' | 'SERIES' };
    /** Book views only: the book's own answer in place of this inherited fact. */
    override: { text: string; updatedAt: string } | null;
    /** Book views only: the field this fact answers once confirmed (the predicate table), or null. */
    answers: { elementId: string; elementName: string; fieldKey: string } | null;
}

export interface FactsPage {
    facts: FactView[];
    counts: Record<FactStatus, number>;
    /** The shown facts a bulk confirm may name, and the token that says so. */
    offered: { ids: string[]; issuedAt: number; token: string };
    nextCursor: string | null;
    sources: Array<{ id: string; filename: string; scope: 'BOOK' | 'SERIES' }>;
}

export interface FactsQuery {
    status?: string | null;
    sourceId?: string | null;
    after?: string | null;
}

function parseQuery(q: FactsQuery): { status: StoryFactStatus | undefined; sourceId: string | null; after: { chunkId: string; position: number } | null } {
    const status = !q.status ? 'PENDING' : q.status === 'ALL' ? undefined : q.status;
    if (status !== undefined && !(FACT_STATUSES as readonly string[]).includes(status)) throw new ValidationError('Unknown status.', { reason: 'STATUS_INVALID' });
    let after: { chunkId: string; position: number } | null = null;
    if (q.after) {
        const m = /^([a-z0-9]{1,64}):(\d{1,6})$/.exec(q.after);
        if (!m) throw new ValidationError('Malformed cursor.', { reason: 'CURSOR_INVALID' });
        after = { chunkId: m[1], position: Number(m[2]) };
    }
    const sourceId = q.sourceId && /^[a-z0-9]{1,64}$/.test(q.sourceId) ? q.sourceId : null;
    return { status: status as StoryFactStatus | undefined, sourceId, after };
}

/** The passage around a span, cut at word boundaries. */
export function passageAround(text: string, start: number, end: number): FactView['passage'] {
    let from = Math.max(0, start - PASSAGE_CONTEXT_CHARS);
    let to = Math.min(text.length, end + PASSAGE_CONTEXT_CHARS);
    if (from > 0) {
        const space = text.indexOf(' ', from);
        from = space >= 0 && space < start ? space + 1 : from;
    }
    if (to < text.length) {
        const space = text.lastIndexOf(' ', to);
        to = space > end ? space : to;
    }
    return { before: `${from > 0 ? '…' : ''}${text.slice(from, start)}`, quote: text.slice(start, end), after: `${text.slice(end, to)}${to < text.length ? '…' : ''}` };
}

async function readView(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    view: FactsViewScope,
    sourceIds: { book: string[]; series: string[] },
    query: FactsQuery,
): Promise<FactsPage> {
    const q = parseQuery(query);
    const all = [...sourceIds.book, ...sourceIds.series];
    const scoped = q.sourceId ? all.filter((id) => id === q.sourceId) : all;
    const rows = await StoryFactRepository.listForView(db, ctx.workspaceId, { sourceIds: scoped, status: q.status, after: q.after, take: FACTS_PER_VIEW_MAX + 1 });
    const page = rows.slice(0, FACTS_PER_VIEW_MAX);
    const sources = await SourceRepository.listByIds(db, ctx.workspaceId, all);
    const sourceById = new Map(sources.map((s) => [s.id, s] as const));
    const chunks = await SourceChunkRepository.listByIds(db, ctx.workspaceId, [...new Set(page.map((f) => f.chunkId))]);
    const chunkById = new Map(chunks.map((c) => [c.id, c] as const));
    const overrides = view.kind === 'book' ? await StoryFactOverrideRepository.listForBook(db, ctx.workspaceId, view.bookId, page.filter((f) => sourceIds.series.includes(f.sourceId)).map((f) => f.id)) : [];
    const overrideBy = new Map(overrides.map((o) => [o.factId, o] as const));
    const answersOf = view.kind === 'book' ? await answerResolver(db, ctx, view.bookId) : () => null;
    const facts: FactView[] = page.map((f) => {
        const source = sourceById.get(f.sourceId);
        const chunk = chunkById.get(f.chunkId);
        const o = overrideBy.get(f.id);
        return {
            id: f.id,
            subjectName: f.subjectName,
            predicate: f.predicate,
            objectLiteral: f.objectLiteral,
            statement: f.statement,
            status: f.status,
            flags: f.flags,
            storyTimeFrom: f.storyTimeFrom,
            storyTimeTo: f.storyTimeTo,
            passage: chunk ? passageAround(chunk.text, f.quoteStart, f.quoteEnd) : { before: '', quote: f.quote, after: '' },
            headingPath: decodeHeadingPath(chunk?.headingPath ?? null),
            provenance: { sourceId: f.sourceId, filename: source?.filename ?? '', version: source?.version ?? 1, scope: source?.library.scope ?? 'BOOK' },
            override: o ? { text: o.text, updatedAt: o.updatedAt.toISOString() } : null,
            answers: answersOf(f),
        };
    });
    const offeredIds = page.filter((f) => f.status === 'PENDING' && f.flags.length === 0).map((f) => f.id);
    const issuedAt = Date.now();
    const last = page[page.length - 1];
    return {
        facts,
        counts: await factCounts(db, ctx, scoped),
        offered: { ids: offeredIds, issuedAt, token: signViewToken({ workspaceId: ctx.workspaceId, userId: ctx.userId, view, offeredIds, issuedAt }) },
        nextCursor: rows.length > FACTS_PER_VIEW_MAX && last ? `${last.chunkId}:${last.position}` : null,
        sources: sources.map((s) => ({ id: s.id, filename: s.filename, scope: s.library.scope })),
    };
}

/**
 * Which field of which book element a fact answers once confirmed: its linked
 * subject, else the one element the book names so (`nameKey`); then the
 * predicate table, and the element's template must hold the field.
 */
export async function answerResolver(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<(f: Pick<StoryFactRow, 'subjectElementId' | 'subjectName' | 'predicate'>) => FactView['answers']> {
    const elements = await BibleElementRepository.listForInterview(db, ctx.workspaceId, bookId, { take: 200 });
    const byId = new Map(elements.map((e) => [e.id, e] as const));
    const byKey = new Map<string, (typeof elements)[number] | null>();
    for (const e of elements) {
        const key = nameKey(e.name);
        byKey.set(key, byKey.has(key) ? null : e);
    }
    return (f) => {
        const element = (f.subjectElementId ? byId.get(f.subjectElementId) : undefined) ?? byKey.get(nameKey(f.subjectName)) ?? null;
        if (!element) return null;
        const fieldKey = fieldAnsweredBy(element.kind, f.predicate);
        if (!fieldKey || !getFieldDef(element.kind as BibleKind, fieldKey)) return null;
        return { elementId: element.id, elementName: element.name, fieldKey };
    };
}

/** A book's facts (`bible.view`; the header). */
export async function listBookFacts(ctx: WorkspaceRequestContext, bookId: string, query: FactsQuery = {}): Promise<FactsPage> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const set = await bookSourceSet(db, ctx, bookId);
        return readView(db, ctx, { kind: 'book', bookId }, { book: set.bookSourceIds, series: set.seriesSourceIds }, query);
    });
}

/** The series library's facts (`bible.view`). */
export async function listSeriesFacts(ctx: WorkspaceRequestContext, query: FactsQuery = {}): Promise<FactsPage> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        const series = await SourceLibraryRepository.findSeries(db, ctx.workspaceId);
        const ids = series ? (await SourceRepository.listForLibrary(db, ctx.workspaceId, series.id, LIBRARY_READ_MAX)).map((s) => s.id) : [];
        return readView(db, ctx, { kind: 'series' }, { book: [], series: ids }, query);
    });
}

async function requireFact(db: PrismaTx, ctx: WorkspaceRequestContext, factId: string): Promise<StoryFactRow> {
    if (!/^[a-z0-9]{1,64}$/.test(factId)) throw new NotFoundError('Fact not found.');
    const fact = await StoryFactRepository.find(db, ctx.workspaceId, factId);
    if (!fact) throw new NotFoundError('Fact not found.');
    // A deleted book's facts are not found (`requireSource`).
    await requireSource(db, ctx, fact.sourceId);
    return fact;
}

/** Confirm or reject one fact (`bible.edit`). */
export async function decideFact(ctx: WorkspaceRequestContext, factId: string, decision: 'CONFIRM' | 'REJECT'): Promise<{ id: string; status: FactStatus }> {
    await assertPermission(ctx, 'bible.edit');
    if (decision !== 'CONFIRM' && decision !== 'REJECT') throw new ValidationError('Unknown decision.', { reason: 'DECISION_INVALID' });
    return runInWorkspaceContext(ctx, async (db) => {
        const fact = await requireFact(db, ctx, factId);
        if (fact.supersededAt) throw new ConflictError('This fact has been replaced.', { reason: 'FACT_SUPERSEDED' });
        const status = decision === 'CONFIRM' ? 'CONFIRMED' : 'REJECTED';
        await StoryFactRepository.decide(db, ctx.workspaceId, fact.id, { status, decidedById: ctx.userId, decidedAt: new Date() });
        await logEvent(ctx, { action: 'STORY_FACT_DECIDED', entityType: 'StoryFact', entityId: fact.id, details: { sourceId: fact.sourceId, status, predicate: fact.predicate, flagged: fact.flags.length > 0 } }, { db });
        return { id: fact.id, status };
    });
}

export interface BulkConfirmInput {
    view: FactsViewScope;
    offeredIds: string[];
    issuedAt: number;
    token: string;
    factIds: string[];
}

/** Confirm facts the view offered (`bible.edit`; the header). */
export async function bulkConfirmFacts(ctx: WorkspaceRequestContext, input: BulkConfirmInput): Promise<{ confirmed: number; skipped: number }> {
    await assertPermission(ctx, 'bible.edit');
    if (input.factIds.length === 0) throw new ValidationError('Name the facts to confirm.', { reason: 'NOTHING_NAMED' });
    const verdict = verifyViewToken({ workspaceId: ctx.workspaceId, userId: ctx.userId, view: input.view, offeredIds: input.offeredIds, issuedAt: input.issuedAt }, input.token);
    if (verdict !== 'OK') throw new ConflictError('Reload the facts and confirm again.', { reason: 'VIEW_EXPIRED' });
    const offered = new Set(input.offeredIds);
    const unseen = input.factIds.filter((id) => !offered.has(id));
    if (unseen.length > 0) throw new ConflictError('Only facts shown on the page can be confirmed together.', { reason: 'FACTS_NOT_OFFERED', count: unseen.length });
    const ids = [...new Set(input.factIds)];
    return runInWorkspaceContext(ctx, async (db) => {
        // The view as it stands now: a fact whose source left the view (removed, opted out) is not confirmed.
        let visible: Set<string>;
        if (input.view.kind === 'book') {
            await requireBook(db, ctx, input.view.bookId);
            const set = await bookSourceSet(db, ctx, input.view.bookId);
            visible = new Set([...set.bookSourceIds, ...set.seriesSourceIds]);
        } else {
            const series = await SourceLibraryRepository.findSeries(db, ctx.workspaceId);
            visible = new Set(series ? (await SourceRepository.listForLibrary(db, ctx.workspaceId, series.id, LIBRARY_READ_MAX)).map((s) => s.id) : []);
        }
        const facts = await StoryFactRepository.listByIds(db, ctx.workspaceId, ids);
        const eligible = facts.filter((f) => visible.has(f.sourceId)).map((f) => f.id);
        const confirmed = await StoryFactRepository.confirmPending(db, ctx.workspaceId, eligible, { decidedById: ctx.userId, decidedAt: new Date() });
        await logEvent(ctx, { action: 'STORY_FACTS_BULK_CONFIRMED', entityType: 'StoryFact', entityId: input.view.kind === 'book' ? input.view.bookId : 'series', details: { named: ids.length, confirmed } }, { db });
        return { confirmed, skipped: ids.length - confirmed };
    });
}

async function requireInherited(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, factId: string): Promise<StoryFactRow> {
    await requireBook(db, ctx, bookId);
    const fact = await requireFact(db, ctx, factId);
    const set = await bookSourceSet(db, ctx, bookId);
    if (!set.seriesSourceIds.includes(fact.sourceId) || fact.status !== 'CONFIRMED') {
        throw new ConflictError('Only a confirmed fact this book inherits from the series can be overridden.', { reason: 'OVERRIDE_NOT_INHERITED' });
    }
    return fact;
}

/** The book's own answer in place of an inherited fact (`bible.edit`). */
export async function setFactOverride(ctx: WorkspaceRequestContext, bookId: string, factId: string, input: unknown): Promise<{ factId: string }> {
    await assertPermission(ctx, 'bible.edit');
    // A missing or deleted book is a 404 before the body is judged.
    await runInWorkspaceContext(ctx, (db) => requireBook(db, ctx, bookId));
    const parsed = OverrideInput.safeParse(input);
    if (!parsed.success) throw new ValidationError('Write the book’s own answer.', { reason: 'OVERRIDE_INVALID' });
    let text: string;
    try {
        text = sanitiseOverrideForStorage(parsed.data.text);
    } catch (err) {
        if (err instanceof SourceTextNotStorableError) throw new ValidationError('Write the book’s own answer in words.', { reason: 'OVERRIDE_EMPTY' });
        throw err;
    }
    return runInWorkspaceContext(ctx, async (db) => {
        const fact = await requireInherited(db, ctx, bookId, factId);
        await StoryFactOverrideRepository.upsert(db, ctx.workspaceId, { bookId, factId: fact.id, text, createdById: ctx.userId });
        await logEvent(ctx, { action: 'STORY_FACT_OVERRIDE_SET', entityType: 'StoryFact', entityId: fact.id, details: { bookId, sourceId: fact.sourceId } }, { db });
        return { factId: fact.id };
    });
}

/** Clear a book's override (`bible.edit`): the inherited fact counts again. */
export async function clearFactOverride(ctx: WorkspaceRequestContext, bookId: string, factId: string): Promise<{ cleared: boolean }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const fact = await requireFact(db, ctx, factId);
        const n = await StoryFactOverrideRepository.remove(db, ctx.workspaceId, bookId, fact.id);
        if (n > 0) await logEvent(ctx, { action: 'STORY_FACT_OVERRIDE_CLEARED', entityType: 'StoryFact', entityId: fact.id, details: { bookId } }, { db });
        return { cleared: n > 0 };
    });
}
