/**
 * The question-coverage evaluation set and its runner (Phase 2.2; roadmap
 * rule 9). The set's expectations are re-derived from the content format's
 * own simulation, and the runner — the product's round engine over every
 * session, in memory — is exercised with deterministic fake generators: a
 * good one passes every session; one that targets the wrong fields, words
 * nothing (so only the pack fallback asks), or attempts a refused behaviour
 * fails the sessions it should. And the WIRED generator — the deployment's,
 * over 2.1's real `callStructured` — runs the whole set against the fake
 * Messages API, with every call recorded. A real-model evaluation record
 * waits for an API key (issue #32, item 8).
 */
import { expectedCoverage, loadCoverageEval, runCoverageEvaluation } from '@/lib/interview/evals/coverage';
import { getPacks } from '@/lib/interview/packs';
import { QUESTION_PROMPT_VERSION } from '@/lib/interview/prompt';
import { BIBLE_KINDS } from '@/lib/bible/kinds';
import { callStructured as callStructuredCore } from '@/lib/ai/call-structured';
import { questionGeneratorOver } from '@/lib/interview/model-seam';
import { QUESTION_CALL_COST_BUDGET_MICRO_USD, QUESTION_PROMPT } from '@/lib/interview/prompt';
import { fakeGenerator } from '../../helpers/fake-question-generator';
import { fakeAnthropic, setFakeApiKey } from '../../helpers/fake-anthropic';
import { memoryLedger } from '../../helpers/memory-ai-ledger';
import { questionModel } from '../../helpers/fake-question-model';

const cases = loadCoverageEval();
const packs = getPacks();

describe('the evaluation set', () => {
    it('holds ten book concepts, every kind, every dial value, four audiences', () => {
        expect(cases).toHaveLength(10);
        const sessions = cases.flatMap((c) => c.sessions);
        expect(new Set(sessions.map((s) => s.kind))).toEqual(new Set(BIBLE_KINDS));
        expect(new Set(sessions.map((s) => s.dials.depth))).toEqual(new Set([1, 2, 3, 4, 5]));
        expect(new Set(sessions.map((s) => s.dials.detail))).toEqual(new Set([1, 2, 3, 4, 5]));
        expect(new Set(cases.map((c) => c.audience)).size).toBe(4);
    });

    it.each(cases.flatMap((c) => c.sessions.map((s, i) => [`${c.id} #${i + 1} ${s.kind}`, s] as const)))('%s: mustCover and mustNotTarget are the format’s simulation', (_l, s) => {
        const expected = expectedCoverage(s);
        expect(s.expect.mustCover).toEqual(expected.mustCover);
        expect(s.expect.mustNotTarget).toEqual(expected.mustNotTarget);
    });
});

describe('the runner', () => {
    it('a generator that asks every allowed target passes every session, at full coverage', async () => {
        const report = await runCoverageEvaluation(cases, fakeGenerator(), { packs });
        if (report.status !== 'MEASURED') throw new Error('expected a measured report');
        expect(report.sessions.filter((s) => !s.passed)).toEqual([]);
        expect(report.coverage).toBe(1);
        expect(report.promptVersion).toBe(QUESTION_PROMPT_VERSION);
        expect(report.maxOutputTokensByDetail[3]).toBeGreaterThan(0);
        // Prose and invented story content need a judge (2.3): listed, never claimed.
        expect(report.sessions[0].ungraded).toEqual(expect.arrayContaining(['PROPOSES_STORY_CONTENT', 'WRITES_PROSE']));
    });

    it('the same holds over core fields only', async () => {
        const report = await runCoverageEvaluation(cases, fakeGenerator(), { packs, fields: 'core' });
        expect(report.status === 'MEASURED' && report.passed).toBe(report.sessions.length);
    });

    it('a generator that words nothing fails: the pack fallback’s questions are not the generator’s coverage', async () => {
        const report = await runCoverageEvaluation(cases, fakeGenerator({ fail: true }), { packs });
        if (report.status !== 'MEASURED') throw new Error('expected a measured report');
        expect(report.passed).toBe(0);
        expect(report.coverage).toBe(0);
        expect(report.sessions.some((s) => s.fallbackOnly.length > 0)).toBe(true);
    });

    it('a generator that asks about fields it was not given is caught attempting ASKS_ANSWERED_FIELD', async () => {
        const report = await runCoverageEvaluation(cases.slice(0, 1), fakeGenerator({ mutate: (q) => [q, { ...q, targetsFieldKeys: ['central_character'] }] }), { packs });
        if (report.status !== 'MEASURED') throw new Error('expected a measured report');
        const premise = report.sessions.find((s) => s.kind === 'PREMISE')!;
        expect(premise.attempted).toContain('ASKS_ANSWERED_FIELD');
        expect(premise.passed).toBe(false);
    });

    it('the WIRED generator (2.1’s callStructured over the fake Messages API) passes every session, every call recorded with the version and within the cost budget', async () => {
        const restore = setFakeApiKey();
        try {
            const api = fakeAnthropic([questionModel()]);
            const ledger = memoryLedger();
            const generator = questionGeneratorOver((input) => callStructuredCore({ ...input, requestedById: null }, { ledger, fetch: api.fetch, env: {} }));
            const report = await runCoverageEvaluation(cases, generator, { packs });
            if (report.status !== 'MEASURED') throw new Error('expected a measured report');
            expect(report.sessions.filter((s) => !s.passed)).toEqual([]);
            expect(report.coverage).toBe(1);
            // The recorded output: one AiCallLog record per call, each the template's.
            expect(report.calls.count).toBeGreaterThan(0);
            expect(report.calls.failed).toBe(0);
            expect(api.requests).toHaveLength(report.calls.count);
            expect(ledger.records).toHaveLength(report.calls.count);
            expect(report.calls.aiCallIds).toEqual(ledger.records.map((r) => r.id));
            expect(ledger.records.every((r) => r.outcome === 'OK' && r.promptId === QUESTION_PROMPT.id && r.promptVersion === QUESTION_PROMPT_VERSION && r.tier === 'balanced')).toBe(true);
            expect(report.calls.tokensUsed).toBe(report.calls.count * 1_500);
            expect(report.calls.costMicroUsd).toBe(ledger.records.reduce((n, r) => n + r.costMicroUsd, 0));
            // Rule 9: the cost budget per call, recorded on the template, held.
            expect(report.costBudgetMicroUsd).toBe(QUESTION_CALL_COST_BUDGET_MICRO_USD);
            expect(report.calls.maxCallCostMicroUsd).toBeLessThanOrEqual(QUESTION_CALL_COST_BUDGET_MICRO_USD);
            expect(report.calls.overBudget).toBe(0);
        } finally {
            restore();
        }
    });

    it('over no session the report is NOT ASSESSED, never 100 % (rule 6)', async () => {
        expect(await runCoverageEvaluation([], fakeGenerator(), { packs })).toEqual({ status: 'NOT_ASSESSED', promptVersion: QUESTION_PROMPT_VERSION, sessions: [] });
    });
});
