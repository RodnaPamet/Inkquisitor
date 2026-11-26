/**
 * WHAT THE QUESTION GENERATORS READ (Phase 4.4, D23 and D30): every input of
 * the pure generators (`src/lib/interview/generators/`), loaded in the
 * caller's transaction after `loadInterviewState`. Not a public usecase
 * module: it runs inside a transaction a usecase opened after asking its
 * permission. Every read is bounded and keyed by the book's own rows (the
 * book's source set, its threads, its proposals, its questions): nothing of
 * another book or workspace is read (RLS, and every query names the book or
 * the book's sources).
 *
 *   ladder        the book's LADDER questions about the scope's subjects and whether each was ever ANSWERED
 *   facts held    live facts per (subject, predicate), counted (the ladder's value)
 *   pairs         the scope's characters and factions two by two, with no relation between them, at most
 *                 `PAIR_CANDIDATES_MAX` pairs, and each pair's angles asked or answered
 *   pending facts PENDING, unflagged facts of the book's own source set (`bookSourceSet`) about an element in scope,
 *                 not yet asked in this session (D30, item 2)
 *   continuity    pending CONTRADICTED proposals whose facts are about an element in scope, OPEN threads about one,
 *                 and timeline gaps among the scope's placed events
 *   held          the fields with an enrichment proposal still PENDING (an element's FIELD, a relation's
 *                 RELATION_FIELD) and the pairs with a NEW_RELATION pending between them: no generator asks about
 *                 one until the author decides it (owner decision 2026-11-26, A: hold follow-ups)
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { BibleElementRepository, BibleFieldRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { QuestionRepository, type SessionRow } from '@/app-layer/repositories/interview.repository';
import { SourceChunkRepository, SourceRepository, StoryFactRepository } from '@/app-layer/repositories/source.repository';
import { FactProposalRepository } from '@/app-layer/repositories/fact-layer.repository';
import { EnrichmentProposalRepository } from '@/app-layer/repositories/enrichment.repository';
import { StoryThreadRepository } from '@/app-layer/repositories/continuity.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { decodeFieldValue } from '@/lib/bible/field-values';
import { getFieldDef } from '@/lib/bible/templates';
import type { BibleKind } from '@/lib/bible/kinds';
import { compareRanks } from '@/lib/bible/story-order';
import { nameKey } from '@/lib/enrichment/validate';
import { refKey, type FrontierResult } from '@/lib/interview/frontier';
import { generatorsOn } from '@/lib/interview/dial-settings';
import { pairSubjectId } from '@/lib/interview/subjects';
import { PAIR_ANGLE_FIELD } from '@/lib/interview/generators/wording';
import { ladderKey, type ContinuityInput, type GeneratorInput, type GeneratorSubject, type PairInput, type PendingFactInput } from '@/lib/interview/generators';
import { PAIR_ANGLES, type PairAngle } from '@/lib/interview/vocabulary';
import { decodeHeadingPath } from '@/lib/sources/storage';
import { fieldAnsweredBy } from '@/lib/sources/vocabulary';
import { bookSourceSet } from './source-common';
import { fieldText, type InterviewState } from './interview-state';

/** The book's ladder and pair questions read at most. */
export const GENERATOR_HISTORY_READ_MAX = 1_000;
/** Pairs considered at most (the scope's characters and factions, two by two, in element order). */
export const PAIR_CANDIDATES_MAX = 15;
/** Relations read to know which pairs are already related. */
const PAIR_RELATIONS_READ_MAX = 500;
/** Pending source facts read at most. */
export const PENDING_FACTS_READ_MAX = 200;
/** Pending contradictions, open threads read at most. */
export const CONTINUITY_ITEMS_READ_MAX = 100;
/** Pending enrichment proposals read to know which fields wait on the author's decision. */
export const PENDING_PROPOSALS_READ_MAX = 1_000;
/** Placed timeline events read for gaps at most. */
const TIMELINE_ORDER_READ_MAX = 2_000;

/** The kinds a pair question asks about: people and groups, who want things from each other (D30 item 3). */
export const PAIR_KINDS: ReadonlySet<BibleKind> = new Set(['CHARACTER', 'FACTION']);

/** The field an open thread lands in, by its subject's kind: the field that tracks setups and loose ends. Explicit and conservative. */
export const THREAD_LANDING_FIELDS: Readonly<Partial<Record<BibleKind, string>>> = Object.freeze({
    PLOT: 'setups_and_payoffs',
    PLOT_BEAT: 'open_threads',
    CUSTOM: 'open_questions',
    RESEARCH: 'open_questions',
});

const STORY_TIME_KEY = 'story_time';

/** The scope's plain elements (no relation, no element not yet created). */
function plainSubjects(state: Pick<InterviewState, 'elements'>): GeneratorSubject[] {
    return state.elements.filter((e) => !e.relation && !e.pending);
}

export async function loadGeneratorInputs(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    session: SessionRow,
    state: InterviewState,
    frontier: FrontierResult,
): Promise<GeneratorInput> {
    const enabled = generatorsOn(session.generatorsOff ?? []);
    const plain = plainSubjects(state);
    const elementIds = plain.map((e) => e.elementId);
    const relationIds = state.elements.filter((e) => e.relation).map((e) => e.elementId);
    const sessionQuestions = state.questions;

    // THE LADDER, AND THE PAIRS' ANGLES: the book's generator questions about the scope.
    const history = enabled.has('LADDER') || enabled.has('RELATIONS') ? await QuestionRepository.listGeneratorHistory(db, ctx.workspaceId, session.bookId, { elementIds, relationIds }, GENERATOR_HISTORY_READ_MAX) : [];
    const answered = new Set<string>();
    const askedInSession = new Set<string>();
    const pairAnswered = new Map<string, Set<PairAngle>>();
    const pairAsked = new Map<string, Set<PairAngle>>();
    for (const q of history) {
        if (!q.angle) continue;
        if (q.generator === 'LADDER' && q.targetsFieldKeys[0]) {
            const key = ladderKey(q.relationId ?? q.elementId, q.targetsFieldKeys[0], q.angle);
            if (q.answers.length > 0) answered.add(key);
            if (q.sessionId === session.id) askedInSession.add(key);
        } else if (q.generator === 'RELATIONS' && q.pairElementId && (PAIR_ANGLES as readonly string[]).includes(q.angle)) {
            const pair = `${q.elementId}\u0000${q.pairElementId}`;
            const angle = q.angle as PairAngle;
            if (q.answers.length > 0) pairAnswered.set(pair, new Set([...(pairAnswered.get(pair) ?? []), angle]));
            if (q.sessionId === session.id) pairAsked.set(pair, new Set([...(pairAsked.get(pair) ?? []), angle]));
        }
    }

    const set = enabled.has('SOURCES') || enabled.has('LADDER') ? await bookSourceSet(db, ctx, session.bookId) : { bookSourceIds: [], seriesSourceIds: [] };
    const sourceIds = [...set.bookSourceIds, ...set.seriesSourceIds];

    // FACTS HELD per field (the ladder's value).
    const factsHeld = new Map<string, number>();
    if (enabled.has('LADDER')) {
        const kindOf = new Map(plain.map((e) => [e.elementId, e.kind] as const));
        for (const row of await StoryFactRepository.countLiveAbout(db, ctx.workspaceId, session.bookId, sourceIds, elementIds)) {
            const kind = kindOf.get(row.subjectElementId);
            const field = kind ? fieldAnsweredBy(kind, row.predicate) : null;
            if (!field) continue;
            const key = refKey({ elementId: row.subjectElementId, fieldKey: field });
            factsHeld.set(key, (factsHeld.get(key) ?? 0) + row.count);
        }
    }

    // PAIRS: the scope's characters and factions with no relation between them.
    const pairs: PairInput[] = [];
    if (enabled.has('RELATIONS')) {
        const people = plain.filter((e) => PAIR_KINDS.has(e.kind));
        if (people.length >= 2) {
            const related = new Set<string>();
            for (const r of await BibleRelationRepository.listBetween(db, ctx.workspaceId, session.bookId, people.map((e) => e.elementId), PAIR_RELATIONS_READ_MAX)) {
                related.add(`${r.fromElementId}\u0000${r.toElementId}`);
                related.add(`${r.toElementId}\u0000${r.fromElementId}`);
            }
            outer: for (let i = 0; i < people.length; i++) {
                for (let j = i + 1; j < people.length; j++) {
                    if (pairs.length >= PAIR_CANDIDATES_MAX) break outer;
                    const a = people[i];
                    const b = people[j];
                    if (related.has(`${a.elementId}\u0000${b.elementId}`)) continue;
                    const key = `${a.elementId}\u0000${b.elementId}`;
                    pairs.push({ firstElementId: a.elementId, secondElementId: b.elementId, firstName: a.name, secondName: b.name, answered: pairAnswered.get(key) ?? new Set(), askedInSession: pairAsked.get(key) ?? new Set() });
                }
            }
        }
    }

    // PENDING SOURCE FACTS (D30, item 2): the book's own source set only, pending and unflagged, about an element in scope.
    const pendingFacts: PendingFactInput[] = [];
    if (enabled.has('SOURCES') && sourceIds.length > 0 && plain.length > 0) {
        const askedFacts = new Set(sessionQuestions.map((q) => q.storyFactId).filter((id): id is string => id !== null));
        const byId = new Map(plain.map((e) => [e.elementId, e] as const));
        const byName = new Map<string, GeneratorSubject | null>();
        for (const e of plain) {
            const k = nameKey(e.name);
            byName.set(k, byName.has(k) ? null : e);
        }
        const facts = (await StoryFactRepository.listPendingUnflagged(db, ctx.workspaceId, sourceIds, PENDING_FACTS_READ_MAX)).filter((f) => !askedFacts.has(f.id));
        const resolved = facts.flatMap((f) => {
            // A series fact's stored link is never this book's (4.0): only a book library's fact carries one.
            const subject = (f.subjectElementId ? byId.get(f.subjectElementId) : undefined) ?? byName.get(nameKey(f.subjectName)) ?? null;
            return subject ? [{ f, subject }] : [];
        });
        const series = new Set(set.seriesSourceIds);
        const sources = new Map((await SourceRepository.listByIds(db, ctx.workspaceId, [...new Set(resolved.map((r) => r.f.sourceId))])).map((s) => [s.id, s] as const));
        const headings = new Map((await SourceChunkRepository.headingsOf(db, ctx.workspaceId, [...new Set(resolved.map((r) => r.f.chunkId))])).map((c) => [c.id, decodeHeadingPath(c.headingPath)] as const));
        for (const { f, subject } of resolved) {
            const key = fieldAnsweredBy(subject.kind, f.predicate);
            const path = headings.get(f.chunkId) ?? [];
            pendingFacts.push({
                factId: f.id,
                subjectElementId: subject.elementId,
                fieldKey: key && getFieldDef(subject.kind, key) ? key : null,
                quote: f.quote,
                sourceName: sources.get(f.sourceId)?.filename ?? 'your draft',
                where: path.length > 0 ? path[path.length - 1] : null,
                // Owner decision 2026-11-26 (B): a series source's fact is decided for every book that uses it.
                series: series.has(f.sourceId),
            });
        }
    }

    // CONTINUITY: contradictions, open threads, timeline gaps about the scope.
    const continuity: ContinuityInput[] = [];
    if (enabled.has('CONTINUITY') && plain.length > 0) {
        const askedRefs = new Set(sessionQuestions.map((q) => q.continuityRef).filter((r): r is string => r !== null));
        const byId = new Map(plain.map((e) => [e.elementId, e] as const));
        const proposals = (await FactProposalRepository.listPendingByReason(db, ctx.workspaceId, session.bookId, 'CONTRADICTED', CONTINUITY_ITEMS_READ_MAX)).filter((p) => p.newerFactId !== null && !askedRefs.has(`proposal:${p.id}`));
        const quotes = new Map((await StoryFactRepository.quotesOf(db, ctx.workspaceId, [...new Set(proposals.flatMap((p) => [p.factId, p.newerFactId!]))])).map((f) => [f.id, f] as const));
        for (const p of proposals) {
            const older = quotes.get(p.factId);
            const newer = quotes.get(p.newerFactId!);
            if (!older || !newer || older.supersededAt || newer.supersededAt) continue;
            const subject = (newer.subjectElementId ? byId.get(newer.subjectElementId) : undefined) ?? (older.subjectElementId ? byId.get(older.subjectElementId) : undefined);
            const field = subject ? fieldAnsweredBy(subject.kind, newer.predicate) ?? fieldAnsweredBy(subject.kind, older.predicate) : null;
            if (!subject || !field) continue;
            continuity.push({ type: 'CONTRADICTION', proposalId: p.id, subjectElementId: subject.elementId, fieldKey: field, olderQuote: older.quote, newerQuote: newer.quote });
        }
        for (const t of await StoryThreadRepository.listOpenAbout(db, ctx.workspaceId, session.bookId, elementIds, CONTINUITY_ITEMS_READ_MAX)) {
            const subject = t.subjectElementId ? byId.get(t.subjectElementId) : undefined;
            const field = subject ? THREAD_LANDING_FIELDS[subject.kind] : undefined;
            if (!subject || !field || askedRefs.has(`thread:${t.id}`)) continue;
            if (t.kind !== 'PROMISE' && t.kind !== 'CLUE' && t.kind !== 'OPEN_QUESTION') continue;
            continuity.push({ type: 'THREAD', threadId: t.id, threadKind: t.kind, subjectElementId: subject.elementId, fieldKey: field, title: t.title });
        }
        continuity.push(...(await timelineGaps(db, ctx, session, plain, frontier, askedRefs)));
    }

    // HOLD FOLLOW-UPS (owner decision 2026-11-26, A): a field whose proposed change the author has not decided yet is
    // asked about by no generator until they decide it; a pair with a new relation pending between them likewise.
    const heldByProposals = new Set<string>();
    const proposals = await EnrichmentProposalRepository.pendingFieldHolds(db, ctx.workspaceId, session.bookId, { elementIds, relationIds }, PENDING_PROPOSALS_READ_MAX);
    for (const p of proposals) {
        if (p.kind === 'FIELD' && p.elementId && p.fieldKey) heldByProposals.add(refKey({ elementId: p.elementId, fieldKey: p.fieldKey }));
        else if (p.kind === 'RELATION_FIELD' && p.relationId && p.fieldKey) heldByProposals.add(refKey({ elementId: p.relationId, fieldKey: p.fieldKey }));
    }
    const pendingLinks = new Set(proposals.flatMap((p) => (p.kind === 'NEW_RELATION' && p.newFromElementId && p.newToElementId ? [[p.newFromElementId, p.newToElementId].sort().join('\u0000')] : [])));
    for (const p of pairs) {
        if (!pendingLinks.has([p.firstElementId, p.secondElementId].sort().join('\u0000'))) continue;
        for (const field of new Set(Object.values(PAIR_ANGLE_FIELD))) heldByProposals.add(refKey({ elementId: pairSubjectId(p.firstElementId, p.secondElementId), fieldKey: field }));
    }

    return { depth: session.depth, detail: session.detail, enabled, subjects: state.elements, frontier, ladder: { answered, askedInSession }, factsHeld, pairs, pendingFacts, continuity, heldByProposals };
}

/**
 * Timeline gaps: a placed TIMELINE_EVENT of the scope whose story time is still open (on the frontier: never one the
 * bible or a fact answers, or one this session touched), between two placed events — its neighbours in the one story
 * order (D25) — that both have a story time.
 */
async function timelineGaps(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    session: SessionRow,
    plain: readonly GeneratorSubject[],
    frontier: FrontierResult,
    askedRefs: ReadonlySet<string>,
): Promise<ContinuityInput[]> {
    const open = new Set(frontier.frontier.filter((f) => f.fieldKey === STORY_TIME_KEY).map((f) => f.elementId));
    const gaps = plain.filter((e) => e.kind === 'TIMELINE_EVENT' && open.has(e.elementId) && !askedRefs.has(`gap:${e.elementId}`));
    if (gaps.length === 0) return [];
    const order = (await BibleElementRepository.rankedInOrder(db, ctx.workspaceId, session.bookId, 'TIMELINE_EVENT', TIMELINE_ORDER_READ_MAX))
        .flatMap((r) => (r.orderRank ? [{ id: r.id, rank: r.orderRank }] : []))
        .sort((a, b) => compareRanks(a.rank, b.rank));
    const at = new Map(order.map((o, i) => [o.id, i] as const));
    const neighbours = gaps.flatMap((g) => {
        const i = at.get(g.elementId);
        return i === undefined || i === 0 || i === order.length - 1 ? [] : [{ g, before: order[i - 1].id, after: order[i + 1].id }];
    });
    if (neighbours.length === 0) return [];
    const ids = [...new Set(neighbours.flatMap((n) => [n.before, n.after]))];
    const times = new Map<string, string>();
    for (const r of await BibleFieldRepository.valuesOfKey(db, ctx.workspaceId, ids, STORY_TIME_KEY)) {
        const text = fieldText(decodeFieldValue(r.value));
        if (text.length > 0) times.set(r.elementId, text);
    }
    const names = new Map((await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, ids)).map((e) => [e.id, e.name] as const));
    return neighbours.flatMap(({ g, before, after }) => {
        const t1 = times.get(before);
        const t2 = times.get(after);
        if (!t1 || !t2) return [];
        return [{ type: 'TIMELINE_GAP' as const, elementId: g.elementId, fieldKey: STORY_TIME_KEY, before: { name: names.get(before) ?? '', time: t1 }, after: { name: names.get(after) ?? '', time: t2 } }];
    });
}
