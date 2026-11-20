/**
 * PRODUCING A ROUND — the model step and everything code does around it
 * (Phase 2.2; design 4.1, 4.3, 4.4, 7).
 *
 *   1. one generation call per persona with a share of the plan (the model
 *      WORDS questions; `generator`)
 *   2. the output re-parsed item by item, each candidate sanitised, then
 *      validated in code (`validateCandidate`)
 *   3. survivors embedded (`embed`, the 2.0 provider) and their neighbours
 *      among the book's asked questions found (`findNeighbours`, the 2.0
 *      vector store), when the caller supplies them
 *   4. deduplicated in code against the session, the book and each other
 *      (`dedupe`), first in frontier order winning
 *   5. every target left with no question given its craft pack's first
 *      fitting example (`fillGapsFromPack`), itself deduplicated; a target
 *      nothing fits is carried to the next round and recorded
 *   6. ordered (`orderRound`) and numbered from 1
 *
 * No database: the caller loads the state, supplies the I/O (generator,
 * embedder, neighbour search), and persists what comes back. The usecase
 * (`src/app-layer/usecases/interview-rounds.ts`) and the coverage evaluation
 * (`src/lib/interview/evals/coverage.ts`) run this same function, so the
 * evaluation measures the engine the product runs.
 */
import type { FieldDef } from '@/lib/bible/template-schema';
import type { BibleKind } from '@/lib/bible/kinds';
import {
    DROP_REASONS,
    candidateFrom,
    parseGeneratedQuestions,
    validateCandidate,
    type Candidate,
    type DropReason,
    type RecommendationStrip,
    type ValidationContext,
    type ValidationElement,
} from './candidates';
import { kindsAllowed, type Dials } from './dials';
import { dedupe, dedupeTokens, exactKey, questionDedupeKey, type AskedQuestion, type DedupeTextContext, type DuplicateSignal, type EmbeddingNeighbour } from './dedupe';
import { refKey, type FieldRef } from './frontier';
import { GenerationStop, type GenerationFailureKind, type GenerationResult, type QuestionGenerator } from './generator';
import type { CraftPack, PackRegistry } from './packs';
import type { RoundPlan } from './plan';
import { buildGenerationRequest, QUESTION_PROMPT, type PromptAnswer, type PromptElement } from './prompt';
import { disclosesInstructions, promptRuns } from '@/lib/text/prompt-disclosure';
import { sanitiseQuestionForStorage } from './storage';
import type { PersonaKey, QuestionOrigin } from './vocabulary';

/** One element in the round's scope, with what the prompt and validation need. */
export interface RoundElement {
    elementId: string;
    kind: BibleKind;
    name: string;
    customLabel: string | null;
    fields: readonly FieldDef[];
    /** Stored values as text, filled fields only. */
    storedText: ReadonlyMap<string, string>;
}

export interface RoundInput {
    /** The book the generation calls are recorded against (`AiCallLog.bookId`); null in the evaluation. */
    bookId: string | null;
    dials: Dials;
    offerRecommended: boolean;
    preferChoice: boolean;
    personaKeys: readonly string[];
    plan: RoundPlan;
    elements: readonly RoundElement[];
    related: ReadonlyArray<{ kind: BibleKind; name: string; summary: string | null }>;
    /** This session's answers (latest revision each), for the prompt and for grounding recommendations. */
    sessionAnswers: readonly PromptAnswer[];
    /** What was asked already: this session's questions and earlier sessions' about the same elements. */
    asked: readonly AskedQuestion[];
    /** Exact-repeat keys (`exactKey`) already known to the caller; `findExactRepeats` adds the book's own. */
    askedKeys?: ReadonlySet<string>;
    packs: Pick<PackRegistry, 'craft' | 'personas'>;
}

export interface RoundDeps {
    generator: QuestionGenerator;
    /** Embed question texts; a degraded call returns nulls (deduplication then falls back to its lexical signals). */
    embed?: (texts: readonly string[]) => Promise<ReadonlyArray<readonly number[] | null>>;
    /** The book's asked questions nearest each vector, and the targets of any not in `asked`. */
    findNeighbours?: (vectors: ReadonlyMap<number, readonly number[]>) => Promise<{
        neighbours: ReadonlyMap<number, readonly EmbeddingNeighbour[]>;
        neighbourTargets: ReadonlyMap<string, { elementId: string; targetsFieldKeys: readonly string[] }>;
    }>;
    /**
     * Which of these (element, dedupe key) pairs a question of the book
     * already holds, as `exactKey`s: the index lookup that finds an exact
     * repeat beyond the bounded read of `asked`. Asked for the round's own
     * candidates and the pack examples that could fill its gaps.
     */
    findExactRepeats?: (probes: ReadonlyArray<{ elementId: string; dedupeKey: string }>) => Promise<ReadonlySet<string>>;
    /**
     * Watches the round as it is produced (Phase 2.4: the stream the author
     * sees). It is told, and never asked: what it does cannot change the round,
     * and a throw from it is swallowed.
     */
    observer?: RoundObserver;
    /**
     * The caller gave up (the author closed the stream, Phase 2.4): the call
     * in flight is aborted, no further call is made, and the round is produced
     * from what it has (the caller then discards it: `aborted`).
     */
    signal?: AbortSignal;
}

/**
 * What the round tells its observer, in order: each generation call as it is
 * made, each call's candidates once they pass validation (a DRAFT: dedupe, the
 * pack fallback and the persist can still drop or renumber them), then that it
 * is checking. Nothing here is the round: the persisted round is.
 */
export interface RoundObserver {
    callStarted?(call: { index: number; total: number }): void;
    candidatesValidated?(candidates: readonly Candidate[], call: { index: number; total: number; reviewRequired: boolean }): void;
    checking?(): void;
}

function tell(fn: () => void): void {
    try {
        fn();
    } catch {
        // An observer cannot change the round, even by failing.
    }
}

export interface PlannedQuestion extends Candidate {
    origin: QuestionOrigin;
    /** 1..n within the round. */
    position: number;
    /** The guard flagged the call that worded it and let the call go on (2.1's "flag and fence"). */
    reviewRequired: boolean;
}

export interface RoundMetrics {
    generationCalls: number;
    generationFailures: number;
    unreadableOutputs: number;
    candidates: number;
    malformed: number;
    declined: number;
    dropped: Partial<Record<DropReason, number>>;
    /** The behaviour codes (content formats 1.11) the drops prevented, counted. */
    preventedBehaviours: Partial<Record<(typeof DROP_REASONS)[DropReason], number>>;
    duplicates: Partial<Record<DuplicateSignal, number>>;
    recommendationsStripped: Partial<Record<RecommendationStrip, number>>;
    accepted: number;
    packFallbacks: number;
    /** Targets nothing could be asked for: carried to the next round (`NO_QUESTION`). */
    noQuestion: FieldRef[];
    /** Questions the embedder gave no vector (stored without one; lexical deduplication only). */
    unembedded: number;
    /** Tokens the round's generation calls reported (charged to the session's token budget). */
    tokensUsed: number;
    /** Calls that failed, by kind (2.1's outcome, `GenerationFailureKind`): their fields went to the pack fallback. */
    failures: Partial<Record<GenerationFailureKind, number>>;
    /** Calls the guard flagged and let through ("flag and fence"); their questions are asked, never applied unseen. */
    guardFlaggedCalls: number;
    /** The guard rule ids that fired on the round's calls (codes, never text). */
    guardRuleIds: string[];
    /** The round's `AiCallLog` ids, in call order: where each call's tokens, cost and outcome are recorded. */
    aiCallIds: string[];
    /** What the round's calls cost, in micro-dollars (0 for a generator that reports none). */
    costMicroUsd: number;
    /** The dearest single call, in micro-dollars, and how many calls passed the template's cost budget (rule 9). */
    maxCallCostMicroUsd: number;
    callsOverBudget: number;
    /**
     * Every generation call, in order (rule 9, per call): the persona whose
     * share it worded, its prompt version (which names the packs it carried),
     * the packs behind that version, its cost budget and what it cost, and how
     * it ended. Names and numbers, never text.
     */
    calls: RoundCall[];
}

export interface RoundCall {
    personaKey: string | null;
    promptVersion: string;
    /** The packs in the call's system prompt, `name@version`. */
    packs: string[];
    costBudgetMicroUsd: number | null;
    costMicroUsd: number;
    callId: string | null;
    outcome: 'OK' | GenerationFailureKind | 'THREW' | 'STOPPED';
}

/** One call's reported tokens are clamped to this, so a bad report cannot overflow the session's counter. */
export const TOKENS_PER_CALL_REPORT_MAX = 1_000_000;

function reportedTokens(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), TOKENS_PER_CALL_REPORT_MAX) : 0;
}

/** The engine instructions' word runs (the static part of every round's system prompt). */
const QUESTION_RUNS = promptRuns([QUESTION_PROMPT]);

/**
 * Does a validated candidate recite the engine's instructions, or its fence's
 * tag, in anything the author would see (Phase 2.H, "no system-prompt
 * disclosure")? Such a candidate is dropped `DISCLOSES_INSTRUCTIONS`.
 */
function disclosesCandidate(c: Candidate): boolean {
    const recommendation = typeof c.recommendedAnswer === 'string' ? c.recommendedAnswer : null;
    return disclosesInstructions([c.text, ...(c.options ?? []), c.rationale, recommendation, c.scaleLabels?.low, c.scaleLabels?.high], QUESTION_RUNS);
}

/** Fold one call's record (id, cost, guard verdict) into the round's metrics. */
function recordCall(metrics: RoundMetrics, result: Partial<GenerationResult> | null, costBudget: number | null): void {
    if (!result) return;
    if (typeof result.callId === 'string') metrics.aiCallIds.push(result.callId);
    const cost = typeof result.costMicroUsd === 'number' && Number.isFinite(result.costMicroUsd) && result.costMicroUsd > 0 ? Math.floor(result.costMicroUsd) : 0;
    metrics.costMicroUsd += cost;
    metrics.maxCallCostMicroUsd = Math.max(metrics.maxCallCostMicroUsd, cost);
    if (costBudget !== null && cost > costBudget) metrics.callsOverBudget++;
    if (result.reviewRequired) metrics.guardFlaggedCalls++;
    for (const id of result.guardRuleIds ?? []) if (!metrics.guardRuleIds.includes(id)) metrics.guardRuleIds.push(id);
}

export interface RoundOutput {
    questions: PlannedQuestion[];
    /** Position → the question's vector, where the embedder produced one. */
    vectors: Map<number, readonly number[]>;
    metrics: RoundMetrics;
}

function bump<K extends string>(bag: Partial<Record<K, number>>, key: K): void {
    bag[key] = (bag[key] ?? 0) + 1;
}

/** The craft pack's first example for exactly this field, of a kind the dial allows, that repeats nothing. */
export function fillGapsFromPack(
    gaps: readonly FieldRef[],
    elements: ReadonlyMap<string, RoundElement>,
    craft: Readonly<Record<BibleKind, CraftPack>>,
    detail: number,
    isDuplicate: (q: Candidate, filledSoFar: readonly Candidate[]) => boolean,
): { filled: Candidate[]; noQuestion: FieldRef[] } {
    const filled: Candidate[] = [];
    const noQuestion: FieldRef[] = [];
    const allowed = kindsAllowed(detail);
    for (const gap of gaps) {
        const element = elements.get(gap.elementId);
        const pack = element ? craft[element.kind] : undefined;
        const example = pack?.examples.find((e) => {
            if (e.keys.length !== 1 || e.keys[0] !== gap.fieldKey || !allowed.includes(e.kind)) return false;
            return !isDuplicate(asCandidate(gap, e), filled);
        });
        if (example) filled.push(asCandidate(gap, example));
        else noQuestion.push(gap);
    }
    return { filled, noQuestion };
}

function asCandidate(gap: FieldRef, e: CraftPack['examples'][number]): Candidate {
    return {
        elementId: gap.elementId,
        targetsFieldKeys: [gap.fieldKey],
        mode: 'FRONTIER',
        kind: e.kind,
        text: e.text,
        options: e.options ? [...e.options] : null,
        scaleLabels: e.scaleLabels ? { ...e.scaleLabels } : null,
        challengeQuote: null,
        recommendedAnswer: null,
        recommendationBasis: null,
        rationale: null,
        personaKey: null,
    };
}

/**
 * The personas that ask for a round to lead with picks and scales before open
 * questions, within the detail dial (design 4.4; the Gentle Mentor's "from the
 * most approachable question to the most demanding").
 */
export const PICKS_FIRST_PERSONAS: ReadonlySet<string> = new Set(['gentle-mentor']);

/** The picks-first order of kinds (design 4.4). */
const PICKS_FIRST_KIND_RANK: Readonly<Record<Candidate['kind'], number>> = { SCALE: 0, EITHER_OR: 1, CHOICE: 2, OPEN: 3, SCENARIO: 4 };

/** Does every persona of the session ask for picks first? (None: no.) */
export function picksFirst(personaKeys: readonly string[]): boolean {
    return personaKeys.length > 0 && personaKeys.every((p) => PICKS_FIRST_PERSONAS.has(p));
}

/**
 * Frontier position of the first target, challenges last; stable otherwise
 * (design 4.4). With `picksFirst` (every persona of the session asks for it),
 * the questions about ONE element are reordered among themselves by kind —
 * scale, either-or, choice, open, scenario — keeping the places the element's
 * questions held, so elements keep their frontier order. Every question of a
 * round is on the frontier, so no order breaks a prerequisite.
 */
export function orderRound<C extends Candidate>(questions: readonly C[], plan: RoundPlan, options: { picksFirst?: boolean } = {}): C[] {
    const position = new Map(plan.targets.map((t, i) => [refKey(t), i] as const));
    const rank = (q: C) =>
        q.mode === 'CHALLENGE' ? Number.MAX_SAFE_INTEGER : Math.min(...q.targetsFieldKeys.map((k) => position.get(refKey({ elementId: q.elementId, fieldKey: k })) ?? Number.MAX_SAFE_INTEGER - 1));
    const ordered = questions
        .map((q, i) => ({ q, i, r: rank(q) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.q);
    if (!options.picksFirst) return ordered;
    const out = [...ordered];
    const byElement = new Map<string, number[]>();
    ordered.forEach((q, i) => {
        if (q.mode === 'CHALLENGE') return;
        byElement.set(q.elementId, [...(byElement.get(q.elementId) ?? []), i]);
    });
    for (const slots of byElement.values()) {
        const sorted = slots.map((i) => ordered[i]).sort((a, b) => PICKS_FIRST_KIND_RANK[a.kind] - PICKS_FIRST_KIND_RANK[b.kind]);
        slots.forEach((slot, j) => (out[slot] = sorted[j]));
    }
    return out;
}

export async function produceRound(input: RoundInput, deps: RoundDeps): Promise<RoundOutput> {
    const metrics: RoundMetrics = {
        generationCalls: 0,
        generationFailures: 0,
        unreadableOutputs: 0,
        candidates: 0,
        malformed: 0,
        declined: 0,
        dropped: {},
        preventedBehaviours: {},
        duplicates: {},
        recommendationsStripped: {},
        accepted: 0,
        packFallbacks: 0,
        noQuestion: [],
        unembedded: 0,
        tokensUsed: 0,
        failures: {},
        guardFlaggedCalls: 0,
        guardRuleIds: [],
        aiCallIds: [],
        costMicroUsd: 0,
        maxCallCostMicroUsd: 0,
        callsOverBudget: 0,
        calls: [],
    };
    const elements = new Map(input.elements.map((e) => [e.elementId, e] as const));
    const validationElements = new Map<string, ValidationElement>(
        input.elements.map((e) => [e.elementId, { elementId: e.elementId, fieldKeys: new Set(e.fields.map((f) => f.key)), storedText: e.storedText }]),
    );
    const assignments = new Map(input.plan.targets.map((t) => [refKey(t), t.personaKey] as const));
    const vctx: ValidationContext = {
        detail: input.dials.detail,
        offerRecommended: input.offerRecommended,
        elements: validationElements,
        assignments,
        challenge: input.plan.challenge,
        answerText: new Map(input.sessionAnswers.filter((a) => a.status === 'ANSWERED' && a.answer !== null).map((a) => [a.answerId, a.answer as string])),
    };

    // 1–2. One call per persona that holds a share of the plan.
    const shares = input.personaKeys.length === 0 ? [null] : [...input.personaKeys];
    const validated: Candidate[] = [];
    // Candidates worded by a call the guard flagged (2.1: the call went on, fenced).
    const flagged = new Set<Candidate>();
    const working = shares.filter((personaKey) => input.plan.targets.some((t) => t.personaKey === personaKey) || input.plan.challenge?.personaKey === personaKey);
    for (const personaKey of shares) {
        const mine = input.plan.targets.filter((t) => t.personaKey === personaKey);
        const challenge = input.plan.challenge && input.plan.challenge.personaKey === personaKey ? input.plan.challenge : null;
        if (mine.length === 0 && !challenge) continue;
        // The caller gave up: no further call is made.
        if (deps.signal?.aborted) break;
        const progress = { index: working.indexOf(personaKey) + 1, total: working.length };
        tell(() => deps.observer?.callStarted?.(progress));
        const inPlay = input.elements.filter((e) => mine.some((t) => t.elementId === e.elementId) || challenge?.elementId === e.elementId);
        const promptElements: PromptElement[] = inPlay.map((e) => ({
            elementId: e.elementId,
            kind: e.kind,
            name: e.name,
            customLabel: e.customLabel,
            fields: e.fields,
            stored: [...e.storedText].map(([key, value]) => ({ key, value })),
            assignedKeys: mine.filter((t) => t.elementId === e.elementId).map((t) => t.fieldKey),
            challengeKey: challenge?.elementId === e.elementId ? challenge.fieldKey : null,
        }));
        const kinds = [...new Set(inPlay.map((e) => e.kind))];
        const request = buildGenerationRequest({
            bookId: input.bookId,
            dials: input.dials,
            offerRecommended: input.offerRecommended,
            preferChoice: input.preferChoice,
            personaKey,
            persona: personaKey ? input.packs.personas[personaKey as PersonaKey] ?? null : null,
            craftPacks: kinds.map((k) => input.packs.craft[k]),
            elements: promptElements,
            related: input.related,
            sessionAnswers: input.sessionAnswers,
        });
        metrics.generationCalls++;
        const call: RoundCall = {
            personaKey,
            promptVersion: request.template.version,
            packs: [...kinds.map((k) => input.packs.craft[k]), ...(personaKey && input.packs.personas[personaKey as PersonaKey] ? [input.packs.personas[personaKey as PersonaKey]] : [])].map(
                (p) => `${p.name}@${p.version}`,
            ),
            costBudgetMicroUsd: request.template.costBudgetMicroUsd ?? null,
            costMicroUsd: 0,
            callId: null,
            outcome: 'OK',
        };
        metrics.calls.push(call);
        let raw: unknown;
        let callFlagged = false;
        try {
            const result = (await deps.generator.generateCandidates(request, deps.signal)) as Partial<GenerationResult> | null;
            callFlagged = result?.reviewRequired === true;
            metrics.tokensUsed += reportedTokens(result?.tokensUsed);
            recordCall(metrics, result, request.template.costBudgetMicroUsd ?? null);
            call.callId = typeof result?.callId === 'string' ? result.callId : null;
            call.costMicroUsd = typeof result?.costMicroUsd === 'number' && Number.isFinite(result.costMicroUsd) && result.costMicroUsd > 0 ? Math.floor(result.costMicroUsd) : 0;
            if (result?.failure) {
                // One call failed (2.1's outcome named): its persona's fields go
                // to the pack fallback; nothing it said is used.
                metrics.generationFailures++;
                bump(metrics.failures, result.failure.kind);
                call.outcome = result.failure.kind;
                continue;
            }
            raw = result?.output;
        } catch (err) {
            // The session must stop (kill switch, ceiling, no configuration):
            // the round is abandoned, carrying what it has spent so far.
            if (err instanceof GenerationStop) {
                call.outcome = 'STOPPED';
                throw err.withTokens(metrics.tokensUsed);
            }
            // Any other throw: a failed call, costing only its persona's share
            // (those fields go to the pack fallback).
            metrics.generationFailures++;
            call.outcome = 'THREW';
            continue;
        }
        const parsed = parseGeneratedQuestions(raw);
        if (parsed.unreadable) metrics.unreadableOutputs++;
        metrics.malformed += parsed.malformed;
        metrics.declined += parsed.declined.length;
        const fromThisCall: Candidate[] = [];
        for (const q of parsed.questions) {
            metrics.candidates++;
            const verdict = validateCandidate(sanitiseQuestionForStorage(candidateFrom(q, personaKey)), vctx);
            if (!verdict.ok) {
                bump(metrics.dropped, verdict.reason);
                bump(metrics.preventedBehaviours, DROP_REASONS[verdict.reason]);
                continue;
            }
            if (disclosesCandidate(verdict.candidate)) {
                bump(metrics.dropped, 'DISCLOSES_INSTRUCTIONS');
                bump(metrics.preventedBehaviours, DROP_REASONS.DISCLOSES_INSTRUCTIONS);
                continue;
            }
            if (verdict.stripped) bump(metrics.recommendationsStripped, verdict.stripped);
            validated.push(verdict.candidate);
            fromThisCall.push(verdict.candidate);
            if (callFlagged) flagged.add(verdict.candidate);
        }
        if (fromThisCall.length > 0) tell(() => deps.observer?.candidatesValidated?.(fromThisCall, { ...progress, reviewRequired: callFlagged }));
    }
    tell(() => deps.observer?.checking?.());
    for (let i = 0; i < metrics.malformed; i++) bump(metrics.preventedBehaviours, DROP_REASONS.MALFORMED_ITEM);

    // 3–4. Deduplicate, frontier order first.
    const ordered = orderRound(validated, input.plan);
    const textCtx: DedupeTextContext = { elementNames: new Map(input.elements.map((e) => [e.elementId, e.name])) };
    const candidateVectors = new Map<number, readonly number[]>();
    if (deps.embed && ordered.length > 0) {
        const vectors = await deps.embed(ordered.map((c) => c.text));
        vectors.forEach((v, i) => v && candidateVectors.set(i, v));
    }
    const found = deps.findNeighbours && candidateVectors.size > 0 ? await deps.findNeighbours(candidateVectors) : undefined;
    // The book's index, asked for exactly the questions this round might ask:
    // its candidates and the pack examples that could fill a gap.
    const askedKeys = new Set(input.askedKeys ?? []);
    if (deps.findExactRepeats) {
        const fallbackProbes = input.plan.targets.flatMap((t) => {
            const element = elements.get(t.elementId);
            const pack = element ? input.packs.craft[element.kind] : undefined;
            const allowed = kindsAllowed(input.dials.detail);
            return (pack?.examples ?? []).filter((e) => e.keys.length === 1 && e.keys[0] === t.fieldKey && allowed.includes(e.kind)).map((e) => asCandidate(t, e));
        });
        const probes = [...ordered, ...fallbackProbes].map((c) => ({ elementId: c.elementId, dedupeKey: questionDedupeKey(dedupeTokens(c, textCtx)) }));
        const unique = [...new Map(probes.map((p) => [exactKey(p.elementId, p.dedupeKey), p])).values()];
        if (unique.length > 0) for (const k of await deps.findExactRepeats(unique)) askedKeys.add(k);
    }
    const deduped = dedupe({
        candidates: ordered,
        asked: input.asked,
        ctx: textCtx,
        neighbours: found?.neighbours,
        neighbourTargets: found?.neighbourTargets,
        askedKeys,
        vectors: candidateVectors,
    });
    for (const d of deduped.dropped) {
        bump(metrics.dropped, 'DUPLICATE');
        bump(metrics.preventedBehaviours, DROP_REASONS.DUPLICATE);
        bump(metrics.duplicates, d.signal);
    }
    // One question per field per round (design 4.2: each field is asked once a
    // round): a later question on a field an earlier one already asks is
    // dropped, so a round never holds more questions than its cap (and its one
    // challenge), however many the model words.
    const askedThisRound = new Set<string>();
    const keptIndexes: number[] = [];
    for (const i of deduped.keptIndexes) {
        const c = ordered[i];
        const refs = c.targetsFieldKeys.map((k) => `${c.mode}\u0000${refKey({ elementId: c.elementId, fieldKey: k })}`);
        if (refs.some((r) => askedThisRound.has(r))) {
            bump(metrics.dropped, 'TARGET_ALREADY_ASKED');
            bump(metrics.preventedBehaviours, DROP_REASONS.TARGET_ALREADY_ASKED);
            continue;
        }
        refs.forEach((r) => askedThisRound.add(r));
        keptIndexes.push(i);
    }
    const kept = keptIndexes.map((i) => ordered[i]);
    metrics.accepted = kept.length;

    // 5. Pack fallback for every target nothing kept covers.
    const covered = new Set(kept.flatMap((c) => c.targetsFieldKeys.map((k) => refKey({ elementId: c.elementId, fieldKey: k }))));
    const gaps = input.plan.targets.filter((t) => !covered.has(refKey(t)));
    const { filled, noQuestion } = fillGapsFromPack(gaps, elements, input.packs.craft, input.dials.detail, (q, filledSoFar) => {
        const before = [...kept, ...filledSoFar];
        const check = dedupe({ candidates: [...before, q], asked: input.asked, ctx: textCtx, askedKeys });
        return !check.keptIndexes.includes(before.length);
    });
    metrics.packFallbacks = filled.length;
    metrics.noQuestion = noQuestion.map((r) => ({ elementId: r.elementId, fieldKey: r.fieldKey }));

    // 6. Order and number; carry every vector across.
    const all = [...kept.map((c) => ({ c, origin: 'MODEL' as const })), ...filled.map((c) => ({ c, origin: 'PACK_FALLBACK' as const }))];
    const final = orderRound(
        all.map((x) => x.c),
        input.plan,
        { picksFirst: picksFirst(input.personaKeys) },
    );
    const vectorOf = new Map<Candidate, readonly number[]>();
    keptIndexes.forEach((i) => {
        const v = candidateVectors.get(i);
        if (v) vectorOf.set(ordered[i], v);
    });
    if (deps.embed && filled.length > 0) {
        const vectors = await deps.embed(filled.map((c) => c.text));
        vectors.forEach((v, i) => v && vectorOf.set(filled[i], v));
    }
    const originOf = new Map(all.map((x) => [x.c, x.origin] as const));
    const questions: PlannedQuestion[] = final.map((c, i) => ({ ...c, origin: originOf.get(c)!, position: i + 1, reviewRequired: flagged.has(c) }));
    const vectors = new Map<number, readonly number[]>();
    final.forEach((c, i) => {
        const v = vectorOf.get(c);
        if (v) vectors.set(i + 1, v);
        else metrics.unembedded++;
    });
    return { questions, vectors, metrics };
}
