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
import { getTemplate, relationFieldDefs, relationTypesFrom } from '@/lib/bible/templates';
import type { RelationSubject } from '@/lib/interview/subjects';
import { buildReconcileRequest, storedForPrompt, type ReconcilePromptAnswer, type ReconcileRequest } from './prompt';
import type { ReconcileCallResult, Reconciler } from './reconciler';
import { parseReconcileOutput } from './schema';
import { fieldDefOf, refusalCounts, validateReconcile, valueAsText, type ExistingRelation, type ReconcileAnswerFact, type RelationEnd, type ValidationResult } from './validate';
import type { ReconcileOutcome, RefusalCode } from './vocabulary';

export interface RoundElementInput {
    /** The subject's id (Phase 3.3): an element's, a relation's, or `PENDING_SUBJECT_ID`. */
    elementId: string;
    kind: BibleKind;
    name: string;
    customLabel: string | null;
    /** Every stored field value, decoded. */
    stored: ReadonlyMap<string, FieldValue>;
    /** The fields the round's questions targeted on this element, in template order. */
    scopeKeys: readonly string[];
    /** Phase 3.3: a relation subject. */
    relation?: RelationSubject;
    /** Phase 3.3: the BETWEEN slot's element not yet created, between two neighbours. */
    pending?: { afterName: string; beforeName: string };
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
    /** Phase 3.3: the elements a new relation may join, and the relations the book holds between them. */
    relationEnds?: readonly RelationEnd[];
    existingRelations?: readonly ExistingRelation[];
    /** Phase 3.3: a BETWEEN session's slot. */
    slot?: { kind: BibleKind } | null;
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
    const fields: readonly FieldDef[] = e.relation ? relationFieldDefs(e.relation.fromKind, e.relation.type) : getTemplate(e.kind).fields;
    return fields.filter((f) => e.scopeKeys.includes(f.key));
}

/** The relation types a new relation between the ends may take, by ordered pair of kinds (template product text). */
export function relationTypesBetween(kinds: readonly BibleKind[]): Array<{ fromKind: BibleKind; toKind: BibleKind; types: Array<{ type: string; label: string }> }> {
    const unique = [...new Set(kinds)];
    const out: Array<{ fromKind: BibleKind; toKind: BibleKind; types: Array<{ type: string; label: string }> }> = [];
    for (const from of unique) {
        for (const to of unique) {
            const types = relationTypesFrom(from)
                .filter((t) => t.targetKinds.includes(to))
                .map((t) => ({ type: t.key, label: t.label }));
            if (types.length > 0) out.push({ fromKind: from, toKind: to, types });
        }
    }
    return out;
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
                ...(e.relation ? { relation: e.relation } : {}),
                ...(e.pending ? { pending: e.pending } : {}),
            };
        }),
        answers: input.answers.map(promptAnswerOf),
        bookElements: input.bookElements,
        relationEnds: input.relationEnds ?? [],
        relationTypes: relationTypesBetween([...(input.relationEnds ?? []).map((e) => e.kind), ...(input.slot ? [input.slot.kind] : [])]),
        slot: input.slot ?? null,
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
        elements: input.elements.map((e) => {
            const relation = e.relation ? { type: e.relation.type, fromKind: e.relation.fromKind, fromElementId: e.relation.fromElementId, toElementId: e.relation.toElementId } : undefined;
            return {
                elementId: e.elementId,
                kind: e.kind,
                stored: e.stored,
                scopeKeys: e.scopeKeys.filter((k) => fieldDefOf({ kind: e.kind, relation }, k)),
                ...(relation ? { relation } : {}),
                ...(e.pending ? { pending: true } : {}),
            };
        }),
        answers: answerFactsOf(input),
        bookElementNames: input.bookElements.map((b) => b.name),
        relationEnds: input.relationEnds ?? [],
        existingRelations: input.existingRelations ?? [],
        slot: input.slot ?? null,
    });
    return { ...result, unreadable: parsed.unreadable };
}

export interface ReconcileMetrics {
    outcome: ReconcileOutcome;
    /** 2.1's error code, for a failed call. */
    errorCode: string | null;
    scopeFields: number;
    answered: number;
    /** Operations stored, by kind (a relation's field's among ADD, UPDATE and REMOVE; Phase 3.3 adds NEW_RELATION). */
    proposed: ProposedCounts;
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

export interface ProposedCounts {
    ADD: number;
    UPDATE: number;
    REMOVE: number;
    NEW_ELEMENT: number;
    NEW_RELATION: number;
}

export function emptyProposedCounts(): ProposedCounts {
    return { ADD: 0, UPDATE: 0, REMOVE: 0, NEW_ELEMENT: 0, NEW_RELATION: 0 };
}

export interface ReconcileStepResult {
    outcome: ReconcileOutcome;
    validation: ValidationResult | null;
    call: ReconcileCallResult | null;
    metrics: ReconcileMetrics;
}

function metricsOf(input: ReconcileRoundInput, outcome: ReconcileOutcome, call: ReconcileCallResult | null, validation: (ValidationResult & { unreadable?: boolean }) | null): ReconcileMetrics {
    const proposed = emptyProposedCounts();
    for (const p of validation?.proposals ?? []) {
        if (p.kind === 'NEW_ELEMENT' || p.kind === 'NEW_RELATION') proposed[p.kind]++;
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
