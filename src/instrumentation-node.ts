/**
 * Server start-up on the Node runtime (called from `src/instrumentation.ts`):
 *   1. refuse to start a production process whose configuration is missing
 *      something production requires (`src/lib/startup-checks.ts`);
 *   1b. the encryption sentinel: the master key must round-trip a value
 *      (`src/lib/security/encryption-sentinel.ts`, Phase 0.3);
 *   1c. the question packs load and validate (`src/lib/interview/packs.ts`,
 *      Phase 2.2): they are read from disk, so an image that lost them, or a
 *      pack an edit broke, is refused at boot rather than at an author's
 *      first interview; then (Phase 2.3) the mount gate is asked about every
 *      pack (`src/lib/interview/pack-mount.ts`), and a production server says
 *      at every start, `[startup] WARN`, how many cannot mount and why — the
 *      rest of the product runs, and interviews answer 503
 *      PACKS_NOT_MOUNTABLE until the records are there;
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
    const [sentinel, packs, mount, reconcileGate, rephraseGate, telemetry, sentry, mailer, shutdown] = await Promise.all([
        import('@/lib/security/encryption-sentinel'),
        import('@/lib/interview/packs'),
        import('@/lib/interview/pack-mount'),
        import('@/lib/enrichment/record-gate'),
        import('@/lib/interview/rephrase-record-gate'),
        import('@/lib/observability/instrumentation'),
        import('@/lib/observability/sentry'),
        import('@/lib/mailer'),
        import('@/lib/observability/shutdown'),
    ]);
    return {
        runEncryptionSentinel: sentinel.runEncryptionSentinel,
        loadQuestionPacks: packs.getPacks,
        packMountReport: async () => mountReport(await mount.packMounts(packs.getPacks(), mount.packRecordModeOf(process.env))),
        /** Phase 2.5: the reconcile step's D11 gate, read the packs' way. */
        reconcileGateReport: () => reconcileGate.reconcileGateReport(mount.packRecordModeOf(process.env)),
        /** Phase 2.H: the rephrase prompt's D11 gate, read the packs' way. */
        rephraseGateReport: () => rephraseGate.rephraseGateReport(packs.getPacks(), mount.packRecordModeOf(process.env)),
        initTelemetry: telemetry.initTelemetry,
        initSentry: sentry.initSentry,
        initMailerFromEnv: mailer.initMailerFromEnv,
        installShutdownHandlers: shutdown.installShutdownHandlers,
    };
}

/** The start-up line about packs that cannot mount: counts and reasons, never a pack's text. Null when all mount. */
export function mountReport(mounts: ReadonlyMap<string, { ok: true } | { ok: false; reason: string }>): string | null {
    const refused = [...mounts].filter(([, v]) => !v.ok);
    if (refused.length === 0) return null;
    const byReason = new Map<string, number>();
    for (const [, v] of refused) if (!v.ok) byReason.set(v.reason, (byReason.get(v.reason) ?? 0) + 1);
    const reasons = [...byReason].map(([r, n]) => `${r} ×${n}`).join(', ');
    return `${refused.length} of ${mounts.size} interview packs cannot mount (${reasons}): interviews that need them answer 503 PACKS_NOT_MOUNTABLE.`;
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

    try {
        services.loadQuestionPacks();
    } catch (err) {
        if (!isProductionServer(process.env)) throw err;
        report(`[startup] FATAL: the question packs failed to load: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
        exit(1);
        return;
    }
    if (isProductionServer(process.env)) {
        const line = await services.packMountReport();
        if (line) report(`[startup] WARN: ${line}`);
        const reconcile = await services.reconcileGateReport();
        if (reconcile) report(`[startup] WARN: ${reconcile}`);
        const rephrase = await services.rephraseGateReport();
        if (rephrase) report(`[startup] WARN: ${rephrase}`);
    }

    await services.initTelemetry();
    await services.initSentry();
    services.initMailerFromEnv();
    services.installShutdownHandlers();
}
