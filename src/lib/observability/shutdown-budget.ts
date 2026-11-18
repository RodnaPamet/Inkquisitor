/**
 * Per-stage graceful-shutdown budgets. Each stage is raced against its budget
 * so a slow exporter never holds the process past the container's grace
 * period. The stages run AFTER Next.js's HTTP drain (`shutdown.ts`), so the
 * worst case is `SHUTDOWN_HTTP_DRAIN_MS + SHUTDOWN_TOTAL_CEILING_MS` (18 s):
 * give the container a stop grace period of at least 20 s (Docker's default
 * is 10 s; `docker stop -t 20`, compose `stop_grace_period: 20s`; Kubernetes'
 * default of 30 s suffices). The stages together must fit under
 * `SHUTDOWN_TOTAL_CEILING_MS`.
 *
 * Adapted from inflect-compliance's `shutdown-budget.ts` (its audit-flush and
 * agentic-run stages are not carried: nothing here buffers either).
 */

/**
 * How long the handler waits for Next's own exit call (made once its HTTP
 * drain finishes) before running the stages and exiting itself.
 */
export const SHUTDOWN_HTTP_DRAIN_MS = 10_000;

/** Close this process's BullMQ queue and Redis connections. */
export const SHUTDOWN_CONNECTIONS_MS = 2_000;
export const SHUTDOWN_OTEL_MS = 2_000;
export const SHUTDOWN_SENTRY_MS = 2_000;

export const SHUTDOWN_TOTAL_CEILING_MS = 8_000;

export const SHUTDOWN_STAGES_TOTAL_MS = SHUTDOWN_CONNECTIONS_MS + SHUTDOWN_OTEL_MS + SHUTDOWN_SENTRY_MS;
