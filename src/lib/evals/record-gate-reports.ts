/**
 * THE START-UP REPORT OF EVERY MODEL FEATURE'S D11 GATE (Phase 4.H-a, #63).
 *
 * Each model feature that production runs only on a real model's evaluation
 * record has a gate (`<feature>/record-gate.ts`) and a one-line report of why
 * it will not run. Until 4.H-a only the reconcile step's report was read at
 * start, so a production deployment missing, say, the continuity record never
 * said so until an author asked why the nightly check found nothing. Every
 * gate is listed here, in the order the features were built, and the web tier
 * (`src/instrumentation-node.ts`) writes one `[startup] WARN:` line for each
 * report that is not null. A new gate joins `GATE_REPORTS`
 * (`tests/unit/platform/startup-record-gates.test.ts` checks every committed
 * evaluation record's gate is listed).
 *
 * Codes and counts only, never a record's text.
 */
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { reconcileGateReport } from '@/lib/enrichment/record-gate';
import { researchGateReport } from '@/lib/research/record-gate';
import { extractionGateReport } from '@/lib/sources/record-gate';
import { bibleFactGateReport } from '@/lib/facts/record-gate';
import { continuityGateReport } from '@/lib/continuity/record-gate';
import { stressTestGateReport } from '@/lib/stress-test/record-gate';
import { gapRankGateReport } from '@/lib/gap-hunt/record-gate';
import { compactionGateReport } from '@/lib/interview/compaction-gate';
import { questionOrderGateReport } from '@/lib/interview/question-order/record-gate';
import { draftReadGateReport } from '@/lib/draft-facts/record-gate';

export type GateReport = (mode: PackRecordMode) => string | null | Promise<string | null>;

/** Every gate, by the feature it holds. */
export const GATE_REPORTS: Readonly<Record<string, GateReport>> = {
    reconcile: reconcileGateReport,
    research: researchGateReport,
    'source-facts': extractionGateReport,
    'bible-facts': bibleFactGateReport,
    continuity: continuityGateReport,
    'stress-test': stressTestGateReport,
    'gap-rank': gapRankGateReport,
    compaction: compactionGateReport,
    'question-order': questionOrderGateReport,
    'draft-read': draftReadGateReport,
};

/** Every gate's report that is not null, in `GATE_REPORTS` order. A gate that throws is reported as such, never skipped. */
export async function recordGateReports(mode: PackRecordMode): Promise<string[]> {
    const lines: string[] = [];
    for (const [feature, report] of Object.entries(GATE_REPORTS)) {
        try {
            const line = await report(mode);
            if (line) lines.push(line);
        } catch (err) {
            lines.push(`the ${feature} gate could not be read (${err instanceof Error ? err.name : 'Error'}): treat that feature as not evaluated.`);
        }
    }
    return lines;
}
