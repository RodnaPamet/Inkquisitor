/**
 * What production refuses to start without.
 *
 * Every platform-service variable is optional with a safe DEVELOPMENT
 * default. A default that points at local infrastructure (the compose Redis,
 * a temp-directory file store, no virus scanner) is exactly wrong in
 * production, so this is the list a production process must have instead.
 *
 * It is a pure function of the environment so it is unit-tested directly,
 * and it is asked in two places, because they are two processes:
 *   - the web tier, `src/instrumentation.ts`;
 *   - the worker, `scripts/worker.ts`, which never loads the Next hook.
 * Both exit 1 with `[startup] FATAL: …` on any problem. The env schema
 * (`src/env.ts`) repeats the REDIS_URL rule for a process with validation
 * on; this list is what holds when `SKIP_ENV_VALIDATION=1` leaks into a
 * runtime container, which is the one variable an image is most likely to
 * carry, because the build sets it on purpose.
 *
 * A new required variable is added here, in `.env.example` (with the note
 * that production requires it) and in a case of
 * `tests/unit/platform/startup-checks.test.ts`.
 */

import { isNextProductionBuild } from './build-phase';
import { DEV_FALLBACK_DATA_ENCRYPTION_KEY, MIN_DATA_ENCRYPTION_KEY_LENGTH } from './security/encryption-constants';
import { DEV_FALLBACK_AUTH_SECRET, MIN_AUTH_SECRET_LENGTH } from './auth/auth-constants';
import { embeddingConfigProblems } from './ai/embeddings/config';
import { aiConfigProblems, aiConfigWarnings } from './ai/config';
import { isLoopbackUrl } from './ai/model-stub';
import { packRecordModeOf } from './interview/pack-records-config';
import { retentionConfigProblems } from './ai/call-log-retention';

export { MIN_AUTH_SECRET_LENGTH };

/** The environment as a plain record (`process.env`, or a test's object). */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** Every reason this environment is not fit to run production. Empty when it is. */
export function productionConfigProblems(e: EnvRecord): string[] {
    if (e.NODE_ENV !== 'production') return [];
    // `next build` is not a running production process: it holds none of the
    // runtime configuration, and the server it builds is checked when it starts.
    if (isNextProductionBuild(e)) return [];
    const problems: string[] = [];

    if (!present(e.DATABASE_URL)) problems.push('DATABASE_URL is required.');

    if (!present(e.REDIS_URL)) {
        problems.push('REDIS_URL is required: rate limits and the job queue depend on it.');
    } else {
        try {
            if (!new URL(e.REDIS_URL).password) {
                problems.push('REDIS_URL must carry a password (redis://:PASSWORD@HOST:6379).');
            }
        } catch {
            problems.push('REDIS_URL is not a valid URL.');
        }
    }

    if (e.STORAGE_PROVIDER === 's3') {
        if (!present(e.S3_BUCKET)) problems.push('S3_BUCKET is required when STORAGE_PROVIDER=s3.');
    } else if (!present(e.FILE_STORAGE_ROOT)) {
        // Local storage's development default is a folder under the OS temp
        // directory, which a container loses on restart.
        problems.push(
            'FILE_STORAGE_ROOT is required for local storage (STORAGE_PROVIDER unset or local): point it at a ' +
                'persistent volume, or set STORAGE_PROVIDER=s3.',
        );
    }

    if (e.AV_SCAN_MODE !== 'disabled' && !present(e.CLAMAV_HOST)) {
        problems.push(
            'CLAMAV_HOST is required unless AV_SCAN_MODE=disabled: without a scanner every upload stays unscanned ' +
                'and, in strict mode, undownloadable.',
        );
    }

    // ── Identity and encryption (Phase 0.3) ──
    if (!present(e.AUTH_SECRET) || e.AUTH_SECRET.length < MIN_AUTH_SECRET_LENGTH) {
        problems.push(
            `AUTH_SECRET is required, at least ${MIN_AUTH_SECRET_LENGTH} characters: it signs every session. ` +
                'Generate one with: openssl rand -base64 48',
        );
    } else if (e.AUTH_SECRET === DEV_FALLBACK_AUTH_SECRET) {
        problems.push('AUTH_SECRET is the documented development fallback; production needs its own secret.');
    }
    if (!present(e.NEXTAUTH_URL)) {
        problems.push('NEXTAUTH_URL is required: sign-in callbacks are built on it (https://your.host).');
    }
    if (!present(e.DATA_ENCRYPTION_KEY) || e.DATA_ENCRYPTION_KEY.length < MIN_DATA_ENCRYPTION_KEY_LENGTH) {
        problems.push(
            `DATA_ENCRYPTION_KEY is required, at least ${MIN_DATA_ENCRYPTION_KEY_LENGTH} characters: it wraps every ` +
                "workspace's data key. Generate one with: openssl rand -base64 48",
        );
    } else if (e.DATA_ENCRYPTION_KEY === DEV_FALLBACK_DATA_ENCRYPTION_KEY) {
        problems.push('DATA_ENCRYPTION_KEY is the documented development fallback; production needs its own key.');
    }
    if (present(e.GOOGLE_CLIENT_ID) !== present(e.GOOGLE_CLIENT_SECRET)) {
        problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set together or not at all.');
    }

    // ── Embeddings (subphase 2.0): never the stub, and a TEI route that is
    // whole and inside the deployment. src/lib/ai/embeddings/config.ts is the
    // one reading of these variables; the factory asks it too.
    problems.push(...embeddingConfigProblems(e));

    // ── The model layer (Phase 2.1, amended in 2.2): the provider key is
    // required (the question engine calls a model) unless AI_DISABLED=1; a key
    // only with a declared retention mode (D5, amended 2026-11-19); no ambient
    // SDK headers; a well-formed ceiling and kill switch.
    // src/lib/ai/config.ts is the one reading.
    problems.push(...aiConfigProblems(e));
    // The call log's retention (Phase 2.H): a whole number of days, at least the database's floor.
    problems.push(...retentionConfigProblems(e.AI_CALL_LOG_RETENTION_DAYS));

    // ── Interview packs (D11, D13): production mounts a pack only on a real
    // model's evaluation record. The loopback-only model stub is the one
    // exception (`packRecordModeOf`); this holds it to a loopback test server
    // whatever that rule says, so no edit to it can open a real host.
    if (packRecordModeOf(e) === 'structural' && !(isLoopbackUrl(e.APP_URL) && isLoopbackUrl(e.NEXTAUTH_URL))) {
        problems.push(
            'Interview packs would mount on structural evaluation records, which only a loopback test server with ' +
                'AI_MODEL_STUB=1 may do (D13): APP_URL and NEXTAUTH_URL must both be loopback addresses.',
        );
    }

    if (present(e.UPSTASH_REDIS_REST_URL) !== present(e.UPSTASH_REDIS_REST_TOKEN)) {
        problems.push(
            'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set together or not at all: with one of them ' +
                'the rate limiter silently falls back to a per-process memory budget.',
        );
    }

    return problems;
}

/**
 * What this production environment runs with but must say out loud at every
 * start: standard model-provider retention during the closed beta
 * (`AI_RETENTION_MODE=standard-beta`, decision D5 amended 2026-11-19), the
 * stubbed model, and structural pack records on its loopback test server
 * (D13). Fixed sentences naming settings, never author text. Empty outside
 * production.
 */
export function productionConfigWarnings(e: EnvRecord): string[] {
    if (e.NODE_ENV !== 'production' || isNextProductionBuild(e)) return [];
    const warnings = aiConfigWarnings(e);
    if (packRecordModeOf(e) === 'structural') {
        warnings.push(
            'Interview packs mount on STRUCTURAL evaluation records (D13: the loopback-only model stub). ' +
                'A local test server only; a real deployment mounts a pack only on a real model\'s record (D11).',
        );
    }
    return warnings;
}

/**
 * Refuse to start: report each problem on stderr and exit 1. Before that,
 * report each warning (`[startup] WARN: …`), which never stops the process.
 * `report` and `exit` are seams for the test; the defaults are the real
 * process.
 */
export function enforceProductionConfig(
    e: EnvRecord,
    report: (line: string) => void = (line) => process.stderr.write(line + '\n'),
    exit: (code: number) => void = (code) => process.exit(code),
): void {
    for (const w of productionConfigWarnings(e)) report(`[startup] WARN: ${w}`);
    const problems = productionConfigProblems(e);
    if (problems.length === 0) return;
    for (const p of problems) report(`[startup] FATAL: ${p}`);
    exit(1);
}
