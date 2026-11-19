/**
 * Edge-compatible structured logger.
 *
 * pino cannot run in the edge runtime (it needs worker_threads and fs), so
 * code that runs in `src/proxy.ts` logs through this instead (the proxy runs on
 * Node in Next 16, but its graph stays runtime-neutral). It writes
 * one JSON line per entry to the console, in pino's shape, so an aggregator
 * parses both alike. Fields pass through the SAME redaction list as the Node
 * logger (`./redaction.ts`), applied recursively.
 *
 * The one file under `src/` allowed to call `console.*` (eslint.config.mjs).
 *
 * Adapted from inflect-compliance's `src/lib/observability/edge-logger.ts`.
 */
import { env } from '@/env';
import { redactFields } from './redaction';

export type EdgeLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUES: Record<EdgeLogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 };

interface EdgeLogFields {
    component?: string;
    [key: string]: unknown;
}

/** The JSON line an entry becomes. Exported for tests. */
export function formatEdgeLine(level: EdgeLogLevel, msg: string, fields?: EdgeLogFields): string {
    const safe = (fields ? redactFields(fields) : {}) as Record<string, unknown>;
    return JSON.stringify({
        level: LEVEL_VALUES[level],
        time: Date.now(),
        msg,
        ...safe,
        requestId: typeof safe.requestId === 'string' && safe.requestId ? safe.requestId : 'unknown',
    });
}

type EdgeLogSink = (level: EdgeLogLevel, line: string) => void;
let sink: EdgeLogSink | null = null;

/**
 * @internal test-only: receive every line, even under Jest, instead of the
 * console. Pass null to restore the default.
 */
export function _setEdgeLogSink(next: EdgeLogSink | null): void {
    sink = next;
}

function emit(level: EdgeLogLevel, msg: string, fields?: EdgeLogFields): void {
    if (sink) {
        sink(level, formatEdgeLine(level, msg, fields));
        return;
    }
    // Silent under Jest: proxy tests would otherwise flood the output with a
    // line per blocked request. A test that reads lines installs a sink.
    if (env.NODE_ENV === 'test') return;
    const line = formatEdgeLine(level, msg, fields);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

export const edgeLogger = {
    debug: (msg: string, fields?: EdgeLogFields) => emit('debug', msg, fields),
    info: (msg: string, fields?: EdgeLogFields) => emit('info', msg, fields),
    warn: (msg: string, fields?: EdgeLogFields) => emit('warn', msg, fields),
    error: (msg: string, fields?: EdgeLogFields) => emit('error', msg, fields),
} as const;
