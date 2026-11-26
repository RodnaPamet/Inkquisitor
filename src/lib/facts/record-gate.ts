/**
 * THE BIBLE FACT GATE (Phase 4.1, D27): decision D11 applied to bible fact
 * extraction, as 4.0 applies it to sources.
 *
 *   production   accepted versions are extracted only on a REAL MODEL's
 *                evaluation record (`evals/evaluation-record.json`, made by the
 *                Evals workflow's `bible_facts` input and committed by a
 *                reviewed pull request). Until one is committed, the dispatcher
 *                queues nothing and an extraction that runs stops
 *                NOT_EVALUATED (resumable). No override.
 *   otherwise    a STRUCTURAL record (the reference extractor's) counts.
 *
 * Which records count is the packs' own reading of D11 (`packRecordModeOf`,
 * through `deploymentPackRecordMode()`), so D13's loopback stub server accepts
 * the structural record. Embedding is not gated: only the model step is.
 */
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import committedRecord from './evals/evaluation-record.json';
import { checkBibleFactsRecord } from './evals/evaluation';

export type BibleFactGateVerdict =
    | { mounted: true; recordKind: 'structural' | 'model' }
    | { mounted: false; reason: 'STRUCTURAL_RECORD_REFUSED' | 'NO_PASSING_RECORD'; detail: string };

const verdicts = new Map<string, BibleFactGateVerdict>();

export function bibleFactGateVerdict(record: unknown, mode: PackRecordMode): BibleFactGateVerdict {
    const check = checkBibleFactsRecord(record);
    if (!check.ok) return { mounted: false, reason: 'NO_PASSING_RECORD', detail: `${check.reason}: ${check.detail}` };
    const kind = check.record.generator.kind;
    if (mode === 'model' && kind !== 'model') return { mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production accepts only a real model’s evaluation record (D11)' };
    return { mounted: true, recordKind: kind };
}

export function bibleFactGate(mode: PackRecordMode, record: unknown = committedRecord): BibleFactGateVerdict {
    if (record !== committedRecord) return bibleFactGateVerdict(record, mode);
    let v = verdicts.get(mode);
    if (!v) {
        v = bibleFactGateVerdict(record, mode);
        verdicts.set(mode, v);
    }
    return v;
}

/** The start-up line about an extraction that will not run, or null. Codes, never text. */
export function bibleFactGateReport(mode: PackRecordMode): string | null {
    const v = bibleFactGate(mode);
    if (v.mounted) return null;
    return `bible fact extraction has no evaluation record this deployment accepts (${v.reason}): accepted versions are not extracted (NOT_EVALUATED).`;
}
