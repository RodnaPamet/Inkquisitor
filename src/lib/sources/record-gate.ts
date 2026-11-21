/**
 * THE EXTRACTION GATE (Phase 4.0): decision D11 applied to fact extraction,
 * as 2.5 applies it to reconcile and 2.6 to research.
 *
 *   production   ingestion extracts facts only on a REAL MODEL's evaluation
 *                record (`evals/evaluation-record.json`, made by the Evals
 *                workflow's `sources` input and committed by a reviewed pull
 *                request). Until one is committed, starting an ingestion is
 *                refused 503 `SOURCE_FACTS_NOT_EVALUATED` before anything is
 *                written, and a queued one stops NOT_EVALUATED. No override.
 *   otherwise    a STRUCTURAL record (the reference extractor's) counts.
 *
 * Which records count is the packs' own reading of D11 (`packRecordModeOf`,
 * through `deploymentPackRecordMode()`), so D13's loopback stub server accepts
 * the structural record. Uploading, chunking and reading sources are not
 * gated: only the model step is.
 */
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import committedRecord from './evals/evaluation-record.json';
import { checkExtractionRecord } from './evals/evaluation';

export type ExtractionGateVerdict =
    | { mounted: true; recordKind: 'structural' | 'model' }
    | { mounted: false; reason: 'STRUCTURAL_RECORD_REFUSED' | 'NO_PASSING_RECORD'; detail: string };

const verdicts = new Map<string, ExtractionGateVerdict>();

export function extractionGateVerdict(record: unknown, mode: PackRecordMode): ExtractionGateVerdict {
    const check = checkExtractionRecord(record);
    if (!check.ok) return { mounted: false, reason: 'NO_PASSING_RECORD', detail: `${check.reason}: ${check.detail}` };
    const kind = check.record.generator.kind;
    if (mode === 'model' && kind !== 'model') return { mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production accepts only a real model’s evaluation record (D11)' };
    return { mounted: true, recordKind: kind };
}

export function extractionGate(mode: PackRecordMode, record: unknown = committedRecord): ExtractionGateVerdict {
    if (record !== committedRecord) return extractionGateVerdict(record, mode);
    let v = verdicts.get(mode);
    if (!v) {
        v = extractionGateVerdict(record, mode);
        verdicts.set(mode, v);
    }
    return v;
}

/** The start-up line about an extraction that will not run, or null. Codes, never text. */
export function extractionGateReport(mode: PackRecordMode): string | null {
    const v = extractionGate(mode);
    if (v.mounted) return null;
    return `source fact extraction has no evaluation record this deployment accepts (${v.reason}): ingestions are refused SOURCE_FACTS_NOT_EVALUATED.`;
}
