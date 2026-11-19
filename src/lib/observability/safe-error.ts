/**
 * What of an error may leave the process (roadmap rule 4).
 *
 * An error's MESSAGE is written by whoever threw it. Ours (`AppError` and its
 * subclasses) describe and never quote — that is a convention every usecase
 * keeps. A third party's do not: a `PrismaClientValidationError` renders the
 * whole failed invocation with its arguments ("Invalid `prisma.x.create()`
 * invocation: { data: { content: "…" } }"), a `JSON.parse` SyntaxError quotes
 * the text it could not parse, and an HTTP client's error can carry the
 * response it got. The redaction list matches field NAMES, so a value inside
 * a message is beyond its reach.
 *
 * So everything that reports an error — the log lines, the OpenTelemetry span
 * status and exception event, the Sentry event — reports it through here:
 *
 *   - an AppError keeps its message and stack;
 *   - any other error keeps its NAME, a short `code` when it has one (P2002,
 *     ECONNREFUSED), and the stack's frames, which are code locations; its
 *     message, and the stack's header lines that repeat it, are replaced by
 *     `WITHHELD_MESSAGE`.
 *
 * Detection is by `instanceof AppError` and by name, never by importing
 * Prisma: `src/lib/errors/types.ts` is imported from the proxy (`src/proxy.ts`).
 */
import { AppError } from '@/lib/errors/types';

export const WITHHELD_MESSAGE = '[message withheld: not an AppError]';

export interface SafeErrorMeta {
    name: string;
    message: string;
    code?: string;
    stack?: string;
}

const CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

function errorName(err: Error): string {
    const name = err.name || err.constructor?.name || 'Error';
    return CODE_SHAPE.test(name) ? name : 'Error';
}

function errorCode(err: Error): string | undefined {
    const code = (err as Error & { code?: unknown }).code;
    if (typeof code === 'number') return String(code);
    return typeof code === 'string' && CODE_SHAPE.test(code) ? code : undefined;
}

/** True when this error's own message may be reported. */
export function mayReportMessage(err: unknown): err is AppError {
    return err instanceof AppError;
}

/** True for any error Prisma's client throws (detected by name). */
export function isPrismaErrorName(name: string | undefined): boolean {
    return typeof name === 'string' && name.startsWith('PrismaClient');
}

/** The stack's frames under a replaced header: no line of the message survives. */
function framesOnly(name: string, stack: string | undefined): string | undefined {
    if (!stack) return undefined;
    const frames = stack.split('\n').filter((line) => /^\s+at\s/.test(line));
    return [`${name}: ${WITHHELD_MESSAGE}`, ...frames].join('\n');
}

export function safeErrorMeta(err: unknown): SafeErrorMeta {
    if (!(err instanceof Error)) {
        // A thrown non-Error (a string, an object) is somebody else's value.
        return { name: 'UnknownError', message: WITHHELD_MESSAGE };
    }
    const name = errorName(err);
    const code = errorCode(err);
    if (mayReportMessage(err)) {
        return { name, message: err.message, ...(code && { code }), stack: err.stack };
    }
    return { name, message: WITHHELD_MESSAGE, ...(code && { code }), stack: framesOnly(name, err.stack) };
}

/** The message that may be reported, e.g. as a span status or a job's failure reason. */
export function safeErrorMessage(err: unknown): string {
    if (mayReportMessage(err)) return err.message;
    const meta = safeErrorMeta(err);
    return `${meta.name}${meta.code ? ` ${meta.code}` : ''}: ${meta.message}`;
}

/**
 * An Error that may be handed to an exporter (`span.recordException`,
 * `Sentry.captureException`): the same error for an AppError, otherwise a
 * fresh Error with the same name, the withheld message and frames-only stack.
 */
export function toReportableError(err: unknown): Error {
    if (mayReportMessage(err)) return err;
    const meta = safeErrorMeta(err);
    const reportable = new Error(meta.message);
    reportable.name = meta.name;
    reportable.stack = meta.stack ?? `${meta.name}: ${meta.message}`;
    if (meta.code) (reportable as Error & { code?: string }).code = meta.code;
    return reportable;
}
