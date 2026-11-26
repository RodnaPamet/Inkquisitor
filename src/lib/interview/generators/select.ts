/**
 * CODE VALIDATES, DEDUPLICATES AND ORDERS EVERY CANDIDATE (Phase 4.4, D23 and
 * D30 item 1: best value first). Pure.
 *
 *   hold         a candidate on a field with an enrichment proposal still PENDING (`held`, owner decision 2026-11-26:
 *                hold follow-ups) is set aside, counted, until the author decides that proposal; then it is asked
 *   validate     the subject is in scope and the field is one of its own (or, a source question, no field); the
 *                value is a whole number 0..100; a code-worded question holds the question rules every question
 *                holds (`questionTextProblem`, `questionOptionsProblem`): refused by name, counted, never softened
 *   deduplicate  ONE candidate per field a round, whichever generators proposed it: the highest value wins
 *                (equal values by `GENERATOR_PRIORITY`, then the order proposed); one per fact and one per
 *                continuity basis. Wording against what the session and the book already asked is
 *                deduplicated again in `produceRound` (2.2's lexical, keyed and vector signals) and, at persist,
 *                by the hard repetition gate
 *   order        value, highest first; then `GENERATOR_PRIORITY`; then the order proposed (the frontier's own)
 *   cut          only candidates at or above the floor (`MINOR_VALUE_FLOOR`, 0 once the author chose to go on),
 *                at most `cap` (the detail dial's round cap, or fewer: what a QUESTIONS session has left), at most
 *                `pairsMax` pairs. Nothing at or above the floor but something below it: `valueFell` — the
 *                session says the rest is minor and asks whether to go on, instead of padding a round
 *
 * The model may reorder only NEAR-EQUAL candidates among those chosen (`tieGroups`, D30 item 4); a score never moves.
 */
import { questionOptionsProblem, questionTextProblem } from '../candidates';
import { refKey } from '../frontier';
import type { QuestionGeneratorKey } from '../vocabulary';
import type { GeneratorSubject, TargetCandidate } from './index';
import { MINOR_VALUE_FLOOR, ORDER_TIE_BAND, VALUE_MAX } from './value';

/** Pairs asked in one round at most (D30 item 3: a small, bounded number). */
export const PAIRS_PER_ROUND_MAX = 2;

/** Equal values break by generator: a decision the author can make at once, then a contradiction, then a gap, then depth. */
export const GENERATOR_PRIORITY: readonly QuestionGeneratorKey[] = ['SOURCES', 'CONTINUITY', 'FRONTIER', 'RELATIONS', 'LADDER'];

export const CANDIDATE_REFUSALS = ['UNKNOWN_SUBJECT', 'UNKNOWN_FIELD', 'NO_FIELD', 'BAD_VALUE', 'BAD_TEXT', 'BAD_OPTIONS'] as const;
export type CandidateRefusal = (typeof CANDIDATE_REFUSALS)[number];

export interface SelectOptions {
    cap: number;
    /** `MINOR_VALUE_FLOOR`, or 0 once the author chose to go on. */
    floor?: number;
    pairsMax?: number;
    /** Every subject a candidate may name: the scope's, and the pairs'. */
    subjects: ReadonlyMap<string, Pick<GeneratorSubject, 'elementId' | 'fields'>>;
    /** Fields (`refKey`) with a PENDING enrichment proposal: no candidate on one is chosen (owner decision 2026-11-26, A). */
    held?: ReadonlySet<string>;
}

export interface Selection {
    /** The round's candidates, best first. */
    chosen: TargetCandidate[];
    /** Candidates at or above the floor left for later rounds. */
    remaining: number;
    /** Candidates below the floor. */
    minor: number;
    /** Nothing at or above the floor, something below it. */
    valueFell: boolean;
    /** Candidates proposed, by generator. */
    proposed: Partial<Record<QuestionGeneratorKey, number>>;
    refused: Partial<Record<CandidateRefusal, number>>;
    /** Candidates another candidate on the same field, fact or basis outranked. */
    duplicates: number;
    /** Valid candidates set aside because their field has a proposed change the author has not decided yet. */
    held: number;
}

function refusalOf(c: TargetCandidate, subjects: SelectOptions['subjects']): CandidateRefusal | null {
    const subject = subjects.get(c.elementId);
    if (!subject) return 'UNKNOWN_SUBJECT';
    if (c.fieldKey === null) {
        if (c.generator !== 'SOURCES') return 'NO_FIELD';
    } else if (!subject.fields.some((f) => f.key === c.fieldKey)) return 'UNKNOWN_FIELD';
    if (!Number.isInteger(c.value) || c.value < 0 || c.value > VALUE_MAX) return 'BAD_VALUE';
    if (c.worded) {
        if (questionTextProblem(c.worded.text)) return 'BAD_TEXT';
        if ((c.worded.kind === 'EITHER_OR') !== (c.worded.options !== null) || (c.worded.options && questionOptionsProblem(c.worded.kind, c.worded.options))) return 'BAD_OPTIONS';
    } else if (c.generator !== 'FRONTIER' && c.generator !== 'RELATIONS') return 'BAD_TEXT';
    return null;
}

function priority(g: QuestionGeneratorKey): number {
    return GENERATOR_PRIORITY.indexOf(g);
}

/** Best first: value, then generator, then the order proposed. */
export function compareCandidates(a: { c: TargetCandidate; i: number }, b: { c: TargetCandidate; i: number }): number {
    return b.c.value - a.c.value || priority(a.c.generator) - priority(b.c.generator) || a.i - b.i;
}

export function selectCandidates(candidates: readonly TargetCandidate[], options: SelectOptions): Selection {
    const floor = options.floor ?? MINOR_VALUE_FLOOR;
    const pairsMax = options.pairsMax ?? PAIRS_PER_ROUND_MAX;
    const out: Selection = { chosen: [], remaining: 0, minor: 0, valueFell: false, proposed: {}, refused: {}, duplicates: 0, held: 0 };
    const valid: Array<{ c: TargetCandidate; i: number }> = [];
    candidates.forEach((c, i) => {
        out.proposed[c.generator] = (out.proposed[c.generator] ?? 0) + 1;
        const refusal = refusalOf(c, options.subjects);
        if (refusal) out.refused[refusal] = (out.refused[refusal] ?? 0) + 1;
        else if (c.fieldKey !== null && options.held?.has(refKey({ elementId: c.elementId, fieldKey: c.fieldKey }))) out.held++;
        else valid.push({ c, i });
    });
    valid.sort(compareCandidates);
    const seen = new Set<string>();
    const unique: TargetCandidate[] = [];
    for (const { c } of valid) {
        const keys = [
            ...(c.fieldKey !== null ? [`field\u0000${c.elementId}\u0000${c.fieldKey}`] : []),
            ...(c.storyFactId ? [`fact\u0000${c.storyFactId}`] : []),
            ...(c.continuityRef ? [`basis\u0000${c.continuityRef}`] : []),
        ];
        if (keys.some((k) => seen.has(k))) {
            out.duplicates++;
            continue;
        }
        keys.forEach((k) => seen.add(k));
        unique.push(c);
    }
    const above = unique.filter((c) => c.value >= floor);
    out.minor = unique.length - above.length;
    if (above.length === 0) {
        out.valueFell = out.minor > 0;
        return out;
    }
    let pairs = 0;
    for (const c of above) {
        if (out.chosen.length >= Math.max(0, options.cap)) break;
        if (c.pairElementId) {
            if (pairs >= pairsMax) continue;
            pairs++;
        }
        out.chosen.push(c);
    }
    out.remaining = above.length - out.chosen.length;
    return out;
}

/**
 * The runs of NEAR-EQUAL candidates among those chosen, each as indexes into `chosen` (consecutive, best first): a run
 * holds candidates within `ORDER_TIE_BAND` of its first. Only these may be reordered by the model (D30 item 4).
 */
export function tieGroups(chosen: readonly Pick<TargetCandidate, 'value'>[], band: number = ORDER_TIE_BAND): number[][] {
    const groups: number[][] = [];
    let i = 0;
    while (i < chosen.length) {
        let j = i + 1;
        while (j < chosen.length && chosen[i].value - chosen[j].value <= band) j++;
        if (j - i >= 2) groups.push(Array.from({ length: j - i }, (_, k) => i + k));
        i = j;
    }
    return groups;
}
