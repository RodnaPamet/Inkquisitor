/**
 * Job schedules — the repeatable jobs and their cron patterns.
 *
 * Registered with BullMQ by `registerSchedules` on every worker boot
 * (idempotent: BullMQ deduplicates a scheduler by id), and readable by the
 * in-process `scheduler.tick()` for a host with no BullMQ.
 *
 * Times are UTC unless an entry sets `tz`.
 *
 * IDEMPOTENCY: do not rely on BullMQ's job-id dedupe as an exactly-once
 * guarantee (a completed job's id is reusable once it leaves the retained
 * set). A job whose double run would be visible carries its own durable
 * idempotency key at the work layer.
 *
 * Adapted from inflect-compliance's `src/app-layer/jobs/schedules.ts`.
 */
import type { JobName } from './types';

export interface ScheduleDefinition {
    name: JobName;
    /** Five-field cron, evaluated in `tz` when set, otherwise UTC. */
    pattern: string;
    tz?: string;
    description: string;
    defaultPayload: Record<string, unknown>;
}

export const SCHEDULED_JOBS: readonly ScheduleDefinition[] = [
    {
        // Two minutes against an eight-minute heartbeat TTL: four missed
        // beats before the worker reads unhealthy (`heartbeat.ts`).
        name: 'heartbeat',
        pattern: '*/2 * * * *',
        description: 'Give the worker a job to complete on a quiet queue; completing it refreshes the heartbeat key.',
        defaultPayload: {},
    },
    {
        // Daily, off the hour (03:17 UTC). A book becomes due 30 days after
        // its deletion; a day's lateness is the most it waits.
        name: 'book-purge',
        pattern: '17 3 * * *',
        description: 'Delete for good every book deleted more than 30 days ago, with its elements, history and vectors (Phase 1.H).',
        defaultPayload: {},
    },
];
