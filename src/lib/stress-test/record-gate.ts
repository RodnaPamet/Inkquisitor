/**
 * THE STRESS TEST GATE (Phase 4.3, D29): decision D11 applied to the stress
 * test, as 4.2 applies it to the deep continuity check.
 *
 *   production   a stress test runs only on a REAL MODEL's evaluation record
 *                (`evals/evaluation-record.json`, made by the Evals workflow's
 *                `book_level` input and committed by a reviewed pull request).
 *                Until one is committed, starting one is refused 503
 *                STRESS_TEST_NOT_EVALUATED and a queued one stops NOT_EVALUATED.
 *   otherwise    a STRUCTURAL record (the reference tester's) counts.
 *
 * Which records count is the packs' own reading of D11 (`packRecordModeOf`,
 * through `deploymentPackRecordMode()`), so D13's loopback stub server accepts
 * the structural record.
 */
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import committedRecord from './evals/evaluation-record.json';
import { checkStressTestRecord } from './evals/evaluation';

export type StressTestGateVerdict =
    | { mounted: true; recordKind: 'structural' | 'model' }
    | { mounted: false; reason: 'STRUCTURAL_RECORD_REFUSED' | 'NO_PASSING_RECORD'; detail: string };

const verdicts = new Map<string, StressTestGateVerdict>();

export function stressTestGateVerdict(record: unknown, mode: PackRecordMode): StressTestGateVerdict {
    const check = checkStressTestRecord(record);
    if (!check.ok) return { mounted: false, reason: 'NO_PASSING_RECORD', detail: `${check.reason}: ${check.detail}` };
    const kind = check.record.generator.kind;
    if (mode === 'model' && kind !== 'model') return { mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production accepts only a real model’s evaluation record (D11)' };
    return { mounted: true, recordKind: kind };
}

export function stressTestGate(mode: PackRecordMode, record: unknown = committedRecord): StressTestGateVerdict {
    if (record !== committedRecord) return stressTestGateVerdict(record, mode);
    let v = verdicts.get(mode);
    if (!v) {
        v = stressTestGateVerdict(record, mode);
        verdicts.set(mode, v);
    }
    return v;
}

/** The start-up line about a stress test that will not run, or null. Codes, never text. */
export function stressTestGateReport(mode: PackRecordMode): string | null {
    const v = stressTestGate(mode);
    if (v.mounted) return null;
    return `the stress test has no evaluation record this deployment accepts (${v.reason}): starting one is refused (STRESS_TEST_NOT_EVALUATED).`;
}
