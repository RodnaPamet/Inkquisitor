/**
 * THE RESEARCH GATE (Phase 2.6): decision D11 applied to the research agent,
 * as 2.5 applies it to reconcile (`src/lib/enrichment/record-gate.ts`).
 *
 *   production   a run starts only on a REAL MODEL's evaluation record of the
 *                research prompts (`evals/evaluation-record.json`, made by the
 *                Evals workflow's `research` input and committed by a reviewed
 *                pull request). Until one is committed, a dispatch is refused
 *                503 `RESEARCH_NOT_EVALUATED` before anything is written, and a
 *                run already queued ends REFUSED with the same reason. There
 *                is no override.
 *   otherwise    a STRUCTURAL record (the deterministic researcher's) counts.
 *
 * Which records count is the packs' own reading of D11 (`packRecordModeOf`,
 * through `deploymentPackRecordMode()`), so D13's loopback stub server accepts
 * the structural record and the E2E runs research end to end. Checked once per
 * process and mode, lazily.
 */
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import committedRecord from './evals/evaluation-record.json';
import { checkResearchRecord } from './evals/evaluation';

export type ResearchGateVerdict =
    | { mounted: true; recordKind: 'structural' | 'model' }
    | { mounted: false; reason: 'STRUCTURAL_RECORD_REFUSED' | 'NO_PASSING_RECORD'; detail: string };

const verdicts = new Map<string, Promise<ResearchGateVerdict>>();

export async function researchGateVerdict(record: unknown, mode: PackRecordMode): Promise<ResearchGateVerdict> {
    const check = await checkResearchRecord(record);
    if (!check.ok) return { mounted: false, reason: 'NO_PASSING_RECORD', detail: `${check.reason}: ${check.detail}` };
    const kind = check.record.generator.kind;
    if (mode === 'model' && kind !== 'model') return { mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production accepts only a real model’s evaluation record (D11)' };
    return { mounted: true, recordKind: kind };
}

export function researchGate(mode: PackRecordMode, record: unknown = committedRecord): Promise<ResearchGateVerdict> {
    if (record !== committedRecord) return researchGateVerdict(record, mode);
    let v = verdicts.get(mode);
    if (!v) {
        v = researchGateVerdict(record, mode);
        verdicts.set(mode, v);
    }
    return v;
}

/** The start-up line about a research agent that will not run, or null. Codes, never text. */
export async function researchGateReport(mode: PackRecordMode): Promise<string | null> {
    const v = await researchGate(mode);
    if (v.mounted) return null;
    return `the research agent has no evaluation record this deployment accepts (${v.reason}): research runs are refused RESEARCH_NOT_EVALUATED.`;
}
