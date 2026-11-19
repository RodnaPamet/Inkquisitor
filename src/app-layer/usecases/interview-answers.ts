/**
 * Answering a question (Phase 2.2): answer it, skip it, or set it aside to
 * decide later. `bible.edit`.
 *
 * An answer is author text: sanitised here (`plainBlock` for written text,
 * `plainLine` for a pick), bounded by the session's detail dial (refused
 * beyond, never cut: 400 `ANSWER_TOO_LONG`), encrypted at rest, and never
 * logged. It must fit its question's kind:
 *
 *   OPEN, SCENARIO   `text`, non-empty after sanitising
 *   CHOICE, EITHER_OR  `choice`, one of the question's options exactly; an
 *                    optional `text` is the reason given with the pick
 *   SCALE            `scale`, 1..5; an optional `text` reason
 *   any              `acceptRecommendation: true` takes the recommended answer
 *                    as offered (400 `NO_RECOMMENDATION` when there is none)
 *
 * Answers are APPEND-ONLY (the table's trigger refuses UPDATE and DELETE): a
 * re-answer, while its round is open, is a NEW row with the next revision,
 * and the latest revision is the answer. Once the round is closed its
 * answers are what the round said (409 `ROUND_NOT_OPEN`): 2.5 reconciles them
 * into proposals that cite them by id.
 */
import type { AnswerStatus } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { AnswerRepository, InterviewRoundRepository, InterviewSessionRepository, QuestionRepository, type QuestionRow, type SessionRow } from '@/app-layer/repositories/interview.repository';
import { AnswerInput } from '@/app-layer/schemas/interview';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { plainBlock, plainLine } from '@/lib/bible/text';
import { answerTextMax } from '@/lib/interview/dials';
import { decodeOptions, decodeRecommendation } from '@/lib/interview/storage';
import { requireBook } from './bible-common';
import { questionView, requireSession, type QuestionView } from './interview-state';

interface AnswerValue {
    status: AnswerStatus;
    text: string | null;
    choice: string | null;
    scale: number | null;
    acceptedRecommendation: boolean;
}

const SKIP: Omit<AnswerValue, 'status'> = { text: null, choice: null, scale: null, acceptedRecommendation: false };

/**
 * Append one answer row for a question, the next revision. The one writer of
 * an answer: every value reaching it is sanitised by the callers below (the
 * skip and decide-later rows carry no value).
 */
export async function recordAnswer(db: PrismaTx, ctx: WorkspaceRequestContext, sessionId: string, questionId: string, value: AnswerValue) {
    const revision = (await AnswerRepository.latestRevision(db, ctx.workspaceId, sessionId, questionId)) + 1;
    return AnswerRepository.create(db, ctx.workspaceId, {
        sessionId,
        questionId,
        revision,
        status: value.status,
        text: value.text === null ? null : plainBlock(value.text),
        choice: value.choice === null ? null : plainLine(value.choice),
        scale: value.scale,
        acceptedRecommendation: value.acceptedRecommendation,
        answeredById: ctx.userId,
    });
}

function boundedText(raw: string | undefined, session: SessionRow, required: boolean): string | null {
    if (raw === undefined) {
        if (required) throw new ValidationError('This question needs a written answer.', { reason: 'ANSWER_REQUIRED' });
        return null;
    }
    const text = plainBlock(raw);
    if (text.length === 0) {
        if (required) throw new ValidationError('This question needs a written answer.', { reason: 'ANSWER_REQUIRED' });
        return null;
    }
    const max = answerTextMax(session.detail);
    if (text.length > max) throw new ValidationError('This answer is longer than the interview allows.', { reason: 'ANSWER_TOO_LONG', max });
    return text;
}

/** The value an answer input gives this question, sanitised and checked against its kind. */
export function answerValueFor(question: QuestionRow, session: SessionRow, input: AnswerInput): AnswerValue {
    if (input.acceptRecommendation) {
        if (input.text !== undefined || input.choice !== undefined || input.scale !== undefined) {
            throw new ValidationError('Take the recommended answer, or give your own, not both.', { reason: 'ANSWER_SHAPE' });
        }
        const rec = decodeRecommendation(question.recommendedAnswer);
        if (rec === null) throw new ValidationError('This question offers no recommended answer.', { reason: 'NO_RECOMMENDATION' });
        if (question.kind === 'SCALE') return { status: 'ANSWERED', text: null, choice: null, scale: rec as number, acceptedRecommendation: true };
        if (question.kind === 'CHOICE' || question.kind === 'EITHER_OR') return { status: 'ANSWERED', text: null, choice: String(rec), scale: null, acceptedRecommendation: true };
        return { status: 'ANSWERED', text: String(rec), choice: null, scale: null, acceptedRecommendation: true };
    }
    switch (question.kind) {
        case 'OPEN':
        case 'SCENARIO': {
            if (input.choice !== undefined || input.scale !== undefined) throw new ValidationError('This question takes a written answer.', { reason: 'ANSWER_SHAPE' });
            return { status: 'ANSWERED', text: boundedText(input.text, session, true), choice: null, scale: null, acceptedRecommendation: false };
        }
        case 'CHOICE':
        case 'EITHER_OR': {
            if (input.scale !== undefined) throw new ValidationError('This question takes one of its options.', { reason: 'ANSWER_SHAPE' });
            if (input.choice === undefined) throw new ValidationError('Pick one of the options.', { reason: 'ANSWER_REQUIRED' });
            const choice = plainLine(input.choice);
            if (!(decodeOptions(question.options) ?? []).includes(choice)) throw new ValidationError('That is not one of the options.', { reason: 'NOT_AN_OPTION' });
            return { status: 'ANSWERED', text: boundedText(input.text, session, false), choice, scale: null, acceptedRecommendation: false };
        }
        case 'SCALE': {
            if (input.choice !== undefined) throw new ValidationError('This question takes a number from 1 to 5.', { reason: 'ANSWER_SHAPE' });
            if (input.scale === undefined) throw new ValidationError('Give a number from 1 to 5.', { reason: 'ANSWER_REQUIRED' });
            return { status: 'ANSWERED', text: boundedText(input.text, session, false), choice: null, scale: input.scale, acceptedRecommendation: false };
        }
    }
}

/** Under the session's lock: the question, in an open round of an active session. */
async function requireAnswerable(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string, questionId: string) {
    await requireBook(db, ctx, bookId);
    await InterviewSessionRepository.lock(db, sessionId);
    const session = await requireSession(db, ctx, bookId, sessionId);
    const question = await QuestionRepository.find(db, ctx.workspaceId, sessionId, questionId);
    if (!question) throw new NotFoundError('Question not found.');
    if (session.status !== 'ACTIVE') throw new ConflictError('This interview is not running.', { reason: 'INTERVIEW_NOT_ACTIVE', status: session.status });
    const round = (await InterviewRoundRepository.listForSession(db, ctx.workspaceId, sessionId, 50)).find((r) => r.id === question.roundId);
    if (round?.status !== 'OPEN') throw new ConflictError('That round is closed; its answers stand.', { reason: 'ROUND_NOT_OPEN' });
    return { session, question };
}

async function record(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, questionId: string, value: (q: QuestionRow, s: SessionRow) => AnswerValue): Promise<QuestionView> {
    return runInWorkspaceContext(ctx, async (db) => {
        const { session, question } = await requireAnswerable(db, ctx, bookId, sessionId, questionId);
        const answer = await recordAnswer(db, ctx, sessionId, questionId, value(question, session));
        return questionView(question, answer);
    });
}

export async function answerQuestion(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, questionId: string, input: unknown): Promise<QuestionView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = AnswerInput.parse(input);
    return record(ctx, bookId, sessionId, questionId, (q, s) => answerValueFor(q, s, parsed));
}

export async function skipQuestion(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, questionId: string): Promise<QuestionView> {
    await assertPermission(ctx, 'bible.edit');
    return record(ctx, bookId, sessionId, questionId, () => ({ status: 'SKIPPED', ...SKIP }));
}

export async function decideLater(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, questionId: string): Promise<QuestionView> {
    await assertPermission(ctx, 'bible.edit');
    return record(ctx, bookId, sessionId, questionId, () => ({ status: 'DECIDE_LATER', ...SKIP }));
}

/** SKIPPED rows for a closing round's unanswered questions (the author's "skip the rest"). */
export async function skipUnanswered(db: PrismaTx, ctx: WorkspaceRequestContext, sessionId: string, questionIds: readonly string[]): Promise<void> {
    for (const questionId of questionIds) await recordAnswer(db, ctx, sessionId, questionId, { status: 'SKIPPED', ...SKIP });
}
