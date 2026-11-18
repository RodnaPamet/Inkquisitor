/**
 * The logger for a standalone process (the BullMQ worker), which logs before,
 * around and outside any request context.
 *
 * Same redaction and level as the web logger (`loggerOptions`), and every
 * line carries `requestId` set to the process name, the way `log()` sets
 * 'unknown' outside a request, so an aggregator keying on `requestId` keeps
 * the worker's lines. A field passed to a call still wins.
 *
 * Adapted from inflect-compliance's `process-logger.ts`.
 */
import pino from 'pino';
import { env } from '@/env';
import { loggerOptions, redactChildBindings } from './logger';

export type ProcessName = 'worker';

export function createProcessLogger(processName: ProcessName, destination?: pino.DestinationStream): pino.Logger {
    const pretty = env.NODE_ENV === 'development' && destination === undefined;
    const options: pino.LoggerOptions = {
        ...loggerOptions(),
        mixin: () => ({ requestId: processName }),
        ...(pretty
            ? { transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname', translateTime: 'HH:MM:ss.l' } } }
            : {}),
    };
    return redactChildBindings(destination ? pino(options, destination) : pino(options));
}
