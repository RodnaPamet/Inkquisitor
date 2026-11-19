/**
 * The question engine wired to the model layer (Phase 2.2 on 2.1), driven
 * end to end: the WIRED generator (`questionGeneratorOver`, the deployment's
 * generator less the workspace binding) over the real `callStructured`, the
 * real SDK and middleware, against the fake Messages API and an in-memory
 * ledger. No network.
 *
 *   the output schema complies with the structured-output limits, and a
 *   schema that does not is refused when the request is built
 *   a call carries the template (version, tier, budgets) and the author text
 *   only in fenced data; it returns the call's real token usage
 *   every 2.1 outcome maps to the engine's named failure or stop
 *   a whole round runs through it, recorded in the ledger
 */
import { z } from 'zod';

import { callStructured as callStructuredCore } from '@/lib/ai/call-structured';
import { jsonSchemaFor, MAX_OPTIONAL_PARAMETERS, MAX_UNION_PARAMETERS } from '@/lib/ai/client';
import { AiPromptError } from '@/lib/ai/errors';
import { definePrompt } from '@/lib/ai/prompt';
import { getTemplate } from '@/lib/bible/templates';
import { GeneratedQuestionsSchema } from '@/lib/interview/candidates';
import { computeFrontier } from '@/lib/interview/frontier';
import { GenerationStop, type GenerationRequest, type QuestionGenerator } from '@/lib/interview/generator';
import { defaultQuestionGenerator, minimumQuestionCallMicroUsd, questionGeneratorOver } from '@/lib/interview/model-seam';
import { getPacks } from '@/lib/interview/packs';
import { planRound } from '@/lib/interview/plan';
import { maxOutputTokensFor, QUESTION_CALL_COST_BUDGET_MICRO_USD, QUESTION_PROMPT, QUESTION_PROMPT_VERSION } from '@/lib/interview/prompt';
import { produceRound, type RoundElement, type RoundInput } from '@/lib/interview/round';
import type { AiEnvRecord } from '@/lib/ai/config';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { fakeAnthropic, setFakeApiKey, type FakeAnthropic, type FakeTurn } from '../../helpers/fake-anthropic';
import { memoryLedger, type MemoryLedger } from '../../helpers/memory-ai-ledger';
import { fencedBlocks, questionModel, systemOf } from '../../helpers/fake-question-model';

const packs = getPacks();
const EL = 'el-1';
const NAME = 'Marisol Etxeberria-Quant';

function roundInput(detail = 3, stored: Record<string, string> = {}): RoundInput {
    const element: RoundElement = { elementId: EL, kind: 'CHARACTER', name: NAME, customLabel: null, fields: getTemplate('CHARACTER').fields, storedText: new Map(Object.entries(stored)) };
    const frontier = computeFrontier({ elements: [{ elementId: EL, kind: 'CHARACTER', fields: element.fields, storedKeys: new Set(Object.keys(stored)) }], sessionAnswers: [], depth: 2 });
    const plan = planRound({ frontier: frontier.frontier, challengeable: [], challenged: [], challengesPlanned: 0, depth: 2, detail, personaKeys: [], roundNumber: 1 });
    return { bookId: 'book-1', dials: { depth: 2, detail }, offerRecommended: true, preferChoice: false, personaKeys: [], plan, elements: [element], related: [], sessionAnswers: [], asked: [], packs };
}

/** The wired generator over the real callStructured, the fake API and an in-memory ledger. */
function wired(turns: FakeTurn[], over: { ledger?: MemoryLedger; env?: AiEnvRecord; timeoutMs?: number } = {}): { generator: QuestionGenerator; api: FakeAnthropic; ledger: MemoryLedger } {
    const api = fakeAnthropic(turns);
    const ledger = over.ledger ?? memoryLedger();
    const generator = questionGeneratorOver((input) =>
        callStructuredCore({ ...input, requestedById: 'user-1' }, { ledger, fetch: api.fetch, env: over.env ?? {}, timeoutMs: over.timeoutMs }),
    );
    return { generator, api, ledger };
}

/** One generation request as the engine builds it for `roundInput()`. */
async function oneRequest(): Promise<GenerationRequest> {
    let captured: GenerationRequest | null = null;
    await produceRound(roundInput(), {
        generator: {
            unavailableReason: () => null,
            async generateCandidates(request) {
                captured = request;
                return { output: null, tokensUsed: 0 };
            },
        },
    });
    return captured!;
}

let restoreKey: () => void;
beforeEach(() => {
    restoreKey = setFakeApiKey();
});
afterEach(() => restoreKey());

describe('the output schema and structured output (2.1’s limits)', () => {
    it('the candidate schema builds: an object root, no record, no recursion, within the optional and union limits', () => {
        const schema = jsonSchemaFor(GeneratedQuestionsSchema);
        expect(schema.type).toBe('object');
        let optional = 0;
        let unions = 0;
        const walk = (n: unknown): void => {
            if (!n || typeof n !== 'object') return;
            const node = n as Record<string, unknown>;
            if (Array.isArray(node.anyOf) || Array.isArray(node.type)) unions++;
            if (node.properties && typeof node.properties === 'object') {
                // Every object is closed: the API requires additionalProperties false.
                expect(node.additionalProperties).toBe(false);
                const required = new Set((node.required as string[] | undefined) ?? []);
                optional += Object.keys(node.properties).filter((k) => !required.has(k)).length;
                Object.values(node.properties).forEach(walk);
            }
            walk(node.items);
            (node.anyOf as unknown[] | undefined)?.forEach(walk);
            if (node.$defs && typeof node.$defs === 'object') Object.values(node.$defs).forEach(walk);
        };
        walk(schema);
        expect(optional).toBeLessThanOrEqual(MAX_OPTIONAL_PARAMETERS);
        expect(unions).toBeLessThanOrEqual(MAX_UNION_PARAMETERS);
        // Shared definitions only, inside the document: no external reference.
        for (const m of JSON.stringify(schema).matchAll(/"\$ref":"([^"]*)"/g)) expect(m[1]).toMatch(/^#\/\$defs\//);
    });

    it('the request builder refuses a candidate schema the feature cannot take (a record), before anything is sent', async () => {
        const broken = GeneratedQuestionsSchema.extend({ byField: z.record(z.string(), z.string()) });
        expect(() => jsonSchemaFor(broken)).toThrow(AiPromptError);
        const api = fakeAnthropic([]);
        const request = await oneRequest();
        await expect(
            callStructuredCore({ template: request.template, data: request.data, schema: broken, bookId: 'book-1' }, { ledger: memoryLedger(), fetch: api.fetch, env: {} }),
        ).rejects.toBeInstanceOf(AiPromptError);
        expect(api.requests).toHaveLength(0);
    });

    it('the schema is the same for every call: it is code, never built from author text', async () => {
        const request = await oneRequest();
        expect(request.schema).toBe(GeneratedQuestionsSchema);
        expect(JSON.stringify(jsonSchemaFor(request.schema))).not.toContain(NAME);
    });
});

describe('a call through the wired generator', () => {
    it('sends the template (version, balanced tier, output budget) with author text only in fenced data, and returns the real token usage', async () => {
        const { generator, api, ledger } = wired([questionModel({ usage: { input_tokens: 1_500, output_tokens: 400, cache_read_input_tokens: 700, cache_creation_input_tokens: 50 } })]);
        const out = await produceRound(roundInput(3), { generator });
        expect(api.requests).toHaveLength(1);
        const body = api.requests[0];
        expect(body.max_tokens).toBe(maxOutputTokensFor(3));
        expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } });
        expect(systemOf(body)).not.toContain(NAME);
        expect(systemOf(body)).toContain('# Character');
        expect([...fencedBlocks(body).keys()]).toEqual(['element.1', 'targets.1']);
        expect(fencedBlocks(body).get('element.1')).toContain(NAME);

        // The real usage: input + output + cache reads + cache writes.
        expect(out.metrics.tokensUsed).toBe(1_500 + 400 + 700 + 50);
        expect(out.metrics.aiCallIds).toEqual([ledger.records[0].id]);
        expect(out.metrics.costMicroUsd).toBe(ledger.records[0].costMicroUsd);
        expect(out.metrics.callsOverBudget).toBe(0);
        expect(ledger.records[0]).toMatchObject({
            outcome: 'OK',
            purpose: 'interview.questions',
            promptId: QUESTION_PROMPT.id,
            promptVersion: QUESTION_PROMPT_VERSION,
            tier: 'balanced',
            bookId: 'book-1',
            requestedById: 'user-1',
        });
        // The model worded every question; code validated them.
        expect(out.questions.length).toBeGreaterThan(0);
        expect(out.questions.every((q) => q.origin === 'MODEL')).toBe(true);
        expect(out.metrics.generationFailures).toBe(0);
    });

    it('the template records the per-call cost budget with its version (rule 9)', () => {
        expect(QUESTION_PROMPT).toMatchObject({ version: QUESTION_PROMPT_VERSION, tier: 'balanced', costBudgetMicroUsd: QUESTION_CALL_COST_BUDGET_MICRO_USD });
        expect(() => definePrompt({ ...QUESTION_PROMPT, costBudgetMicroUsd: 0 })).toThrow(AiPromptError);
        expect(minimumQuestionCallMicroUsd(1)).toBeGreaterThan(0);
    });
});

describe('2.1 outcome → the engine (the mapping in model-seam.ts)', () => {
    async function outcome(turns: FakeTurn[], over: Parameters<typeof wired>[1] = {}) {
        const { generator, ledger, api } = wired(turns, over);
        const request = await oneRequest();
        const result = await generator.generateCandidates(request).catch((e: unknown) => e);
        return { result, ledger, api };
    }

    it('KILLED: GenerationStop KILL_SWITCH, nothing sent', async () => {
        const { result, api, ledger } = await outcome([], { env: { AI_DISABLED: '1' } });
        expect(result).toBeInstanceOf(GenerationStop);
        expect(result).toMatchObject({ reason: 'KILL_SWITCH', errorCode: 'AI_DISABLED' });
        expect(api.requests).toHaveLength(0);
        expect(ledger.records[0]).toMatchObject({ outcome: 'KILLED' });
    });

    it('CEILING: GenerationStop WORKSPACE_CEILING, nothing sent', async () => {
        const { result, api } = await outcome([], { ledger: memoryLedger({ alreadySpent: 50_000_000 }) });
        expect(result).toMatchObject({ reason: 'WORKSPACE_CEILING', errorCode: 'SPEND_CEILING' });
        expect(api.requests).toHaveLength(0);
    });

    it('no key: GenerationStop PROVIDER_FAILURE naming CREDENTIAL_NOT_CONFIGURED, nothing sent', async () => {
        restoreKey();
        const { result, api } = await outcome([]);
        restoreKey = setFakeApiKey();
        expect(result).toMatchObject({ reason: 'PROVIDER_FAILURE', errorCode: 'CREDENTIAL_NOT_CONFIGURED' });
        expect(api.requests).toHaveLength(0);
    });

    it('REFUSED_GUARD (a secret in the answer): failure GUARD, the tokens charged, the answer withheld', async () => {
        const leak = JSON.stringify({ questions: [{ elementId: EL, targetsFieldKeys: ['role'], mode: 'FRONTIER', kind: 'OPEN', text: `Is AKIA${'IOSFODNN7'}EXAMPLE their key?`, rationale: '' }], declined: [] });
        const { result } = await outcome([{ kind: 'text', text: leak, usage: { input_tokens: 800, output_tokens: 90 } }]);
        expect(result).toMatchObject({ output: null, tokensUsed: 890, failure: { kind: 'GUARD', errorCode: 'GUARD_BLOCKED_OUTPUT' } });
    });

    it('TIMEOUT: failure TIMEOUT, charged what the stream reported', async () => {
        const { result } = await outcome([{ kind: 'hang', usage: { input_tokens: 900, output_tokens: 0 } }], { timeoutMs: 50 });
        // 900 in, and the one output token the stream's message_start reported.
        expect(result).toMatchObject({ output: null, tokensUsed: 901, failure: { kind: 'TIMEOUT', errorCode: 'DEADLINE' } });
    });

    it('PROVIDER_ERROR: failure PROVIDER', async () => {
        const { result } = await outcome([{ kind: 'http-error', status: 400, type: 'invalid_request_error' }]);
        expect(result).toMatchObject({ output: null, failure: { kind: 'PROVIDER', errorCode: 'PROVIDER_HTTP_ERROR' } });
    });

    it('INVALID_OUTPUT (twice not JSON): failure INVALID_OUTPUT with both attempts’ tokens', async () => {
        const bad: FakeTurn = { kind: 'text', text: 'not json', usage: { input_tokens: 500, output_tokens: 20 } };
        const { result, api } = await outcome([bad, bad]);
        expect(api.requests).toHaveLength(2);
        expect(result).toMatchObject({ output: null, tokensUsed: 1_040, failure: { kind: 'INVALID_OUTPUT', errorCode: 'INVALID_AFTER_REPAIR' } });
    });

    it('a failed call’s cost counts in the round like an answered one’s: its money and the per-call budget tally (rule 9)', async () => {
        // Twice not JSON, each attempt dear: the call fails INVALID_OUTPUT having
        // cost two attempts, past the template's per-call budget.
        const bad: FakeTurn = { kind: 'text', text: 'not json', usage: { input_tokens: 100_000, output_tokens: 20 } };
        const { generator, ledger } = wired([bad, bad]);
        const out = await produceRound(roundInput(1), { generator });
        expect(out.metrics.failures).toEqual({ INVALID_OUTPUT: 1 });
        const record = ledger.records[0];
        expect(record).toMatchObject({ outcome: 'INVALID_OUTPUT', attempts: 2 });
        expect(record.costMicroUsd).toBeGreaterThan(QUESTION_CALL_COST_BUDGET_MICRO_USD);
        expect(out.metrics.aiCallIds).toEqual([record.id]);
        expect(out.metrics.costMicroUsd).toBe(record.costMicroUsd);
        expect(out.metrics.maxCallCostMicroUsd).toBe(record.costMicroUsd);
        expect(out.metrics.callsOverBudget).toBe(1);
    });

    it('a request cut off before the provider reported any usage: its estimated cost is counted, and no tokens are invented', async () => {
        // The stream never opens: no usage ever arrives, and the deadline aborts it.
        const silent = (async (_url: unknown, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                const stop = () => reject(signal?.reason ?? new Error('aborted'));
                if (signal?.aborted) stop();
                else signal?.addEventListener('abort', stop, { once: true });
            })) as typeof fetch;
        const ledger = memoryLedger();
        const generator = questionGeneratorOver((input) => callStructuredCore({ ...input, requestedById: 'user-1' }, { ledger, fetch: silent, env: {}, timeoutMs: 50 }));
        const result = await generator.generateCandidates(await oneRequest());
        expect(result.failure).toEqual({ kind: 'TIMEOUT', errorCode: 'DEADLINE' });
        const record = ledger.records[0];
        expect(record).toMatchObject({ costEstimated: true, inputTokens: 0, outputTokens: 0 });
        expect(record.costMicroUsd).toBeGreaterThan(0);
        // The money 2.1 charged the month travels with the failure; the
        // session is charged only tokens the provider reported (none here).
        expect(result.costMicroUsd).toBe(record.costMicroUsd);
        expect(result.tokensUsed).toBe(0);
    });

    it('a round whose calls fail goes to the pack fallback, the failures named; a stop abandons the round', async () => {
        const failing = wired([{ kind: 'repeat', turn: { kind: 'http-error', status: 400, type: 'invalid_request_error' } }]);
        const out = await produceRound(roundInput(1), { generator: failing.generator });
        expect(out.metrics.failures).toEqual({ PROVIDER: 1 });
        expect(out.questions.every((q) => q.origin === 'PACK_FALLBACK')).toBe(true);

        const killed = wired([], { env: { AI_DISABLED: '1' } });
        await expect(produceRound(roundInput(1), { generator: killed.generator })).rejects.toMatchObject({ name: 'GenerationStop', reason: 'KILL_SWITCH' });
    });
});

describe('the deployment generator', () => {
    const ctx = { workspaceId: 'ws', requestId: 'r', userId: 'u' } as unknown as WorkspaceRequestContext;

    it('names why no call can be made, before anything is written: no key', () => {
        restoreKey();
        try {
            expect(defaultQuestionGenerator(ctx).unavailableReason()).toBe('CREDENTIAL_NOT_CONFIGURED');
        } finally {
            restoreKey = setFakeApiKey();
        }
        expect(defaultQuestionGenerator(ctx).unavailableReason()).toBeNull();
    });

    it('in production, a key with no declared retention mode is a refusal named RETENTION_MODE_UNDECLARED (D5); a declared one is not', () => {
        const before = { NODE_ENV: process.env.NODE_ENV, mode: process.env.AI_RETENTION_MODE, zdr: process.env.ANTHROPIC_ZDR_CONFIRMED };
        const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
        try {
            (process.env as Record<string, string>).NODE_ENV = 'production';
            delete process.env.AI_RETENTION_MODE;
            delete process.env.ANTHROPIC_ZDR_CONFIRMED;
            expect(defaultQuestionGenerator(ctx).unavailableReason()).toBe('RETENTION_MODE_UNDECLARED');
            for (const mode of ['zdr', 'standard-beta']) {
                process.env.AI_RETENTION_MODE = mode;
                expect(defaultQuestionGenerator(ctx).unavailableReason()).toBeNull();
            }
            delete process.env.AI_RETENTION_MODE;
            process.env.ANTHROPIC_ZDR_CONFIRMED = '1';
            expect(defaultQuestionGenerator(ctx).unavailableReason()).toBeNull();
        } finally {
            restore('NODE_ENV', before.NODE_ENV);
            restore('AI_RETENTION_MODE', before.mode);
            restore('ANTHROPIC_ZDR_CONFIRMED', before.zdr);
        }
    });

    it('the kill switch is not a refusal but a session stop (modelBudgetSignals)', () => {
        process.env.AI_DISABLED = '1';
        try {
            expect(defaultQuestionGenerator(ctx).unavailableReason()).toBeNull();
        } finally {
            delete process.env.AI_DISABLED;
        }
    });
});
