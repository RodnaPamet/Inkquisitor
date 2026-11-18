/**
 * GET /api/livez — liveness probe.
 *
 * 200 while the process is serving requests. It checks no dependency on
 * purpose: a liveness failure makes the orchestrator RESTART the process, and
 * restarting the app does not bring a database back. Dependencies are
 * /api/readyz's job.
 *
 * Unauthenticated by design; returns nothing but the status and uptime.
 *
 * Adapted from inflect-compliance's `src/app/api/livez/route.ts`.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
    return Response.json(
        { status: 'alive', timestamp: new Date().toISOString(), uptime: process.uptime() },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
}
