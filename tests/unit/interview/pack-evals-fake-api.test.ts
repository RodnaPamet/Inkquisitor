/**
 * Every pack's evaluation set end to end through the WIRED generator (Phase
 * 2.3): the deployment's own generator over 2.1's real `callStructured` —
 * the request builder, the fence, the guard, the SDK, the messages-only
 * middleware, the stream parser and the ledger — against the fake Messages
 * API. Every case passes, every call is recorded under the current prompt
 * version and within its cost budget, and the outputs are exactly the
 * committed structural records', so a record made by the `Evals` workflow
 * through this path is checked by the same gate.
 */
import { callStructured as callStructuredCore } from '@/lib/ai/call-structured';
import { questionGeneratorOver } from '@/lib/interview/model-seam';
import { getPacks } from '@/lib/interview/packs';
import { checkPackRecord, evaluatePack, type PackEvaluationRecord } from '@/lib/interview/pack-evaluation';
import { QUESTION_CALL_COST_BUDGET_MICRO_USD, QUESTION_PROMPT, QUESTION_PROMPT_VERSION } from '@/lib/interview/prompt';
import { fakeAnthropic, setFakeApiKey } from '../../helpers/fake-anthropic';
import { memoryLedger } from '../../helpers/memory-ai-ledger';
import { questionModel } from '../../helpers/fake-question-model';

const packs = getPacks();

it.each(Object.keys(packs.files))('%s: its set passes through the wired generator over the fake Messages API', async (name) => {
    const restore = setFakeApiKey();
    try {
        const api = fakeAnthropic([questionModel()]);
        const ledger = memoryLedger();
        const generator = questionGeneratorOver((input) => callStructuredCore({ ...input, requestedById: null }, { ledger, fetch: api.fetch, env: {} }));
        const { record, grades } = await evaluatePack(packs, name, generator, { kind: 'model', id: 'fake-messages-api' }, new Date(0));
        expect(grades.filter((g) => !g.passed)).toEqual([]);
        const check = await checkPackRecord(record, packs.files[name], packs);
        expect(check.ok).toBe(true);
        // The same outputs as the committed structural record: one engine, two paths.
        const committed = (packs.files[name].record as { raw: PackEvaluationRecord }).raw;
        if (committed.generator.kind === 'structural') expect(record.answers).toEqual(committed.answers);
        // Every call recorded, under the prompt's version and within its budget (rule 9).
        expect(ledger.records).toHaveLength(api.requests.length);
        expect(ledger.records.every((r) => r.outcome === 'OK' && r.promptId === QUESTION_PROMPT.id && r.promptVersion.startsWith(`${QUESTION_PROMPT_VERSION}+packs.`))).toBe(true);
        expect(ledger.records.every((r) => r.costMicroUsd <= QUESTION_CALL_COST_BUDGET_MICRO_USD)).toBe(true);
    } finally {
        restore();
    }
});
