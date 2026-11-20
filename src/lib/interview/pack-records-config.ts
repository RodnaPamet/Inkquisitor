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
 * A pack with no record, or with a record that does not pass, never mounts
 * anywhere.
 */

export const PACK_RECORD_MODES = ['model', 'structural'] as const;
export type PackRecordMode = (typeof PACK_RECORD_MODES)[number];

/** The variable this file reads, from `process.env`, `env` or a test's object. */
export type PackEnvRecord = { readonly NODE_ENV?: string | undefined };

/** Which evaluation records mount a pack in this environment (D11). */
export function packRecordModeOf(e: PackEnvRecord): PackRecordMode {
    return e.NODE_ENV === 'production' ? 'model' : 'structural';
}
