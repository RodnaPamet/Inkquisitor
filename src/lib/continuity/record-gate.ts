/**
 * THE CONTINUITY GATE (Phase 4.2, D28): decision D11 applied to the nightly
 * deep check, as 4.1 applies it to bible fact extraction.
 *
 *   production   the deep step runs only on a REAL MODEL's evaluation record
 *                (`evals/evaluation-record.json`, made by the Evals workflow's
 *                `continuity` input and committed by a reviewed pull request).
 *                Until one is committed the night's rule sweep still runs and the
 *                deep step stops NOT_EVALUATED (resumable). No override.
 *   otherwise    a STRUCTURAL record (the reference checker's) counts.
 *
 * Which records count is the packs' own reading of D11 (`packRecordModeOf`,
 * through `deploymentPackRecordMode()`), so D13's loopback stub server accepts
 * the structural record.
 */
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import committedRecord from './evals/evaluation-record.json';
import { checkContinuityRecord } from './evals/evaluation';

export type ContinuityGateVerdict =
    | { mounted: true; recordKind: 'structural' | 'model' }
    | { mounted: false; reason: 'STRUCTURAL_RECORD_REFUSED' | 'NO_PASSING_RECORD'; detail: string };

const verdicts = new Map<string, ContinuityGateVerdict>();

export function continuityGateVerdict(record: unknown, mode: PackRecordMode): ContinuityGateVerdict {
    const check = checkContinuityRecord(record);
    if (!check.ok) return { mounted: false, reason: 'NO_PASSING_RECORD', detail: `${check.reason}: ${check.detail}` };
    const kind = check.record.generator.kind;
    if (mode === 'model' && kind !== 'model') return { mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production accepts only a real model’s evaluation record (D11)' };
    return { mounted: true, recordKind: kind };
}

export function continuityGate(mode: PackRecordMode, record: unknown = committedRecord): ContinuityGateVerdict {
    if (record !== committedRecord) return continuityGateVerdict(record, mode);
    let v = verdicts.get(mode);
    if (!v) {
        v = continuityGateVerdict(record, mode);
        verdicts.set(mode, v);
    }
    return v;
}

/** The start-up line about an extraction that will not run, or null. Codes, never text. */
export function continuityGateReport(mode: PackRecordMode): string | null {
    const v = continuityGate(mode);
    if (v.mounted) return null;
    return `the deep continuity check has no evaluation record this deployment accepts (${v.reason}): only its rules run (NOT_EVALUATED).`;
}
