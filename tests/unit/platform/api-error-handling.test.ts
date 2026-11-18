/**
 * withApiErrorHandling: the error envelope, the request id, the mutation
 * rate-limit tier, and that no request body reaches a log line.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { NotFoundError, ForbiddenError, ConflictError, InternalError, toApiErrorResponse } from '@/lib/errors/types';
import { pinoInstance } from '@/lib/observability/logger';
import { clearAllRateLimits, API_MUTATION_LIMIT } from '@/lib/security/rate-limit';

const AUTHOR_TEXT = 'The lighthouse keeper had buried the letters under the third step';

function req(method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/thing', {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

describe('toApiErrorResponse', () => {
    it.each([
        [new NotFoundError(), 404, 'NOT_FOUND'],
        [new ForbiddenError(), 403, 'FORBIDDEN'],
        [new ConflictError(), 409, 'CONFLICT'],
    ])('maps %p to its status and code', (err, status, code) => {
        const r = toApiErrorResponse(err, 'rid');
        expect(r.status).toBe(status);
        expect(r.payload.error.code).toBe(code);
        expect(r.payload.error.requestId).toBe('rid');
    });

    it('never exposes the message of a non-exposed or unknown error', () => {
        expect(toApiErrorResponse(new InternalError('db password is hunter2')).payload.error.message).toBe('An error occurred');
        const unknown = toApiErrorResponse(new Error('connection to 10.0.0.5:5432 refused'));
        expect(unknown.status).toBe(500);
        expect(JSON.stringify(unknown.payload)).not.toContain('10.0.0.5');
    });

    it('a ZodError is a 400 with the issues', () => {
        const parsed = z.object({ n: z.number() }).safeParse({ n: 'x' });
        const r = toApiErrorResponse(parsed.error);
        expect(r.status).toBe(400);
        expect(r.payload.error.code).toBe('VALIDATION_ERROR');
    });

    it('maps Prisma unique and not-found codes', () => {
        expect(toApiErrorResponse({ code: 'P2002', meta: { target: ['slug'] } }).status).toBe(409);
        expect(toApiErrorResponse({ code: 'P2025' }).status).toBe(404);
    });
});

describe('withApiErrorHandling', () => {
    const logged: string[] = [];
    beforeEach(() => {
        logged.length = 0;
        for (const level of ['debug', 'info', 'warn', 'error'] as const) {
            jest.spyOn(pinoInstance, level).mockImplementation(((obj: unknown, msg?: string) => {
                logged.push(JSON.stringify([obj, msg]));
            }) as never);
        }
        clearAllRateLimits();
    });
    afterEach(() => {
        jest.restoreAllMocks();
        delete process.env.RATE_LIMIT_ENABLED;
    });

    it('stamps the incoming x-request-id on the response', async () => {
        const handler = withApiErrorHandling(async () => NextResponse.json({ ok: true }));
        const res = await handler(req('GET', undefined, { 'x-request-id': 'abc-123' }), {});
        expect(res.headers.get('x-request-id')).toBe('abc-123');
    });

    it('replaces a request id that is not in the safe shape', async () => {
        const handler = withApiErrorHandling(async () => NextResponse.json({ ok: true }));
        const res = await handler(req('GET', undefined, { 'x-request-id': '<script>alert(1)</script>' }), {});
        expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('shapes a thrown AppError into the envelope', async () => {
        const handler = withApiErrorHandling(async () => {
            throw new NotFoundError('No such book');
        });
        const res = await handler(req(), {});
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toMatchObject({ code: 'NOT_FOUND', message: 'No such book' });
        expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
    });

    it('never logs the request body, on success or on failure', async () => {
        const ok = withApiErrorHandling(async (r: NextRequest) => {
            await r.json();
            return NextResponse.json({ ok: true });
        });
        const failing = withApiErrorHandling(async (r: NextRequest) => {
            await r.json();
            throw new Error('boom');
        });
        await ok(req('POST', { answer: AUTHOR_TEXT }), {});
        const res = await failing(req('POST', { answer: AUTHOR_TEXT }), {});
        expect(res.status).toBe(500);
        expect(logged.length).toBeGreaterThan(0);
        expect(logged.join('\n')).not.toContain('lighthouse keeper');
    });

    it('rate-limits mutations at API_MUTATION_LIMIT per IP when enabled', async () => {
        process.env.RATE_LIMIT_ENABLED = '1';
        const handler = withApiErrorHandling(async () => NextResponse.json({ ok: true }));
        for (let i = 0; i < API_MUTATION_LIMIT.maxAttempts; i++) {
            expect((await handler(req('POST', {}), {})).status).toBe(200);
        }
        const blocked = await handler(req('POST', {}), {});
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('Retry-After')).toBeTruthy();
        expect(blocked.headers.get('x-request-id')).toBeTruthy();
        // GETs are not the mutation tier's.
        expect((await handler(req('GET'), {})).status).toBe(200);
        // Another IP has its own budget.
        expect((await handler(req('POST', {}, { 'x-forwarded-for': '198.51.100.9' }), {})).status).toBe(200);
    });

    it('is bypassed under test unless the suite opts in', async () => {
        const handler = withApiErrorHandling(async () => NextResponse.json({ ok: true }));
        for (let i = 0; i < API_MUTATION_LIMIT.maxAttempts + 5; i++) {
            expect((await handler(req('POST', {}), {})).status).toBe(200);
        }
    });

    it('rateLimit: false opts a route out', async () => {
        process.env.RATE_LIMIT_ENABLED = '1';
        const handler = withApiErrorHandling(async () => NextResponse.json({ ok: true }), { rateLimit: false });
        for (let i = 0; i < API_MUTATION_LIMIT.maxAttempts + 5; i++) {
            expect((await handler(req('POST', {}), {})).status).toBe(200);
        }
    });

    it('keys the budget on the user when the route resolves one', async () => {
        process.env.RATE_LIMIT_ENABLED = '1';
        let user = 'u1';
        const handler = withApiErrorHandling(async () => NextResponse.json({ ok: true }), {
            rateLimit: { config: { maxAttempts: 2, windowMs: 60_000 }, scope: 'test', getUserId: () => user },
        });
        expect((await handler(req('POST', {}), {})).status).toBe(200);
        expect((await handler(req('POST', {}), {})).status).toBe(200);
        expect((await handler(req('POST', {}), {})).status).toBe(429);
        user = 'u2';
        expect((await handler(req('POST', {}), {})).status).toBe(200);
    });
});
