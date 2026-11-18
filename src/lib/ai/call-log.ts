/**
 * THE CALL RECORD — every model call, as numbers and names, never text.
 *
 * New for Inkquisitor (Phase 2.1). The roadmap's `AiCallLog` table needs a
 * workspace to belong to and row-level security to live under, and both arrive
 * with Phase 0.3. Until then the model layer writes through this interface,
 * and the in-memory recorder below is its only implementation. The Prisma
 * recorder (an `AiCallLog` model in a domain schema file, RLS-scoped to the
 * workspace) implements the same interface once 0.3 lands; `callStructured`
 * does not change.
 *
 * ── WHAT A RECORD NEVER HOLDS (roadmap rule 4) ──────────────────────────────
 *
 * No prompt, no author text, no model output, no error message from the
 * provider. A record holds ids, the prompt's id and version, the model,
 * counts, money, a duration, an outcome code and the guard's rule ids. Every
 * string field is code-supplied (`AiCallRecord` documents each).
 * `tests/unit/ai/call-structured.test.ts` asserts that a serialised record
 * contains neither the author's text nor the model's answer.
 */
import type { GuardCheck } from './guard';
import type { OutputMode } from './prompt';

/** How a call ended. Every exit of `callStructured` records exactly one. */
export type AiCallOutcome =
    | 'ok'
    | 'ok_after_repair'
    | 'invalid_output'
    | 'truncated'
    | 'model_refused'
    | 'guard_blocked_input'
    | 'guard_blocked_output'
    | 'spend_ceiling'
    | 'disabled'
    | 'unavailable'
    | 'provider_error'
    | 'request_refused'
    | 'aborted';

export interface AiCallRecord {
    /** Random id per `callStructured` invocation. */
    readonly callId: string;
    /** The spend scope the call was charged to (a workspace id once 0.3 lands). Opaque. */
    readonly scopeId: string;
    /** The template's `purpose`. */
    readonly purpose: string;
    readonly promptId: string;
    readonly promptVersion: string;
    /** The model id the tier resolved to. */
    readonly model: string;
    /** How structured output was asked for. Null when the call ended before a request was built. */
    readonly outputMode: OutputMode | null;
    /** Requests sent: 0 (refused before any), 1, or 2 (one repair). */
    readonly attempts: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicroUsd: number;
    /** The per-call budget the spend ceiling was asked about (roadmap rule 9). */
    readonly worstCaseMicroUsd: number;
    readonly durationMs: number;
    readonly outcome: AiCallOutcome;
    /** Every guard check the call made: one per data block, one on the output. Rule ids only. */
    readonly guardVerdicts: readonly GuardCheck[];
    /** ISO-8601 instant the call started. */
    readonly startedAt: string;
}

/** Where call records go. One implementation today (in memory); a Prisma one with Phase 0.3. */
export interface AiCallRecorder {
    record(entry: AiCallRecord): Promise<void>;
}

/**
 * Holds records in process memory, newest last, up to `capacity` (oldest are
 * dropped first). For tests and for a process with no database yet; never the
 * production store once 0.3 lands.
 */
export class InMemoryAiCallRecorder implements AiCallRecorder {
    private readonly entries: AiCallRecord[] = [];

    constructor(private readonly capacity = 1_000) {}

    async record(entry: AiCallRecord): Promise<void> {
        this.entries.push(entry);
        if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    }

    /** A copy, newest last. */
    list(): AiCallRecord[] {
        return [...this.entries];
    }

    clear(): void {
        this.entries.length = 0;
    }
}
