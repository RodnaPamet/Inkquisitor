/**
 * THE RULES A WEAK POINT IS HELD TO (Phase 4.3, D29; rules 1 and 2, D3). Pure.
 * The model names weak points; code decides what is kept. In order, each
 * refusal a named, counted code (never a row):
 *
 *   INVALID_ITEM        the item did not parse
 *   OVER_LIMIT          past `WEAK_POINTS_MAX`
 *   COPIES_INJECTED     markup, a script scheme, an address the material does not give, the guard's injection hit,
 *                       or eight words of this prompt's own instructions (2.H's disclosure rule)
 *   TITLE_EMPTY         no label left after sanitising
 *   TITLE_A_SENTENCE    the label holds more than one sentence (a label, never a verdict written out)
 *   NOT_A_QUESTION      (per question, the question dropped) not one question ending in its only question mark,
 *                       or past `WEAK_POINT_QUESTION_MAX`
 *   REWRITES_TEXT       (per question, the question dropped) it quotes a run of more than `QUOTED_RUN_WORDS_MAX`
 *                       words the material does not hold: replacement wording, never a question (D3)
 *   NO_QUESTION         no question survived: a weak point is questions or nothing
 *   INVENTS_NAME        the label or a question names someone or something (a capitalised word past a sentence's
 *                       first) the material does not hold: a weak point never invents story content (D3)
 *   NO_CITATION         it cites nothing
 *   UNKNOWN_CITATION    it cites a tag the call was not shown: the whole weak point goes (a citation that names
 *                       nothing is a claim resting on nothing, rule 2)
 *   DUPLICATE           the same kind and label twice in one answer
 *
 * D14: a weak point whose label or questions address the product itself is KEPT and flagged
 * `POSSIBLE_INSTRUCTION`, shown as such. The caller checks again, at persist, that every cited row still exists
 * (CITATION_GONE).
 */
import { plainLine } from '@/lib/bible/text';
import { addressesTheProduct } from '@/lib/enrichment/validate';
import { normaliseText } from '@/lib/interview/text';
import { copiesInjected } from '@/lib/sources/validate';
import { disclosesInstructions, promptRuns } from '@/lib/text/prompt-disclosure';
import type { ShownRef } from './input';
import { STRESS_TEST_PROMPT } from './prompt';
import { parseStressTestOutput } from './schema';
import {
    CITES_PER_WEAK_POINT_MAX,
    QUESTIONS_PER_WEAK_POINT_MAX,
    QUOTED_RUN_WORDS_MAX,
    WEAK_POINT_QUESTION_MAX,
    WEAK_POINT_TITLE_MAX,
    WEAK_POINTS_MAX,
    type WeakPointKind,
    type WeakPointRefusal,
} from './vocabulary';

const RUNS = promptRuns([STRESS_TEST_PROMPT]);
const TAG = /^[EFTP][1-9][0-9]{0,2}$/;
/** A quoted run: straight or curly double quotes around at most 400 characters that hold no quote. */
const QUOTED = /["“]([^"“”\n]{1,400})["”]/g;

export interface WeakPointDraft {
    readonly kind: WeakPointKind;
    readonly title: string;
    readonly questions: readonly string[];
    readonly citations: readonly ShownRef[];
    /** D14: POSSIBLE_INSTRUCTION. */
    readonly flags: readonly string[];
}

export interface WeakPointValidation {
    readonly weakPoints: WeakPointDraft[];
    readonly refusals: Partial<Record<WeakPointRefusal, number>>;
    readonly drafted: number;
}

/** A label: one line, a single trailing full stop dropped, clipped; '' when nothing is left. */
function labelOf(raw: string): string {
    const line = plainLine(raw).replace(/\.$/, '');
    return line.length > WEAK_POINT_TITLE_MAX ? line.slice(0, WEAK_POINT_TITLE_MAX).trimEnd() : line;
}

/** More than one sentence: a sentence end followed by more text. */
function holdsTwoSentences(text: string): boolean {
    return /[.!?]\s+\S/.test(text);
}

/** One question, ending in its only question mark, no other sentence before it. */
export function isOneQuestion(q: string): boolean {
    if (q.length === 0 || q.length > WEAK_POINT_QUESTION_MAX || !q.endsWith('?')) return false;
    if (q.indexOf('?') !== q.length - 1) return false;
    return !/[.!]\s+\S/.test(q);
}

/** It quotes more than `QUOTED_RUN_WORDS_MAX` words that the material does not hold verbatim (folded). */
export function rewritesText(q: string, material: string): boolean {
    const folded = normaliseText(material);
    for (const m of q.matchAll(QUOTED)) {
        const quote = m[1].trim();
        if (quote.split(/\s+/).filter((w) => w !== '').length <= QUOTED_RUN_WORDS_MAX) continue;
        if (!folded.includes(normaliseText(quote))) return true;
    }
    return false;
}

const CAPITALISED = /\p{Lu}[\p{Ll}'’-]{2,}/gu;

/** A capitalised word (a name) past the first word of a sentence that the material does not hold, folded. */
export function inventsName(text: string, material: string): boolean {
    const folded = ` ${normaliseText(material).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    for (const sentence of text.split(/(?<=[.!?:;])\s+/)) {
        const words = sentence.trim().split(/\s+/).slice(1).join(' ');
        for (const m of words.matchAll(CAPITALISED)) {
            const word = normaliseText(m[0]).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
            if (word !== '' && !folded.includes(` ${word} `) && !folded.includes(` ${word.replace(/s$/, '')} `)) return true;
        }
    }
    return false;
}

export function validateWeakPoints(raw: unknown, input: { shown: ReadonlyMap<string, ShownRef>; text: string }): WeakPointValidation {
    const { items, malformed } = parseStressTestOutput(raw);
    const refusals: Partial<Record<WeakPointRefusal, number>> = {};
    const refuse = (code: WeakPointRefusal, n = 1) => (refusals[code] = (refusals[code] ?? 0) + n);
    if (malformed > 0) refuse('INVALID_ITEM', malformed);
    const out: WeakPointDraft[] = [];
    const seen = new Set<string>();
    items.forEach((item, i) => {
        if (i >= WEAK_POINTS_MAX) return refuse('OVER_LIMIT');
        const parts = [item.title, ...item.questions];
        if (copiesInjected(parts, input.text) || disclosesInstructions(parts, RUNS)) return refuse('COPIES_INJECTED');
        const title = labelOf(item.title);
        if (title === '') return refuse('TITLE_EMPTY');
        if (holdsTwoSentences(title)) return refuse('TITLE_A_SENTENCE');
        const questions: string[] = [];
        for (const rawQ of item.questions.slice(0, QUESTIONS_PER_WEAK_POINT_MAX)) {
            const q = plainLine(rawQ);
            if (!isOneQuestion(q)) {
                refuse('NOT_A_QUESTION');
                continue;
            }
            if (rewritesText(q, input.text)) {
                refuse('REWRITES_TEXT');
                continue;
            }
            if (!questions.includes(q)) questions.push(q);
        }
        if (questions.length === 0) return refuse('NO_QUESTION');
        if ([title, ...questions].some((t) => inventsName(t, input.text))) return refuse('INVENTS_NAME');
        const tags = [...new Set(item.cites.map((c) => c.trim().toUpperCase()))];
        if (tags.length === 0) return refuse('NO_CITATION');
        // EVERY tag is resolved, the ones past the kept bound too: an unknown tag anywhere refuses the whole weak point.
        const citations: ShownRef[] = [];
        for (const tag of tags) {
            const ref = TAG.test(tag) ? input.shown.get(tag) : undefined;
            if (!ref) return refuse('UNKNOWN_CITATION');
            if (citations.length < CITES_PER_WEAK_POINT_MAX) citations.push(ref);
        }
        const key = `${item.kind}:${normaliseText(title)}`;
        if (seen.has(key)) return refuse('DUPLICATE');
        seen.add(key);
        out.push({ kind: item.kind, title, questions, citations, flags: [title, ...questions].some(addressesTheProduct) ? ['POSSIBLE_INSTRUCTION'] : [] });
    });
    return { weakPoints: out, refusals, drafted: items.length + malformed };
}
