/**
 * THE RECONCILE STEP (Phase 2.5), pure over its inputs: one round's answers
 * and scope in, validated proposals out. Run by the usecase
 * (`src/app-layer/usecases/enrichment-reconcile.ts`) AND by the evaluation
 * (`./evals/`), so the evaluation measures exactly what the product does.
 *
 *   1. nothing ANSWERED in the round (or nothing left in scope): no call,
 *      outcome NOTHING_TO_RECONCILE — the run says so, nothing is proposed;
 *   2. build the request (`buildReconcileRequest`): the template, the data;
 *   3. one call through the `Reconciler` — a failure is a named outcome and
 *      proposes nothing;
 *   4. read the answer item by item (`parseReconcileOutput`) and hold every
 *      item to the rules (`validateReconcile`): what passes may be stored,
 *      what fails is counted by code.
 *
 * The metrics are counts and codes: never a value, a name or an answer.
 */
import type { FieldDef } from '@/lib/bible/template-schema';
import type { FieldValue } from '@/lib/bible/field-values';
import type { BibleKind } from '@/lib/bible/kinds';
import { getFieldDef, getTemplate } from '@/lib/bible/templates';
import { buildReconcileRequest, storedForPrompt, type ReconcilePromptAnswer, type ReconcileRequest } from './prompt';
import type { ReconcileCallResult, Reconciler } from './reconciler';
import { parseReconcileOutput } from './schema';
import { refusalCounts, validateReconcile, valueAsText, type ReconcileAnswerFact, type ValidationResult } from './validate';
import type { ReconcileOutcome, RefusalCode } from './vocabulary';

export interface RoundElementInput {
    elementId: string;
    kind: BibleKind;
    name: string;
    customLabel: string | null;
    /** Every stored field value, decoded. */
    stored: ReadonlyMap<string, FieldValue>;
    /** The fields the round's questions targeted on this element, in template order. */
    scopeKeys: readonly string[];
}

export interface RoundAnswerInput {
    answerId: string;
    elementId: string;
    targetsFieldKeys: readonly string[];
    questionKind: string;
    question: string;
    options: readonly string[] | null;
    scaleLabels: { low: string; high: string } | null;
    status: 'ANSWERED' | 'SKIPPED' | 'DECIDE_LATER';
    text: string | null;
    choice: string | null;
    scale: number | null;
}

export interface ReconcileRoundInput {
    bookId: string | null;
    elements: readonly RoundElementInput[];
    /** The round's answers, the latest revision of each question's. */
    answers: readonly RoundAnswerInput[];
    /** The book's elements by kind and name (new elements are judged against them). */
    bookElements: ReadonlyArray<{ kind: BibleKind; name: string }>;
}

/** An answer as text: the choice, the number and the words, joined; null unless ANSWERED. */
export function answerAsText(a: Pick<RoundAnswerInput, 'status' | 'text' | 'choice' | 'scale'>): string | null {
    if (a.status !== 'ANSWERED') return null;
    const parts = [a.choice, a.scale === null ? null : String(a.scale), a.text].filter((p): p is string => p !== null && p !== '');
    return parts.length > 0 ? parts.join(' — ') : null;
}

/** The reply as the request shows it. */
function promptAnswerOf(a: RoundAnswerInput): ReconcilePromptAnswer {
    let answer: string | number | null = null;
    if (a.status === 'ANSWERED') {
        if (a.questionKind === 'SCALE' && a.scale !== null && !a.text) answer = a.scale;
        else answer = answerAsText(a);
    }
    return {
        answerId: a.answerId,
        elementId: a.elementId,
        targetsFieldKeys: a.targetsFieldKeys,
        questionKind: a.questionKind,
        question: a.question,
        options: a.options,
        scaleLabels: a.scaleLabels,
        status: a.status,
        answer,
    };
}

function scopeFieldsOf(e: RoundElementInput): FieldDef[] {
    return getTemplate(e.kind).fields.filter((f) => e.scopeKeys.includes(f.key));
}

/** The request one round's reconcile call sends. Pure. */
export function reconcileRequestFor(input: ReconcileRoundInput): ReconcileRequest {
    return buildReconcileRequest({
        bookId: input.bookId,
        elements: input.elements.map((e) => {
            const scopeFields = scopeFieldsOf(e);
            return {
                elementId: e.elementId,
                kind: e.kind,
                name: e.name,
                customLabel: e.customLabel,
                scopeFields,
                stored: new Map(scopeFields.map((f) => [f.key, storedForPrompt(f, e.stored.get(f.key) ?? null, valueAsText)])),
            };
        }),
        answers: input.answers.map(promptAnswerOf),
        bookElements: input.bookElements,
    });
}

/** The answers as the validator reads them. */
export function answerFactsOf(input: ReconcileRoundInput): ReconcileAnswerFact[] {
    return input.answers.map((a) => ({
        answerId: a.answerId,
        status: a.status,
        text: answerAsText(a),
        scale: a.status === 'ANSWERED' ? a.scale : null,
        about: { elementId: a.elementId, fieldKeys: a.targetsFieldKeys },
    }));
}

/** Validate a raw output against the round. Pure: the evaluation replays recorded outputs through it. */
export function validateOutput(raw: unknown, input: ReconcileRoundInput): ValidationResult & { unreadable: boolean } {
    const parsed = parseReconcileOutput(raw);
    const result = validateReconcile(parsed, {
        elements: input.elements.map((e) => ({ elementId: e.elementId, kind: e.kind, stored: e.stored, scopeKeys: e.scopeKeys.filter((k) => getFieldDef(e.kind, k)) })),
        answers: answerFactsOf(input),
        bookElementNames: input.bookElements.map((b) => b.name),
    });
    return { ...result, unreadable: parsed.unreadable };
}

export interface ReconcileMetrics {
    outcome: ReconcileOutcome;
    /** 2.1's error code, for a failed call. */
    errorCode: string | null;
    scopeFields: number;
    answered: number;
    /** Operations stored, by kind. */
    proposed: { ADD: number; UPDATE: number; REMOVE: number; NEW_ELEMENT: number };
    /** Of those, flagged POSSIBLE_INSTRUCTION (D14). */
    flagged: number;
    noChange: number;
    refused: Partial<Record<RefusalCode, number>>;
    /** The output was not readable at all (every item lost). */
    unreadable: boolean;
    tokensUsed: number;
    costMicroUsd: number;
    aiCallId: string | null;
    reviewRequired: boolean;
    guardRuleIds: string[];
}

export interface ReconcileStepResult {
    outcome: ReconcileOutcome;
    validation: ValidationResult | null;
    call: ReconcileCallResult | null;
    metrics: ReconcileMetrics;
}

function metricsOf(input: ReconcileRoundInput, outcome: ReconcileOutcome, call: ReconcileCallResult | null, validation: (ValidationResult & { unreadable?: boolean }) | null): ReconcileMetrics {
    const proposed = { ADD: 0, UPDATE: 0, REMOVE: 0, NEW_ELEMENT: 0 };
    for (const p of validation?.proposals ?? []) {
        if (p.kind === 'NEW_ELEMENT') proposed.NEW_ELEMENT++;
        else proposed[p.operation]++;
    }
    return {
        outcome,
        errorCode: call?.failure?.errorCode ?? null,
        scopeFields: input.elements.reduce((n, e) => n + e.scopeKeys.length, 0),
        answered: input.answers.filter((a) => a.status === 'ANSWERED').length,
        proposed,
        flagged: (validation?.proposals ?? []).filter((p) => p.flags.length > 0).length,
        noChange: validation?.noChange ?? 0,
        refused: validation ? refusalCounts(validation.refusals) : {},
        unreadable: validation?.unreadable ?? false,
        tokensUsed: call?.tokensUsed ?? 0,
        costMicroUsd: call?.costMicroUsd ?? 0,
        aiCallId: call?.callId ?? null,
        reviewRequired: call?.reviewRequired ?? false,
        guardRuleIds: [...(call?.guardRuleIds ?? [])],
    };
}

/** The whole step over one round (the order in the header). */
export async function runReconcileStep(input: ReconcileRoundInput, reconciler: Reconciler, signal?: AbortSignal): Promise<ReconcileStepResult> {
    const inScope = input.elements.some((e) => e.scopeKeys.length > 0);
    if (!inScope || !input.answers.some((a) => a.status === 'ANSWERED')) {
        return { outcome: 'NOTHING_TO_RECONCILE', validation: null, call: null, metrics: metricsOf(input, 'NOTHING_TO_RECONCILE', null, null) };
    }
    const call = await reconciler.reconcile(reconcileRequestFor(input), signal);
    if (call.failure || call.output === null || call.output === undefined) {
        const outcome = call.failure?.outcome ?? 'INVALID_OUTPUT';
        return { outcome, validation: null, call, metrics: metricsOf(input, outcome, call, null) };
    }
    const validation = validateOutput(call.output, input);
    return { outcome: 'OK', validation, call, metrics: metricsOf(input, 'OK', call, validation) };
}
