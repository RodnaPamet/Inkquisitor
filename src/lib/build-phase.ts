/**
 * Is this process `next build`?
 *
 * `next build` runs with NODE_ENV=production and imports every route module
 * to collect its page data, so a production-only rule evaluated at module
 * load (the env schema's REDIS_URL rule) fires at BUILD time, where no
 * runtime secret exists and none is needed. Next sets
 * `NEXT_PHASE=phase-production-build` in the build process before it starts
 * the workers that collect page data, and never at `next start`, so this is
 * the narrow carve-out: the build skips the production-only rules, and the
 * running server still enforces them twice (the env schema at module load,
 * `src/lib/startup-checks.ts` from the instrumentation hook).
 *
 * The worker (`scripts/worker.ts`) is not Next and never sees the variable.
 *
 * No imports, so the env module and the edge bundle can both hold it.
 */

/** The value of `PHASE_PRODUCTION_BUILD` in `next/constants`. */
export const NEXT_PRODUCTION_BUILD_PHASE = 'phase-production-build';

export function isNextProductionBuild(e: Readonly<Record<string, string | undefined>>): boolean {
    return e.NEXT_PHASE === NEXT_PRODUCTION_BUILD_PHASE;
}
