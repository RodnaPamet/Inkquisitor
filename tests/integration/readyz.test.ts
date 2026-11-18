/**
 * /api/readyz against the real dependencies: 200 when PostgreSQL and Redis
 * answer, 503 naming Redis when it does not.
 */
import { testRedisUrl } from '../helpers/test-redis';

afterEach(async () => {
    const { _closeReadinessClients } = await import('@/lib/health/readiness');
    await _closeReadinessClients();
    const { prisma } = await import('@/lib/db');
    await prisma.$disconnect();
    jest.resetModules();
});

it('is ready when the database and Redis answer', async () => {
    process.env.REDIS_URL = testRedisUrl();
    const { GET } = await import('@/app/api/readyz/route');
    const res = await GET();
    const body = await res.json();
    expect({ status: res.status, failed: body.failed }).toEqual({ status: 200, failed: [] });
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.redis.status).toBe('ok');
});

it('answers 503 within its timeout when Redis is unreachable', async () => {
    // Port 1 on loopback: nothing listens, the connection is refused.
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const { GET } = await import('@/app/api/readyz/route');
    const started = Date.now();
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe('not_ready');
    expect(body.failed).toEqual(['redis']);
    expect(body.checks.database.status).toBe('ok');
    expect(['connection_failed', 'timeout']).toContain(body.checks.redis.error);
    expect(Date.now() - started).toBeLessThan(5_000);
    delete process.env.REDIS_URL;
}, 10_000);
