/**
 * The job layer without Redis: the registry, the schedules, the cron matcher,
 * the scheduler tick, the job-id check and the heartbeat writer.
 */
import { InternalError } from '@/lib/errors/types';
import { executorRegistry } from '@/app-layer/jobs/executor-registry';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { cronMatchesNow, scheduler } from '@/app-layer/jobs/scheduler';
import { registerSchedules } from '@/app-layer/jobs/register-schedules';
import { isValidBullMqJobId } from '@/app-layer/jobs/queue';
import { JOB_DEFAULTS, QUEUE_NAME } from '@/app-layer/jobs/types';
import {
    beat,
    isWorkerHealthy,
    WORKER_HEARTBEAT_KEY,
    WORKER_HEARTBEAT_TTL_SECONDS,
} from '@/app-layer/jobs/heartbeat';
import { OTEL_CARRIER_KEY, readTraceCarrier, stripTraceCarrier } from '@/lib/observability/job-trace';

afterEach(() => executorRegistry._reset());

describe('executor registry', () => {
    it('registers the heartbeat, the book purge (Phase 1.H), the call-log retention (2.H), the research run (2.6), the source ingestion (4.0), the fact layer’s dispatcher and extraction (4.1) the backfill (4.H-b), and the nightly continuity dispatcher and check (4.2) and the stress test (4.3), nothing else', () => {
        expect(executorRegistry.listRegistered()).toEqual(['heartbeat', 'book-purge', 'ai-call-log-retention', 'research-run', 'source-ingest', 'fact-layer-dispatch', 'bible-facts', 'fact-backfill', 'continuity-dispatch', 'continuity-check', 'stress-test']);
    });

    it('the heartbeat is a no-op that succeeds', async () => {
        const r = await executorRegistry.execute('heartbeat', {});
        expect(r).toMatchObject({ jobName: 'heartbeat', success: true, itemsActioned: 0 });
    });

    it('isolates a throwing executor into a failure result, and refuses a duplicate', async () => {
        executorRegistry._reset(false);
        executorRegistry.register('heartbeat', async () => {
            throw new InternalError('executor exploded');
        });
        const r = await executorRegistry.execute('heartbeat', {});
        // An AppError's own message is the failure reason; a third party's is
        // withheld (tests/unit/observability/safe-error.test.ts).
        expect(r).toMatchObject({ success: false, errorMessage: 'executor exploded' });
        expect(() => executorRegistry.register('heartbeat', async () => r)).toThrow(/Duplicate/);
    });

    it('a job with no executor fails without throwing', async () => {
        const r = await executorRegistry.execute('no-such-job' as 'heartbeat', {});
        expect(r.success).toBe(false);
        expect(r.errorMessage).toMatch(/No executor/);
    });
});

describe('schedules', () => {
    it('every scheduled job has an executor and defaults', () => {
        expect(scheduler.validateRegistrations()).toEqual({ valid: true, missing: [] });
        for (const s of SCHEDULED_JOBS) expect(JOB_DEFAULTS[s.name]).toBeDefined();
    });

    it('the book purge runs once a day, off the hour', () => {
        const purge = SCHEDULED_JOBS.find((s) => s.name === 'book-purge');
        expect(purge?.pattern).toMatch(/^([1-9]|[1-5]\d) \d{1,2} \* \* \*$/);
    });

    it('the call-log retention runs once a day, off the hour (Phase 2.H)', () => {
        const retention = SCHEDULED_JOBS.find((s) => s.name === 'ai-call-log-retention');
        expect(retention?.pattern).toMatch(/^([1-9]|[1-5]\d) \d{1,2} \* \* \*$/);
    });

    it('the heartbeat TTL survives at least three missed beats of its cron', () => {
        const hb = SCHEDULED_JOBS.find((s) => s.name === 'heartbeat');
        const minutes = Number(/^\*\/(\d+) /.exec(hb!.pattern)?.[1]);
        expect(minutes).toBeGreaterThan(0);
        expect(WORKER_HEARTBEAT_TTL_SECONDS).toBeGreaterThanOrEqual(minutes * 60 * 3);
    });

    it('registerSchedules upserts each schedule with its JOB_DEFAULTS as opts', async () => {
        const calls: unknown[][] = [];
        const count = await registerSchedules({ upsertJobScheduler: async (...args: unknown[]) => { calls.push(args); return undefined as never; } } as never);
        expect(count).toBe(SCHEDULED_JOBS.length);
        expect(calls[0][0]).toBe('heartbeat');
        expect(calls[0][1]).toEqual({ pattern: '*/2 * * * *' });
        expect(calls[0][2]).toMatchObject({ name: 'heartbeat', opts: { attempts: 1 } });
    });

    it('the queue has a product-specific name', () => {
        expect(QUEUE_NAME).toBe('inkquisitor-jobs');
    });
});

describe('cron matcher and tick', () => {
    it('matches steps, lists, ranges and exact values in UTC', () => {
        const t = new Date('2026-11-18T10:04:00Z'); // Wednesday
        expect(cronMatchesNow('*/2 * * * *', t)).toBe(true);
        expect(cronMatchesNow('*/3 * * * *', t)).toBe(false);
        expect(cronMatchesNow('4 10 * * 3', t)).toBe(true);
        expect(cronMatchesNow('0,4 9-11 18 11 *', t)).toBe(true);
        expect(cronMatchesNow('4 10 * * 1', t)).toBe(false);
    });

    it('honours a schedule timezone', () => {
        const t = new Date('2026-07-01T07:30:00Z');
        expect(cronMatchesNow('30 9 * * *', t, 'Europe/Sofia')).toBe(false);
        expect(cronMatchesNow('30 10 * * *', t, 'Europe/Sofia')).toBe(true);
    });

    it('tick runs exactly the jobs that are due', async () => {
        // The fact layer's dispatcher (4.1) is due every minute; here it is a no-op, as the heartbeat is (no database in a unit test).
        const spy = jest.fn(async () => ({ jobName: 'fact-layer-dispatch', jobRunId: 'x', success: true, startedAt: '', completedAt: '', durationMs: 0, itemsScanned: 0, itemsActioned: 0, itemsSkipped: 0 }));
        executorRegistry._reset(false);
        executorRegistry.register('heartbeat', async () => ({ jobName: 'heartbeat', jobRunId: 'h', success: true, startedAt: '', completedAt: '', durationMs: 0, itemsScanned: 0, itemsActioned: 0, itemsSkipped: 0 }));
        executorRegistry.register('fact-layer-dispatch', spy);
        try {
            const due = await scheduler.tick(new Date('2026-11-18T10:04:00Z'));
            expect(due.jobsExecuted).toBe(2); // the heartbeat (every two minutes) and the dispatcher
            expect(due.jobsSucceeded).toBe(2);
            const odd = await scheduler.tick(new Date('2026-11-18T10:05:00Z'));
            expect(odd.jobsExecuted).toBe(1); // the dispatcher alone
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            executorRegistry._reset();
        }
    });
});

describe('job ids and trace carrier', () => {
    it('accepts BullMQ-valid custom ids only', () => {
        expect(isValidBullMqJobId('heartbeat-123')).toBe(true);
        expect(isValidBullMqJobId('a:b:c')).toBe(true);
        expect(isValidBullMqJobId('a:b')).toBe(false);
        expect(isValidBullMqJobId('a:b:c:d')).toBe(false);
    });

    it('the carrier is read and stripped before an executor sees the payload', () => {
        const data = { workspaceId: 'w1', [OTEL_CARRIER_KEY]: { traceparent: '00-abc' } };
        expect(readTraceCarrier(data)).toEqual({ traceparent: '00-abc' });
        expect(stripTraceCarrier(data)).toEqual({ workspaceId: 'w1' });
    });
});

describe('heartbeat', () => {
    it('writes the key with the TTL, and swallows a failed write', async () => {
        const set = jest.fn().mockResolvedValue('OK');
        await beat({ set } as never, () => 42);
        expect(set).toHaveBeenCalledWith(WORKER_HEARTBEAT_KEY, '42', 'EX', WORKER_HEARTBEAT_TTL_SECONDS);
        await expect(beat({ set: jest.fn().mockRejectedValue(new Error('down')) } as never)).resolves.toBeUndefined();
    });

    it('healthy means the key exists', async () => {
        expect(await isWorkerHealthy({ exists: async () => 1 } as never)).toBe(true);
        expect(await isWorkerHealthy({ exists: async () => 0 } as never)).toBe(false);
        expect(await isWorkerHealthy({ exists: async () => { throw new Error('x'); } } as never)).toBe(false);
    });
});
