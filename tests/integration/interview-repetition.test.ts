/**
 * Repetition (Phase 2.H item 3): no question repeats within a book across
 * sessions, against a real PostgreSQL with the vector store.
 *
 * The generator here is a model that REPEATS ITSELF: the deterministic fake
 * words a field's question the same way every time. Three sessions on one
 * character are started back to back (each re-asks the frontier: earlier
 * sessions' answers do not settle a field). The book's questions are then
 * read and `bookRepetition` must find no repeat — and, so the test is not
 * vacuous, the rounds must record that deduplication actually dropped the
 * repeats the model offered.
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { startInterview, stopInterview } from '@/app-layer/usecases/interviews';
import { bookRepetition } from '@/lib/interview/repetition';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { stubQuestionEmbedder } from '../helpers/interview';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

it('three sessions on one character, a model repeating its wording: no question is asked twice in the book, and the repeats were dropped', async () => {
    const owner = await createAccount();
    const ctx = workspaceCtx(owner);
    const bookId = (await createBook(ctx, { title: 'The Same River' })).id;
    const elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Odile Varga' })).id;
    const generator = fakeGenerator();

    for (let i = 0; i < 3; i++) {
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, { generator, embedder: stubQuestionEmbedder });
        if (view.session.status === 'ACTIVE') await stopInterview(ctx, bookId, view.session.id);
    }

    const rows = await prisma.question.findMany({ where: { bookId }, select: { elementId: true, dedupeKey: true, supersededAt: true }, take: 500 });
    const report = bookRepetition(rows.map((r) => ({ elementId: r.elementId, dedupeKey: r.dedupeKey, superseded: r.supersededAt !== null })));
    expect(report).toMatchObject({ status: 'MEASURED', repeats: 0 });
    expect(report.asked).toBeGreaterThan(0);

    const rounds = await prisma.interviewRound.findMany({ where: { session: { bookId } }, select: { metrics: true }, take: 50 });
    const dropped = rounds.reduce((n, r) => n + Object.values(((r.metrics ?? {}) as { duplicates?: Record<string, number> }).duplicates ?? {}).reduce((a, b) => a + b, 0), 0);
    expect(dropped).toBeGreaterThan(0);
    expect(generator.calls.length).toBeGreaterThanOrEqual(2);
});
