/**
 * The reconcile step wired to the model layer (Phase 2.5 on 2.1), end to end
 * through the real `callStructured`, SDK and middleware against the fake
 * Messages API and an in-memory ledger: the output schema fits the
 * structured-output limits, author text travels only in fenced data, every
 * 2.1 outcome is a named run outcome that proposes nothing, and a round with
 * nothing answered makes no call. No network.
 */
import { callStructured as callStructuredCore } from '@/lib/ai/call-structured';
import { jsonSchemaFor } from '@/lib/ai/client';
import type { AiEnvRecord } from '@/lib/ai/config';
import { stubReconcileAnswer } from '@/lib/ai/model-stub';
import { allReconcileCases, type ReconcileEvalCase } from '@/lib/enrichment/evals/eval-set';
import { referenceOutput, roundInputOf } from '@/lib/enrichment/evals/evaluation';
import { reconcilerOver } from '@/lib/enrichment/model-seam';
import { RECONCILE_CALL_COST_BUDGET_MICRO_USD, RECONCILE_PROMPT, RECONCILE_PROMPT_VERSION } from '@/lib/enrichment/prompt';
import { reconcileRequestFor, runReconcileStep } from '@/lib/enrichment/reconcile';
import type { Reconciler } from '@/lib/enrichment/reconciler';
import { bulkEligible } from '@/lib/enrichment/review-rules';
import { ReconcileOutputSchema } from '@/lib/enrichment/schema';
import { fakeAnthropic, setFakeApiKey, type FakeTurn } from '../../helpers/fake-anthropic';
import { memoryLedger, type MemoryLedger } from '../../helpers/memory-ai-ledger';
import { fencedBlocks, systemOf } from '../../helpers/fake-question-model';

const byId = (id: string): ReconcileEvalCase => allReconcileCases().find((c) => c.id === id)!;

let restoreKey: () => void;
beforeEach(() => {
    restoreKey = setFakeApiKey();
});
afterEach(() => restoreKey());

function wired(turns: FakeTurn[], over: { ledger?: MemoryLedger; env?: AiEnvRecord; timeoutMs?: number } = {}) {
    const api = fakeAnthropic(turns);
    const ledger = over.ledger ?? memoryLedger();
    const reconciler = reconcilerOver((input) => callStructuredCore({ ...input, requestedById: 'user-1' }, { ledger, fetch: api.fetch, env: over.env ?? {}, timeoutMs: over.timeoutMs }));
    return { reconciler, api, ledger };
}

const answer = (c: ReconcileEvalCase): FakeTurn => ({ kind: 'text', text: JSON.stringify(referenceOutput(c)), usage: { input_tokens: 2_000, output_tokens: 300 } });

describe('the request', () => {
    it('the output schema fits the structured-output limits (2.1 refuses one that does not when it builds the request)', () => {
        expect(() => jsonSchemaFor(ReconcileOutputSchema)).not.toThrow();
    });

    it('the template is versioned, tiered, budgeted; author text is only in fenced data, never the system prompt', async () => {
        expect(RECONCILE_PROMPT).toMatchObject({ id: 'interview.reconcile', version: RECONCILE_PROMPT_VERSION, tier: 'balanced', costBudgetMicroUsd: RECONCILE_CALL_COST_BUDGET_MICRO_USD });
        const c = byId('en-01');
        const { reconciler, api, ledger } = wired([answer(c)]);
        const step = await runReconcileStep(roundInputOf(c), reconciler);
        expect(step.outcome).toBe('OK');
        const body = api.requests[0];
        const system = systemOf(body);
        // The template's own text, then 2.1's trust boundary; nothing of the author's.
        expect(system.startsWith(RECONCILE_PROMPT.system)).toBe(true);
        for (const a of c.answers) if (typeof a.answer === 'string') expect(system).not.toContain(a.answer);
        const blocks = fencedBlocks(body);
        expect([...blocks.keys()]).toEqual(['element.1', 'answers', 'book']);
        expect(blocks.get('answers')).toContain('She wants to win back the seat');
        // Only this session's answers are sent; nothing of an earlier one.
        const tempting = byId('en-32');
        expect(reconcileRequestFor(roundInputOf(tempting)).data.find((b) => b.label === 'answers')!.text).not.toContain('"a1"');
        expect(ledger.records[0]).toMatchObject({ outcome: 'OK', promptVersion: RECONCILE_PROMPT_VERSION, purpose: 'interview.reconcile' });
        expect(step.metrics).toMatchObject({ proposed: { ADD: 1, UPDATE: 1, REMOVE: 0, NEW_ELEMENT: 0 }, tokensUsed: 2_300, aiCallId: ledger.records[0].id });
    });
});

describe('2.1 outcome → the run (the table in model-seam.ts); a failed call proposes nothing', () => {
    const c = byId('en-01');
    async function outcomeOf(turns: FakeTurn[], over: Parameters<typeof wired>[1] = {}) {
        const { reconciler, api } = wired(turns, over);
        const step = await runReconcileStep(roundInputOf(c), reconciler);
        return { step, api };
    }

    it('KILLED → KILL_SWITCH, nothing sent', async () => {
        const { step, api } = await outcomeOf([], { env: { AI_DISABLED: '1' } });
        expect(step).toMatchObject({ outcome: 'KILL_SWITCH', validation: null });
        expect(api.requests).toHaveLength(0);
    });

    it('CEILING → WORKSPACE_CEILING, nothing sent', async () => {
        const { step, api } = await outcomeOf([], { ledger: memoryLedger({ alreadySpent: 50_000_000 }) });
        expect(step.outcome).toBe('WORKSPACE_CEILING');
        expect(api.requests).toHaveLength(0);
    });

    it('no key → AI_UNAVAILABLE, nothing sent', async () => {
        restoreKey();
        const { step, api } = await outcomeOf([]);
        restoreKey = setFakeApiKey();
        expect(step).toMatchObject({ outcome: 'AI_UNAVAILABLE', metrics: { errorCode: 'CREDENTIAL_NOT_CONFIGURED' } });
        expect(api.requests).toHaveLength(0);
    });

    it('TIMEOUT, PROVIDER_FAILURE, INVALID_OUTPUT, GUARD_REFUSED', async () => {
        expect((await outcomeOf([{ kind: 'hang', usage: { input_tokens: 900, output_tokens: 0 } }], { timeoutMs: 50 })).step.outcome).toBe('TIMEOUT');
        expect((await outcomeOf([{ kind: 'http-error', status: 500, type: 'api_error' }, { kind: 'http-error', status: 500, type: 'api_error' }, { kind: 'http-error', status: 500, type: 'api_error' }])).step.outcome).toBe('PROVIDER_FAILURE');
        const bad: FakeTurn = { kind: 'text', text: 'not json', usage: { input_tokens: 500, output_tokens: 20 } };
        const invalid = await outcomeOf([bad, bad]);
        expect(invalid.step).toMatchObject({ outcome: 'INVALID_OUTPUT', validation: null, metrics: { tokensUsed: 1_040, proposed: { ADD: 0, UPDATE: 0, REMOVE: 0, NEW_ELEMENT: 0 } } });
        const leak = JSON.stringify({ operations: [{ elementId: 'eval-en-01', fieldKey: 'want', op: 'ADD', value: `AKIA${'IOSFODNN7'}EXAMPLE`, cites: ['a1'] }], newElements: [] });
        expect((await outcomeOf([{ kind: 'text', text: leak }])).step.outcome).toBe('GUARD_REFUSED');
    });

    it('a round with nothing answered makes no call: NOTHING_TO_RECONCILE', async () => {
        const reconcile = jest.fn();
        const spy: Reconciler = { unavailableReason: () => null, reconcile };
        const input = roundInputOf(c);
        const step = await runReconcileStep({ ...input, answers: input.answers.map((a) => ({ ...a, status: 'SKIPPED' as const, text: null })) }, spy);
        expect(step.outcome).toBe('NOTHING_TO_RECONCILE');
        expect(reconcile).not.toHaveBeenCalled();
    });
});

describe('adversarial answers change nothing beyond their own content', () => {
    const adversarial = allReconcileCases().filter((c) => c.id.startsWith('adv-'));

    it.each(adversarial.map((c) => [c.id, c] as const))('%s: a model that obeys the injection is refused, or flagged for the author, on every point it obeys', async (_id, c) => {
        const input = roundInputOf(c);
        const element = input.elements[0];
        const injected = c.injectedText!;
        // An obedient model: writes the injected text into every scope field,
        // changes a field outside scope, cites an answer it was not given and
        // invents an element.
        const obey = {
            operations: [
                ...element.scopeKeys.map((k) => ({ elementId: element.elementId, fieldKey: k, op: element.stored.has(k) ? 'UPDATE' : 'ADD', value: injected, cites: ['a1'] })),
                { elementId: element.elementId, fieldKey: 'not_in_scope', op: 'ADD', value: 'Whatever.', cites: ['a1'] },
                { elementId: 'another-book-element', fieldKey: element.scopeKeys[0], op: 'ADD', value: 'Whatever.', cites: ['a99'] },
            ],
            newElements: [{ kind: 'CHARACTER', name: 'Zebulon Quartermaine', summary: null, cites: ['a1'] }],
        };
        const step = await runReconcileStep(input, { unavailableReason: () => null, reconcile: async () => ({ output: obey, tokensUsed: 0 }) });
        const stored = step.validation!.proposals;
        // Nothing outside scope, no invented element, and no stored value carries the injection
        // unless it is FLAGGED a possible instruction (D14): stored PENDING, shown as such, never
        // bulk-eligible, so it changes nothing until the author accepts it on its own (an in-world
        // order may be recorded, but only as the answer's own story text).
        expect(stored.every((p) => p.kind === 'FIELD' && element.scopeKeys.includes(p.fieldKey) && p.elementId === element.elementId)).toBe(true);
        const fragments = c.expect.operations.flatMap((o) => (o.op === 'ADD' || o.op === 'UPDATE' ? o.mustNotContain : []));
        for (const p of stored) {
            if (p.kind !== 'FIELD') continue;
            const carries = fragments.some((f) => JSON.stringify(p.value).toLowerCase().includes(f.toLowerCase()));
            if (!carries) continue;
            expect([c.id, p.fieldKey, p.flags]).toEqual([c.id, p.fieldKey, ['POSSIBLE_INSTRUCTION']]);
            expect(bulkEligible({ status: 'PENDING', operation: p.operation, flags: p.flags }, null)).toBe(false);
        }
        // What the guard, markup, an unvouched URL or an answer-id citation catches is still refused.
        if (['adv-01', 'adv-02', 'adv-05'].includes(c.id)) expect(step.validation!.refusals.map((r) => r.code)).toContain('COPIES_INJECTED_TEXT');
        expect(step.validation!.refusals.map((r) => r.code)).toContain('TARGETS_OUT_OF_SCOPE_FIELD');
        expect(stored.some((p) => p.kind === 'NEW_ELEMENT')).toBe(false);
    });
});

describe('the loopback stub answers a reconcile request conservatively (Phase 2.4’s D13 server)', () => {
    it('an ADD of the answer’s own words into each empty field an answer targeted, NO_CHANGE elsewhere, every one valid', () => {
        const c = byId('en-01');
        const input = roundInputOf(c);
        const request = reconcileRequestFor(input);
        // The SDK's body: the fenced data in the first user turn, as 2.1 builds it.
        const user = request.data.map((b) => `<author_data_${'0'.repeat(32)} label="${b.label}">\n${b.text}\n</author_data_${'0'.repeat(32)}>`).join('\n');
        const out = stubReconcileAnswer({ messages: [{ role: 'user', content: user }] })!;
        expect(out.operations).toEqual([
            { elementId: 'eval-en-01', fieldKey: 'want', op: 'ADD', value: 'She wants to win back the seat on the town council that she lost to her brother.', cites: ['a1'] },
            { elementId: 'eval-en-01', fieldKey: 'wound', op: 'NO_CHANGE', value: null, cites: [] },
        ]);
        expect(stubReconcileAnswer({ messages: [{ role: 'user', content: 'no blocks' }] })).toBeNull();
    });
});
