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
import type { QuestionGenerator } from './generator';
import type { CraftPack, PackRegistry } from './packs';
import type { RoundPlan } from './plan';
import { buildGenerationRequest, type PromptAnswer, type PromptElement } from './prompt';
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
    workspaceId: string;
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
}

export interface PlannedQuestion extends Candidate {
    origin: QuestionOrigin;
    /** 1..n within the round. */
    position: number;
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
}

/** One call's reported tokens are clamped to this, so a bad report cannot overflow the session's counter. */
export const TOKENS_PER_CALL_REPORT_MAX = 1_000_000;

function reportedTokens(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), TOKENS_PER_CALL_REPORT_MAX) : 0;
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

/** Frontier position of the first target, challenges last; stable otherwise (design 4.4). */
export function orderRound<C extends Candidate>(questions: readonly C[], plan: RoundPlan): C[] {
    const position = new Map(plan.targets.map((t, i) => [refKey(t), i] as const));
    const rank = (q: C) =>
        q.mode === 'CHALLENGE' ? Number.MAX_SAFE_INTEGER : Math.min(...q.targetsFieldKeys.map((k) => position.get(refKey({ elementId: q.elementId, fieldKey: k })) ?? Number.MAX_SAFE_INTEGER - 1));
    return questions
        .map((q, i) => ({ q, i, r: rank(q) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.q);
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
    for (const personaKey of shares) {
        const mine = input.plan.targets.filter((t) => t.personaKey === personaKey);
        const challenge = input.plan.challenge && input.plan.challenge.personaKey === personaKey ? input.plan.challenge : null;
        if (mine.length === 0 && !challenge) continue;
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
            workspaceId: input.workspaceId,
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
        let raw: unknown;
        try {
            const result = await deps.generator.generateCandidates(request);
            metrics.tokensUsed += reportedTokens((result as { tokensUsed?: unknown } | null)?.tokensUsed);
            raw = (result as { output?: unknown } | null)?.output;
        } catch {
            // A failed call costs only its persona's share: those fields go to the pack fallback.
            metrics.generationFailures++;
            continue;
        }
        const parsed = parseGeneratedQuestions(raw);
        if (parsed.unreadable) metrics.unreadableOutputs++;
        metrics.malformed += parsed.malformed;
        metrics.declined += parsed.declined.length;
        for (const q of parsed.questions) {
            metrics.candidates++;
            const verdict = validateCandidate(sanitiseQuestionForStorage(candidateFrom(q, personaKey)), vctx);
            if (!verdict.ok) {
                bump(metrics.dropped, verdict.reason);
                bump(metrics.preventedBehaviours, DROP_REASONS[verdict.reason]);
                continue;
            }
            if (verdict.stripped) bump(metrics.recommendationsStripped, verdict.stripped);
            validated.push(verdict.candidate);
        }
    }
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
    const questions: PlannedQuestion[] = final.map((c, i) => ({ ...c, origin: originOf.get(c)!, position: i + 1 }));
    const vectors = new Map<number, readonly number[]>();
    final.forEach((c, i) => {
        const v = vectorOf.get(c);
        if (v) vectors.set(i + 1, v);
        else metrics.unembedded++;
    });
    return { questions, vectors, metrics };
}
