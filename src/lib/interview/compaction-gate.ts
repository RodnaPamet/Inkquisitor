/**
 * THE COMPACTION GATE (Phase 4.3, D29): decision D11 applied to the
 * rounds-summary call. Production compacts only on a REAL MODEL's evaluation
 * record (`evals/compaction-evaluation-record.json`); without one a long
 * session simply sends every round verbatim (the metric names
 * `NOT_EVALUATED`), as it does with compaction off. Development, test and D13's
 * loopback stub accept the structural record.
 */
import committedRecord from './evals/compaction-evaluation-record.json';
import { checkCompactionRecord } from './evals/compaction-evaluation';
import type { PackRecordMode } from './pack-records-config';

export type CompactionGateVerdict = { mounted: true; recordKind: 'structural' | 'model' } | { mounted: false; reason: 'STRUCTURAL_RECORD_REFUSED' | 'NO_PASSING_RECORD'; detail: string };

const verdicts = new Map<string, CompactionGateVerdict>();

export function compactionGateVerdict(record: unknown, mode: PackRecordMode): CompactionGateVerdict {
    const check = checkCompactionRecord(record);
    if (!check.ok) return { mounted: false, reason: 'NO_PASSING_RECORD', detail: `${check.reason}: ${check.detail}` };
    if (mode === 'model' && check.record.generator.kind !== 'model') return { mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production accepts only a real model’s evaluation record (D11)' };
    return { mounted: true, recordKind: check.record.generator.kind };
}

export function compactionGate(mode: PackRecordMode, record: unknown = committedRecord): CompactionGateVerdict {
    if (record !== committedRecord) return compactionGateVerdict(record, mode);
    let v = verdicts.get(mode);
    if (!v) {
        v = compactionGateVerdict(record, mode);
        verdicts.set(mode, v);
    }
    return v;
}
