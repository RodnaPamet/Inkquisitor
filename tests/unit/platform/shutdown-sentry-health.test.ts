/**
 * Graceful shutdown, Sentry scrubbing, the readiness logic and liveness.
 */
import { runShutdownStages } from '@/lib/observability/shutdown';
import { SHUTDOWN_STAGES_TOTAL_MS, SHUTDOWN_TOTAL_CEILING_MS } from '@/lib/observability/shutdown-budget';
import { scrubEvent, redactUrl } from '@/lib/observability/sentry';
import { runReadinessChecks } from '@/lib/health/readiness';
import { GET as livez } from '@/app/api/livez/route';
import type { ErrorEvent } from '@sentry/nextjs';

describe('graceful shutdown', () => {
    it('runs every stage in order even when one throws and one hangs', async () => {
        const order: string[] = [];
        const outcomes = await runShutdownStages([
            { name: 'a', budgetMs: 100, run: async () => { order.push('a'); throw new Error('x'); } },
            { name: 'b', budgetMs: 20, run: () => new Promise<void>(() => order.push('b')) },
            { name: 'c', budgetMs: 100, run: async () => { order.push('c'); } },
        ]);
        expect(order).toEqual(['a', 'b', 'c']);
        expect(outcomes).toEqual(['a:failed', 'b:timeout', 'c:done']);
    });

    it('the stage budgets fit under the ceiling', () => {
        expect(SHUTDOWN_STAGES_TOTAL_MS).toBeLessThanOrEqual(SHUTDOWN_TOTAL_CEILING_MS);
    });
});

describe('Sentry scrubbing', () => {
    it('drops bodies, cookies, auth headers, query strings and the IP', () => {
        const event = {
            request: {
                headers: { Authorization: 'Bearer x', cookie: 's=1', 'user-agent': 'ua' },
                data: { answer: 'Mara never forgave her brother' },
                cookies: { s: '1' },
                url: 'https://app.example/reset?token=abc&page=2',
                query_string: 'token=abc',
            },
            user: { id: 'u1', ip_address: '203.0.113.7' },
            breadcrumbs: [{ data: { url: '/cb?code=xyz' } }],
        } as unknown as ErrorEvent;
        const out = scrubEvent(event)!;
        const text = JSON.stringify(out);
        expect(text).not.toContain('Mara');
        expect(text).not.toContain('Bearer');
        expect(text).not.toContain('203.0.113.7');
        expect(text).not.toContain('abc');
        expect(text).not.toContain('xyz');
        expect(out.request?.headers?.['user-agent']).toBe('ua');
        expect(out.user?.id).toBe('u1');
    });

    it('drops Next navigation signals entirely', () => {
        expect(scrubEvent({} as ErrorEvent, { originalException: new Error('NEXT_REDIRECT') })).toBeNull();
    });

    it('cuts the whole query from relative URLs too, not only credential-named params (issue #29 item 1)', () => {
        expect(redactUrl('/x?state=1&b=2')).toBe('/x?[Filtered]');
    });
});

describe('readiness', () => {
    it('ready only when every check answers ok', async () => {
        const r = await runReadinessChecks({ database: async () => 'ok', redis: async () => 'ok' });
        expect(r).toMatchObject({ ready: true, failed: [] });
    });

    it('names a refusing check, a hanging check and an odd reply, with fixed error codes', async () => {
        const r = await runReadinessChecks(
            {
                database: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 role=app'); },
                redis: () => new Promise(() => undefined),
                other: async () => 'unexpected_reply',
            },
            50,
        );
        expect(r.ready).toBe(false);
        expect(r.failed.sort()).toEqual(['database', 'other', 'redis']);
        expect(r.checks.database.error).toBe('connection_failed');
        expect(r.checks.redis.error).toBe('timeout');
        expect(r.checks.other.error).toBe('unexpected_reply');
        expect(JSON.stringify(r)).not.toContain('10.0.0.5');
    });

    it('zero checks is not ready', async () => {
        expect((await runReadinessChecks({})).ready).toBe(false);
    });
});

describe('/api/livez', () => {
    it('answers 200 alive with no dependency', async () => {
        const res = livez();
        expect(res.status).toBe(200);
        expect((await res.json()).status).toBe('alive');
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
});
