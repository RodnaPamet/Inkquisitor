/**
 * DEDUPLICATION — code, not the model, decides whether a question repeats
 * one already asked (Phase 2.2; design 7, with the 2.0 vector store's
 * embedding similarity added beside the lexical signals). Pure: the caller
 * gathers the embedding neighbours (`getVectorRepository().search`) and
 * passes their scores in.
 *
 * Normalisation (`dedupeTokens`): the text of the grounding test's
 * normalisation (`text.ts`), then the element's own name and the role
 * phrases ("your protagonist", "this place") dropped, so two questions about
 * the same thing do not differ only in how they address it; stop words
 * dropped; light stemming.
 *
 * Signals, for a candidate `c` and an asked question `q`:
 *
 *   exact       the same sorted content tokens (`dedupeKey` holds them, keyed)
 *   jaccard     Jaccard similarity of the content-token sets
 *   trigram     Dice coefficient of the character trigrams of the normalised text
 *   sameTarget  `c` and `q` share a field reference
 *   sameShape   CHOICE / EITHER_OR with at least half the options equal, or
 *               SCALE with both anchors equal (an OPEN or SCENARIO question has
 *               no shape beyond its words, so it never matches on shape alone)
 *   cosine      the embedding similarity of the two texts, when both have one
 *
 * Rule, for two questions about the SAME element (a question about another
 * element is never a repeat: "what does this character want?" asked of two
 * characters is two questions): `c` duplicates `q` when exact; or sameTarget
 * and (jaccard ≥ 0.6, or trigram ≥ 0.75, or sameShape, or cosine ≥ 0.9); or,
 * on another field of the element, jaccard ≥ 0.8 or cosine ≥ 0.97. The lexical thresholds are constants here; the
 * COSINE pair is per embedding revision (`dedupe-thresholds.ts`, issue #32 item 1: 0.9 / 0.97 is the
 * uncalibrated default, pending the production model), handed in as `cosine`. Tested
 * on paraphrase pairs (which must match) and near-miss pairs on one field
 * (which must not) in tests/unit/interview/dedupe.test.ts.
 *
 * Scopes: within a round (candidates against the ones before them, in
 * frontier order: the first wins), within the session (every question asked,
 * answered or not), and within the book (earlier sessions' questions: a field
 * reopened in a new session may be asked again, but not in the same words).
 */
import { createHmac } from 'node:crypto';
import { deriveSubkey } from '@/lib/security/encryption';
import type { FieldRef } from './frontier';
import { contentTokens, normaliseText, words } from './text';
import type { QuestionKind } from './vocabulary';

export const DEDUPE = Object.freeze({
    SAME_TARGET_JACCARD: 0.6,
    SAME_TARGET_TRIGRAM: 0.75,
    SAME_TARGET_COSINE: 0.9,
    OTHER_TARGET_JACCARD: 0.8,
    OTHER_TARGET_COSINE: 0.97,
    SHAPE_OPTION_SHARE: 0.5,
});

/** Ways a question addresses its element without naming it. */
const ROLE_PHRASES = [
    'your protagonist',
    'your antagonist',
    'your narrator',
    'this character',
    'this place',
    'this setting',
    'this element',
    'this theme',
    'this plotline',
    'this plot',
    'this faction',
    'this group',
    'this object',
    'this rule',
    'this event',
    'this topic',
    'your book',
    'the book',
    'your story',
    'the story',
];

/** A question as deduplication compares it. */
export interface DedupeQuestion {
    elementId: string;
    targetsFieldKeys: readonly string[];
    kind: QuestionKind;
    text: string;
    options: readonly string[] | null;
    scaleLabels: { low: string; high: string } | null;
}

/** An asked question: its id, and where it was asked. */
export interface AskedQuestion extends DedupeQuestion {
    id: string;
    scope: 'SESSION' | 'BOOK';
}

export interface DedupeTextContext {
    /** Each element's name, whose words are dropped from its questions' tokens. */
    elementNames: ReadonlyMap<string, string>;
}

/** The content tokens deduplication compares, as a sorted unique list. */
export function dedupeTokens(q: Pick<DedupeQuestion, 'elementId' | 'text'>, ctx: DedupeTextContext): string[] {
    let normal = normaliseText(q.text);
    for (const phrase of ROLE_PHRASES) normal = normal.split(phrase).join(' ');
    const nameWords = new Set(words(normaliseText(ctx.elementNames.get(q.elementId) ?? '')));
    return [...new Set(contentTokens(normal, nameWords))].sort();
}

/**
 * The stored `dedupeKey`: a KEYED hash (HMAC-SHA256 under a purpose-labelled
 * subkey, as `vectorContentHash` is) of the sorted content tokens. Equal keys
 * are exact repeats anywhere in the book, found by an index lookup, and the
 * key recovers nothing of the question without the deployment's key.
 */
export function questionDedupeKey(tokens: readonly string[]): string {
    return createHmac('sha256', deriveSubkey('inkquisitor-question-dedupe-key/1')).update(tokens.join(' '), 'utf8').digest('hex');
}

/** The index key of an exact repeat: the element and the question's dedupe key. */
export function exactKey(elementId: string, dedupeKey: string): string {
    return `${elementId}\u0000${dedupeKey}`;
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
    const sa = new Set(a);
    const sb = new Set(b);
    if (sa.size === 0 && sb.size === 0) return 1;
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    return inter / (sa.size + sb.size - inter);
}

function trigrams(text: string): Map<string, number> {
    const s = `  ${normaliseText(text).replace(/[^\p{L}\p{N} ]/gu, '')}  `;
    const out = new Map<string, number>();
    for (let i = 0; i + 3 <= s.length; i++) {
        const g = s.slice(i, i + 3);
        out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
}

/** Dice coefficient of character trigram multisets. */
export function trigramDice(a: string, b: string): number {
    const ta = trigrams(a);
    const tb = trigrams(b);
    let inter = 0;
    let na = 0;
    let nb = 0;
    for (const n of ta.values()) na += n;
    for (const n of tb.values()) nb += n;
    for (const [g, n] of ta) inter += Math.min(n, tb.get(g) ?? 0);
    return na + nb === 0 ? 1 : (2 * inter) / (na + nb);
}

export function sameTarget(a: Pick<DedupeQuestion, 'elementId' | 'targetsFieldKeys'>, b: Pick<DedupeQuestion, 'elementId' | 'targetsFieldKeys'>): boolean {
    return a.elementId === b.elementId && a.targetsFieldKeys.some((k) => b.targetsFieldKeys.includes(k));
}

export function sameShape(a: DedupeQuestion, b: DedupeQuestion): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'CHOICE' || a.kind === 'EITHER_OR') {
        const oa = (a.options ?? []).map(normaliseText);
        const ob = new Set((b.options ?? []).map(normaliseText));
        const shared = oa.filter((o) => ob.has(o)).length;
        return oa.length > 0 && shared / Math.max(oa.length, ob.size) >= DEDUPE.SHAPE_OPTION_SHARE;
    }
    if (a.kind === 'SCALE') {
        return (
            !!a.scaleLabels &&
            !!b.scaleLabels &&
            normaliseText(a.scaleLabels.low) === normaliseText(b.scaleLabels.low) &&
            normaliseText(a.scaleLabels.high) === normaliseText(b.scaleLabels.high)
        );
    }
    return false;
}

export type DuplicateSignal = 'EXACT' | 'JACCARD' | 'TRIGRAM' | 'SHAPE' | 'EMBEDDING';

/** The cosine thresholds of one embedding revision: same target, and another field of the element. */
export interface CosineThresholds {
    readonly sameTarget: number;
    readonly otherTarget: number;
}

/** The uncalibrated default (2.2's figures), for a revision nobody calibrated (`dedupe-thresholds.ts`). */
export const DEFAULT_COSINE_THRESHOLDS: CosineThresholds = Object.freeze({ sameTarget: DEDUPE.SAME_TARGET_COSINE, otherTarget: DEDUPE.OTHER_TARGET_COSINE });

/** Does `c` repeat `q`? `cosine` is their embedding similarity, when both have one, judged by `thresholds`. */
export function duplicateSignal(
    c: DedupeQuestion,
    q: DedupeQuestion,
    ctx: DedupeTextContext,
    cosine: number | null = null,
    thresholds: CosineThresholds = DEFAULT_COSINE_THRESHOLDS,
): DuplicateSignal | null {
    if (c.elementId !== q.elementId) return null;
    const tc = dedupeTokens(c, ctx);
    const tq = dedupeTokens(q, ctx);
    if (tc.length > 0 && tc.join(' ') === tq.join(' ')) return 'EXACT';
    const j = jaccard(tc, tq);
    if (sameTarget(c, q)) {
        if (j >= DEDUPE.SAME_TARGET_JACCARD) return 'JACCARD';
        if (trigramDice(c.text, q.text) >= DEDUPE.SAME_TARGET_TRIGRAM) return 'TRIGRAM';
        if (sameShape(c, q)) return 'SHAPE';
        if (cosine !== null && cosine >= thresholds.sameTarget) return 'EMBEDDING';
        return null;
    }
    if (j >= DEDUPE.OTHER_TARGET_JACCARD) return 'JACCARD';
    if (cosine !== null && cosine >= thresholds.otherTarget) return 'EMBEDDING';
    return null;
}

/** An embedding neighbour of a candidate among the asked questions, found by the vector store. */
export interface EmbeddingNeighbour {
    questionId: string;
    score: number;
}

export interface DedupeInput<C extends DedupeQuestion> {
    /** In frontier order: the first of two duplicates wins. */
    candidates: readonly C[];
    asked: readonly AskedQuestion[];
    ctx: DedupeTextContext;
    /** Candidate index → its vector store neighbours among `asked` (and beyond: unknown ids are looked up in `neighbourTargets`). */
    neighbours?: ReadonlyMap<number, readonly EmbeddingNeighbour[]>;
    /** Questions a neighbour names that are not in `asked` (beyond the bounded read), by id. */
    neighbourTargets?: ReadonlyMap<string, Pick<DedupeQuestion, 'elementId' | 'targetsFieldKeys'>>;
    /** `exactKey(elementId, dedupeKey)` of every question of the book about an element in scope: an exact repeat found by the index. */
    askedKeys?: ReadonlySet<string>;
    /** Candidate index → its own embedding, for comparisons within the round. */
    vectors?: ReadonlyMap<number, readonly number[]>;
    /** The cosine thresholds of the vectors' embedding revision (`cosineThresholdsFor`); default: uncalibrated. */
    cosine?: CosineThresholds;
}

export interface DedupeResult {
    keptIndexes: number[];
    dropped: Array<{ index: number; duplicateOf: string; signal: DuplicateSignal; scope: 'ROUND' | 'SESSION' | 'BOOK' }>;
}

function cosine(a: readonly number[], b: readonly number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function dedupe<C extends DedupeQuestion>(input: DedupeInput<C>): DedupeResult {
    const askedById = new Map(input.asked.map((q) => [q.id, q]));
    const thresholds = input.cosine ?? DEFAULT_COSINE_THRESHOLDS;
    const result: DedupeResult = { keptIndexes: [], dropped: [] };
    input.candidates.forEach((c, index) => {
        // 1. Against what was asked, lexically, with the neighbour's score when the store found it.
        const scoreOf = new Map((input.neighbours?.get(index) ?? []).map((n) => [n.questionId, n.score]));
        for (const q of input.asked) {
            const signal = duplicateSignal(c, q, input.ctx, scoreOf.get(q.id) ?? null, thresholds);
            if (signal) {
                result.dropped.push({ index, duplicateOf: q.id, signal, scope: q.scope });
                return;
            }
        }
        // 2. An exact repeat the book's index holds beyond the bounded read.
        if (input.askedKeys?.has(exactKey(c.elementId, questionDedupeKey(dedupeTokens(c, input.ctx))))) {
            result.dropped.push({ index, duplicateOf: 'dedupe-key', signal: 'EXACT', scope: 'BOOK' });
            return;
        }
        // 3. Embedding neighbours beyond the bounded read: by element, target and score alone.
        for (const n of input.neighbours?.get(index) ?? []) {
            if (askedById.has(n.questionId)) continue;
            const target = input.neighbourTargets?.get(n.questionId);
            if (!target || target.elementId !== c.elementId) continue;
            const threshold = sameTarget(c, target) ? thresholds.sameTarget : thresholds.otherTarget;
            if (n.score >= threshold) {
                result.dropped.push({ index, duplicateOf: n.questionId, signal: 'EMBEDDING', scope: 'BOOK' });
                return;
            }
        }
        // 4. Against the candidates kept before it in this round.
        for (const k of result.keptIndexes) {
            const a = input.vectors?.get(index);
            const b = input.vectors?.get(k);
            const signal = duplicateSignal(c, input.candidates[k], input.ctx, a && b ? cosine(a, b) : null, thresholds);
            if (signal) {
                result.dropped.push({ index, duplicateOf: `candidate:${k}`, signal, scope: 'ROUND' });
                return;
            }
        }
        result.keptIndexes.push(index);
    });
    return result;
}

/** The field references a question targets. */
export function targetRefs(q: Pick<DedupeQuestion, 'elementId' | 'targetsFieldKeys'>): FieldRef[] {
    return q.targetsFieldKeys.map((fieldKey) => ({ elementId: q.elementId, fieldKey }));
}
