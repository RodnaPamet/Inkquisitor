/**
 * The cost-aware model-call limit (issue #32, item 5): charged by the calls a
 * request will make, per workspace, all or nothing; refused 429
 * MODEL_RATE_LIMITED with a retry hint; another workspace is unaffected; off
 * where the other tiers are off.
 */
import { clearAllRateLimits } from '@/lib/security/rate-limit';
import { chargeModelCalls, MODEL_CALLS_LIMIT } from '@/lib/security/model-call-rate-limit';
import { RateLimitedError } from '@/lib/errors/types';

const on = () => false;
const LIMIT = { maxAttempts: 5, windowMs: 60_000 };

beforeEach(() => clearAllRateLimits());

it('counts calls, not requests: two rounds of three personas fit a budget of five no more than once', () => {
    chargeModelCalls('ws-a', 3, LIMIT, on);
    let refused: unknown = null;
    try {
        chargeModelCalls('ws-a', 3, LIMIT, on);
    } catch (err) {
        refused = err;
    }
    expect(refused).toBeInstanceOf(RateLimitedError);
    expect(refused).toMatchObject({ status: 429, details: { reason: 'MODEL_RATE_LIMITED', retryAfterMs: expect.any(Number) } });
    // All or nothing: the refused charge took nothing, so two single calls still fit.
    chargeModelCalls('ws-a', 1, LIMIT, on);
    chargeModelCalls('ws-a', 1, LIMIT, on);
    expect(() => chargeModelCalls('ws-a', 1, LIMIT, on)).toThrow(RateLimitedError);
    // Another workspace has its own minute.
    expect(() => chargeModelCalls('ws-b', 5, LIMIT, on)).not.toThrow();
});

it('is off where the rate-limit tiers are off', () => {
    for (let i = 0; i < 10; i++) chargeModelCalls('ws-c', 3, LIMIT, () => true);
});

it('the default budget is 100 model calls a minute per workspace (D17): the 100th call fits, the 101st is refused', () => {
    expect(MODEL_CALLS_LIMIT).toEqual({ maxAttempts: 100, windowMs: 60_000 });
    for (let i = 0; i < 33; i++) chargeModelCalls('ws-d', 3, MODEL_CALLS_LIMIT, on);
    chargeModelCalls('ws-d', 1, MODEL_CALLS_LIMIT, on);
    expect(() => chargeModelCalls('ws-d', 1, MODEL_CALLS_LIMIT, on)).toThrow(RateLimitedError);
});
