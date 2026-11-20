/**
 * THE CALL RECORD AND THE LEDGER PORT (Phase 2.1).
 *
 * `callStructured` (`./call-structured.ts`) records every call — however it
 * ended — and reserves every call's worst case against the workspace's
 * monthly ceiling, through the `AiLedger` it is handed. The production ledger
 * is `src/app-layer/usecases/model-calls.ts`'s, over
 * `src/app-layer/repositories/ai-call.repository.ts` (`AiCallLog`,
 * `AiSpendMonth`, `AiSpendReservation`, under the workspace's RLS). The port
 * keeps this layer free of Prisma and lets the unit tests run the whole call
 * against an in-memory ledger.
 *
 * ── WHAT A RECORD NEVER HOLDS (roadmap rule 4) ──────────────────────────────
 *
 * No prompt, no author text, no model output, no provider message. A record
 * holds ids, the template's id, version and purpose, the tier and the model,
 * counts, money, a duration, an outcome, an error code from a closed list and
 * the guard's rule ids. Every string is code-supplied; the table's CHECKs
 * bound each one's shape.
 */
import type { AiCallOutcome, AiErrorCode } from './errors';
import type { OutputMode } from './prompt';

/** How a call asked for its answer: 2.1's two structured modes, or a server-tool turn (2.6). */
export type RecordedOutputMode = OutputMode | 'server_tools';
import type { ModelTier } from './tiers';

export interface AiCallRecord {
    /** The call's id, drawn before anything is reserved or sent. */
    readonly id: string;
    readonly bookId: string | null;
    readonly requestedById: string | null;
    readonly purpose: string;
    readonly promptId: string;
    readonly promptVersion: string;
    readonly tier: ModelTier;
    readonly model: string;
    readonly outputMode: RecordedOutputMode | null;
    readonly attempts: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly costMicroUsd: number;
    readonly costEstimated: boolean;
    readonly worstCaseMicroUsd: number;
    readonly durationMs: number;
    readonly outcome: AiCallOutcome;
    readonly errorCode: AiErrorCode | null;
    readonly guardRuleIds: readonly string[];
    readonly guardReviewRequired: boolean;
    /**
     * Server tool requests the provider billed on this call (Phase 2.6: the
     * research run's gather turns; 0 for every other call). Counts only.
     */
    readonly webSearchRequests?: number;
    readonly webFetchRequests?: number;
    readonly startedAt: Date;
}

/** The answer to "may this worst case be held against the month?". */
export type ReserveResult =
    | { readonly ok: true; readonly period: string }
    | {
          readonly ok: false;
          readonly period: string;
          readonly spentMicroUsd: number;
          readonly reservedMicroUsd: number;
          readonly ceilingMicroUsd: number;
      };

export interface ReserveRequest {
    /** The call's id; one reservation per call, re-reserved (replaced) before a repair. */
    readonly callId: string;
    /** What to hold: the attempt's worst case, plus what earlier attempts already cost. */
    readonly amountMicroUsd: number;
    readonly ceilingMicroUsd: number;
    /** How long the reservation counts if its process dies before settling. */
    readonly ttlMs: number;
    /** The call's start: the month it is charged to. */
    readonly startedAt: Date;
}

/** Where a call's money and record go. */
export interface AiLedger {
    /** Atomically: admit the reservation only if settled spend + live reservations + it fit under the ceiling. */
    reserve(request: ReserveRequest): Promise<ReserveResult>;
    /** Atomically: drop the call's reservation, add its cost to its month, append its record. */
    settle(record: AiCallRecord): Promise<void>;
}

/** The UTC calendar month an instant falls in: `YYYY-MM`. */
export function spendPeriod(at: Date): string {
    return at.toISOString().slice(0, 7);
}

/** The first day of that month, at UTC midnight (the `@db.Date` the ledger keys on). */
export function periodStartOf(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}
