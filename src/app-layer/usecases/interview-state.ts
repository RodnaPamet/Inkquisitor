/**
 * What the interview usecases share (Phase 2.2): loading a session's state
 * for the pure core, and the views the API returns.
 *
 * Not a public usecase module: every function here runs inside a transaction
 * a usecase opened with `runInWorkspaceContext` after asking its permission.
 *
 * THE STATE a round is planned from, read in one transaction:
 *
 *   elements    the scope's SUBJECTS (`src/lib/interview/subjects.ts`): its
 *               elements (one; one kind's; the book's; a selection's), in kind
 *               then creation order, each with its template and its stored
 *               values as text (rich text without markup, a list joined);
 *               since Phase 3.3 a selection's relations too (each with its
 *               type's relation fields and stored values), and a BETWEEN
 *               session's element not yet created (its kind's fields, nothing
 *               stored, its act answered by the slot: `checks`);
 *   answers     this session's questions and the LATEST answer of each;
 *   asked       this session's questions, and earlier sessions' questions
 *               about the same elements (book-wide deduplication), bounded;
 *   related     for an element session, the elements it is related to, with
 *               their summaries (the prompt's context);
 *   challenges  which stored fields this session has already challenged, and
 *               how many challenges its rounds planned.
 */
import type { Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { BibleElementRepository, BibleFieldRepository, BibleRelationFieldRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import {
    AnswerRepository,
    InterviewRoundRepository,
    InterviewSessionRepository,
    QuestionRepository,
    type AnswerRow,
    type QuestionRow,
    type RoundRow,
    type SessionRow,
} from '@/app-layer/repositories/interview.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { NotFoundError } from '@/lib/errors/types';
import { decodeFieldValue, type FieldValue } from '@/lib/bible/field-values';
import type { BibleKind } from '@/lib/bible/kinds';
import { getFieldDef, getRelationType, getTemplate, relationFieldDefs } from '@/lib/bible/templates';
import { plainBlock } from '@/lib/bible/text';
import type { AskedQuestion } from '@/lib/interview/dedupe';
import { bibleFactsCheck, sourceFactsCheck } from './source-retrieval';
import { computeFrontier, emptyFrontierReason, refsCheck, type AlreadyAnsweredCheck, type AnswerFact, type BlockedField, type FieldRef, type FrontierResult } from '@/lib/interview/frontier';
import { slotBeat } from './story-slot';
import { PENDING_SUBJECT_ID, relationSubjectName, subjectIdOf, type RelationSubject } from '@/lib/interview/subjects';
import type { RoundPlan } from '@/lib/interview/plan';
import type { PromptAnswer } from '@/lib/interview/prompt';
import type { RoundElement } from '@/lib/interview/round';
import { sessionProgress, type SessionProgress } from '@/lib/interview/stop';
import { decodeOptions, decodeRecommendation, decodeScaleLabels } from '@/lib/interview/storage';
import { isPersonaKey, type AnswerStatus, type StopReason } from '@/lib/interview/vocabulary';
import { PERSONA_DISPLAY_NAMES } from '@/lib/interview/packs';
import { parsePackPins } from '@/lib/interview/pack-mount';
import { acceptedFieldsCiting, citedAnswersOf, StaleFlagRepository } from '@/app-layer/repositories/continuity.repository';
import { BibleVersionReadRepository } from '@/app-layer/repositories/fact-layer.repository';
import { upstreamChangeText } from '@/lib/continuity/change-text';
import { answersAbout } from '@/lib/continuity/cited';
import { renderElementEntry } from '@/lib/facts/entry-text';
import { parseSnapshot } from '@/lib/bible/snapshot';
import { factSubjectsAndPredicates, StressWeakPointRepository } from '@/app-layer/repositories/interrogation.repository';
import { decodeWeakPointQuestions } from '@/lib/stress-test/storage';
import { WEAK_POINTS_MAX } from '@/lib/stress-test/vocabulary';
import { fieldAnsweredBy } from '@/lib/sources/vocabulary';

/** At most this many elements a kind or book session questions (a larger scope is cut, and says so). */
export const SCOPE_ELEMENTS_MAX = 60;
/** At most this many relations a selection questions (Phase 3.3; the start refuses more, and the CHECK holds it). */
export const SCOPE_RELATIONS_MAX = 60;
/** Stored relation fields read per relation (a type declares at most four). */
const FIELDS_PER_RELATION = 10;
/**
 * Questions of a session read at most: six rounds of at most eight and a
 * challenge, each with up to `REPHRASES_PER_ROUND_MAX` rephrases (Phase 2.4;
 * tests/unit/interview/session-bounds.test.ts holds the product under it).
 */
export const SESSION_QUESTIONS_MAX = 80;
/** Answer rows of a session read at most (every revision). */
export const SESSION_ANSWERS_MAX = 2_000;
/** Earlier sessions' questions about the scope's elements read for deduplication. */
export const BOOK_QUESTIONS_MAX = 500;
/** A session's latest rounds read (the open or generating one is always the newest). */
export const SESSION_ROUNDS_READ = 50;
/** Related elements an element session's prompt carries. */
export const RELATED_MAX = 20;
const FIELDS_PER_ELEMENT = 50;

/** A stored field value as the interviewer reads it: plain text. */
export function fieldText(value: FieldValue): string {
    if (Array.isArray(value)) return value.join('; ');
    if (typeof value === 'number') return String(value);
    return plainBlock(value);
}

/** The stored values of these elements as text, filled fields only, by element then key. */
export async function storedTextOf(db: PrismaTx, ctx: WorkspaceRequestContext, elementIds: readonly string[]): Promise<Map<string, Map<string, string>>> {
    const fields = await BibleFieldRepository.listForElements(db, ctx.workspaceId, elementIds, FIELDS_PER_ELEMENT);
    const stored = new Map<string, Map<string, string>>(elementIds.map((id) => [id, new Map()]));
    for (const f of fields) {
        const text = fieldText(decodeFieldValue(f.value));
        if (text.length > 0) stored.get(f.elementId)?.set(f.key, text);
    }
    return stored;
}

export interface InterviewState {
    /** The scope's subjects: elements, and since Phase 3.3 relations and a BETWEEN session's element not yet created. */
    elements: RoundElement[];
    /** Already-answered checks beyond the bible's own values (Phase 3.3: the BETWEEN slot's act; Phase 4.0: confirmed source facts). */
    checks: AlreadyAnsweredCheck[];
    /** The scope held more elements than `SCOPE_ELEMENTS_MAX`; the rest are not asked about. */
    scopeTruncated: boolean;
    questions: QuestionRow[];
    latest: Map<string, AnswerRow>;
    answerFacts: AnswerFact[];
    promptAnswers: PromptAnswer[];
    asked: AskedQuestion[];
    related: Array<{ kind: BibleKind; name: string; summary: string | null }>;
    rounds: RoundRow[];
    challenged: FieldRef[];
    challengesPlanned: number;
    /**
     * Phase 4.2 (D28): a "grill me on what changed" session's stale entry, the fields of it the change may touch
     * (those its accepted proposals drew from answers about the changed element; every filled one when none can be
     * told), and what changed, as text (author text: a fenced data block only).
     */
    stale?: { elementId: string; fieldKeys: string[]; changeText: string };
    /**
     * Phase 4.3 (D29): a session started from a stress test: its weak points as text (author-derived: a fenced data
     * block only) and the fields of the scope's elements they bear on, challenged first.
     */
    weakPoints?: { text: string; focus: Array<{ elementId: string; fieldKeys: string[] }> };
}

export async function requireSession(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string): Promise<SessionRow> {
    const session = await InterviewSessionRepository.find(db, ctx.workspaceId, bookId, sessionId);
    if (!session) throw new NotFoundError('Interview not found.');
    return session;
}

/** The latest revision of each question's answer. */
export function latestAnswers(rows: readonly AnswerRow[]): Map<string, AnswerRow> {
    const out = new Map<string, AnswerRow>();
    for (const r of rows) {
        const prev = out.get(r.questionId);
        if (!prev || prev.revision < r.revision) out.set(r.questionId, r);
    }
    return out;
}

/** An answer as text (what a recommendation or a later prompt reads). */
export function answerText(a: Pick<AnswerRow, 'status' | 'text' | 'choice' | 'scale'>): string | null {
    if (a.status !== 'ANSWERED') return null;
    return [a.choice, a.scale === null ? null : String(a.scale), a.text].filter((p): p is string => p !== null && p !== '').join(' — ') || null;
}

function asAsked(q: QuestionRow, scope: 'SESSION' | 'BOOK'): AskedQuestion {
    return {
        id: q.id,
        scope,
        elementId: subjectIdOf(q),
        targetsFieldKeys: q.targetsFieldKeys,
        kind: q.kind,
        text: q.text,
        options: decodeOptions(q.options),
        scaleLabels: decodeScaleLabels(q.scaleLabels),
    };
}

async function scopeElements(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow) {
    if (session.scope === 'ELEMENT') {
        const element = await BibleElementRepository.find(db, ctx.workspaceId, session.bookId, session.targetElementId!);
        if (!element) throw new NotFoundError('Element not found.');
        return { rows: [element], truncated: false };
    }
    if (session.scope === 'SELECTION') {
        // Phase 3.3: the elements the author selected; one deleted since is no longer in scope.
        return { rows: await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, session.scopeElementIds.slice(0, SCOPE_ELEMENTS_MAX)), truncated: false };
    }
    if (session.scope === 'BETWEEN') return { rows: [], truncated: false };
    const rows = await BibleElementRepository.listForInterview(db, ctx.workspaceId, session.bookId, {
        kind: session.scope === 'KIND' ? session.targetKind! : undefined,
        take: SCOPE_ELEMENTS_MAX + 1,
    });
    return { rows: rows.slice(0, SCOPE_ELEMENTS_MAX), truncated: rows.length > SCOPE_ELEMENTS_MAX };
}

/** A relation's stored fields as text, by relation then key (filled fields only). */
async function relationStoredText(db: PrismaTx, ctx: WorkspaceRequestContext, relationIds: readonly string[]): Promise<Map<string, Map<string, string>>> {
    const fields = await BibleRelationFieldRepository.listForRelations(db, ctx.workspaceId, relationIds, FIELDS_PER_RELATION);
    const stored = new Map<string, Map<string, string>>(relationIds.map((id) => [id, new Map()]));
    for (const f of fields) {
        const text = fieldText(decodeFieldValue(f.value));
        if (text.length > 0) stored.get(f.relationId)?.set(f.key, text);
    }
    return stored;
}

/** A SELECTION's relations as subjects (Phase 3.3): each with its type's relation fields and its stored values. One deleted since is not asked about. */
async function relationSubjects(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow): Promise<RoundElement[]> {
    if (session.scope !== 'SELECTION' || session.scopeRelationIds.length === 0) return [];
    const rows = await BibleRelationRepository.listByIdsWithEnds(db, ctx.workspaceId, session.bookId, session.scopeRelationIds.slice(0, SCOPE_RELATIONS_MAX));
    const stored = await relationStoredText(db, ctx, rows.map((r) => r.id));
    return rows.map((r) => {
        const relation: RelationSubject = {
            relationId: r.id,
            type: r.type,
            label: getRelationType(r.from.kind, r.type)?.label ?? r.type,
            fromElementId: r.fromElementId,
            toElementId: r.toElementId,
            fromKind: r.from.kind,
            toKind: r.to.kind,
            fromName: r.from.name,
            toName: r.to.name,
        };
        return {
            elementId: r.id,
            kind: r.from.kind,
            name: relationSubjectName(relation),
            customLabel: null,
            fields: relationFieldDefs(r.from.kind, r.type),
            storedText: stored.get(r.id) ?? new Map(),
            relation,
        };
    });
}

/**
 * A BETWEEN session's element not yet created (Phase 3.3), as a subject, and
 * its two neighbours as the prompt's related elements. The slot's act is
 * answered by the slot itself (`checks`): the element joins the lane it was
 * asked about. When a neighbour has gone, there is no slot to ask about.
 *
 * Once the slot holds its beat (proposed and pending, or accepted: `slotBeat`,
 * Phase 3.H), the session GOES ON WITH IT (decision D25 as the owner amended
 * it, 2026-11-20): the subject is still the beat not yet created, so the scope
 * the session started with holds, but it carries the beat's name and what the
 * beat already holds — its proposal's fields, and once accepted its element's
 * — as stored values, so none of them is asked again (rule 5) and the later
 * rounds ask about the rest (cause, effect, stakes and so on).
 */
async function pendingSubject(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow) {
    if (session.scope !== 'BETWEEN' || !session.slotKind || !session.slotAfterElementId || !session.slotBeforeElementId) return null;
    const ends = await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, [session.slotAfterElementId, session.slotBeforeElementId]);
    const after = ends.find((e) => e.id === session.slotAfterElementId);
    const before = ends.find((e) => e.id === session.slotBeforeElementId);
    if (!after || !before) return null;
    const kind = session.slotKind as BibleKind;
    const beat = await slotBeat(db, ctx, session);
    const stored = await storedTextOf(db, ctx, [after.id, before.id]);
    // The neighbours' context: their summary, or failing that what happens in them.
    const contextOf = (e: typeof after) => e.summary ?? stored.get(e.id)?.get('what_happens') ?? null;
    const beatText = new Map<string, string>();
    for (const [key, value] of beat?.fields ?? []) {
        const text = fieldText(value);
        if (text.length > 0) beatText.set(key, text);
    }
    const element: RoundElement = {
        elementId: PENDING_SUBJECT_ID,
        kind,
        name: beat && beat.name !== '' ? beat.name : `${after.name} → … → ${before.name}`,
        customLabel: null,
        fields: getTemplate(kind).fields,
        storedText: beatText,
        pending: { kind, afterElementId: after.id, beforeElementId: before.id, afterName: after.name, beforeName: before.name, act: session.slotAct, ...(beat ? { proposedName: beat.name } : {}) },
    };
    const checks: AlreadyAnsweredCheck[] = session.slotAct && getFieldDef(kind, 'act') ? [refsCheck('between-slot', [{ elementId: PENDING_SUBJECT_ID, fieldKey: 'act' }])] : [];
    const related = [after, before].map((e) => ({ kind: e.kind as BibleKind, name: e.name, summary: contextOf(e) }));
    return { element, checks, related };
}

export async function loadInterviewState(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow): Promise<InterviewState> {
    const scope = await scopeElements(db, ctx, session);
    const ids = scope.rows.map((e) => e.id);
    const stored = await storedTextOf(db, ctx, ids);
    const elements: RoundElement[] = scope.rows.map((e) => ({
        elementId: e.id,
        kind: e.kind,
        name: e.name,
        customLabel: e.customLabel,
        fields: getTemplate(e.kind).fields,
        storedText: stored.get(e.id) ?? new Map(),
    }));
    const relationRows = await relationSubjects(db, ctx, session);
    elements.push(...relationRows);
    const pending = await pendingSubject(db, ctx, session);
    if (pending) elements.push(pending.element);

    const questions = await QuestionRepository.listForSession(db, ctx.workspaceId, session.id, SESSION_QUESTIONS_MAX);
    const latest = latestAnswers(await AnswerRepository.listForSession(db, ctx.workspaceId, session.id, SESSION_ANSWERS_MAX));
    const answerFacts: AnswerFact[] = [];
    const promptAnswers: PromptAnswer[] = [];
    for (const q of questions) {
        const a = latest.get(q.id);
        if (!a) continue;
        const subject = subjectIdOf(q);
        answerFacts.push({ status: a.status, targets: q.targetsFieldKeys.map((fieldKey) => ({ elementId: subject, fieldKey })) });
        promptAnswers.push({
            answerId: a.id,
            elementId: subject,
            targetsFieldKeys: q.targetsFieldKeys,
            questionKind: q.kind,
            question: q.text,
            status: a.status,
            answer: answerText(a),
        });
    }
    const elsewhere = await QuestionRepository.listForElementsElsewhere(db, ctx.workspaceId, session.bookId, ids, session.id, BOOK_QUESTIONS_MAX);
    const relationsElsewhere = await QuestionRepository.listForRelationsElsewhere(db, ctx.workspaceId, session.bookId, relationRows.map((r) => r.elementId), session.id, BOOK_QUESTIONS_MAX);
    const asked = [...questions.map((q) => asAsked(q, 'SESSION')), ...elsewhere.map((q) => asAsked(q, 'BOOK')), ...relationsElsewhere.map((q) => asAsked(q, 'BOOK'))];

    let related: InterviewState['related'] = [];
    if (session.scope === 'ELEMENT') {
        const relations = await BibleRelationRepository.listForElement(db, ctx.workspaceId, session.bookId, session.targetElementId!, RELATED_MAX);
        const otherIds = [...new Set(relations.map((r) => (r.fromElementId === session.targetElementId ? r.toElementId : r.fromElementId)))];
        const others = await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, otherIds);
        related = others.map((o) => ({ kind: o.kind, name: o.name, summary: o.summary }));
    } else if (session.scope === 'SELECTION') {
        // A selected relation's ends that are not themselves selected: the link's context (Phase 3.3).
        const inScope = new Set(ids);
        const endIds = [...new Set(relationRows.flatMap((r) => [r.relation!.fromElementId, r.relation!.toElementId]))].filter((id) => !inScope.has(id)).slice(0, RELATED_MAX);
        const ends = await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, endIds);
        related = ends.map((o) => ({ kind: o.kind, name: o.name, summary: o.summary }));
    } else if (pending) {
        related = pending.related;
    }

    const rounds = await InterviewRoundRepository.listForSession(db, ctx.workspaceId, session.id, SESSION_ROUNDS_READ);
    const challenged = questions.filter((q) => q.mode === 'CHALLENGE').map((q) => ({ elementId: subjectIdOf(q), fieldKey: q.targetsFieldKeys[0] }));
    const challengesPlanned = challengesPlannedOf(rounds);

    // Phase 4.0 (D23, rule 5): a CONFIRMED fact from the book's sources answers its field; a pending one never does.
    const scopeRows = scope.rows.map((e) => ({ elementId: e.id, kind: e.kind, name: e.name }));
    const sourceCheck = await sourceFactsCheck(db, ctx, session.bookId, scopeRows);
    // Phase 4.1 (D27, rule 5): a live fact drawn from an accepted bible version answers its field at once.
    const bibleCheck = await bibleFactsCheck(db, ctx, session.bookId, scopeRows);

    const stale = session.staleFlagId ? await staleContext(db, ctx, session, elements) : undefined;
    const weakPoints = session.stressTestId ? await weakPointContext(db, ctx, session, elements) : undefined;

    return {
        ...(stale ? { stale } : {}),
        ...(weakPoints ? { weakPoints } : {}),
        elements,
        checks: [...(pending?.checks ?? []), sourceCheck, bibleCheck],
        scopeTruncated: scope.truncated,
        questions,
        latest,
        answerFacts,
        promptAnswers,
        asked,
        related,
        rounds,
        challenged,
        challengesPlanned,
    };
}

/** Phase 4.2 (D28): what a grill session on what changed reads (the header of `InterviewState.stale`). */
async function staleContext(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow, elements: readonly RoundElement[]): Promise<InterviewState['stale']> {
    const flag = await StaleFlagRepository.find(db, ctx.workspaceId, session.bookId, session.staleFlagId!);
    const entry = flag ? elements.find((e) => e.elementId === flag.elementId && !e.relation && !e.pending) : undefined;
    if (!flag || !entry) return undefined;
    const after = await BibleVersionReadRepository.elementVersion(db, ctx.workspaceId, flag.upstreamVersionId);
    if (!after) return undefined;
    const before = flag.baseVersionId ? await BibleVersionReadRepository.elementVersion(db, ctx.workspaceId, flag.baseVersionId) : null;
    const changeText = upstreamChangeText(before ? renderElementEntry(parseSnapshot(before.snapshot)) : null, renderElementEntry(parseSnapshot(after.snapshot)));
    const cited = await citedAnswersOf(db, ctx.workspaceId, session.bookId, flag.elementId, CITED_VERSIONS_READ_MAX);
    const relationIds = [...new Set(cited.map((c) => c.questionRelationId).filter((x): x is string => !!x))];
    const ends = new Map((await BibleRelationRepository.listByIdsWithEnds(db, ctx.workspaceId, session.bookId, relationIds)).map((r) => [r.id, { fromElementId: r.fromElementId, toElementId: r.toElementId }] as const));
    const about = answersAbout(flag.upstreamElementId, cited, ends);
    const filled = [...entry.storedText.keys()];
    const drawn = (await acceptedFieldsCiting(db, ctx.workspaceId, flag.elementId, about, CITED_VERSIONS_READ_MAX)).filter((k) => entry.storedText.has(k));
    return { elementId: flag.elementId, fieldKeys: drawn.length > 0 ? drawn : filled, changeText };
}

/**
 * Phase 4.3 (D29): what an interview started from a stress test reads: its weak points (label, questions and the
 * names of the scope's elements each cites, as one data block) and the fields they bear on — a cited fact's field
 * (`fieldAnsweredBy`) on its subject, else every filled field of a cited element. A test whose weak points are gone
 * reads nothing.
 */
async function weakPointContext(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow, elements: readonly RoundElement[]): Promise<InterviewState['weakPoints']> {
    const rows = await StressWeakPointRepository.listForTests(db, ctx.workspaceId, [session.stressTestId!], WEAK_POINTS_MAX);
    if (rows.length === 0) return undefined;
    const inScope = new Map(elements.filter((e) => !e.relation && !e.pending).map((e) => [e.elementId, e] as const));
    const refs = rows.map((r) => (Array.isArray(r.citations) ? (r.citations as Array<{ type?: unknown; id?: unknown }>) : []).filter((c): c is { type: string; id: string } => typeof c.type === 'string' && typeof c.id === 'string'));
    const facts = new Map((await factSubjectsAndPredicates(db, ctx.workspaceId, [...new Set(refs.flat().filter((c) => c.type === 'FACT').map((c) => c.id))])).map((f) => [f.id, f] as const));
    const focus = new Map<string, Set<string>>();
    const add = (elementId: string, keys: Iterable<string>) => {
        const set = focus.get(elementId) ?? new Set<string>();
        for (const k of keys) set.add(k);
        focus.set(elementId, set);
    };
    const blocks = rows.map((r, i) => {
        const about = new Set<string>();
        for (const c of refs[i]) {
            if (c.type === 'ELEMENT' && inScope.has(c.id)) {
                about.add(inScope.get(c.id)!.name);
                if (![...refs[i]].some((x) => x.type === 'FACT' && facts.get(x.id)?.subjectElementId === c.id)) add(c.id, inScope.get(c.id)!.storedText.keys());
            }
            const f = c.type === 'FACT' ? facts.get(c.id) : undefined;
            const subject = f?.subjectElementId ? inScope.get(f.subjectElementId) : undefined;
            if (f && subject) {
                about.add(subject.name);
                const key = fieldAnsweredBy(subject.kind, f.predicate);
                if (key && subject.storedText.has(key)) add(subject.elementId, [key]);
            }
        }
        return { kind: r.kind, weakPoint: r.title, questions: decodeWeakPointQuestions(r.questions), about: [...about] };
    });
    return { text: JSON.stringify(blocks), focus: [...focus].map(([elementId, keys]) => ({ elementId, fieldKeys: [...keys] })).filter((f) => f.fieldKeys.length > 0) };
}

/** A stale entry's citing versions (and accepted proposals) read at most for a grill session. */
const CITED_VERSIONS_READ_MAX = 50;

/**
 * The challenges the session has spent of its per-session limit: those planned
 * by rounds that were ASKED (or are being asked). A round that FAILED asked
 * nothing, so its planned challenge is not spent: failures (a provider
 * outage, a cancelled stream) cannot use up the limit (issue #32, item 6).
 */
export function challengesPlannedOf(rounds: ReadonlyArray<Pick<RoundRow, 'status' | 'plan'>>): number {
    return rounds.filter((r) => r.status !== 'FAILED' && (r.plan as { challenge?: unknown } | null)?.challenge).length;
}

/** The number the session's next round takes: one past the newest (never a count of the rounds read, which are bounded). */
export function nextRoundNumber(state: Pick<InterviewState, 'rounds'>): number {
    return state.rounds.reduce((max, r) => Math.max(max, r.number), 0) + 1;
}

/** The frontier over a loaded state. */
export function frontierOf(state: InterviewState, depth: number): FrontierResult {
    return computeFrontier({
        elements: state.elements.map((e) => ({ elementId: e.elementId, kind: e.kind, fields: e.fields, storedKeys: new Set(e.storedText.keys()) })),
        sessionAnswers: state.answerFacts,
        checks: state.checks,
        depth,
    });
}

/**
 * Stored fields within the depth that this session may still challenge, in
 * frontier order. Never a field of the slot's beat not yet created (Phase 3.H):
 * what its proposal holds is waiting for the author, not stored, and a
 * challenge would ask for an UPDATE of a value nobody has accepted.
 */
export function challengeableOf(frontier: FrontierResult, depth: number): Array<FieldRef & { level: number }> {
    return frontier.answered
        .filter((a) => a.by === 'bible-values' && a.level <= depth && a.elementId !== PENDING_SUBJECT_ID)
        .map((a) => ({ elementId: a.elementId, fieldKey: a.fieldKey, level: a.level }));
}

/** Why the session ended, in ids and keys only (never a value): the session's `stopDetail`. */
export function stopDetailFor(reason: StopReason, frontier: FrontierResult | null, extra: Record<string, unknown> = {}): Prisma.InputJsonValue {
    const ref = (b: BlockedField) => ({ elementId: b.elementId, fieldKey: b.fieldKey, level: b.level, ...(b.waitsOn ? { waitsOn: b.waitsOn } : {}) });
    const detail: Record<string, unknown> = { ...extra };
    if (frontier && (reason === 'FRONTIER_EMPTY' || reason === 'NOTHING_AT_DEPTH')) {
        detail.answered = frontier.answered.length + frontier.answeredInSession.length;
        detail.waitingOnDeferred = frontier.blocked.filter((b) => b.reason === 'WAITS_ON_DEFERRED').map(ref);
        detail.setAside = frontier.blocked.filter((b) => b.reason === 'TOUCHED').map(ref);
        detail.tooDeep = frontier.blocked.filter((b) => b.reason === 'TOO_DEEP').map(ref);
    }
    if (frontier && reason === 'ROUND_BUDGET') detail.remainingOnFrontier = frontier.frontier.length;
    return detail as Prisma.InputJsonValue;
}

/** The frontier says the session has nothing left to ask (and no challenge is due): why. */
export function frontierStop(frontier: FrontierResult, plan: RoundPlan): StopReason | null {
    if (plan.targets.length > 0 || plan.challenge) return null;
    return emptyFrontierReason(frontier.blocked);
}

// ─── Views ─────────────────────────────────────────────────────────

export interface QuestionView {
    id: string;
    position: number;
    /** The element it is filed under (for a relation, its declaring end; for the element not yet created, the slot's anchor). */
    elementId: string;
    /** What it asks about (Phase 3.3, `subjectIdOf`): the element's id, the relation's, or `PENDING_SUBJECT_ID`. */
    subjectId: string;
    /** Phase 3.3: the relation it asks about, or null. */
    relationId: string | null;
    targetsFieldKeys: string[];
    mode: 'FRONTIER' | 'CHALLENGE';
    origin: QuestionRow['origin'];
    /** The persona that worded it (STORM's perspective tag), or null for a pack fallback / a session with none. */
    personaKey: string | null;
    /** That persona's display name (`Gentle Mentor`, …), or null. */
    personaName: string | null;
    kind: QuestionRow['kind'];
    text: string;
    options: string[] | null;
    scaleLabels: { low: string; high: string } | null;
    recommendedAnswer: string | number | null;
    rationale: string | null;
    challengeQuote: string | null;
    dependsOnQuestionIds: string[];
    /** The question this one replaced ("Ask me this differently", Phase 2.4). */
    replacesQuestionId: string | null;
    /** The guard flagged the call that worded it (Phase 2.4): the UI marks it. */
    reviewRequired: boolean;
    answer: {
        revision: number;
        status: AnswerStatus;
        text: string | null;
        choice: string | null;
        scale: number | null;
        acceptedRecommendation: boolean;
    } | null;
}

export function questionView(q: QuestionRow, a: AnswerRow | undefined): QuestionView {
    return {
        id: q.id,
        position: q.position,
        elementId: q.elementId,
        subjectId: subjectIdOf(q),
        relationId: q.relationId,
        targetsFieldKeys: q.targetsFieldKeys,
        mode: q.mode,
        origin: q.origin,
        personaKey: q.personaKey,
        personaName: isPersonaKey(q.personaKey) ? PERSONA_DISPLAY_NAMES[q.personaKey] : null,
        kind: q.kind,
        text: q.text,
        options: decodeOptions(q.options),
        scaleLabels: decodeScaleLabels(q.scaleLabels),
        recommendedAnswer: decodeRecommendation(q.recommendedAnswer),
        rationale: q.rationale,
        challengeQuote: q.challengeQuote,
        dependsOnQuestionIds: q.dependsOnQuestionIds,
        replacesQuestionId: q.replacesQuestionId,
        reviewRequired: q.reviewRequired,
        answer: a
            ? { revision: a.revision, status: a.status, text: a.text, choice: a.choice, scale: a.scale, acceptedRecommendation: a.acceptedRecommendation }
            : null,
    };
}

export interface SessionSummaryView {
    id: string;
    bookId: string;
    scope: SessionRow['scope'];
    targetElementId: string | null;
    /** The ELEMENT session's element's name, where the request read it (the list, Phase 2.4); else null. */
    targetElementName: string | null;
    targetKind: SessionRow['targetKind'];
    /** Phase 3.3: a SELECTION's elements and relations, and a BETWEEN session's slot. */
    scopeElementIds: string[];
    scopeRelationIds: string[];
    slot: { kind: string; afterElementId: string; beforeElementId: string; act: string | null } | null;
    dials: { depth: number; detail: number };
    personaKeys: string[];
    offerRecommended: boolean;
    preferChoice: boolean;
    /** The packs the session mounted, pinned when it started; null for a session from before pinning. */
    packs: Array<{ name: string; version: number; contentHash: string; recordKind: string }> | null;
    status: SessionRow['status'];
    stopReason: SessionRow['stopReason'];
    stopDetail: Prisma.JsonValue;
    roundBudget: number;
    roundsRun: number;
    /** Phase 4.3 (D29): the stress test whose weak points this session questions, or null. */
    stressTestId: string | null;
    createdAt: string;
    endedAt: string | null;
}

export function sessionSummaryView(s: SessionRow, targetElementName: string | null = null): SessionSummaryView {
    return {
        id: s.id,
        bookId: s.bookId,
        scope: s.scope,
        targetElementId: s.targetElementId,
        targetElementName,
        targetKind: s.targetKind,
        scopeElementIds: s.scopeElementIds,
        scopeRelationIds: s.scopeRelationIds,
        slot: s.slotKind && s.slotAfterElementId && s.slotBeforeElementId ? { kind: s.slotKind, afterElementId: s.slotAfterElementId, beforeElementId: s.slotBeforeElementId, act: s.slotAct } : null,
        dials: { depth: s.depth, detail: s.detail },
        personaKeys: s.personaKeys,
        offerRecommended: s.offerRecommended,
        preferChoice: s.preferChoice,
        packs: parsePackPins(s.packPins)?.map((p) => ({ name: p.name, version: p.version, contentHash: p.contentHash, recordKind: p.recordKind })) ?? null,
        status: s.status,
        stopReason: s.stopReason,
        stopDetail: s.stopDetail,
        roundBudget: s.roundBudget,
        roundsRun: s.roundsRun,
        stressTestId: s.stressTestId,
        createdAt: s.createdAt.toISOString(),
        endedAt: s.endedAt ? s.endedAt.toISOString() : null,
    };
}

export interface InterviewView {
    session: SessionSummaryView;
    /** Over every question the session asks (a superseded one is not asked); NOT_ASSESSED when it asked none (rule 6). */
    progress: SessionProgress;
    /**
     * The round the author is in (OPEN), or the last one; null before the
     * first. Its questions are the ones it ASKS: a question a rephrase
     * replaced is left out, and its rephrase stands in its place (Phase 2.4).
     */
    round: { id: string; number: number; status: RoundRow['status']; questions: QuestionView[] } | null;
    /** A round being generated right now (another request's claim), by number; null when none (Phase 2.4). */
    generatingRound: number | null;
    scopeTruncated: boolean;
}

/**
 * The questions a round asks, in the author's order: every question no
 * rephrase replaced, a rephrase standing at the position of the question it
 * replaced (followed back to the round's own question). Pure.
 */
export function askedInOrder(questions: readonly QuestionRow[]): QuestionRow[] {
    const byId = new Map(questions.map((q) => [q.id, q] as const));
    const rootPosition = (q: QuestionRow): number => {
        let at = q;
        for (let hops = 0; at.replacesQuestionId && hops < questions.length; hops++) {
            const prev = byId.get(at.replacesQuestionId);
            if (!prev) break;
            at = prev;
        }
        return at.position;
    };
    return questions
        .filter((q) => q.supersededAt === null)
        .map((q) => ({ q, at: rootPosition(q) }))
        .sort((a, b) => a.at - b.at || a.q.position - b.q.position)
        .map((x) => x.q);
}

export function interviewView(session: SessionRow, state: Pick<InterviewState, 'questions' | 'latest' | 'rounds' | 'scopeTruncated'>): InterviewView {
    const round = [...state.rounds].reverse().find((r) => r.status === 'OPEN' || r.status === 'CLOSED') ?? null;
    const generating = [...state.rounds].reverse().find((r) => r.status === 'GENERATING') ?? null;
    const asked = state.questions.filter((q) => q.supersededAt === null);
    return {
        session: sessionSummaryView(session),
        progress: sessionProgress(asked.map((q) => ({ status: state.latest.get(q.id)?.status ?? null }))),
        round: round
            ? {
                  id: round.id,
                  number: round.number,
                  status: round.status,
                  questions: askedInOrder(state.questions.filter((q) => q.roundId === round.id)).map((q) => questionView(q, state.latest.get(q.id))),
              }
            : null,
        generatingRound: generating ? generating.number : null,
        scopeTruncated: state.scopeTruncated,
    };
}
