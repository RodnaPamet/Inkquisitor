/**
 * The research steps (Phase 2.6): the depth caps, the outcome mapping, the
 * gather's data (the brief alone), and rule 6 — a run that keeps nothing says
 * why.
 */
import { AiCallAbortedError, AiGuardBlockedError, AiOutputInvalidError, AiProviderError, AiSpendCeilingError, AiTimeoutError, AiToolUseRefusedError, AiUnavailableError } from '@/lib/ai/errors';
import { researchOutcomeOf } from '@/lib/research/model-seam';
import { buildBookTextIndex } from '@/lib/research/query-egress';
import type { GatherOutput, Researcher, StepResult } from '@/lib/research/researcher';
import { runResearchSteps, webToolsForDepth, type ResearchRunInput } from '@/lib/research/run';
import { DEPTH_BUDGETS, RESEARCH_OUTCOMES, statusOfOutcome } from '@/lib/research/vocabulary';

const INPUT: ResearchRunInput = {
    bookId: 'book-1',
    brief: { question: 'How did medieval falconers train hawks?', purpose: 'Methods for my falconer.', urls: [] },
    depth: 'QUICK',
    uploads: [],
    elements: [{ elementId: 'el-1', kind: 'CHARACTER', name: 'Wren Ashdown', summary: 'A falconer with a secret.', role: 'scope', fields: [], stored: new Map([['role', 'Keeps the queen’s gyrfalcons in the old stone mews.']]) }],
    bookNames: ['Wren Ashdown'],
    bookIndex: buildBookTextIndex(['Keeps the queen’s gyrfalcons in the old stone mews.']),
};
const PAGE_TEXT = 'Medieval falconers began training by manning the bird, keeping it on the fist for many hours so it grew used to people.';

function researcher(over: Partial<{ gather: GatherOutput | 'fail'; findings: unknown; fit: unknown }> = {}, seen: { gatherData?: string } = {}): Researcher {
    const ok = <T>(output: T): StepResult<T> => ({ ok: true, output, tokensUsed: 10, costMicroUsd: 5, callIds: ['c'] });
    return {
        async gather(request) {
            seen.gatherData = JSON.stringify(request.data);
            if (over.gather === 'fail') return { ok: false, failure: 'WORKSPACE_CEILING', errorCode: 'SPEND_CEILING', tokensUsed: 0, costMicroUsd: 0, callIds: [] };
            return {
                ok: true,
                output: over.gather ?? { stop: 'END_TURN', searches: [], fetches: [{ url: 'https://falconry.example.org/a', title: 'A', text: PAGE_TEXT, retrievedAt: null, errorCode: null }], requests: 1, tokensUsed: 10, costMicroUsd: 15_000, callIds: ['g'] },
            };
        },
        async findings() {
            return ok(over.findings ?? { findings: [{ claim: 'Medieval falconers began training by manning the bird.', summary: PAGE_TEXT, confidence: 'HIGH', citations: [{ ref: 'web.1', quote: PAGE_TEXT }] }] });
        },
        async fit() {
            return ok(over.fit ?? { proposals: [], noFit: [{ finding: 'f1', reason: 'No field fits.' }] });
        },
    };
}

describe('the depth caps', () => {
    it.each(['QUICK', 'STANDARD', 'THOROUGH'] as const)('%s sets the tools’ max_uses, the requests and the gather budget from DEPTH_BUDGETS', (depth) => {
        const plan = webToolsForDepth(depth);
        expect(plan.tools.search.maxUses).toBe(DEPTH_BUDGETS[depth].searches);
        expect(plan.tools.fetch.maxUses).toBe(DEPTH_BUDGETS[depth].fetches);
        expect(plan.maxRequests).toBe(DEPTH_BUDGETS[depth].requests);
        expect(plan.budgetMicroUsd).toBe(DEPTH_BUDGETS[depth].gatherSpendMicroUsd);
    });

    it('deeper is never smaller', () => {
        const order = ['QUICK', 'STANDARD', 'THOROUGH'] as const;
        for (let i = 1; i < order.length; i++) {
            for (const k of ['searches', 'fetches', 'requests', 'gatherSpendMicroUsd', 'findings'] as const) expect(DEPTH_BUDGETS[order[i]][k]).toBeGreaterThanOrEqual(DEPTH_BUDGETS[order[i - 1]][k]);
        }
    });
});

describe('the outcome mapping', () => {
    it.each([
        [new AiUnavailableError('AI_DISABLED'), 'KILL_SWITCH'],
        [new AiUnavailableError('CREDENTIAL_NOT_CONFIGURED'), 'AI_UNAVAILABLE'],
        [new AiSpendCeilingError({ spentMicroUsd: 0, reservedMicroUsd: 0, worstCaseMicroUsd: 1, ceilingMicroUsd: 0, period: '2026-11' }, 'c'), 'WORKSPACE_CEILING'],
        [new AiToolUseRefusedError('web_search', 'QUOTES_BOOK_TEXT', 'c'), 'QUERY_REFUSED'],
        [new AiGuardBlockedError('input', ['inj.x'], 'c'), 'GUARD_REFUSED'],
        [new AiTimeoutError('c'), 'TIMEOUT'],
        [new AiCallAbortedError('c'), 'ABORTED'],
        [new AiProviderError('PROVIDER_HTTP_ERROR', 'c'), 'PROVIDER_FAILURE'],
        [new AiOutputInvalidError('INVALID_AFTER_REPAIR', [], 'c'), 'INVALID_OUTPUT'],
    ] as const)('%s → %s, with what it cost', (err, outcome) => {
        err.tokensUsed = 7;
        err.costMicroUsd = 3;
        expect(researchOutcomeOf(err)).toMatchObject({ ok: false, failure: outcome, tokensUsed: 7, costMicroUsd: 3 });
    });

    it('rethrows what is neither 2.1’s nor the SDK’s', () => {
        expect(() => researchOutcomeOf(new Error('bug'))).toThrow('bug');
    });

    it('every outcome ends in a status, and the CHECK’s three groups partition them', () => {
        for (const o of RESEARCH_OUTCOMES) expect(['DONE', 'FAILED', 'REFUSED']).toContain(statusOfOutcome(o));
        expect(statusOfOutcome('OK')).toBe('DONE');
        expect(statusOfOutcome('NO_SOURCES')).toBe('DONE');
        expect(statusOfOutcome('QUERY_REFUSED')).toBe('FAILED');
        expect(statusOfOutcome('RESEARCH_NOT_EVALUATED')).toBe('REFUSED');
    });
});

describe('the steps', () => {
    it('hands the gather the brief and nothing else of the book', async () => {
        const seen: { gatherData?: string } = {};
        await runResearchSteps(INPUT, researcher({}, seen));
        expect(seen.gatherData).toContain('How did medieval falconers train hawks?');
        expect(seen.gatherData).not.toContain('gyrfalcons');
        expect(seen.gatherData).not.toContain('Wren Ashdown');
        expect(seen.gatherData).not.toContain('secret');
    });

    it('a run that keeps findings ends OK, its costs summed and its no-fit reasons kept', async () => {
        const r = await runResearchSteps(INPUT, researcher());
        expect(r.outcome).toBe('OK');
        expect(r.findings).toHaveLength(1);
        expect([...r.noFit]).toEqual([['f1', 'No field fits.']]);
        expect(r.metrics.costMicroUsd).toBe(15_000 + 5 + 5);
    });

    it.each([
        ['nothing was read', { gather: { stop: 'END_TURN', searches: [], fetches: [], requests: 1, tokensUsed: 0, costMicroUsd: 0, callIds: [] } }, 'NO_SOURCES'],
        ['the budget went before anything was read', { gather: { stop: 'BUDGET', searches: [], fetches: [], requests: 2, tokensUsed: 0, costMicroUsd: 0, callIds: [] } }, 'BUDGET_SPENT'],
        ['a page that is not text', { gather: { stop: 'END_TURN', searches: [], fetches: [{ url: 'https://x.example/a.pdf', title: null, text: null, retrievedAt: null, errorCode: 'NOT_TEXT' }], requests: 1, tokensUsed: 0, costMicroUsd: 0, callIds: [] } }, 'NO_SOURCES'],
        ['no claim drafted', { findings: { findings: [] } }, 'NO_FINDINGS'],
        ['every claim refused', { findings: { findings: [{ claim: 'Eagles hunted wolves.', summary: 'Eagles hunted wolves.', confidence: 'LOW', citations: [{ ref: 'web.1', quote: 'Eagles hunted wolves across the steppe.' }] }] } }, 'ALL_REFUSED'],
    ] as const)('zero is never complete: %s ends %s', async (_label, over, outcome) => {
        const r = await runResearchSteps(INPUT, researcher(over as Parameters<typeof researcher>[0]));
        expect(r.outcome).toBe(outcome);
        expect(r.findings).toHaveLength(0);
    });

    it('a failed gather ends the run with its failure and calls nothing more', async () => {
        const r = await runResearchSteps(INPUT, researcher({ gather: 'fail' }));
        expect(r.outcome).toBe('WORKSPACE_CEILING');
        expect(r.metrics.errorCode).toBe('SPEND_CEILING');
    });
});
