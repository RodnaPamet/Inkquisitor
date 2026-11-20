/**
 * "Ask me this differently" runs in PRODUCTION without a real-model
 * evaluation record of its own prompt (owner decision D17, 2026-11-20: it
 * only rewords a question the round already validated). Its set, its
 * structural record and the prompt-hash pin stay
 * (`tests/guards/evaluation-records-current.test.ts`); no gate reads them on
 * the request path.
 *
 * Production here is D11's reading, `packRecordMode: 'model'`, with the
 * session's packs mountable — as they are in a production holding real-model
 * pack records (simulated: the pack check is asked under the structural
 * reading, since the shipped pack records are structural). The committed
 * rephrase record is structural; the rephrase is made all the same.
 */
jest.mock('@/lib/interview/pack-mount', () => {
    const actual = jest.requireActual<typeof import('@/lib/interview/pack-mount')>('@/lib/interview/pack-mount');
    return {
        ...actual,
        packMounts: (packs: Parameters<typeof actual.packMounts>[0], _mode: Parameters<typeof actual.packMounts>[1], names?: Parameters<typeof actual.packMounts>[2]) =>
            actual.packMounts(packs, 'structural', names),
    };
});

import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { startInterview } from '@/app-layer/usecases/interviews';
import { rephraseQuestion } from '@/app-layer/usecases/interview-rephrase';
import committed from '@/lib/interview/evals/rephrase-evaluation-record.json';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

it('rephrases a question under production’s reading of D11, with only the structural rephrase record committed', async () => {
    expect(committed.generator.kind).toBe('structural');
    const ctx = workspaceCtx(await createAccount({ workspaceName: 'Rephrase in production' }));
    const bookId = (await createBook(ctx, { title: 'The Weir Ledger' })).id;
    const elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Tamsin Reed', fields: [{ key: 'role', value: 'A lock keeper on the old canal.' }] })).id;
    const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
    const q = view.round!.questions[0];
    const generator = fakeGenerator({
        mutate: (candidate, request) =>
            request.data.some((b) => b.label === 'previous-wording') ? { ...candidate, text: `Picture a reader meeting the ${candidate.targetsFieldKeys[0].split('_').join(' ')}: what do they notice first?` } : candidate,
    });

    const rephrased = await rephraseQuestion(ctx, bookId, view.session.id, q.id, { generator, embedder: null, packRecordMode: 'model' });

    expect(rephrased.replacesQuestionId).toBe(q.id);
    expect(rephrased.text).not.toBe(q.text);
    expect(await prisma.question.count({ where: { sessionId: view.session.id, replacesQuestionId: q.id } })).toBe(1);
});
