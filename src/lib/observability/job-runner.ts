/**
 * Job runner — the observability wrapper every job executor's body runs in.
 *
 * Gives the run a fresh request context (`requestId` = a new jobRunId,
 * `route: job:<name>`), a `job.<name>` span, start / completed / failed log
 * lines, and Sentry capture on failure. It rethrows, so the executor registry
 * decides what a failure means.
 *
 * Adapted from inflect-compliance's `src/lib/observability/job-runner.ts`
 * (job metrics are recorded once, by the executor registry, not here too).
 */

import { runWithRequestContext } from './context';
import { logger } from './logger';
import { traceOperation } from './tracing';
import { captureError } from './sentry';
import { safeErrorMeta } from './safe-error';

export async function runJob<T>(
    jobName: string,
    fn: () => Promise<T>,
    options?: { workspaceId?: string },
): Promise<T> {
    const jobRunId = crypto.randomUUID();
    const startTime = performance.now();
    return runWithRequestContext(
        { requestId: jobRunId, route: `job:${jobName}`, startTime, workspaceId: options?.workspaceId },
        async () => {
            const meta = { component: 'job', jobName, jobRunId };
            logger.info('job started', meta);
            return traceOperation(`job.${jobName}`, { 'job.runId': jobRunId }, async () => {
                try {
                    const result = await fn();
                    logger.info('job completed', { ...meta, durationMs: Math.round(performance.now() - startTime) });
                    return result;
                } catch (error) {
                    logger.error('job failed', {
                        ...meta,
                        durationMs: Math.round(performance.now() - startTime),
                        error: safeErrorMeta(error),
                    });
                    captureError(error, { requestId: jobRunId, route: `job:${jobName}`, status: 500 });
                    throw error;
                }
            });
        },
    );
}
