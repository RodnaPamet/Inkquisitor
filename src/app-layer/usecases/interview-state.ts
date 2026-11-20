/**
 * What the interview usecases share (Phase 2.2): loading a session's state
 * for the pure core, and the views the API returns.
 *
 * Not a public usecase module: every function here runs inside a transaction
 * a usecase opened with `runInWorkspaceContext` after asking its permission.
 *
 * THE STATE a round is planned from, read in one transaction:
 *
 *   elements    the scope's elements (one; one kind's; the book's), in kind
 *               then creation order, each with its template and its stored
 *               values as text (rich text without markup, a list joined);
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
import { BibleElementRepository, BibleFieldRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
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
import { getTemplate } from '@/lib/bible/templates';
import { plainBlock } from '@/lib/bible/text';
import type { AskedQuestion } from '@/lib/interview/dedupe';
import { computeFrontier, emptyFrontierReason, type AnswerFact, type BlockedField, type FieldRef, type FrontierResult } from '@/lib/interview/frontier';
import type { RoundPlan } from '@/lib/interview/plan';
import type { PromptAnswer } from '@/lib/interview/prompt';
import type { RoundElement } from '@/lib/interview/round';
import { sessionProgress, type SessionProgress } from '@/lib/interview/stop';
import { decodeOptions, decodeRecommendation, decodeScaleLabels } from '@/lib/interview/storage';
import { isPersonaKey, type AnswerStatus, type StopReason } from '@/lib/interview/vocabulary';
import { PERSONA_DISPLAY_NAMES } from '@/lib/interview/packs';
import { parsePackPins } from '@/lib/interview/pack-mount';

/** At most this many elements a kind or book session questions (a larger scope is cut, and says so). */
export const SCOPE_ELEMENTS_MAX = 60;
/** Questions of a session read at most (six rounds of at most eight). */
export const SESSION_QUESTIONS_MAX = 60;
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
    elements: RoundElement[];
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
        elementId: q.elementId,
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
    const rows = await BibleElementRepository.listForInterview(db, ctx.workspaceId, session.bookId, {
        kind: session.scope === 'KIND' ? session.targetKind! : undefined,
        take: SCOPE_ELEMENTS_MAX + 1,
    });
    return { rows: rows.slice(0, SCOPE_ELEMENTS_MAX), truncated: rows.length > SCOPE_ELEMENTS_MAX };
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

    const questions = await QuestionRepository.listForSession(db, ctx.workspaceId, session.id, SESSION_QUESTIONS_MAX);
    const latest = latestAnswers(await AnswerRepository.listForSession(db, ctx.workspaceId, session.id, SESSION_ANSWERS_MAX));
    const answerFacts: AnswerFact[] = [];
    const promptAnswers: PromptAnswer[] = [];
    for (const q of questions) {
        const a = latest.get(q.id);
        if (!a) continue;
        answerFacts.push({ status: a.status, targets: q.targetsFieldKeys.map((fieldKey) => ({ elementId: q.elementId, fieldKey })) });
        promptAnswers.push({
            answerId: a.id,
            elementId: q.elementId,
            targetsFieldKeys: q.targetsFieldKeys,
            questionKind: q.kind,
            question: q.text,
            status: a.status,
            answer: answerText(a),
        });
    }
    const elsewhere = await QuestionRepository.listForElementsElsewhere(db, ctx.workspaceId, session.bookId, ids, session.id, BOOK_QUESTIONS_MAX);
    const asked = [...questions.map((q) => asAsked(q, 'SESSION')), ...elsewhere.map((q) => asAsked(q, 'BOOK'))];

    let related: InterviewState['related'] = [];
    if (session.scope === 'ELEMENT') {
        const relations = await BibleRelationRepository.listForElement(db, ctx.workspaceId, session.bookId, session.targetElementId!, RELATED_MAX);
        const otherIds = [...new Set(relations.map((r) => (r.fromElementId === session.targetElementId ? r.toElementId : r.fromElementId)))];
        const others = await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, otherIds);
        related = others.map((o) => ({ kind: o.kind, name: o.name, summary: o.summary }));
    }

    const rounds = await InterviewRoundRepository.listForSession(db, ctx.workspaceId, session.id, SESSION_ROUNDS_READ);
    const challenged = questions.filter((q) => q.mode === 'CHALLENGE').map((q) => ({ elementId: q.elementId, fieldKey: q.targetsFieldKeys[0] }));
    const challengesPlanned = rounds.filter((r) => (r.plan as { challenge?: unknown } | null)?.challenge).length;

    return { elements, scopeTruncated: scope.truncated, questions, latest, answerFacts, promptAnswers, asked, related, rounds, challenged, challengesPlanned };
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
        depth,
    });
}

/** Stored fields within the depth that this session may still challenge, in frontier order. */
export function challengeableOf(frontier: FrontierResult, depth: number): Array<FieldRef & { level: number }> {
    return frontier.answered.filter((a) => a.by === 'bible-values' && a.level <= depth).map((a) => ({ elementId: a.elementId, fieldKey: a.fieldKey, level: a.level }));
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
    elementId: string;
    targetsFieldKeys: string[];
    mode: 'FRONTIER' | 'CHALLENGE';
    origin: 'MODEL' | 'PACK_FALLBACK';
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
    targetKind: SessionRow['targetKind'];
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
    createdAt: string;
    endedAt: string | null;
}

export function sessionSummaryView(s: SessionRow): SessionSummaryView {
    return {
        id: s.id,
        bookId: s.bookId,
        scope: s.scope,
        targetElementId: s.targetElementId,
        targetKind: s.targetKind,
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
        createdAt: s.createdAt.toISOString(),
        endedAt: s.endedAt ? s.endedAt.toISOString() : null,
    };
}

export interface InterviewView {
    session: SessionSummaryView;
    /** Over every question the session asked; NOT_ASSESSED when it asked none (rule 6). */
    progress: SessionProgress;
    /** The round the author is in (OPEN), or the last one; null before the first. */
    round: { id: string; number: number; status: RoundRow['status']; questions: QuestionView[] } | null;
    scopeTruncated: boolean;
}

export function interviewView(session: SessionRow, state: Pick<InterviewState, 'questions' | 'latest' | 'rounds' | 'scopeTruncated'>): InterviewView {
    const round = [...state.rounds].reverse().find((r) => r.status === 'OPEN' || r.status === 'CLOSED') ?? null;
    return {
        session: sessionSummaryView(session),
        progress: sessionProgress(state.questions.map((q) => ({ status: state.latest.get(q.id)?.status ?? null }))),
        round: round
            ? {
                  id: round.id,
                  number: round.number,
                  status: round.status,
                  questions: state.questions.filter((q) => q.roundId === round.id).map((q) => questionView(q, state.latest.get(q.id))),
              }
            : null,
        scopeTruncated: state.scopeTruncated,
    };
}
