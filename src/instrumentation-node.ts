/**
 * Server start-up on the Node runtime (called from `src/instrumentation.ts`):
 *   1. refuse to start a production process whose configuration is missing
 *      something production requires (`src/lib/startup-checks.ts`);
 *   1b. the encryption sentinel: the master key must round-trip a value
 *      (`src/lib/security/encryption-sentinel.ts`, Phase 0.3);
 *   2. OpenTelemetry (no-op unless OTEL_ENABLED=true) and Sentry (no-op
 *      unless SENTRY_DSN is set);
 *   3. the mailer's SMTP transport (console sink when SMTP_HOST is unset);
 *   4. SIGTERM / SIGINT handlers that close the queue and Redis connections
 *      and drain OTel and Sentry within their budgets.
 *
 * ORDER IS LOAD-BEARING. Every service module imports `@/env`, whose schema
 * THROWS at module load when the environment is invalid (REDIS_URL missing in
 * production, say). A static import of any of them would evaluate that schema
 * before step 1 could run, and Next treats a throw from the instrumentation
 * hook as "Failed to prepare server" and then KEEPS RUNNING, answering 500 on
 * every route — /api/livez included, so an orchestrator sees a live process
 * that cannot serve. So the only static import is the refusal (which imports
 * no env module), the services are loaded after it, and a production process
 * whose services fail to load exits 1 rather than limp on.
 *
 * Shape follows inflect-compliance's `src/instrumentation.ts`, cut to the
 * platform services this phase lifts.
 */
import { enforceProductionConfig, type EnvRecord } from '@/lib/startup-checks';
import { isNextProductionBuild } from '@/lib/build-phase';

export interface RegisterNodeSeams {
    /** One stderr line. */
    report?: (line: string) => void;
    /** Ends the process. */
    exit?: (code: number) => void;
}

async function loadServices() {
    const [sentinel, telemetry, sentry, mailer, shutdown] = await Promise.all([
        import('@/lib/security/encryption-sentinel'),
        import('@/lib/observability/instrumentation'),
        import('@/lib/observability/sentry'),
        import('@/lib/mailer'),
        import('@/lib/observability/shutdown'),
    ]);
    return {
        runEncryptionSentinel: sentinel.runEncryptionSentinel,
        initTelemetry: telemetry.initTelemetry,
        initSentry: sentry.initSentry,
        initMailerFromEnv: mailer.initMailerFromEnv,
        installShutdownHandlers: shutdown.installShutdownHandlers,
    };
}

/** A running production server (not `next build`, which holds no runtime configuration). */
function isProductionServer(e: EnvRecord): boolean {
    return e.NODE_ENV === 'production' && !isNextProductionBuild(e);
}

export async function registerNode(seams: RegisterNodeSeams = {}): Promise<void> {
    const report = seams.report ?? ((line: string) => void process.stderr.write(line + '\n'));
    const exit = seams.exit ?? ((code: number) => process.exit(code));

    // Reads process.env directly on purpose: it must see the runtime
    // environment even when SKIP_ENV_VALIDATION leaked into it.
    enforceProductionConfig(process.env, report, exit);

    let services: Awaited<ReturnType<typeof loadServices>>;
    try {
        services = await loadServices();
    } catch (err) {
        if (!isProductionServer(process.env)) throw err;
        // The env schema's own message names the variables, never their
        // values; the first line is enough to say why.
        const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
        report(`[startup] FATAL: the server's configuration failed to load: ${reason}`);
        exit(1);
        return;
    }

    try {
        services.runEncryptionSentinel();
    } catch (err) {
        if (!isProductionServer(process.env)) throw err;
        report(`[startup] FATAL: ${err instanceof Error ? err.message : String(err)}`);
        exit(1);
        return;
    }

    await services.initTelemetry();
    services.initSentry();
    services.initMailerFromEnv();
    services.installShutdownHandlers();
}
