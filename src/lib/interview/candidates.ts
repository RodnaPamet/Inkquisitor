/**
 * What the model step returns, and what code accepts of it (Phase 2.2;
 * design 4.3 and 5.1).
 *
 * The model words questions; CODE decides whether each may be asked. The
 * structured output is `GeneratedQuestionsSchema` (the schema the 2.1 seam
 * sends as the call's output format), but code never trusts that the model
 * met it: `parseGeneratedQuestions` re-reads the raw output item by item, so
 * one malformed question costs only itself, and `validateCandidate` then holds
 * every survivor to the rules below. A failed rule DROPS the candidate (its
 * field goes to the pack fallback); a failed recommendation is STRIPPED and
 * the question kept — a weak recommendation should not cost the author a good
 * question.
 *
 *   targets      1..2 keys of one element in scope, each assigned to this
 *                persona this round (FRONTIER), or exactly the round's one
 *                challengeable field (CHALLENGE); two only from detail 3
 *   kind         one the detail dial allows (content formats 1.6)
 *   options      CHOICE 3..5, EITHER_OR exactly 2, none on OPEN / SCENARIO /
 *                SCALE, no repeats, no catch-all ("Other", "None of these")
 *   scale        SCALE carries both anchors, nothing else does
 *   text         non-empty, at most 280 characters, ends with `?` and holds
 *                exactly one `?`
 *   challenge    the quote is a verbatim run of at least four words of the
 *                stored value, and the text contains it
 *   recommendation  (stripped when it fails) CHOICE / EITHER_OR: an option
 *                verbatim; SCALE: an integer 1..5; OPEN / SCENARIO: grounded
 *                in the stored values and answers its basis names, every one
 *                of which exists; none at all when the toggle is off. A basis
 *                goes with its recommendation: none is kept without one
 *   rationale    at most 400 characters, or dropped (the question kept)
 *
 * The behaviour codes these enforce (content formats 1.11) are named with
 * each drop reason, so the round's metrics read in the evaluation sets' terms.
 */
import { z } from 'zod';
import { IDENTIFIER_MAX, IDENTIFIER_PATTERN } from '@/lib/bible/kinds';
import { PAIR_TARGETS_FROM_DETAIL, answerTextMax, kindsAllowed } from './dials';
import { refKey, type FieldRef } from './frontier';
import { grounded, normaliseText, words } from './text';
import { QUESTION_KINDS, type QuestionKind, type QuestionMode } from './vocabulary';

export const QUESTION_TEXT_MAX = 280;
export const OPTION_MAX = 160;
export const SCALE_LABEL_MAX = 40;
export const RECOMMENDATION_TEXT_MAX = 600;
export const RATIONALE_MAX = 400;
export const CHALLENGE_QUOTE_MAX = 600;
export const CHALLENGE_QUOTE_MIN_WORDS = 4;
export const QUESTIONS_PER_CALL_MAX = 12;

const fieldKey = z.string().max(IDENTIFIER_MAX).regex(IDENTIFIER_PATTERN);

/** One generated question (design 5.1, with the element it asks about: a round may span several). */
export const GeneratedQuestionSchema = z
    .object({
        elementId: z.string().min(1).max(64),
        targetsFieldKeys: z.array(fieldKey).min(1).max(2),
        mode: z.enum(['FRONTIER', 'CHALLENGE']),
        kind: z.enum(QUESTION_KINDS),
        text: z.string().min(1).max(QUESTION_TEXT_MAX * 2),
        options: z.array(z.string().min(1).max(OPTION_MAX * 2)).min(2).max(5).optional(),
        scaleLabels: z.object({ low: z.string().min(1).max(SCALE_LABEL_MAX * 2), high: z.string().min(1).max(SCALE_LABEL_MAX * 2) }).strict().optional(),
        challengeQuote: z.string().min(1).max(CHALLENGE_QUOTE_MAX * 2).optional(),
        recommendedAnswer: z.union([z.string().min(1).max(RECOMMENDATION_TEXT_MAX * 2), z.number().int().min(1).max(5)]).optional(),
        recommendationBasis: z
            .object({ fieldKeys: z.array(fieldKey).max(20), answerIds: z.array(z.string().min(1).max(64)).max(50) })
            .strict()
            .optional(),
        rationale: z.string().max(RATIONALE_MAX * 2),
    })
    .strict();
export type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>;

export const DECLINE_REASONS = ['NOTHING_TO_ASK_WITHOUT_INVENTING', 'NEEDS_ANOTHER_ELEMENT_FIRST'] as const;

const DeclinedSchema = z
    .object({ elementId: z.string().min(1).max(64), fieldKey, reason: z.enum(DECLINE_REASONS) })
    .strict();
export type Declined = z.infer<typeof DeclinedSchema>;

/**
 * The model step's structured output. `declined` lets the model say it cannot
 * word a question without supplying story content; code treats a declined
 * field like one with no candidate (pack fallback, then carry-over) and never
 * takes it off the frontier.
 */
export const GeneratedQuestionsSchema = z
    .object({
        questions: z.array(GeneratedQuestionSchema).max(QUESTIONS_PER_CALL_MAX),
        declined: z.array(DeclinedSchema).max(QUESTIONS_PER_CALL_MAX),
    })
    .strict();
export type GeneratedQuestions = z.infer<typeof GeneratedQuestionsSchema>;

export interface ParsedGeneration {
    questions: GeneratedQuestion[];
    declined: Declined[];
    /** Items that did not parse, counted (never logged: they hold model text). */
    malformed: number;
    /** The whole output was not an object with a `questions` array. */
    unreadable: boolean;
}

/** Read a model's raw output one item at a time, so a malformed item costs only itself. */
export function parseGeneratedQuestions(raw: unknown): ParsedGeneration {
    const out: ParsedGeneration = { questions: [], declined: [], malformed: 0, unreadable: false };
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { questions?: unknown }).questions)) {
        out.unreadable = true;
        return out;
    }
    const items = (raw as { questions: unknown[] }).questions.slice(0, QUESTIONS_PER_CALL_MAX);
    out.malformed += Math.max(0, (raw as { questions: unknown[] }).questions.length - items.length);
    for (const item of items) {
        const parsed = GeneratedQuestionSchema.safeParse(item);
        if (parsed.success) out.questions.push(parsed.data);
        else out.malformed++;
    }
    const declined = (raw as { declined?: unknown }).declined;
    if (Array.isArray(declined)) {
        for (const item of declined.slice(0, QUESTIONS_PER_CALL_MAX)) {
            const parsed = DeclinedSchema.safeParse(item);
            if (parsed.success) out.declined.push(parsed.data);
        }
    }
    return out;
}

// ─── Validation ─────────────────────────────────────────────────────

/** A candidate as code holds it: a generated question plus who asked it. */
export interface Candidate {
    elementId: string;
    targetsFieldKeys: string[];
    mode: QuestionMode;
    kind: QuestionKind;
    text: string;
    options: string[] | null;
    scaleLabels: { low: string; high: string } | null;
    challengeQuote: string | null;
    recommendedAnswer: string | number | null;
    recommendationBasis: { fieldKeys: string[]; answerIds: string[] } | null;
    rationale: string | null;
    personaKey: string | null;
    /**
     * Phase 4.4 (D30): a question a generator other than the frontier proposed and code worded — which generator, what
     * it rests on (ids and codes), its value score. Absent on a model's question; never read from model output.
     */
    generated?: GeneratedMeta;
}

/** What a code-worded question carries about the generator that proposed it (ids and codes, never text). */
export interface GeneratedMeta {
    generator: 'FRONTIER' | 'LADDER' | 'RELATIONS' | 'SOURCES' | 'CONTINUITY';
    value: number;
    angle?: string;
    pairElementId?: string;
    storyFactId?: string;
    continuityRef?: string;
}

export function candidateFrom(q: GeneratedQuestion, personaKey: string | null): Candidate {
    return {
        elementId: q.elementId,
        targetsFieldKeys: [...q.targetsFieldKeys],
        mode: q.mode,
        kind: q.kind,
        text: q.text,
        options: q.options ? [...q.options] : null,
        scaleLabels: q.scaleLabels ? { ...q.scaleLabels } : null,
        challengeQuote: q.challengeQuote ?? null,
        recommendedAnswer: q.recommendedAnswer ?? null,
        recommendationBasis: q.recommendationBasis ? { fieldKeys: [...q.recommendationBasis.fieldKeys], answerIds: [...q.recommendationBasis.answerIds] } : null,
        rationale: q.rationale.length > 0 ? q.rationale : null,
        personaKey,
    };
}

/** Why a candidate was dropped, and the behaviour code (content formats 1.11) it would have shown. */
export const DROP_REASONS = {
    MALFORMED_ITEM: 'MALFORMED_OPTIONS',
    UNKNOWN_ELEMENT: 'OUT_OF_SCOPE_KIND',
    UNKNOWN_FIELD: 'OUT_OF_SCOPE_KIND',
    NOT_ASSIGNED: 'ASKS_ANSWERED_FIELD',
    REPEATED_TARGET: 'COMPOUND_QUESTION',
    TOO_MANY_TARGETS: 'COMPOUND_QUESTION',
    KIND_NOT_ALLOWED: 'MISMATCHES_DETAIL',
    MALFORMED_OPTIONS: 'MALFORMED_OPTIONS',
    EMPTY_TEXT: 'COMPOUND_QUESTION',
    TEXT_TOO_LONG: 'COMPOUND_QUESTION',
    COMPOUND_QUESTION: 'COMPOUND_QUESTION',
    BAD_CHALLENGE: 'ASKS_ANSWERED_FIELD',
    DUPLICATE: 'REPEATS_PRIOR_QUESTION',
    /** A second question of the round on a field another already asks (one question per field a round). */
    TARGET_ALREADY_ASKED: 'REPEATS_PRIOR_QUESTION',
    /** Six words of the engine's own instructions, or its fence's tag, in what the author would see (Phase 2.H). */
    DISCLOSES_INSTRUCTIONS: 'DISCLOSES_INSTRUCTIONS',
} as const;
export type DropReason = keyof typeof DROP_REASONS;

/** Why a recommendation was stripped (the question kept). */
export type RecommendationStrip = 'TOGGLE_OFF' | 'NOT_AN_OPTION' | 'NOT_A_SCALE_VALUE' | 'BASIS_UNKNOWN' | 'UNGROUNDED' | 'WRONG_TYPE' | 'TOO_LONG';

/** One element of the round, as validation reads it. */
export interface ValidationElement {
    elementId: string;
    /** Every key of the element's template. */
    fieldKeys: ReadonlySet<string>;
    /** Stored values as text (a list joined, a scale as its number), by key. */
    storedText: ReadonlyMap<string, string>;
}

export interface ValidationContext {
    detail: number;
    offerRecommended: boolean;
    elements: ReadonlyMap<string, ValidationElement>;
    /** Each FRONTIER target of the round and the persona it is assigned to (null: the session has none). */
    assignments: ReadonlyMap<string, string | null>;
    /** The round's one challengeable field and its persona, or null. */
    challenge: (FieldRef & { personaKey: string | null }) | null;
    /** This session's answered answers, as text, by answer id (what a recommendation may cite). */
    answerText: ReadonlyMap<string, string>;
}

export type Verdict =
    | { ok: true; candidate: Candidate; stripped: RecommendationStrip | null }
    | { ok: false; reason: DropReason };

/** Options that stand for "anything else": the interface always offers a free reply instead (content formats 1.7). */
const CATCH_ALL = /^(other|others|something else|anything else|none|none of these|none of the above|all|all of these|all of the above|not sure|i don'?t know|it depends)\b/;

export function isCatchAllOption(option: string): boolean {
    return CATCH_ALL.test(normaliseText(option).replace(/[.!?]+$/, ''));
}

function optionsProblem(c: Candidate): boolean {
    const options = c.options ?? [];
    if (c.kind === 'CHOICE' && (options.length < 3 || options.length > 5)) return true;
    if (c.kind === 'EITHER_OR' && options.length !== 2) return true;
    if ((c.kind === 'OPEN' || c.kind === 'SCENARIO' || c.kind === 'SCALE') && c.options !== null) return true;
    if (c.kind === 'SCALE' && c.scaleLabels === null) return true;
    if (c.kind !== 'SCALE' && c.scaleLabels !== null) return true;
    if (options.some((o) => o.trim().length === 0 || o.length > OPTION_MAX || isCatchAllOption(o))) return true;
    if (new Set(options.map(normaliseText)).size !== options.length) return true;
    if (c.scaleLabels && (c.scaleLabels.low.length > SCALE_LABEL_MAX || c.scaleLabels.high.length > SCALE_LABEL_MAX)) return true;
    return false;
}

/** Is `quote` a run of at least four whole words of `stored` (after normalisation on both sides)? */
export function isVerbatimQuote(quote: string, stored: string): boolean {
    const q = words(normaliseText(quote));
    const s = words(normaliseText(stored));
    if (q.length < CHALLENGE_QUOTE_MIN_WORDS) return false;
    for (let i = 0; i + q.length <= s.length; i++) {
        if (q.every((w, j) => s[i + j] === w)) return true;
    }
    return false;
}

function targetsProblem(c: Candidate, ctx: ValidationContext): DropReason | null {
    const element = ctx.elements.get(c.elementId);
    if (!element) return 'UNKNOWN_ELEMENT';
    if (c.targetsFieldKeys.length === 0) return 'UNKNOWN_FIELD';
    if (c.targetsFieldKeys.some((k) => !element.fieldKeys.has(k))) return 'UNKNOWN_FIELD';
    if (new Set(c.targetsFieldKeys).size !== c.targetsFieldKeys.length) return 'REPEATED_TARGET';
    if (c.mode === 'CHALLENGE') {
        const ch = ctx.challenge;
        if (!ch || c.targetsFieldKeys.length !== 1 || ch.elementId !== c.elementId || ch.fieldKey !== c.targetsFieldKeys[0]) return 'NOT_ASSIGNED';
        if (ch.personaKey !== c.personaKey) return 'NOT_ASSIGNED';
        const stored = element.storedText.get(ch.fieldKey);
        if (!stored || !c.challengeQuote || !isVerbatimQuote(c.challengeQuote, stored)) return 'BAD_CHALLENGE';
        if (!normaliseText(c.text).includes(normaliseText(c.challengeQuote))) return 'BAD_CHALLENGE';
        return null;
    }
    if (c.challengeQuote !== null) return 'BAD_CHALLENGE';
    if (c.targetsFieldKeys.length > 1 && ctx.detail < PAIR_TARGETS_FROM_DETAIL) return 'TOO_MANY_TARGETS';
    for (const key of c.targetsFieldKeys) {
        const ref = refKey({ elementId: c.elementId, fieldKey: key });
        if (!ctx.assignments.has(ref) || ctx.assignments.get(ref) !== c.personaKey) return 'NOT_ASSIGNED';
    }
    return null;
}

/** The question-text rules (non-empty, bounded, one question mark, at the end), for any text code or model wrote. */
export function questionTextProblem(text: string): DropReason | null {
    return textProblem({ text } as Candidate);
}

/** The option rules for a CHOICE / EITHER_OR question's options (code's own as well as the model's). */
export function questionOptionsProblem(kind: QuestionKind, options: string[] | null): boolean {
    return optionsProblem({ kind, options, scaleLabels: null } as Candidate);
}

function textProblem(c: Candidate): DropReason | null {
    const text = c.text.trim();
    if (text.length === 0) return 'EMPTY_TEXT';
    if (text.length > QUESTION_TEXT_MAX) return 'TEXT_TOO_LONG';
    if (!text.endsWith('?') || (text.match(/\?/g) ?? []).length !== 1) return 'COMPOUND_QUESTION';
    return null;
}

function recommendationProblem(c: Candidate, ctx: ValidationContext): RecommendationStrip | null {
    if (c.recommendedAnswer === null) return null;
    if (!ctx.offerRecommended) return 'TOGGLE_OFF';
    const element = ctx.elements.get(c.elementId)!;
    const basis = c.recommendationBasis ?? { fieldKeys: [], answerIds: [] };
    if (basis.fieldKeys.some((k) => !element.storedText.has(k)) || basis.answerIds.some((id) => !ctx.answerText.has(id))) return 'BASIS_UNKNOWN';
    const rec = c.recommendedAnswer;
    switch (c.kind) {
        case 'CHOICE':
        case 'EITHER_OR':
            if (typeof rec !== 'string') return 'WRONG_TYPE';
            return (c.options ?? []).includes(rec) ? null : 'NOT_AN_OPTION';
        case 'SCALE':
            return typeof rec === 'number' && Number.isInteger(rec) && rec >= 1 && rec <= 5 ? null : 'NOT_A_SCALE_VALUE';
        case 'OPEN':
        case 'SCENARIO': {
            if (typeof rec !== 'string') return 'WRONG_TYPE';
            // Taking it must be an answer the session accepts (`answerTextMax`): one click cannot store more than typing could.
            if (rec.length > Math.min(RECOMMENDATION_TEXT_MAX, answerTextMax(ctx.detail))) return 'TOO_LONG';
            const sources = [...basis.fieldKeys.map((k) => element.storedText.get(k)!), ...basis.answerIds.map((id) => ctx.answerText.get(id)!)];
            return sources.length > 0 && grounded(rec, sources) ? null : 'UNGROUNDED';
        }
    }
}

/** Hold one candidate to the rules (module header). Pure. */
export function validateCandidate(candidate: Candidate, ctx: ValidationContext): Verdict {
    const c: Candidate = {
        ...candidate,
        text: candidate.text.trim(),
        // A basis exists only for a recommendation, and is checked with it: a
        // basis left without one would store model-chosen strings, unchecked and
        // in a column that is not encrypted.
        recommendationBasis: candidate.recommendedAnswer === null ? null : candidate.recommendationBasis,
        // The rationale is held to its bound (dropped beyond it, the question kept).
        rationale: candidate.rationale !== null && candidate.rationale.length > RATIONALE_MAX ? null : candidate.rationale,
    };
    const target = targetsProblem(c, ctx);
    if (target) return { ok: false, reason: target };
    if (!kindsAllowed(ctx.detail).includes(c.kind)) return { ok: false, reason: 'KIND_NOT_ALLOWED' };
    if (optionsProblem(c)) return { ok: false, reason: 'MALFORMED_OPTIONS' };
    const text = textProblem(c);
    if (text) return { ok: false, reason: text };
    const strip = recommendationProblem(c, ctx);
    if (strip) return { ok: true, candidate: { ...c, recommendedAnswer: null, recommendationBasis: null }, stripped: strip };
    return { ok: true, candidate: c, stripped: null };
}
