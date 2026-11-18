/**
 * The logger never writes a credential or author text (roadmap rule 4).
 *
 * Built against a capturing destination with the production options
 * (`createLogger(destination)` uses `loggerOptions()`, the same object the
 * process logger uses), so what is asserted here is what would reach stdout.
 */
import { Writable } from 'node:stream';
import { createLogger, withRequestBindings } from '@/lib/observability/logger';
import { createProcessLogger } from '@/lib/observability/process-logger';
import { formatEdgeLine } from '@/lib/observability/edge-logger';
import { REDACTED_KEYS, isRedactedKey, redactFields } from '@/lib/observability/redaction';
import { runWithRequestContext } from '@/lib/observability/context';

const AUTHOR_TEXT = 'Mara never forgave her brother for the fire at Ashgrove';
const CREDENTIAL = 'placeholder-credential-7f3a';

// jest.setup.js silences logs; this suite reads them, at production's level.
beforeAll(() => {
    process.env.LOG_LEVEL = 'info';
});
afterAll(() => {
    process.env.LOG_LEVEL = 'silent';
});

function capture() {
    const lines: string[] = [];
    const destination = new Writable({
        write(chunk, _enc, cb) {
            lines.push(String(chunk));
            cb();
        },
    });
    return { lines, destination };
}

describe('pino logger redaction', () => {
    it('redacts credentials and author text at the root, one level and two levels down', () => {
        const { lines, destination } = capture();
        const log = createLogger(destination);
        log.info(
            {
                authorization: `Bearer ${CREDENTIAL}`,
                cookie: `session=${CREDENTIAL}`,
                password: CREDENTIAL,
                token: CREDENTIAL,
                answer: AUTHOR_TEXT,
                text: AUTHOR_TEXT,
                req: { headers: { authorization: CREDENTIAL, cookie: CREDENTIAL }, body: { answer: AUTHOR_TEXT } },
                field: { content: AUTHOR_TEXT },
                questionId: 'q_123',
            },
            'saved',
        );
        const out = lines.join('');
        expect(out).not.toContain(CREDENTIAL);
        expect(out).not.toContain(AUTHOR_TEXT);
        // The ids that make the line useful survive.
        expect(out).toContain('q_123');
        expect(out).toContain('[Redacted]');
    });

    it('redacts by name at any depth, in any casing, and the OAuth snake_case names', () => {
        const { lines, destination } = capture();
        const log = createLogger(destination);
        log.info(
            {
                a: { b: { c: { text: AUTHOR_TEXT } } },
                deep: { list: [{ answer: AUTHOR_TEXT }] },
                w: { x: { y: { z: { content: AUTHOR_TEXT } } } },
                Body: AUTHOR_TEXT,
                Text: AUTHOR_TEXT,
                Content: AUTHOR_TEXT,
                Password: CREDENTIAL,
                AUTHORIZATION: CREDENTIAL,
                cookies: { session: CREDENTIAL },
                res: { headers: { 'Set-Cookie': `sid=${CREDENTIAL}`, 'x-api-key': CREDENTIAL } },
                refresh_token: CREDENTIAL,
                access_token: CREDENTIAL,
                id_token: CREDENTIAL,
                client_secret: CREDENTIAL,
                questionId: 'q_456',
            },
            'deep',
        );
        const out = lines.join('');
        expect(out).not.toContain(CREDENTIAL);
        expect(out).not.toContain(AUTHOR_TEXT);
        const entry = JSON.parse(lines[0]);
        expect(entry.a.b.c.text).toBe('[Redacted]');
        expect(entry.deep.list[0].answer).toBe('[Redacted]');
        expect(entry.Body).toBe('[Redacted]');
        expect(entry.questionId).toBe('q_456');
    });

    it("a child logger's bindings are redacted too, and an err keeps its stack", () => {
        const { lines, destination } = capture();
        const err = new Error('boom');
        createLogger(destination).child({ ctx: { inner: { Answer: AUTHOR_TEXT } } }).error({ err }, 'child');
        const out = lines.join('');
        expect(out).not.toContain(AUTHOR_TEXT);
        const entry = JSON.parse(lines[0]);
        expect(entry.err.type).toBe('Error');
        expect(entry.err.stack).toContain('logger-redaction.test');
    });

    it('the process (worker) logger redacts the same names and carries a requestId', () => {
        const { lines, destination } = capture();
        createProcessLogger('worker', destination).info({ body: AUTHOR_TEXT, jobId: 'j1' }, 'job');
        const entry = JSON.parse(lines[0]);
        expect(entry.body).toBe('[Redacted]');
        expect(entry.requestId).toBe('worker');
        expect(entry.jobId).toBe('j1');
    });

    it('covers every name the brief requires', () => {
        for (const k of ['authorization', 'cookie', 'cookies', 'set-cookie', 'password', 'token', 'text', 'answer', 'content', 'body']) {
            expect(REDACTED_KEYS).toContain(k);
        }
    });
});

describe('request bindings', () => {
    it('stamps the request context onto every entry', () => {
        const bindings = runWithRequestContext(
            { requestId: 'req-1', route: '/api/x', workspaceId: 'w1', startTime: performance.now() },
            () => withRequestBindings({ component: 'api' }),
        );
        expect(bindings).toMatchObject({ requestId: 'req-1', route: '/api/x', workspaceId: 'w1', component: 'api' });
        expect(typeof bindings.durationMs).toBe('number');
    });

    it("outside a request the id is 'unknown'", () => {
        expect(withRequestBindings().requestId).toBe('unknown');
    });
});

describe('edge logger redaction', () => {
    it('redacts recursively and case-insensitively, at any depth', () => {
        const line = formatEdgeLine('warn', 'blocked', {
            Authorization: CREDENTIAL,
            deep: { a: { b: { c: { Answer: AUTHOR_TEXT } } } },
            list: [{ content: AUTHOR_TEXT }],
            tier: 'high',
        });
        expect(line).not.toContain(CREDENTIAL);
        expect(line).not.toContain(AUTHOR_TEXT);
        const parsed = JSON.parse(line);
        expect(parsed.tier).toBe('high');
        expect(parsed.requestId).toBe('unknown');
    });

    it('redactFields leaves unlisted fields and the input untouched', () => {
        const input = { text: AUTHOR_TEXT, count: 3 };
        expect(redactFields(input)).toEqual({ text: '[Redacted]', count: 3 });
        expect(input.text).toBe(AUTHOR_TEXT);
        expect(isRedactedKey('BODY')).toBe(true);
        expect(isRedactedKey('bodyChars')).toBe(false);
    });
});
