/**
 * "Ask me this differently" (Phase 2.4; design 5.2): replace one unanswered
 * question of the open round with a rephrase. `bible.edit`.
 *
 * In three steps, the model call outside every transaction, as a round's:
 *
 *   1. CHECK (under the session's lock): the question is answerable (an open
 *      round of an active session, not already replaced), has no answer yet
 *      (409 QUESTION_ANSWERED: a rephrase never moves an answer), the round
 *      holds fewer than `REPHRASES_PER_ROUND_MAX` rephrases (409
 *      REPHRASE_LIMIT), the session's token budget can take one more call
 *      (409 TOKEN_BUDGET), the kill switch is off and a call can be made at
 *      all (503 AI_UNAVAILABLE, naming 2.1's reason), and the month can take
 *      it (409 WORKSPACE_CEILING). Nothing is written.
 *   2. REPHRASE (no transaction): `produceRephrase`, one `fast` call through
 *      2.1, held to the rules in `src/lib/interview/rephrase.ts`.
 *   3. PERSIST (under the lock again): the tokens are charged whatever the
 *      outcome; when the question is still unanswered and unreplaced, the
 *      rephrase is written (sanitised again, encrypted; numbered after the
 *      round's last position, shown in the place of the one it replaces) and
 *      the original stamped `supersededAt`, in ONE transaction, then its
 *      vector filed in a transaction of its own. Otherwise 409 (the reason).
 *
 * Nothing acceptable to ask is 409 NO_REPHRASE: the original stands, and the
 * author can still answer, skip or defer it.
 */
import { Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { AnswerRepository, InterviewSessionRepository, QuestionRepository, type QuestionRow } from '@/app-layer/repositories/interview.repository';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError } from '@/lib/errors/types';
import { AiUnavailableError } from '@/lib/ai/errors';
import { dedupeTokens, questionDedupeKey } from '@/lib/interview/dedupe';
import { GenerationStop } from '@/lib/interview/generator';
import { rephraseBudgetSignals } from '@/lib/interview/model-seam';
import { getPacks } from '@/lib/interview/packs';
import { produceRephrase, REPHRASE_PROMPT_VERSION, REPHRASES_PER_ROUND_MAX, TOKENS_PER_REPHRASE_CALL, type RephraseOriginal, type RephraseOutput } from '@/lib/interview/rephrase';
import { encodeJson, decodeOptions, decodeScaleLabels, sanitiseQuestionForStorage } from '@/lib/interview/storage';
import { isPersonaKey } from '@/lib/interview/vocabulary';
import { logger } from '@/lib/observability/logger';
import { requireAnswerable } from './interview-answers';
import { assertModelAvailable, generatorOf, type InterviewDeps } from './interview-rounds';
import { loadInterviewState, questionView, type QuestionView } from './interview-state';
import { defaultQuestionEmbedder, questionRecord, upsertQuestionVectors } from './question-embeddings';

export { REPHRASES_PER_ROUND_MAX };

function originalOf(q: QuestionRow): RephraseOriginal {
    return {
        id: q.id,
        scope: 'SESSION',
        elementId: q.elementId,
        targetsFieldKeys: q.targetsFieldKeys,
        kind: q.kind,
        text: q.text,
        options: decodeOptions(q.options),
        scaleLabels: decodeScaleLabels(q.scaleLabels),
        mode: q.mode,
        challengeQuote: q.challengeQuote,
        personaKey: q.personaKey,
    };
}

export async function rephraseQuestion(
    ctx: WorkspaceRequestContext,
    bookId: string,
    sessionId: string,
    questionId: string,
    deps: Pick<InterviewDeps, 'generator' | 'embedder' | 'packs' | 'signal'> = {},
): Promise<QuestionView> {
    await assertPermission(ctx, 'bible.edit');
    const generator = generatorOf(ctx, deps);
    const packs = deps.packs ?? getPacks();

    // 1. Check, and read what the call needs.
    const prepared = await runInWorkspaceContext(ctx, async (db) => {
        const { session, question } = await requireAnswerable(db, ctx, bookId, sessionId, questionId);
        if ((await AnswerRepository.latestRevision(db, ctx.workspaceId, sessionId, questionId)) > 0) {
            throw new ConflictError('This question has an answer; it is not asked again.', { reason: 'QUESTION_ANSWERED' });
        }
        const state = await loadInterviewState(db, ctx, session);
        const rephrases = state.questions.filter((q) => q.roundId === question.roundId && q.replacesQuestionId !== null).length;
        if (rephrases >= REPHRASES_PER_ROUND_MAX) throw new ConflictError('This round has been asked differently as often as it can be.', { reason: 'REPHRASE_LIMIT', max: REPHRASES_PER_ROUND_MAX });
        if (session.tokensUsed + TOKENS_PER_REPHRASE_CALL > session.tokenBudget) throw new ConflictError('This interview has spent its budget.', { reason: 'TOKEN_BUDGET' });
        const signals = await rephraseBudgetSignals(db, ctx);
        if (signals.killSwitch) throw new AiUnavailableError('AI_DISABLED');
        assertModelAvailable(generator);
        if (signals.workspaceCeilingReached) throw new ConflictError('The monthly AI limit for this workspace has been reached.', { reason: 'WORKSPACE_CEILING' });
        const element = state.elements.find((e) => e.elementId === question.elementId);
        if (!element) throw new NotFoundError('Element not found.');
        return { session, question, state, element };
    });

    const { session, question, state, element } = prepared;
    const personaKey = question.personaKey && isPersonaKey(question.personaKey) ? question.personaKey : null;

    // 2. The call, outside every transaction.
    let output: RephraseOutput | null = null;
    let stop: GenerationStop | null = null;
    try {
        output = await produceRephrase(
            {
                bookId,
                dials: { depth: session.depth, detail: session.detail },
                offerRecommended: session.offerRecommended,
                preferChoice: session.preferChoice,
                persona: personaKey ? packs.personas[personaKey] : null,
                craft: packs.craft,
                element,
                original: originalOf(question),
                related: state.related,
                sessionAnswers: state.promptAnswers,
                asked: state.asked,
            },
            { generator, signal: deps.signal },
        );
    } catch (err) {
        if (!(err instanceof GenerationStop)) throw err;
        stop = err;
    }

    // 3. Persist: tokens always; the rephrase only if the question still waits for one.
    const embedder = deps.embedder === undefined ? defaultQuestionEmbedder() : deps.embedder;
    const created = await runInWorkspaceContext(ctx, async (db) => {
        await InterviewSessionRepository.lock(db, sessionId);
        const tokens = stop ? stop.tokensUsed : (output?.tokensUsed ?? 0);
        if (tokens > 0) await InterviewSessionRepository.addTokens(db, ctx.workspaceId, sessionId, tokens);
        if (stop) return { refused: stop.reason === 'KILL_SWITCH' ? ('KILL_SWITCH' as const) : stop.reason } as const;
        if (!output?.question) return { refused: 'NO_REPHRASE' } as const;

        const current = await QuestionRepository.find(db, ctx.workspaceId, sessionId, questionId);
        const answered = (await AnswerRepository.latestRevision(db, ctx.workspaceId, sessionId, questionId)) > 0;
        if (!current || current.supersededAt !== null || answered) return { refused: answered ? 'QUESTION_ANSWERED' : 'QUESTION_SUPERSEDED' } as const;
        // The session or round may have moved meanwhile: the usual answerable check, under this lock.
        await requireAnswerable(db, ctx, bookId, sessionId, questionId);

        const q = sanitiseQuestionForStorage(output.question);
        const position = (await QuestionRepository.maxPosition(db, ctx.workspaceId, sessionId, question.roundId)) + 1;
        const textCtx = { elementNames: new Map([[element.elementId, element.name]]) };
        const row = await QuestionRepository.create(db, ctx.workspaceId, {
            bookId,
            sessionId,
            roundId: question.roundId,
            position,
            elementId: q.elementId,
            targetsFieldKeys: q.targetsFieldKeys,
            mode: q.mode,
            origin: output.question.origin,
            personaKey: output.question.origin === 'PACK_FALLBACK' ? null : q.personaKey,
            kind: q.kind,
            text: q.text,
            options: encodeJson(q.options),
            scaleLabels: encodeJson(q.scaleLabels),
            recommendedAnswer: output.question.origin === 'PACK_FALLBACK' ? null : encodeJson(q.recommendedAnswer),
            recommendationBasis: output.question.origin === 'PACK_FALLBACK' ? Prisma.DbNull : (q.recommendationBasis ?? Prisma.DbNull),
            rationale: q.rationale,
            challengeQuote: q.challengeQuote,
            dependsOnQuestionIds: question.dependsOnQuestionIds,
            dedupeKey: questionDedupeKey(dedupeTokens(q, textCtx)),
            replacesQuestionId: question.id,
            reviewRequired: output.question.reviewRequired,
        });
        await QuestionRepository.markSuperseded(db, ctx.workspaceId, sessionId, question.id, new Date());
        await logEvent(
            ctx,
            {
                action: 'INTERVIEW_QUESTION_REPHRASED',
                entityType: 'Question',
                entityId: row.id,
                details: { sessionId, replacesQuestionId: question.id, origin: output.question.origin, promptVersion: REPHRASE_PROMPT_VERSION, ...(output.callId ? { aiCallId: output.callId } : {}) },
            },
            { db },
        );
        return { row, view: questionView(row, undefined) } as const;
    });

    if ('refused' in created) {
        if (created.refused === 'KILL_SWITCH') throw new AiUnavailableError('AI_DISABLED');
        throw new ConflictError('The question could not be asked differently.', { reason: created.refused });
    }

    // The vector after the commit: a store failure degrades later deduplication only.
    if (embedder) {
        try {
            const [vector] = await embedder.embed([created.row.text]);
            if (vector) await runInWorkspaceContext(ctx, (db) => upsertQuestionVectors(db, ctx, [questionRecord(created.row.id, bookId, created.row.text, vector, embedder.revision)]));
        } catch (err) {
            logger.warn('interview.question_vectors_not_stored', { component: 'interview', sessionId, count: 1, error: err instanceof Error ? err.name : 'unknown' });
        }
    }
    return created.view;
}
