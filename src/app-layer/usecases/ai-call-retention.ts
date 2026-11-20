/**
 * The daily call-log retention (Phase 2.H, issue #30 item 4; the
 * `ai-call-log-retention` job): delete every `AiCallLog` row started more than
 * `AI_CALL_LOG_RETENTION_DAYS` days ago (`src/lib/ai/call-log-retention.ts`).
 *
 * The rows are numbers and names (no text), deleted across workspaces in
 * bounded batches, oldest first, each batch its own short statement outside
 * row-level security (`runWithoutRls`, reason `ai-call-log-retention`) — the
 * one place the append-only trigger admits a delete that is not a cascade,
 * and only for a row past the floor written into the trigger. At most
 * `RETENTION_BATCHES` batches a run: a backlog is worked through over the
 * following days. Idempotent: a deleted row is not found again. The month's
 * spend is untouched (`AiSpendMonth`), so the ceiling never moves.
 */
import { AiCallRepository } from '@/app-layer/repositories/ai-call.repository';
import { env } from '@/env';
import { retentionCutoff, retentionDays } from '@/lib/ai/call-log-retention';
import { runWithoutRls } from '@/lib/db/rls-middleware';

/** Rows deleted per statement. */
export const RETENTION_BATCH = 1_000;
/** Statements per run. */
export const RETENTION_BATCHES = 50;

export interface RetentionResult {
    readonly days: number;
    readonly cutoff: string;
    readonly deleted: number;
    /** True when the run stopped at its batch cap with rows possibly left. */
    readonly more: boolean;
}

export async function purgeExpiredAiCallLogs(options: { now?: Date; days?: number; batch?: number; batches?: number } = {}): Promise<RetentionResult> {
    const days = options.days ?? retentionDays(env.AI_CALL_LOG_RETENTION_DAYS);
    const cutoff = retentionCutoff(options.now ?? new Date(), days);
    const batch = options.batch ?? RETENTION_BATCH;
    const batches = options.batches ?? RETENTION_BATCHES;
    let deleted = 0;
    for (let i = 0; i < batches; i++) {
        const n = await runWithoutRls({ reason: 'ai-call-log-retention' }, (db) => AiCallRepository.deleteStartedBefore(db, cutoff, batch));
        deleted += n;
        if (n < batch) return { days, cutoff: cutoff.toISOString(), deleted, more: false };
    }
    return { days, cutoff: cutoff.toISOString(), deleted, more: true };
}
