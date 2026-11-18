/**
 * GET /api/health
 *
 * Liveness probe: 200 `{ status: 'ok' }` while the process is serving
 * requests. It checks no dependency on purpose — a readiness probe that
 * pings Postgres and Redis arrives with the platform services (Phase 0.4).
 *
 * Unauthenticated by design: orchestrators and load balancers call it with
 * no credential, and it returns nothing but the status.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
    return Response.json({ status: 'ok' }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
