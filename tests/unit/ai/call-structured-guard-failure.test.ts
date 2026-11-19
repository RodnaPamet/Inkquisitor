/**
 * The guard fails CLOSED (Phase 2.1): a scanner that throws refuses the call
 * — nothing is sent when it is the input scan, the answer is withheld when it
 * is the output scan — and the call is still recorded, REFUSED_GUARD with
 * GUARD_UNAVAILABLE. The scanners are pure and are not expected to throw; this
 * holds the layer to its order if one ever does.
 */
import { z } from 'zod';

import { callStructured } from '@/lib/ai/call-structured';
import { AiGuardBlockedError } from '@/lib/ai/errors';
import { definePrompt } from '@/lib/ai/prompt';
import { fakeAnthropic, setFakeApiKey } from '../../helpers/fake-anthropic';
import { memoryLedger } from '../../helpers/memory-ai-ledger';

const failing = { input: false, output: false };

jest.mock('@/lib/ai/guard', () => {
    const actual = jest.requireActual<typeof import('@/lib/ai/guard')>('@/lib/ai/guard');
    return {
        ...actual,
        guardAuthorText: (...args: Parameters<typeof actual.guardAuthorText>) => {
            if (failing.input) throw new RangeError('scanner failed');
            return actual.guardAuthorText(...args);
        },
        guardModelOutput: (...args: Parameters<typeof actual.guardModelOutput>) => {
            if (failing.output) throw new RangeError('scanner failed');
            return actual.guardModelOutput(...args);
        },
    };
});

const TEMPLATE = definePrompt({
    id: 'test.guard-failure',
    version: '1',
    purpose: 'guard-failure',
    tier: 'fast',
    system: 'You ask an author questions about their book.',
    task: 'Ask one question about the note below.',
});
const SCHEMA = z.object({ question: z.string() });
const GOOD = JSON.stringify({ question: 'Who keeps the lighthouse?' });

let restoreKey: () => void;
beforeEach(() => {
    restoreKey = setFakeApiKey();
    failing.input = false;
    failing.output = false;
});
afterEach(() => restoreKey());

async function run() {
    const api = fakeAnthropic([{ kind: 'text', text: GOOD }]);
    const ledger = memoryLedger();
    const err = await callStructured(
        { template: TEMPLATE, data: [{ label: 'note', text: 'Ilse keeps the lighthouse.' }], schema: SCHEMA },
        { ledger, fetch: api.fetch, env: {} },
    ).then(
        () => null,
        (e: unknown) => e,
    );
    return { api, ledger, err };
}

it('the input scan throws: refused, NOTHING sent or reserved, recorded GUARD_UNAVAILABLE', async () => {
    failing.input = true;
    const { api, ledger, err } = await run();
    expect(err).toBeInstanceOf(AiGuardBlockedError);
    expect((err as AiGuardBlockedError).reason).toBe('GUARD_UNAVAILABLE');
    expect(api.requests).toHaveLength(0);
    expect(ledger.reserveRequests).toHaveLength(0);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({ outcome: 'REFUSED_GUARD', errorCode: 'GUARD_UNAVAILABLE', attempts: 0 });
});

it('the output scan throws: the answer is withheld, recorded GUARD_UNAVAILABLE with its cost', async () => {
    failing.output = true;
    const { api, ledger, err } = await run();
    expect(err).toBeInstanceOf(AiGuardBlockedError);
    expect((err as AiGuardBlockedError).direction).toBe('egress');
    expect((err as AiGuardBlockedError).reason).toBe('GUARD_UNAVAILABLE');
    expect(api.requests).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({ outcome: 'REFUSED_GUARD', errorCode: 'GUARD_UNAVAILABLE', attempts: 1 });
    expect(ledger.records[0].costMicroUsd).toBeGreaterThan(0);
});

it('with the scanners working, the same call succeeds (the mock is transparent)', async () => {
    const { err, ledger } = await run();
    expect(err).toBeNull();
    expect(ledger.records[0].outcome).toBe('OK');
});
