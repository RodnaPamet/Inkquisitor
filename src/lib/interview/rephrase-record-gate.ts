/**
 * THE REPHRASE GATE (Phase 2.H item 7; issue #36, item 4): decision D11
 * applied to "Ask me this differently", as reconcile's gate applies it to the
 * reconcile step (`src/lib/enrichment/record-gate.ts`, whose shape this is).
 *
 *   production   a rephrase runs only on a REAL MODEL's evaluation record of
 *                the rephrase prompt (`evals/rephrase-evaluation-record.json`,
 *                made by the Evals workflow, input `rephrase`, committed by a
 *                reviewed pull request). Until then the request is a 503
 *                `REPHRASE_NOT_EVALUATED` before any call, nothing written:
 *                the question stands and can be answered, skipped or
 *                deferred. A `[startup] WARN` says so. There is no override.
 *   otherwise    a STRUCTURAL record counts too (the packs' own reading of D11,
 *                `packRecordModeOf`, so D13's loopback stub server rephrases).
 *
 * The record is checked once per process (every module graph shares the
 * verdict), lazily, and at start-up in production (the WARN).
 */
import type { PackRecordMode } from './pack-records-config';
import type { PackRegistry } from './packs';
import committedRecord from './evals/rephrase-evaluation-record.json';
import { checkRephraseRecord } from './evals/rephrase-evaluation';
import { processSharedMap } from '@/lib/process-shared-cache';

export type RephraseGateVerdict =
    | { mounted: true; recordKind: 'structural' | 'model' }
    | { mounted: false; reason: 'STRUCTURAL_RECORD_REFUSED' | 'NO_PASSING_RECORD'; detail: string };

/** Shared by every module graph of the process (issue #36, item 7), keyed by mode and the packs' content. */
const verdicts = processSharedMap<Promise<RephraseGateVerdict>>('rephrase-gate-verdicts');

export async function rephraseGateVerdict(record: unknown, registry: PackRegistry, mode: PackRecordMode): Promise<RephraseGateVerdict> {
    const check = await checkRephraseRecord(record, registry);
    if (!check.ok) return { mounted: false, reason: 'NO_PASSING_RECORD', detail: `${check.reason}: ${check.detail}` };
    const kind = check.record.generator.kind;
    if (mode === 'model' && kind !== 'model') return { mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production accepts only a real model’s evaluation record (D11)' };
    return { mounted: true, recordKind: kind };
}

/** The verdict on the committed record under `mode`, cached per mode and registry. */
export function rephraseGate(registry: PackRegistry, mode: PackRecordMode): Promise<RephraseGateVerdict> {
    const key = `${mode}\u0000${Object.values(registry.files).map((f) => f.contentHash).sort().join(',')}`;
    let v = verdicts.get(key);
    if (!v) {
        v = rephraseGateVerdict(committedRecord, registry, mode);
        verdicts.set(key, v);
    }
    return v;
}

/** The start-up line about a rephrase step that will not run, or null. Codes, never text. */
export async function rephraseGateReport(registry: PackRegistry, mode: PackRecordMode): Promise<string | null> {
    const v = await rephraseGate(registry, mode);
    if (v.mounted) return null;
    return `"Ask me this differently" has no evaluation record this deployment accepts (${v.reason}): rephrase requests are refused REPHRASE_NOT_EVALUATED.`;
}
