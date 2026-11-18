/**
 * Register `SCHEDULED_JOBS` as BullMQ job schedulers.
 *
 * `upsertJobScheduler` is idempotent, so the worker calls this on every boot:
 * a running worker always implies its schedules exist (inflect-compliance
 * lost a daily reminder for weeks to a deploy step that was skipped).
 *
 * The template carries each job's `JOB_DEFAULTS` as `opts`; without it a
 * scheduled job takes the queue-level defaults (three attempts) whatever its
 * entry says, which is how inflect-compliance found its entries inert.
 *
 * Adapted from inflect-compliance's `src/app-layer/jobs/register-schedules.ts`
 * (its retired-scheduler sweep is not carried: nothing has been retired).
 */
import type { Queue } from 'bullmq';
import { SCHEDULED_JOBS, type ScheduleDefinition } from './schedules';
import { JOB_DEFAULTS } from './types';

export async function registerSchedules(
    queue: Pick<Queue, 'upsertJobScheduler'>,
    schedules: readonly ScheduleDefinition[] = SCHEDULED_JOBS,
): Promise<number> {
    for (const s of schedules) {
        await queue.upsertJobScheduler(
            s.name,
            { pattern: s.pattern, ...(s.tz ? { tz: s.tz } : {}) },
            { name: s.name, data: s.defaultPayload, opts: { ...JOB_DEFAULTS[s.name] } },
        );
    }
    return schedules.length;
}
