/**
 * Integration fixtures for the question engine (Phase 2.2): an interview
 * started, generated and answered through the product's own usecases, with
 * the deterministic fake generator (no model is called) and the stub
 * embedder, so every row is sanitised, encrypted and vectorised exactly as a
 * request would leave it.
 */
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { startInterview } from '@/app-layer/usecases/interviews';
import { embedderFrom } from '@/app-layer/usecases/question-embeddings';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { fakeGenerator } from './fake-question-generator';

export const stubQuestionEmbedder = embedderFrom(new StubEmbeddingProvider());

/** An element interview with its first round generated and its first question answered. */
export async function seedInterview(ctx: WorkspaceRequestContext, bookId: string, elementId: string, marker = 'seed') {
    const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: stubQuestionEmbedder });
    const question = view.round!.questions[0];
    await answerQuestion(ctx, bookId, view.session.id, question.id, { text: `Answer ${marker}` });
    return { sessionId: view.session.id, questionId: question.id };
}
