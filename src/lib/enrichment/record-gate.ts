/**
 * THE RECONCILE GATE (Phase 2.5): decision D11 applied to the reconcile step,
 * as it applies to the interview packs.
 *
 *   production   reconcile runs only on a REAL MODEL's evaluation record of
 *                the reconcile prompt (`evals/evaluation-record.json`, made by
 *                the Evals workflow and committed by a reviewed pull request).
 *                Until one is committed, a closed round's run is REFUSED
 *                `RECONCILE_NOT_EVALUATED` (the reason in its metrics), nothing
 *                is sent and nothing is proposed — interviews still run, and
 *                their answers are kept, so a later deployment that holds a
 *                record can reconcile the same rounds (a refused run is
 *                re-runnable). A `[startup] WARN` says so at every start.
 *                There is no override.
 *   otherwise    a STRUCTURAL record (the reference reconciler's) counts too.
 *
 * Which records count is the packs' own reading of D11 (`packRecordModeOf`,
 * `src/lib/interview/pack-records-config.ts`, as `deploymentPackRecordMode()`
 * passes it), so the two gates never disagree about an environment. Reconcile
 * mounts no pack and reads no dial; the mode is read only by the run, never on
 * the bible's write path.
 *
 * The record is checked once per process (a full replay of 54 cases), lazily.
 */
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import committedRecord from './evals/evaluation-record.json';
import { checkReconcileRecord, type ReconcileRecordCheck } from './evals/evaluation';
import { processSharedMap } from '@/lib/process-shared-cache';

export type ReconcileGateVerdict =
    | { mounted: true; recordKind: 'structural' | 'model' }
    | { mounted: false; reason: 'STRUCTURAL_RECORD_REFUSED' | 'NO_PASSING_RECORD'; detail: string };

/** Shared by every module graph of the process (issue #36, item 7): the start-up report's check is the one the close route reads. */
const verdicts = processSharedMap<Promise<ReconcileGateVerdict>>('reconcile-gate-verdicts');

/** The verdict on a record under a mode. Pure but for the replay. */
export async function gateVerdict(record: unknown, mode: PackRecordMode): Promise<ReconcileGateVerdict> {
    const check: ReconcileRecordCheck = await checkReconcileRecord(record);
    if (!check.ok) return { mounted: false, reason: 'NO_PASSING_RECORD', detail: `${check.reason}: ${check.detail}` };
    const kind = check.record.generator.kind;
    if (mode === 'model' && kind !== 'model') return { mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production accepts only a real model’s evaluation record (D11)' };
    return { mounted: true, recordKind: kind };
}

/**
 * The verdict on the committed record under `mode`, cached per mode. The
 * deployment's mode is `deploymentPackRecordMode()` (the usecase layer reads
 * it from the env), so D11's reading is the packs' own.
 */
export function reconcileGate(mode: PackRecordMode, record: unknown = committedRecord): Promise<ReconcileGateVerdict> {
    if (record !== committedRecord) return gateVerdict(record, mode);
    let v = verdicts.get(mode);
    if (!v) {
        v = gateVerdict(record, mode);
        verdicts.set(mode, v);
    }
    return v;
}

/** The start-up line about a reconcile step that will not run, or null. Codes, never text. */
export async function reconcileGateReport(mode: PackRecordMode): Promise<string | null> {
    const v = await reconcileGate(mode);
    if (v.mounted) return null;
    return `the reconcile step has no evaluation record this deployment accepts (${v.reason}): closed interview rounds are kept, and their reconcile runs are refused RECONCILE_NOT_EVALUATED.`;
}
