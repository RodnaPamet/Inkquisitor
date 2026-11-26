/**
 * The stubbed model (Phase 2.4, src/lib/ai/model-stub.ts): a test server's
 * stand-in for the Messages API, refused in a real production configuration.
 */
import { productionConfigProblems, productionConfigWarnings } from '@/lib/startup-checks';
import { aiUnavailableReason, stubModelActive } from '@/lib/ai/config';
import { isLoopbackUrl, stubAnswer, stubGapRankAnswer, stubMessagesFetch, stubModelProblems, stubRoundsSummaryAnswer, stubStressTestAnswer } from '@/lib/ai/model-stub';
import { buildStressInput, shownText } from '@/lib/stress-test/input';
import { validateWeakPoints } from '@/lib/stress-test/validate';
import { computeGapCandidates } from '@/lib/gap-hunt/candidates';
import { gapRankBlocks } from '@/lib/gap-hunt/prompt';
import { validateGapPicks } from '@/lib/gap-hunt/validate';
import { getTemplate } from '@/lib/bible/templates';
import { validateRoundsSummary } from '@/lib/interview/compaction-prompt';
import { validateCandidate, candidateFrom, GeneratedQuestionsSchema } from '@/lib/interview/candidates';

const longValue = (seed: string) => `${seed}-`.repeat(8);
/** A production environment fit to run, with AI switched off (as the E2E server's). */
const PROD = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/ink',
    REDIS_URL: 'redis://:pw@redis:6379',
    CLAMAV_HOST: 'clamav:3310',
    FILE_STORAGE_ROOT: '/var/lib/inkquisitor/uploads',
    AUTH_SECRET: longValue('auth'),
    DATA_ENCRYPTION_KEY: longValue('kek'),
    AI_DISABLED: '1',
};

describe('production refuses the stub unless the server is plainly a local test server', () => {
    it('refuses it on a real host: a deployment cannot answer authors with canned questions', () => {
        const problems = productionConfigProblems({ ...PROD, AI_DISABLED: undefined, AI_MODEL_STUB: '1', APP_URL: 'https://inkquisitor.example', NEXTAUTH_URL: 'https://inkquisitor.example' });
        expect(problems.some((p) => p.includes('AI_MODEL_STUB'))).toBe(true);
    });

    it('refuses it with only one of the two addresses on loopback, or with APP_URL unset', () => {
        for (const urls of [
            { APP_URL: 'http://localhost:3312', NEXTAUTH_URL: 'https://inkquisitor.example' },
            { APP_URL: 'https://inkquisitor.example', NEXTAUTH_URL: 'http://localhost:3312' },
            { NEXTAUTH_URL: 'http://localhost:3312' },
        ]) {
            expect(productionConfigProblems({ ...PROD, AI_DISABLED: undefined, AI_MODEL_STUB: '1', ...urls }).some((p) => p.includes('AI_MODEL_STUB'))).toBe(true);
        }
    });

    it('refuses it beside a provider key, and a value other than 1', () => {
        const local = { APP_URL: 'http://localhost:3312', NEXTAUTH_URL: 'http://127.0.0.1:3312' };
        expect(productionConfigProblems({ ...PROD, ...local, AI_DISABLED: undefined, AI_MODEL_STUB: '1', ANTHROPIC_API_KEY: longValue('k'), AI_RETENTION_MODE: 'zdr' }).some((p) => p.includes('beside ANTHROPIC_API_KEY'))).toBe(true);
        expect(stubModelProblems({ AI_MODEL_STUB: 'yes' })).toEqual(['AI_MODEL_STUB must be 1 or unset.']);
        expect(stubModelProblems({ AI_MODEL_STUB: '0', NODE_ENV: 'production' })).toEqual([]);
    });

    it('lets a loopback test server start with it, no key needed, and says so at every start', () => {
        const env = { ...PROD, AI_DISABLED: undefined, AI_MODEL_STUB: '1', APP_URL: 'http://localhost:3312', NEXTAUTH_URL: 'http://localhost:3312' };
        expect(productionConfigProblems(env)).toEqual([]);
        expect(productionConfigWarnings(env).some((w) => w.includes('AI_MODEL_STUB=1'))).toBe(true);
        // Without the stub the same server must hold a key (or AI_DISABLED=1).
        expect(productionConfigProblems({ ...env, AI_MODEL_STUB: undefined }).some((p) => p.includes('ANTHROPIC_API_KEY is required'))).toBe(true);
    });

    it('never answers for a real host in production, even where the start-up check did not run (D13)', () => {
        // The start-up check is skipped for `next build` (NEXT_PHASE): a process carrying that marker is not checked at all.
        const unchecked = { ...PROD, AI_DISABLED: undefined, AI_MODEL_STUB: '1', APP_URL: 'https://inkquisitor.example', NEXTAUTH_URL: 'https://inkquisitor.example', NEXT_PHASE: 'phase-production-build' };
        expect(productionConfigProblems(unchecked)).toEqual([]);
        // The stub itself still refuses: no call is possible, and none would be answered by the stub.
        expect(stubModelActive(unchecked)).toBe(false);
        expect(aiUnavailableReason(unchecked)).toBe('CREDENTIAL_NOT_CONFIGURED');
        expect(stubModelActive({ ...unchecked, APP_URL: 'http://localhost:3332', NEXTAUTH_URL: 'http://127.0.0.1:3332' })).toBe(true);
        expect(stubModelActive({ AI_MODEL_STUB: '1', NODE_ENV: 'development' })).toBe(true);
    });

    it('makes a call possible without a key, but never past the kill switch', () => {
        expect(aiUnavailableReason({ AI_MODEL_STUB: '1', NODE_ENV: 'production', APP_URL: 'http://localhost:3332', NEXTAUTH_URL: 'http://localhost:3332' })).toBeNull();
        expect(aiUnavailableReason({ AI_MODEL_STUB: '1', AI_DISABLED: '1' })).toBe('AI_DISABLED');
        expect(aiUnavailableReason({})).toBe('CREDENTIAL_NOT_CONFIGURED');
    });

    it.each([
        ['http://localhost:3000', true],
        ['http://127.0.0.1', true],
        ['http://127.4.5.6:80', true],
        ['http://[::1]:3000', true],
        ['https://localhost.example', false],
        ['https://inkquisitor.app', false],
        ['not a url', false],
    ])('%s is loopback: %s', (url, expected) => expect(isLoopbackUrl(url)).toBe(expected));
});

/** A Messages body as 2.1 builds it: the fenced targets in the user turn, the kinds in the system prompt. */
function body(kinds: string, blocks: Record<string, string>) {
    const nonce = 'a'.repeat(32);
    const user = Object.entries(blocks)
        .map(([label, text]) => `<author_data_${nonce} label="${label}">\n${text}\n</author_data_${nonce}>`)
        .join('\n');
    return { model: 'm', system: [{ type: 'text', text: `Use only these question kinds: ${kinds}.` }], messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] };
}

describe('the stub’s answers', () => {
    const targets = JSON.stringify({ elementId: 'el-1', allowed_targets: ['want', 'need', 'wound'], may_challenge: null });

    it('words one valid question per target, in the kinds the dial allows, and passes the engine’s validation', () => {
        const out = stubAnswer(body('OPEN, CHOICE, EITHER_OR, SCENARIO, SCALE', { 'targets.1': targets }));
        expect(GeneratedQuestionsSchema.safeParse(out).success).toBe(true);
        expect(out.questions.map((q) => (q.targetsFieldKeys as string[])[0])).toEqual(['want', 'need', 'wound']);
        const ctx = {
            detail: 3,
            offerRecommended: true,
            elements: new Map([['el-1', { elementId: 'el-1', fieldKeys: new Set(['want', 'need', 'wound']), storedText: new Map() }]]),
            assignments: new Map([['el-1\u0000want', null], ['el-1\u0000need', null], ['el-1\u0000wound', null]]),
            challenge: null,
            answerText: new Map(),
        };
        for (const q of GeneratedQuestionsSchema.parse(out).questions) {
            const verdict = validateCandidate(candidateFrom(q, null), ctx as never);
            expect(verdict).toMatchObject({ ok: true, stripped: null });
        }
        expect(stubAnswer(body('CHOICE, EITHER_OR, SCALE', { 'targets.1': targets })).questions.every((q) => ['CHOICE', 'EITHER_OR', 'SCALE'].includes(q.kind as string))).toBe(true);
    });

    it('asks a rephrase in another kind and other words', () => {
        const first = stubAnswer(body('OPEN, CHOICE', { 'targets.1': JSON.stringify({ elementId: 'el-1', allowed_targets: ['want'] }) })).questions[0];
        const again = stubAnswer(body('OPEN, CHOICE', { 'targets.1': JSON.stringify({ elementId: 'el-1', allowed_targets: ['want'] }), 'previous-wording': JSON.stringify({ kind: first.kind, text: first.text }) })).questions[0];
        expect(again.kind).not.toBe(first.kind);
        expect(again.text).not.toBe(first.text);
    });

    it('asks nothing of a request it cannot read', () => {
        expect(stubAnswer({})).toEqual({ questions: [], declined: [] });
    });

    it('answers as a streamed Messages reply, and honours the caller’s abort', async () => {
        const res = await stubMessagesFetch('https://x/v1/messages', { method: 'POST', body: JSON.stringify(body('OPEN', { 'targets.1': targets })) });
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        expect(await res.text()).toMatch(/message_start[\s\S]*content_block_delta[\s\S]*message_stop/);
        const abort = new AbortController();
        const pending = stubMessagesFetch('https://x/v1/messages', { method: 'POST', body: '{}', signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toBeDefined();
    });
});

describe('the stub’s book-level answers (Phase 4.3), each kept whole by the product’s own validation', () => {
    it('the stress test: a weak point per element shown, a single question citing a shown tag', () => {
        const input = buildStressInput(
            {
                book: { title: 'The Lamp Room', logline: null },
                elements: [
                    { id: 'e-1', kind: 'CHARACTER', name: 'Ilse', summary: 'Ilse keeps the lighthouse.' },
                    { id: 'e-2', kind: 'CHARACTER', name: 'Corvin', summary: 'Corvin arrives on the ferry.' },
                ],
                facts: [],
                threads: [],
                passages: [],
                orders: [],
                totals: { elements: 2, facts: 0, threads: 0, passages: 0 },
            },
            40_000,
        );
        const out = stubStressTestAnswer(body('OPEN', Object.fromEntries(input.blocks.map((b) => [b.label, b.text]))));
        const v = validateWeakPoints(out, { shown: input.shown, text: shownText(input) });
        expect(v.refusals).toEqual({});
        expect(v.weakPoints.map((w) => w.citations.map((c) => c.id))).toEqual([['e-1'], ['e-2']]);
        expect(stubStressTestAnswer(body('OPEN', { 'targets.1': '{}' }))).toBeNull();
    });

    it('the gap ranking: the first three candidates, each reason naming its own field', () => {
        const candidates = computeGapCandidates({ elements: [{ id: 'p1', kind: 'PREMISE', filledKeys: new Set<string>() }], signals: new Map(), template: getTemplate });
        const blocks = gapRankBlocks({ candidates, book: { title: 'The Lamp Room', logline: null }, elements: [] });
        const out = stubGapRankAnswer(body('OPEN', Object.fromEntries(blocks.map((b) => [b.label, b.text]))));
        const v = validateGapPicks(out, { candidates, text: blocks.map((b) => b.text).join('\n') });
        expect(v.refusals).toEqual({});
        expect(v.picks.map((p) => p.n)).toEqual([1, 2, 3]);
    });

    it('the rounds summary: one sentence that quotes no answer', () => {
        const out = stubRoundsSummaryAnswer(body('OPEN', { 'earlier-rounds': '[]' }));
        expect(validateRoundsSummary(out, { text: '[]', answers: ['She burns the logbook every winter night.'] })).toMatchObject({ ok: true });
        expect(stubRoundsSummaryAnswer(body('OPEN', { 'targets.1': '{}' }))).toBeNull();
    });
});
