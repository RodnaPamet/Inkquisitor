/**
 * THE PROSE CHECKS' WORK BOUND PER WORKSPACE (Phase 5.2, D34 item 1). The
 * checks are deterministic code, so the cap is work, not money: each check is
 * bounded in text (`PROSE_CHECK_TEXT_MAX_CHARS`), repeated saves of a scene
 * coalesce in the queue (`prose-check-schedule.ts`), and a workspace runs at
 * most `PROSE_CHECK_RUNS_LIMIT` checks a minute — a check past it is put back
 * on the queue for when the minute frees, never dropped and never run.
 *
 * Charged by the WORKER, once a check is about to run (a save that only
 * reschedules a waiting check charges nothing). In-process, like the model-call
 * limit (`model-call-rate-limit.ts`): per worker process, honestly. Off where
 * the other tiers are off (`isRateLimitBypassed`: tests, `RATE_LIMIT_ENABLED=0`).
 */
import { checkRateLimit, type RateLimitConfig } from './rate-limit';
import { isRateLimitBypassed } from './rate-limit-middleware';

/** Checks a workspace runs a minute: a busy author's pauses and a chapter re-run, with room to spare. */
export const PROSE_CHECK_RUNS_LIMIT: RateLimitConfig = { maxAttempts: 60, windowMs: 60_000 };

/** Charge one check to the workspace's minute: 0 when it may run now, else the milliseconds until it may. */
export function chargeProseCheckRun(workspaceId: string, config: RateLimitConfig = PROSE_CHECK_RUNS_LIMIT, bypass: () => boolean = isRateLimitBypassed): number {
    if (bypass()) return 0;
    const result = checkRateLimit(`prose-checks:ws:${workspaceId}`, config);
    return result.allowed ? 0 : Math.max(1_000, result.retryAfterMs);
}
