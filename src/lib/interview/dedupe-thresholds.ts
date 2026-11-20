/**
 * THE COSINE THRESHOLDS DEDUPLICATION USES, PER EMBEDDING REVISION (issue #32,
 * item 1).
 *
 * Two questions' embedding similarity means something only for the model that
 * embedded them: 0.9 for one model is a paraphrase, for another a different
 * question on the same subject. So the pair (same target, another field) is
 * looked up by the embedding REVISION (`embeddingRevisionOf`: model,
 * dimensions, prefixes), in this order:
 *
 *   1. `DEDUPE_COSINE_THRESHOLDS`, the operator's calibration, as
 *      `<revision>=<same>,<other>` entries separated by `;` — the way a
 *      deployment that calibrated its own TEI model states it without a
 *      release;
 *   2. `CALIBRATED_COSINE_THRESHOLDS`, a reviewed row per revision with the
 *      evidence it was calibrated on;
 *   3. the UNCALIBRATED default, 2.2's 0.9 / 0.97.
 *
 * PENDING: the table is empty. Calibration needs the production embedding
 * model (not chosen yet, D8 / 4.1): run the coverage evaluation and a
 * near-duplicate set (paraphrase pairs that must match, near-miss pairs on one
 * field that must not; `tests/unit/interview/dedupe-and-text.test.ts` holds today's)
 * through that model, pick the pair that separates them, and add its row here
 * with the evidence. Until then every revision reads the default and says so
 * (`source: 'UNCALIBRATED_DEFAULT'`).
 *
 * A malformed entry is refused by the env schema (`src/env.ts`) at start; an
 * entry for another revision is simply not this one's.
 */
import { DEFAULT_COSINE_THRESHOLDS, type CosineThresholds } from './dedupe';

export interface CalibratedThresholds extends CosineThresholds {
    /** What the pair was calibrated on (a set, a date), for the reviewer. */
    readonly evidence: string;
}

/** Reviewed rows, by embedding revision. Empty until the production model is chosen and calibrated. */
export const CALIBRATED_COSINE_THRESHOLDS: Readonly<Record<string, CalibratedThresholds>> = Object.freeze({});

export type ThresholdSource = 'ENV' | 'CALIBRATED' | 'UNCALIBRATED_DEFAULT';

/** One `revision=same,other` entry. Thresholds in (0.5, 1], same ≤ other: a looser bar on another field would drop more there than on the field itself. */
const ENTRY = /^([^=;\s]{1,200})=(0(?:\.\d+)?|1(?:\.0+)?),(0(?:\.\d+)?|1(?:\.0+)?)$/;

/** The env value's grammar, for the env schema. */
export const DEDUPE_COSINE_THRESHOLDS_PATTERN = /^[^=;\s]{1,200}=(0(\.\d+)?|1(\.0+)?),(0(\.\d+)?|1(\.0+)?)(;[^=;\s]{1,200}=(0(\.\d+)?|1(\.0+)?),(0(\.\d+)?|1(\.0+)?))*$/;

/** Parse the operator's entries; a malformed one throws (the env schema refuses it first in a validated start). */
export function parseCosineThresholds(value: string | undefined): Map<string, CosineThresholds> {
    const out = new Map<string, CosineThresholds>();
    if (!value?.trim()) return out;
    for (const raw of value.split(';')) {
        const m = ENTRY.exec(raw.trim());
        if (!m) throw new Error('DEDUPE_COSINE_THRESHOLDS: each entry is <revision>=<same>,<other>');
        const sameTarget = Number(m[2]);
        const otherTarget = Number(m[3]);
        if (sameTarget <= 0.5 || otherTarget <= 0.5 || sameTarget > otherTarget) throw new Error('DEDUPE_COSINE_THRESHOLDS: each threshold is in (0.5, 1], the same-target one no higher than the other');
        out.set(m[1], { sameTarget, otherTarget });
    }
    return out;
}

/** The thresholds for `revision` and where they came from. */
export function cosineThresholdsFor(revision: string, envValue: string | undefined): CosineThresholds & { source: ThresholdSource } {
    const fromEnv = parseCosineThresholds(envValue).get(revision);
    if (fromEnv) return { ...fromEnv, source: 'ENV' };
    const row = CALIBRATED_COSINE_THRESHOLDS[revision];
    if (row) return { sameTarget: row.sameTarget, otherTarget: row.otherTarget, source: 'CALIBRATED' };
    return { ...DEFAULT_COSINE_THRESHOLDS, source: 'UNCALIBRATED_DEFAULT' };
}
