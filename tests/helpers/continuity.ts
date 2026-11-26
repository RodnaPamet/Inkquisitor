/**
 * Fixtures for continuity (Phase 4.2, D28), made through the product's own
 * usecases: an answer about one element cited by another's accepted version
 * (propagation debt), a thread proposed by a bible fact extraction, a thread
 * added by hand, and a nightly run. Nothing reaches a network.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { createElement, updateElement } from '@/app-layer/usecases/bible-elements';
import { recordVersion } from '@/app-layer/usecases/bible-common';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { startInterview } from '@/app-layer/usecases/interviews';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { createThread } from '@/app-layer/usecases/continuity';
import { executeContinuityDispatch } from '@/app-layer/usecases/continuity-dispatch';
import { executeContinuityCheck, type ContinuityCheckDeps } from '@/app-layer/usecases/continuity-check';
import { CONTINUITY_PASS_SETTLE_MS } from '@/lib/continuity/vocabulary';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import type { FactExtractor } from '@/lib/sources/extractor';
import { fakeGenerator } from './fake-question-generator';
import { stubQuestionEmbedder } from './interview';
import { extractPending } from './facts';
import { setFakeApiKey } from './fake-anthropic';

/** An ANSWERED answer to a question about `elementId` (an element interview's first question). */
export async function answerAbout(ctx: WorkspaceRequestContext, bookId: string, elementId: string, text = 'An answer about it.'): Promise<string> {
    const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: stubQuestionEmbedder });
    const question = view.round!.questions[0];
    await answerQuestion(ctx, bookId, view.session.id, question.id, { text });
    const answer = await runWithoutRls({ reason: 'test' }, (db) => db.answer.findFirstOrThrow({ where: { questionId: question.id, status: 'ANSWERED' }, orderBy: { revision: 'desc' }, select: { id: true } }));
    return answer.id;
}

/** An accepted version of `elementId` drawn from these answers (source INTERVIEW, `sourceAnswerIds`), as reconcile's acceptance writes one. */
export async function citeAnswers(ctx: WorkspaceRequestContext, bookId: string, elementId: string, answerIds: readonly string[]): Promise<void> {
    await runInWorkspaceContext(ctx, async (db) => {
        await BibleElementRepository.lock(db, elementId);
        await recordVersion(db, ctx, bookId, elementId, { source: 'INTERVIEW', sourceAnswerIds: [...answerIds] });
    });
}

/** A scripted bible fact extractor: no facts, and a PROMISE thread for an entry holding `sentence`. */
export function threadExtractor(sentence: string, title: string): () => FactExtractor {
    return () => ({
        async extract(request) {
            const text = request.data.find((b) => b.label === 'entry.text')?.text ?? '';
            const threads = text.includes(sentence) ? [{ kind: 'PROMISE', title, quote: sentence, paysOff: 0 }] : [];
            return { ok: true, output: { facts: [], threads }, tokensUsed: 1, costMicroUsd: 1, callIds: [] };
        },
    });
}

/**
 * Queue and run the nightly check of the workspace's due books (the dispatcher, then each run), the deps given. The
 * night runs, by default, a settle margin (`CONTINUITY_PASS_SETTLE_MS`) after the facts a test has just written, as a
 * real night runs long after the day's saves; a test about the margin itself passes `now`.
 */
export async function runNight(ctx: WorkspaceRequestContext, deps: ContinuityCheckDeps = {}): Promise<Array<string | null>> {
    const queued: string[] = [];
    await executeContinuityDispatch({ enqueue: async (_name, payload) => void queued.push((payload as { runId: string }).runId), workspaceIds: [ctx.workspaceId] });
    const undo = setFakeApiKey();
    try {
        const outcomes: Array<string | null> = [];
        for (const runId of queued) outcomes.push((await executeContinuityCheck({ workspaceId: ctx.workspaceId, runId }, { charge: () => undefined, gate: () => ({ mounted: true, recordKind: 'structural' }), now: () => new Date(Date.now() + CONTINUITY_PASS_SETTLE_MS), ...deps })).outcome);
        return outcomes;
    } finally {
        undo();
    }
}

/** A row in every continuity table: a thread by hand, a thread proposed, a stale flag, a nightly run and its state. */
export async function seedContinuity(ctx: WorkspaceRequestContext, bookId: string, marker: string): Promise<void> {
    const name = `Oath${marker.replace(/[^A-Za-z]/g, '')}`;
    const sentence = `${name} swears to cross the river before the floods.`;
    await createElement(ctx, bookId, { kind: 'CHARACTER', name, summary: sentence });
    await extractPending(ctx, bookId, threadExtractor(sentence, `${name} will cross the river before the floods`));
    await createThread(ctx, bookId, { kind: 'CLUE', title: `A wet boot by the door (${marker})` });
    const upstream = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Up${name}` });
    const downstream = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Down${name}` });
    await citeAnswers(ctx, bookId, downstream.id, [await answerAbout(ctx, bookId, upstream.id)]);
    await updateElement(ctx, bookId, upstream.id, { summary: `Up${name} has changed.`, baseVersion: 1 });
    await runNight(ctx, { checker: () => ({ extract: async () => ({ ok: true, output: { contradictions: [] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] }) }) });
}
