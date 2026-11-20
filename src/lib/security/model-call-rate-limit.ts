/**
 * A COST-AWARE RATE LIMIT ON MODEL CALLS (issue #32, item 5).
 *
 * The mutation limit (`API_MUTATION_LIMIT`, 60 a minute per client address)
 * counts REQUESTS, and a request that generates an interview round makes one
 * model call per persona — up to three — so one author's sixty requests could
 * be a hundred and eighty balanced-tier calls a minute, each reserved against
 * the month's ceiling. This limit counts the CALLS a request will make, per
 * WORKSPACE (the ceiling's own key), charged all or nothing BEFORE anything is
 * claimed or sent: `MODEL_CALLS_LIMIT` a minute. It sits next to 2.1's spend
 * ceiling, which bounds the month: this one bounds the rate, so a runaway
 * client cannot spend the month in minutes.
 *
 * In-process (the rate-limit tier's store, `src/lib/security/rate-limit.ts`),
 * like the mutation tier: per web process, honestly. Off where the other tiers
 * are off (`isRateLimitBypassed`: tests, `RATE_LIMIT_ENABLED=0`).
 *
 * Charged by: a round's claim (one unit per generation call it will make),
 * "Ask me this differently" (one), a research dispatch (its depth's requests
 * plus the findings and fit calls). Refused: 429 `MODEL_RATE_LIMITED` with
 * `retryAfterMs`, nothing written.
 */
import { RateLimitedError } from '@/lib/errors/types';
import { checkRateLimit, type RateLimitConfig } from './rate-limit';
import { isRateLimitBypassed } from './rate-limit-middleware';

/** Model calls a workspace may start a minute (D17, 2026-11-20): a busy author's rounds, rephrases and research, with room to spare. */
export const MODEL_CALLS_LIMIT: RateLimitConfig = { maxAttempts: 100, windowMs: 60_000 };

/** Charge `calls` model calls to the workspace's minute, or refuse 429 before anything is written. */
export function chargeModelCalls(workspaceId: string, calls: number, config: RateLimitConfig = MODEL_CALLS_LIMIT, bypass: () => boolean = isRateLimitBypassed): void {
    if (bypass() || calls <= 0) return;
    const result = checkRateLimit(`model-calls:ws:${workspaceId}`, config, Math.min(calls, config.maxAttempts));
    if (!result.allowed) throw new RateLimitedError('Too many AI requests in this workspace; wait a moment.', { reason: 'MODEL_RATE_LIMITED', retryAfterMs: result.retryAfterMs });
}
