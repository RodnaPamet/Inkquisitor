/**
 * THE TIE-BREAK GATE (Phase 4.4, D30 item 4): decision D11 applied to the
 * interview's tie-break call. Production reorders near-equal candidates with
 * the model only on a REAL MODEL's evaluation record
 * (`evals/evaluation-record.json`); without one every round keeps the code's
 * order and records `NOT_EVALUATED`, never a model's. Development, test and
 * D13's loopback stub accept the structural record.
 */
import type { PackRecordMode } from '../pack-records-config';
import committedRecord from './evals/evaluation-record.json';
import { checkQuestionOrderRecord } from './evals/evaluation';

export type QuestionOrderGateVerdict = { mounted: true; recordKind: 'structural' | 'model' } | { mounted: false; reason: 'STRUCTURAL_RECORD_REFUSED' | 'NO_PASSING_RECORD'; detail: string };

const verdicts = new Map<string, QuestionOrderGateVerdict>();

export function questionOrderGateVerdict(record: unknown, mode: PackRecordMode): QuestionOrderGateVerdict {
    const check = checkQuestionOrderRecord(record);
    if (!check.ok) return { mounted: false, reason: 'NO_PASSING_RECORD', detail: `${check.reason}: ${check.detail}` };
    if (mode === 'model' && check.record.generator.kind !== 'model') return { mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production accepts only a real model’s evaluation record (D11)' };
    return { mounted: true, recordKind: check.record.generator.kind };
}

export function questionOrderGate(mode: PackRecordMode, record: unknown = committedRecord): QuestionOrderGateVerdict {
    if (record !== committedRecord) return questionOrderGateVerdict(record, mode);
    let v = verdicts.get(mode);
    if (!v) {
        v = questionOrderGateVerdict(record, mode);
        verdicts.set(mode, v);
    }
    return v;
}

/** The start-up line about a tie-break that will not run, or null. Codes, never text. */
export function questionOrderGateReport(mode: PackRecordMode): string | null {
    const v = questionOrderGate(mode);
    if (v.mounted) return null;
    return `the interview tie-break has no evaluation record this deployment accepts (${v.reason}): rounds keep the code's order (NOT_EVALUATED).`;
}
