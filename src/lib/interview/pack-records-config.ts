/**
 * WHICH EVALUATION RECORDS MOUNT AN INTERVIEW PACK (Phase 2.3; owner decision
 * D11, 2026-11-19, "Pack mount gate before real-model evaluation records"), as
 * a pure function of an env record, so the start-up report
 * (`src/instrumentation-node.ts`) and the mount gate (`pack-mount.ts`) read it
 * one way.
 *
 *   production   `model`: only a real model's record mounts a pack. Until such
 *                records are committed, production refuses every pack and
 *                interviews stay off there, loudly (503 PACKS_NOT_MOUNTABLE
 *                naming each pack, and a `[startup] WARN` at every start).
 *                There is NO override: no setting lets production run a pack
 *                a real model has not passed.
 *   otherwise    `structural`: a record made by the deterministic structural
 *                generator counts too (development and test).
 *
 * ONE EXCEPTION, AND THIS IS ITS ONLY PLACE (decision D13, 2026-11-20,
 * "Interview E2E against the production build"): a production process in the
 * loopback-only stub mode (`loopbackStubMode`, `src/lib/ai/model-stub.ts`:
 * `AI_MODEL_STUB=1`, no provider key, `APP_URL` and `NEXTAUTH_URL` both
 * loopback) also accepts structural records, so the stub E2E server can run
 * interviews on the production build. A real deployment can reach neither:
 * its public `APP_URL` keeps it in `model` mode, and the start-up check
 * refuses the stub (and a structural mode) beside a real host. Production
 * without the loopback stub still mounts only real-model records (D11).
 *
 * A pack with no record, or with a record that does not pass, never mounts
 * anywhere.
 */
import { loopbackStubMode } from '@/lib/ai/model-stub';

export const PACK_RECORD_MODES = ['model', 'structural'] as const;
export type PackRecordMode = (typeof PACK_RECORD_MODES)[number];

/** The variables this file reads, from `process.env`, `env` or a test's object. */
export type PackEnvRecord = {
    readonly [K in 'NODE_ENV' | 'AI_MODEL_STUB' | 'ANTHROPIC_API_KEY' | 'APP_URL' | 'NEXTAUTH_URL']?: string | undefined;
};

/** Which evaluation records mount a pack in this environment (D11; D13's loopback stub). */
export function packRecordModeOf(e: PackEnvRecord): PackRecordMode {
    if (e.NODE_ENV !== 'production') return 'structural';
    return loopbackStubMode(e) ? 'structural' : 'model';
}
