/**
 * THE GAP RANKING GATE (Phase 4.3, D29): decision D11 applied to the gap
 * hunt's model ranking. Production ranks with the model only on a REAL MODEL's
 * evaluation record; without one the gap hunt still runs and shows the code's
 * own order LABELLED UNRANKED (`NOT_EVALUATED`), never a model's. Development
 * and test (and D13's loopback stub server) accept the structural record.
 */
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import committedRecord from './evals/evaluation-record.json';
import { checkGapRankRecord } from './evals/evaluation';

export type GapRankGateVerdict =
    | { mounted: true; recordKind: 'structural' | 'model' }
    | { mounted: false; reason: 'STRUCTURAL_RECORD_REFUSED' | 'NO_PASSING_RECORD'; detail: string };

const verdicts = new Map<string, GapRankGateVerdict>();

export function gapRankGateVerdict(record: unknown, mode: PackRecordMode): GapRankGateVerdict {
    const check = checkGapRankRecord(record);
    if (!check.ok) return { mounted: false, reason: 'NO_PASSING_RECORD', detail: `${check.reason}: ${check.detail}` };
    const kind = check.record.generator.kind;
    if (mode === 'model' && kind !== 'model') return { mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production accepts only a real model’s evaluation record (D11)' };
    return { mounted: true, recordKind: kind };
}

export function gapRankGate(mode: PackRecordMode, record: unknown = committedRecord): GapRankGateVerdict {
    if (record !== committedRecord) return gapRankGateVerdict(record, mode);
    let v = verdicts.get(mode);
    if (!v) {
        v = gapRankGateVerdict(record, mode);
        verdicts.set(mode, v);
    }
    return v;
}

export function gapRankGateReport(mode: PackRecordMode): string | null {
    const v = gapRankGate(mode);
    if (v.mounted) return null;
    return `the gap hunt's model ranking has no evaluation record this deployment accepts (${v.reason}): gap hunts are shown unranked (NOT_EVALUATED).`;
}
