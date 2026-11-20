/**
 * Repetition (Phase 2.H item 3): no question is asked twice within a book,
 * across sessions, and how often the engine had to stop one.
 *
 * Two readings, both counts (never text):
 *
 *   • `bookRepetition(rows)` — over a book's asked questions, the repeats
 *     that got through: questions about the same element with the same keyed
 *     `dedupeKey` (`dedupe.ts`; the key `findExactRepeats` asks the book's
 *     index by). A book whose deduplication holds reads `repeats: 0`. Over no
 *     question it is NOT_ASSESSED (rule 6), never "0 % repetition".
 *   • `interview.questions.repeats_dropped` / `interview.questions.asked` —
 *     the OpenTelemetry counters each persisted round adds to: how many
 *     candidates deduplication dropped, by the signal that caught them
 *     (`DuplicateSignal`: exact — the book's index included — word overlap,
 *     trigrams, same shape, embedding), against
 *     how many questions were asked. Their ratio is the engine's repetition
 *     PRESSURE: a model that keeps rewording what was asked shows here long
 *     before a repeat could ever reach an author. Labels are closed sets (the
 *     signal), so cardinality is bounded by the type system.
 *
 * A repeat across a REPHRASE pair is not a repeat: a rephrase replaces its
 * original (`replacesQuestionId`), and the pair is one question asked
 * differently (Phase 2.4). Superseded originals are left out.
 */
import { metrics, type Counter } from '@opentelemetry/api';
import type { DuplicateSignal } from './dedupe';

const METER_NAME = 'inkquisitor';

export interface AskedQuestionKey {
    readonly elementId: string;
    readonly dedupeKey: string;
    /** Set on an original a rephrase replaced (`supersededAt`): not counted. */
    readonly superseded?: boolean;
}

export type BookRepetition =
    | { readonly status: 'NOT_ASSESSED'; readonly asked: 0 }
    | { readonly status: 'MEASURED'; readonly asked: number; readonly repeats: number; readonly rate: number };

/** The repeats among a book's asked questions (see the header). */
export function bookRepetition(rows: readonly AskedQuestionKey[]): BookRepetition {
    const live = rows.filter((r) => !r.superseded);
    if (live.length === 0) return { status: 'NOT_ASSESSED', asked: 0 };
    const seen = new Set<string>();
    let repeats = 0;
    for (const r of live) {
        const key = `${r.elementId}\u0000${r.dedupeKey}`;
        if (seen.has(key)) repeats++;
        else seen.add(key);
    }
    return { status: 'MEASURED', asked: live.length, repeats, rate: repeats / live.length };
}

let dropped: Counter | null = null;
let asked: Counter | null = null;

/** Count what one persisted round asked and the repeats its deduplication dropped (by signal). */
export function recordRoundRepetition(input: { asked: number; duplicates: Partial<Record<DuplicateSignal, number>> }): void {
    const meter = metrics.getMeter(METER_NAME);
    dropped ??= meter.createCounter('interview.questions.repeats_dropped', { description: 'Candidate questions dropped as repeats of one already asked in the book, by signal', unit: '1' });
    asked ??= meter.createCounter('interview.questions.asked', { description: 'Questions asked in persisted rounds', unit: '1' });
    if (input.asked > 0) asked.add(input.asked);
    for (const [signal, n] of Object.entries(input.duplicates)) if (n && n > 0) dropped.add(n, { signal });
}
