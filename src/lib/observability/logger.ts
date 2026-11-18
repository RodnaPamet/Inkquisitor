/**
 * Structured logger — pino, JSON to stdout.
 *
 * Every entry is enriched with the observability request context
 * (`requestId`, `workspaceId`, `userId`, `route`) when one is active, and
 * `durationMs` since the request started.
 *
 * CANONICAL FIELDS
 *   level, time, msg        pino's own
 *   requestId               correlation id ('unknown' outside a request)
 *   workspaceId, userId     once authentication resolves them (Phase 0.3)
 *   route                   pathname, or `job:<name>`
 *   durationMs              elapsed since the request started
 *   component               logical subsystem ("api", "queue", "storage", …)
 *   err / error             error metadata (name, message, stack)
 *
 * WHAT NEVER REACHES A LINE (roadmap rule 4)
 *   - Request bodies. `withApiErrorHandling` logs method, route, status and
 *     duration, and nothing it read from the request.
 *   - Credentials and author text by name: see `./redaction.ts`. pino
 *     replaces those fields with "[Redacted]" before serialisation.
 *
 * Adapted from inflect-compliance's `src/lib/observability/logger.ts`; see
 * docs/carve-manifest.md.
 */

import pino from 'pino';
import { env } from '@/env';
import { getRequestContext } from './context';
import { PINO_REDACT_PATHS, REDACT_CENSOR, redactLogObject } from './redaction';
import { safeErrorMeta, type SafeErrorMeta } from './safe-error';

const isDev = env.NODE_ENV === 'development';

/**
 * pino's `err` serializer, over an error whose message can be logged
 * (`./safe-error.ts`): a Prisma or other third-party message is withheld,
 * because it can quote the arguments of the call that failed.
 */
function serializeErr(err: unknown): unknown {
    if (!(err instanceof Error)) return err;
    const meta = safeErrorMeta(err);
    return { type: meta.name, message: meta.message, ...(meta.code && { code: meta.code }), stack: meta.stack };
}

/**
 * The pino options every logger in the process uses, exported so a test can
 * build a logger against its own destination stream and see exactly what the
 * production logger would write.
 */
export function loggerOptions(level: string = env.LOG_LEVEL ?? (isDev ? 'debug' : 'info')): pino.LoggerOptions {
    return {
        level,
        // Fast path: literal, shallow, case-sensitive.
        redact: { paths: [...PINO_REDACT_PATHS], censor: REDACT_CENSOR },
        // The guarantee: every listed name, any casing, any depth, on the
        // call's object and the root's bindings, before pino serialises
        // either (a child's bindings: `redactChildBindings`).
        formatters: {
            log: (object) => redactLogObject(object) as Record<string, unknown>,
            bindings: (bindings) => redactLogObject(bindings) as pino.Bindings,
        },
        serializers: { err: serializeErr },
    };
}

/**
 * pino-pretty in development only: production and test write raw JSON for an
 * aggregator to parse. pino-pretty is a dev dependency and is externalised in
 * next.config.mjs.
 */
function buildTransport(): pino.TransportSingleOptions | undefined {
    if (!isDev) return undefined;
    return {
        target: 'pino-pretty',
        options: { colorize: true, ignore: 'pid,hostname', translateTime: 'HH:MM:ss.l' },
    };
}

/**
 * pino applies `formatters.bindings` to the ROOT logger's bindings only: a
 * child resets it. So every child's bindings pass through the same walk
 * here, on the logger and (by prototype) on every logger descended from it.
 */
export function redactChildBindings(root: pino.Logger): pino.Logger {
    const protoChild = Object.getPrototypeOf(root).child as (
        this: pino.Logger,
        bindings: pino.Bindings,
        options?: pino.ChildLoggerOptions,
    ) => pino.Logger;
    Object.defineProperty(root, 'child', {
        configurable: true,
        writable: true,
        value: function child(this: pino.Logger, bindings: pino.Bindings, options?: pino.ChildLoggerOptions) {
            return protoChild.call(this, redactLogObject(bindings) as pino.Bindings, options);
        },
    });
    return root;
}

/** Build a logger. `destination` is the test seam. */
export function createLogger(destination?: pino.DestinationStream): pino.Logger {
    const transport = destination ? undefined : buildTransport();
    const options = { ...loggerOptions(), ...(transport ? { transport } : {}) };
    return redactChildBindings(destination ? pino(options, destination) : pino(options));
}

/** The process-wide pino instance. */
export const pinoInstance: pino.Logger = createLogger();

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogFields {
    /** Logical subsystem */
    component?: string;
    /** Duration in ms */
    durationMs?: number;
    /** Error metadata — a string message or `extractErrorMeta`'s safe shape */
    error?: string | SafeErrorMeta;
    /** Serialised error, pino's `err` convention */
    err?: Error;
    /** Any further safe metadata: ids, counts, enums — never author text */
    [key: string]: unknown;
}

/** Build the bindings `log` writes: request context first, fields over it. */
export function withRequestBindings(fields?: LogFields): Record<string, unknown> {
    const ctx = getRequestContext();
    const bindings: Record<string, unknown> = {
        requestId: ctx?.requestId ?? 'unknown',
        ...(ctx?.workspaceId && { workspaceId: ctx.workspaceId }),
        ...(ctx?.userId && { userId: ctx.userId }),
        ...(ctx?.route && { route: ctx.route }),
        ...fields,
    };
    if (bindings.durationMs === undefined && ctx?.startTime) {
        bindings.durationMs = Math.round(performance.now() - ctx.startTime);
    }
    return bindings;
}

/** Emit one structured entry, enriched from the request context. */
export function log(level: LogLevel, msg: string, fields?: LogFields): void {
    pinoInstance[level](withRequestBindings(fields), msg);
}

export const logger = {
    debug: (msg: string, fields?: LogFields) => log('debug', msg, fields),
    info: (msg: string, fields?: LogFields) => log('info', msg, fields),
    warn: (msg: string, fields?: LogFields) => log('warn', msg, fields),
    error: (msg: string, fields?: LogFields) => log('error', msg, fields),
    fatal: (msg: string, fields?: LogFields) => log('fatal', msg, fields),
    /** A child logger with fixed bindings for a subsystem. */
    child: (bindings: Record<string, unknown>): pino.Logger => pinoInstance.child(bindings),
} as const;

/** A child logger that inherits the redaction and level. */
export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
    return pinoInstance.child(bindings);
}

/**
 * Safe error metadata for a log field: name, code, and a message only when it
 * is our own (an AppError) — see `./safe-error.ts`.
 */
export function extractErrorMeta(err: unknown): SafeErrorMeta {
    return safeErrorMeta(err);
}
