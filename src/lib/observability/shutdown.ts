/**
 * Graceful shutdown on SIGTERM / SIGINT for the web process.
 *
 * Stages, most-to-least costly to lose, run AFTER the HTTP drain:
 *   1. close this process's job-queue and Redis connections — after the drain,
 *      so no request still in flight can enqueue on a connection already
 *      closed (or reopen one that nothing would close);
 *   2. drain OpenTelemetry's span and metric batches;
 *   3. flush Sentry's transport.
 *
 * WHO EXITS. `next start` registers its own SIGTERM / SIGINT listener (unless
 * NEXT_MANUAL_SIG_HANDLE is set): it stops accepting connections, waits for
 * the requests in flight, closes the Next server and then calls
 * `process.exit(143)` (130 for SIGINT) at once — it never waits for another
 * listener. Left alone, that exit landed while these stages were still
 * running, and the last span batch and the queued Sentry events were lost.
 * So on a signal this handler DEFERS `process.exit`: Next's call (made after
 * its drain) runs the stages first and then exits with Next's code. If no
 * exit call arrives within `SHUTDOWN_HTTP_DRAIN_MS` (a process without Next's
 * handler, or a drain that will not finish), the stages run anyway and the
 * handler exits with the signal's code itself.
 *
 * Each stage is bounded by its budget (`shutdown-budget.ts`) and guarded, so
 * a throw or a hang in one never skips the stages after it, and the process
 * always exits. A repeated signal does not start a second shutdown.
 *
 * Adapted from inflect-compliance's `src/lib/observability/shutdown.ts`.
 */

import { logger } from './logger';
import { safeErrorMessage } from './safe-error';
import { shutdownTelemetry } from './instrumentation';
import { shutdownSentry } from './sentry';
import {
    SHUTDOWN_CONNECTIONS_MS,
    SHUTDOWN_HTTP_DRAIN_MS,
    SHUTDOWN_OTEL_MS,
    SHUTDOWN_SENTRY_MS,
} from './shutdown-budget';

export interface ShutdownStage {
    name: string;
    budgetMs: number;
    run: () => Promise<void>;
}

/** Run each stage in order, each raced against its budget, none able to stop the rest. */
export async function runShutdownStages(stages: readonly ShutdownStage[]): Promise<string[]> {
    const outcomes: string[] = [];
    for (const stage of stages) {
        let timer: NodeJS.Timeout | undefined;
        try {
            const result = await Promise.race([
                stage.run().then(() => 'done' as const),
                new Promise<'timeout'>((resolve) => {
                    timer = setTimeout(() => resolve('timeout'), stage.budgetMs);
                    timer.unref();
                }),
            ]);
            outcomes.push(`${stage.name}:${result}`);
            if (result === 'timeout') {
                logger.warn('shutdown: stage exceeded its budget', { component: 'shutdown', stage: stage.name });
            }
        } catch (err) {
            outcomes.push(`${stage.name}:failed`);
            logger.warn('shutdown: stage threw', {
                component: 'shutdown',
                stage: stage.name,
                error: safeErrorMessage(err),
            });
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    return outcomes;
}

/** The web process's stages. */
export function defaultShutdownStages(): ShutdownStage[] {
    return [
        {
            name: 'connections',
            budgetMs: SHUTDOWN_CONNECTIONS_MS,
            run: async () => {
                const { closeQueue } = await import('@/app-layer/jobs/queue');
                const { disconnectRedis } = await import('@/lib/redis');
                await closeQueue();
                await disconnectRedis();
            },
        },
        { name: 'otel', budgetMs: SHUTDOWN_OTEL_MS, run: () => shutdownTelemetry(SHUTDOWN_OTEL_MS) },
        { name: 'sentry', budgetMs: SHUTDOWN_SENTRY_MS, run: () => shutdownSentry(SHUTDOWN_SENTRY_MS) },
    ];
}

/** The exit code a signal termination reports (128 + the signal's number), as Next uses. */
export const SIGNAL_EXIT_CODES = { SIGTERM: 143, SIGINT: 130 } as const;

/** What the handler needs of the process: the test seam. */
export interface ShutdownHost {
    once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
    exit: (code?: number) => never;
}

let installed = false;

/**
 * Register the handlers once per process (idempotent under HMR). `host` and
 * `drainMs` are seams for the test; the defaults are the real process.
 */
export function installShutdownHandlers(
    stages: () => ShutdownStage[] = defaultShutdownStages,
    host: ShutdownHost = process as unknown as ShutdownHost,
    drainMs: number = SHUTDOWN_HTTP_DRAIN_MS,
): void {
    if (installed) return;
    installed = true;
    let started = false;

    const handler = (signal: 'SIGTERM' | 'SIGINT') => {
        if (started) return;
        started = true;
        logger.info('graceful shutdown initiated', { component: 'shutdown', signal });

        const realExit = host.exit.bind(host) as (code?: number) => never;
        let finishing: Promise<void> | undefined;
        const finish = (code: number): Promise<void> => {
            finishing ??= (async () => {
                clearTimeout(fallback);
                await runShutdownStages(stages());
                logger.info('graceful shutdown complete', { component: 'shutdown', signal, exitCode: code });
                realExit(code);
            })();
            return finishing;
        };

        // Nobody called exit: run the stages and exit ourselves. Not unref'd —
        // this timer is what guarantees the process ends.
        const fallback = setTimeout(() => void finish(SIGNAL_EXIT_CODES[signal]), drainMs);

        // Next's listener calls exit after its HTTP drain; that call now runs
        // the stages first. The caller of process.exit continues past it, which
        // Next's cleanup does harmlessly (it is the last thing it does).
        host.exit = ((code?: number) => {
            void finish(typeof code === 'number' ? code : SIGNAL_EXIT_CODES[signal]);
        }) as (code?: number) => never;
    };
    host.once('SIGTERM', () => handler('SIGTERM'));
    host.once('SIGINT', () => handler('SIGINT'));
}

/** @internal test-only */
export function _resetShutdownInstalledForTesting(): void {
    installed = false;
}
