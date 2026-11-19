/**
 * An error's message reaches a log line, a span or Sentry only when it is our
 * own (an AppError). A Prisma validation error renders the failed call's
 * arguments into its message, so it must leave as its name, code and frames.
 */
jest.mock('@sentry/nextjs', () => {
    const captured: unknown[] = [];
    const scope = { setTag: jest.fn(), setUser: jest.fn() };
    return {
        __captured: captured,
        init: jest.fn(),
        getClient: () => ({}),
        withScope: (fn: (s: typeof scope) => void) => fn(scope),
        captureException: (e: unknown) => {
            captured.push(e);
            return 'evt-1';
        },
    };
});

import * as Sentry from '@sentry/nextjs';
import type { ErrorEvent } from '@sentry/nextjs';
import { NextRequest } from 'next/server';
import { Writable } from 'node:stream';
import { NotFoundError } from '@/lib/errors/types';
import { withApiErrorHandling } from '@/lib/errors/api';
import * as tracing from '@/lib/observability/tracing';
import { createLogger, pinoInstance } from '@/lib/observability/logger';
import { _resetSentryForTests, captureError, initSentry, scrubEvent } from '@/lib/observability/sentry';
import { WITHHELD_MESSAGE, safeErrorMeta, safeErrorMessage, toReportableError } from '@/lib/observability/safe-error';
import { executorRegistry } from '@/app-layer/jobs/executor-registry';

const AUTHOR_TEXT = 'The orchard burned the night Elin left';

// The SDK (mocked above) is loaded only by initSentry with a DSN.
beforeAll(async () => {
    _resetSentryForTests();
    process.env.SENTRY_DSN = 'https://public@sentry.example.test/1';
    await initSentry();
});
afterAll(() => {
    delete process.env.SENTRY_DSN;
    _resetSentryForTests();
});

class PrismaClientValidationError extends Error {
    constructor() {
        super(`Invalid \`prisma.bibleEntry.create()\` invocation:\n{\n  data: {\n    content: "${AUTHOR_TEXT}"\n  }\n}`);
        this.name = 'PrismaClientValidationError';
    }
}

class PrismaClientKnownRequestError extends Error {
    code = 'P2002';
    constructor() {
        super(`Unique constraint failed on value "${AUTHOR_TEXT}"`);
        this.name = 'PrismaClientKnownRequestError';
    }
}

describe('safeErrorMeta', () => {
    it('keeps an AppError whole', () => {
        const meta = safeErrorMeta(new NotFoundError('No such book'));
        expect(meta).toMatchObject({ name: 'NotFoundError', message: 'No such book', code: 'NOT_FOUND' });
        expect(meta.stack).toContain('No such book');
    });

    it('withholds a Prisma message, from the message AND every stack line, keeping name, code and frames', () => {
        for (const err of [new PrismaClientValidationError(), new PrismaClientKnownRequestError()]) {
            const meta = safeErrorMeta(err);
            expect(JSON.stringify(meta)).not.toContain(AUTHOR_TEXT);
            expect(meta.name).toBe(err.name);
            expect(meta.message).toBe(WITHHELD_MESSAGE);
            expect(meta.stack).toMatch(/\n\s+at /);
        }
        expect(safeErrorMeta(new PrismaClientKnownRequestError()).code).toBe('P2002');
        expect(safeErrorMessage(new PrismaClientKnownRequestError())).toContain('P2002');
    });

    it('withholds any other third-party message and a thrown non-Error', () => {
        let parseError: unknown;
        try {
            JSON.parse(AUTHOR_TEXT);
        } catch (e) {
            parseError = e;
        }
        expect(JSON.stringify(safeErrorMeta(parseError))).not.toContain('orchard');
        expect(safeErrorMeta(AUTHOR_TEXT)).toEqual({ name: 'UnknownError', message: WITHHELD_MESSAGE });
        const reportable = toReportableError(new PrismaClientValidationError());
        expect(reportable.name).toBe('PrismaClientValidationError');
        expect(`${reportable.message}${reportable.stack}`).not.toContain(AUTHOR_TEXT);
    });
});

describe('every sink', () => {
    afterEach(() => jest.restoreAllMocks());

    it("pino's err serializer withholds the message", () => {
        const lines: string[] = [];
        const destination = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } });
        const log = createLogger(destination);
        log.level = 'info';
        log.error({ err: new PrismaClientValidationError() }, 'x');
        expect(lines.join('')).not.toContain(AUTHOR_TEXT);
        expect(JSON.parse(lines[0]).err.type).toBe('PrismaClientValidationError');
    });

    it('withApiErrorHandling: the log line, the span and Sentry get no message', async () => {
        const logged: string[] = [];
        jest.spyOn(pinoInstance, 'error').mockImplementation(((obj: unknown) => {
            logged.push(JSON.stringify(obj));
        }) as never);
        const span = {
            setAttributes: jest.fn(),
            setStatus: jest.fn(),
            recordException: jest.fn(),
            end: jest.fn(),
        };
        jest.spyOn(tracing, 'getTracer').mockReturnValue({
            startActiveSpan: (_n: string, fn: (s: typeof span) => unknown) => fn(span),
        } as never);
        const captured = (Sentry as unknown as { __captured: unknown[] }).__captured;
        captured.length = 0;

        const handler = withApiErrorHandling(async () => {
            throw new PrismaClientValidationError();
        });
        const res = await handler(new NextRequest('http://localhost/api/thing'), {});
        expect(res.status).toBe(500);

        expect(logged.join('\n')).toContain('PrismaClientValidationError');
        expect(logged.join('\n')).not.toContain(AUTHOR_TEXT);
        const statusArg = JSON.stringify(span.setStatus.mock.calls);
        expect(statusArg).not.toContain(AUTHOR_TEXT);
        const recorded = span.recordException.mock.calls[0][0] as Error;
        expect(`${recorded.message}${recorded.stack}`).not.toContain(AUTHOR_TEXT);
        expect(captured).toHaveLength(1);
        const sent = captured[0] as Error;
        expect(sent.name).toBe('PrismaClientValidationError');
        expect(`${sent.message}${sent.stack}`).not.toContain(AUTHOR_TEXT);
    });

    it('captureError reports an AppError as itself', () => {
        const captured = (Sentry as unknown as { __captured: unknown[] }).__captured;
        captured.length = 0;
        const err = new NotFoundError('No such book');
        captureError(err, { status: 500 });
        expect(captured[0]).toBe(err);
    });

    it("Sentry's beforeSend withholds Prisma and non-AppError exception values, keeping an AppError's own", () => {
        const prismaEvent = {
            exception: { values: [{ type: 'PrismaClientValidationError', value: AUTHOR_TEXT }] },
        } as unknown as ErrorEvent;
        expect(JSON.stringify(scrubEvent(prismaEvent))).not.toContain(AUTHOR_TEXT);

        const plain = new Error(AUTHOR_TEXT);
        const plainEvent = { exception: { values: [{ type: 'Error', value: AUTHOR_TEXT }] } } as unknown as ErrorEvent;
        expect(JSON.stringify(scrubEvent(plainEvent, { originalException: plain }))).not.toContain(AUTHOR_TEXT);

        const own = new NotFoundError('No such book');
        const ownEvent = {
            exception: {
                values: [
                    { type: 'Error', value: AUTHOR_TEXT },
                    { type: 'NotFoundError', value: 'No such book' },
                ],
            },
        } as unknown as ErrorEvent;
        const out = scrubEvent(ownEvent, { originalException: own })!;
        expect(out.exception!.values![1].value).toBe('No such book');
        expect(JSON.stringify(out)).not.toContain(AUTHOR_TEXT);
    });

    it("the executor registry's failure reason withholds a thrown third-party message", async () => {
        executorRegistry._reset(false);
        executorRegistry.register('heartbeat', async () => {
            throw new PrismaClientValidationError();
        });
        try {
            const result = await executorRegistry.execute('heartbeat', {} as never);
            expect(result.success).toBe(false);
            expect(result.errorMessage).not.toContain(AUTHOR_TEXT);
            expect(result.errorMessage).toContain('PrismaClientValidationError');
        } finally {
            executorRegistry._reset();
        }
    });
});
