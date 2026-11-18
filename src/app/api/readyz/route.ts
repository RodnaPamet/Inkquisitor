/**
 * GET /api/readyz — readiness probe.
 *
 * 200 `{ status: 'ready', … }` when PostgreSQL and Redis both answer within
 * the per-check timeout; 503 `{ status: 'not_ready', failed: [...] }`
 * otherwise. The body names each check's status, latency and a fixed error
 * code, never a driver message (see src/lib/health/readiness.ts).
 *
 * Unauthenticated by design, like /api/health and /api/livez: an
 * orchestrator calls it with no credential. The read rate-limit tier
 * excludes it so a flood of API reads cannot make an instance look down.
 */
import { defaultReadinessChecks, runReadinessChecks } from '@/lib/health/readiness';
import { logger } from '@/lib/observability/logger';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
    const start = Date.now();
    const report = await runReadinessChecks(defaultReadinessChecks());
    if (!report.ready) {
        logger.warn('readyz: dependency check failed', { component: 'readyz', failed: report.failed });
    }
    return Response.json(
        {
            status: report.ready ? 'ready' : 'not_ready',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            checks: report.checks,
            failed: report.failed,
            latencyMs: Date.now() - start,
        },
        { status: report.ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
    );
}
