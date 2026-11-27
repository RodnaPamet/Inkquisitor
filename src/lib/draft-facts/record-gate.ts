/**
 * THE DRAFT-READING GATE (Phase 5.3): decision D11 applied to the nightly draft reading, as 4.0 applies it to source
 * fact extraction and 4.2 to the deep check.
 *
 *   production   the nightly pass reads scenes only on a REAL MODEL's evaluation record (`evals/evaluation-record.json`,
 *                made by the Evals workflow's `draft_read` input and committed by a reviewed pull request). Until one is
 *                committed, a night's run stops NOT_EVALUATED, reads nothing and sends nothing. No override.
 *   otherwise    a STRUCTURAL record (the reference reader's) counts.
 *
 * Which records count is the packs' own reading of D11 (`packRecordModeOf`, through `deploymentPackRecordMode()`), so
 * D13's loopback stub server accepts the structural record.
 */
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import committedRecord from './evals/evaluation-record.json';
import { checkDraftReadRecord } from './evals/evaluation';

export type DraftReadGateVerdict =
    | { mounted: true; recordKind: 'structural' | 'model' }
    | { mounted: false; reason: 'STRUCTURAL_RECORD_REFUSED' | 'NO_PASSING_RECORD'; detail: string };

const verdicts = new Map<string, DraftReadGateVerdict>();

export function draftReadGateVerdict(record: unknown, mode: PackRecordMode): DraftReadGateVerdict {
    const check = checkDraftReadRecord(record);
    if (!check.ok) return { mounted: false, reason: 'NO_PASSING_RECORD', detail: `${check.reason}: ${check.detail}` };
    const kind = check.record.generator.kind;
    if (mode === 'model' && kind !== 'model') return { mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production accepts only a real model’s evaluation record (D11)' };
    return { mounted: true, recordKind: kind };
}

export function draftReadGate(mode: PackRecordMode, record: unknown = committedRecord): DraftReadGateVerdict {
    if (record !== committedRecord) return draftReadGateVerdict(record, mode);
    let v = verdicts.get(mode);
    if (!v) {
        v = draftReadGateVerdict(record, mode);
        verdicts.set(mode, v);
    }
    return v;
}

/** The start-up line about a draft reading that will not run, or null. Codes, never text. */
export function draftReadGateReport(mode: PackRecordMode): string | null {
    const v = draftReadGate(mode);
    if (v.mounted) return null;
    return `the nightly draft reading has no evaluation record this deployment accepts (${v.reason}): no scene is read (NOT_EVALUATED).`;
}
