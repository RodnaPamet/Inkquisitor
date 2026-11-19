/**
 * Interviews of a book's bible (Phase 2.2): start one, read them, generate
 * the next round, close a round, stop.
 *
 * Permissions: `bible.edit` runs an interview (start, next round, close,
 * stop, and the answers in `interview-answers.ts`), because an interview is
 * how the bible is written to (2.5 turns its answers into accepted bible
 * changes); `bible.view` reads interviews, which every member holds, as they
 * read the bible itself. The questions and answers are author text: a
 * reader of the book may read them, as they may read the bible.
 *
 * A session's lifecycle:
 *
 *   start        ACTIVE, round 1 generated (or, when the scope already has
 *                nothing to ask at its depth, COMPLETED at once with the
 *                reason — no model needed for that)
 *   close round  every question has a status (`skipUnanswered` records SKIPPED
 *                for the rest, the author's own act); the round is CLOSED and
 *                the frontier recomputed: the session ends here when nothing
 *                is left to ask or its rounds are spent, and says which
 *   next round   generates the next round (a PAUSED session resumes here)
 *   stop         STOPPED, AUTHOR_STOPPED; every answer given is kept
 *
 * A request that needs the model (start, next round) refuses 503
 * `MODEL_NOT_WIRED` until 2.1 wires it (`src/lib/interview/model-seam.ts`),
 * before writing anything. Nothing here fakes model output.
 *
 * A scope with no element (a kind the book has none of) is refused 400
 * `SCOPE_EMPTY`: a session over nothing would "complete" having asked
 * nothing, and zero is never complete (rule 6).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { AnswerRepository, InterviewRoundRepository, InterviewSessionRepository, QuestionRepository, type SessionRow } from '@/app-layer/repositories/interview.repository';
import { CloseRoundInput, InterviewStartInput, RoundNumberParam } from '@/app-layer/schemas/interview';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { DEFAULT_DIALS, roundBudgetFor, tokenBudgetFor } from '@/lib/interview/dials';
import { requireBook, requireElement } from './bible-common';
import {
    claimRound,
    endSession,
    generateClaimedRound,
    generatorOf,
    stopNow,
    type InterviewDeps,
} from './interview-rounds';
import { skipUnanswered } from './interview-answers';
import {
    interviewView,
    latestAnswers,
    loadInterviewState,
    requireSession,
    sessionSummaryView,
    SESSION_ANSWERS_MAX,
    SESSION_QUESTIONS_MAX,
    type InterviewView,
    type SessionSummaryView,
} from './interview-state';

export type { InterviewDeps } from './interview-rounds';

/** A book's interviews listed at most. */
export const INTERVIEW_LIST_MAX = 100;

function assertNotEnded(session: SessionRow): void {
    if (session.status === 'COMPLETED' || session.status === 'STOPPED') {
        throw new ConflictError('This interview has ended.', { reason: 'INTERVIEW_ENDED', status: session.status, stopReason: session.stopReason });
    }
}

async function viewOf(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string): Promise<InterviewView> {
    const session = await requireSession(db, ctx, bookId, sessionId);
    const state = await loadInterviewState(db, ctx, session);
    return interviewView(session, state);
}

export async function startInterview(ctx: WorkspaceRequestContext, bookId: string, input: unknown, deps: InterviewDeps = {}): Promise<InterviewView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = InterviewStartInput.parse(input);
    const generator = generatorOf(deps);
    const depth = parsed.depth ?? DEFAULT_DIALS.depth;
    const detail = parsed.detail ?? DEFAULT_DIALS.detail;
    const personaKeys = parsed.persona ? [parsed.persona] : [];

    const started = await runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        if (parsed.scope === 'ELEMENT') await requireElement(db, ctx, bookId, parsed.elementId!);
        else {
            const any = await BibleElementRepository.listForInterview(db, ctx.workspaceId, bookId, { kind: parsed.kind, take: 1 });
            if (any.length === 0) throw new ValidationError('There is nothing in this book to ask about yet.', { reason: 'SCOPE_EMPTY' });
        }
        const session = await InterviewSessionRepository.create(db, ctx.workspaceId, {
            bookId,
            scope: parsed.scope,
            targetElementId: parsed.scope === 'ELEMENT' ? parsed.elementId! : null,
            targetKind: parsed.scope === 'KIND' ? parsed.kind! : null,
            depth,
            detail,
            personaKeys,
            offerRecommended: parsed.offerRecommended ?? true,
            preferChoice: parsed.preferChoice ?? false,
            roundBudget: roundBudgetFor(depth),
            tokenBudget: tokenBudgetFor(depth, personaKeys.length),
            createdById: ctx.userId,
        });
        await logEvent(
            ctx,
            {
                action: 'INTERVIEW_STARTED',
                entityType: 'InterviewSession',
                entityId: session.id,
                details: { bookId, scope: parsed.scope, targetElementId: session.targetElementId, targetKind: session.targetKind, depth, detail, personaKeys },
            },
            { db },
        );
        return { session, claim: await claimRound(db, ctx, session, generator) };
    });
    if (started.claim.kind === 'claimed') await generateClaimedRound(ctx, started.session, started.claim, deps);
    return runInWorkspaceContext(ctx, (db) => viewOf(db, ctx, bookId, started.session.id));
}

export async function listInterviews(ctx: WorkspaceRequestContext, bookId: string): Promise<{ sessions: SessionSummaryView[]; truncated: boolean }> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const rows = await InterviewSessionRepository.listForBook(db, ctx.workspaceId, bookId, INTERVIEW_LIST_MAX + 1);
        return { sessions: rows.slice(0, INTERVIEW_LIST_MAX).map(sessionSummaryView), truncated: rows.length > INTERVIEW_LIST_MAX };
    });
}

export async function getInterview(ctx: WorkspaceRequestContext, bookId: string, sessionId: string): Promise<InterviewView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        return viewOf(db, ctx, bookId, sessionId);
    });
}

/** Generate the session's next round (a paused session resumes). */
export async function nextRound(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, deps: InterviewDeps = {}): Promise<InterviewView> {
    await assertPermission(ctx, 'bible.edit');
    const generator = generatorOf(deps);
    const claimed = await runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await InterviewSessionRepository.lock(db, sessionId);
        const session = await requireSession(db, ctx, bookId, sessionId);
        assertNotEnded(session);
        return { session, claim: await claimRound(db, ctx, session, generator) };
    });
    if (claimed.claim.kind === 'claimed') await generateClaimedRound(ctx, claimed.session, claimed.claim, deps);
    return runInWorkspaceContext(ctx, (db) => viewOf(db, ctx, bookId, sessionId));
}

/**
 * Close the session's open round `roundNumber`. Every question needs a
 * status: an unanswered one refuses 409 `ROUND_HAS_UNANSWERED`, unless
 * `skipUnanswered`, which records a SKIPPED answer for each (the author's own
 * act). Then the session stops if nothing is left to ask or its rounds are
 * spent, and says which.
 */
export async function closeRound(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, roundNumberParam: string, input: unknown): Promise<InterviewView> {
    await assertPermission(ctx, 'bible.edit');
    const roundNumber = RoundNumberParam.parse(roundNumberParam);
    const parsed = CloseRoundInput.parse(input ?? {});
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await InterviewSessionRepository.lock(db, sessionId);
        const session = await requireSession(db, ctx, bookId, sessionId);
        assertNotEnded(session);
        const rounds = await InterviewRoundRepository.listForSession(db, ctx.workspaceId, sessionId, 50);
        const round = rounds.find((r) => r.number === roundNumber);
        if (!round) throw new NotFoundError('Round not found.');
        if (round.status !== 'OPEN') throw new ConflictError('That round is not open.', { reason: 'ROUND_NOT_OPEN', status: round.status });

        const questions = await QuestionRepository.listForRound(db, ctx.workspaceId, sessionId, round.id, SESSION_QUESTIONS_MAX);
        const latest = latestAnswers(await AnswerRepository.listForSession(db, ctx.workspaceId, sessionId, SESSION_ANSWERS_MAX));
        const unanswered = questions.filter((q) => !latest.has(q.id));
        if (unanswered.length > 0 && !parsed.skipUnanswered) {
            throw new ConflictError('Some questions of this round have no answer yet.', { reason: 'ROUND_HAS_UNANSWERED', unanswered: unanswered.length });
        }
        await skipUnanswered(db, ctx, sessionId, unanswered.map((q) => q.id));
        await InterviewRoundRepository.update(db, ctx.workspaceId, round.id, { status: 'CLOSED', closedAt: new Date() });
        await InterviewSessionRepository.update(db, ctx.workspaceId, sessionId, { roundsRun: session.roundsRun + 1 });
        await logEvent(
            ctx,
            {
                action: 'INTERVIEW_ROUND_CLOSED',
                entityType: 'InterviewRound',
                entityId: round.id,
                details: { sessionId, roundNumber, questionCount: questions.length, skippedAtClose: unanswered.length },
            },
            { db },
        );

        const after = await requireSession(db, ctx, bookId, sessionId);
        const state = await loadInterviewState(db, ctx, after);
        const stop = stopNow(after, state);
        if (stop) await endSession(db, ctx, after, stop.reason, stop.detail);
        return viewOf(db, ctx, bookId, sessionId);
    });
}

/** The author stops: every answer given is kept; a round in flight is closed as it stands. */
export async function stopInterview(ctx: WorkspaceRequestContext, bookId: string, sessionId: string): Promise<InterviewView> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await InterviewSessionRepository.lock(db, sessionId);
        const session = await requireSession(db, ctx, bookId, sessionId);
        assertNotEnded(session);
        const rounds = await InterviewRoundRepository.listForSession(db, ctx.workspaceId, sessionId, 50);
        let roundsRun = session.roundsRun;
        for (const r of rounds) {
            if (r.status === 'OPEN') {
                await InterviewRoundRepository.update(db, ctx.workspaceId, r.id, { status: 'CLOSED', closedAt: new Date() });
                roundsRun += 1;
            } else if (r.status === 'GENERATING') {
                await InterviewRoundRepository.update(db, ctx.workspaceId, r.id, { status: 'FAILED' });
            }
        }
        if (roundsRun !== session.roundsRun) await InterviewSessionRepository.update(db, ctx.workspaceId, sessionId, { roundsRun });
        await endSession(db, ctx, { ...session, roundsRun }, 'AUTHOR_STOPPED', { roundsRun });
        return viewOf(db, ctx, bookId, sessionId);
    });
}
