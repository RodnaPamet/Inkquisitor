/**
 * HOW A PACK PROVES IT DOES WHAT IT SAYS BEFORE A SESSION MAY MOUNT IT
 * (Phase 2.3; roadmap rule 9).
 *
 * Two shapes, and the split is the point (lifted from inflect-compliance's
 * skill evaluation records, `src/lib/agentic/flue/skills/evaluation-record.ts`;
 * see docs/carve-manifest.md):
 *
 *   • An EVALUATION SET is authored with the pack: `evals.json` beside
 *     `PACK.md` (content formats 3.5 and 4.5), and for a persona the fixed
 *     situations it refers to. It names cases and what a right output must and
 *     must not do. It never carries an answer.
 *   • An EVALUATION RECORD (`evaluation-record.json`) is the set's hash PLUS
 *     what one named generator actually produced for every case, at a recorded
 *     time, under a named prompt version: the RAW structured output of each
 *     generation call, exactly as the generator returned it. Only a run can
 *     produce one (`npm run packs:evaluate`).
 *
 * ‾‾‾ NO STORED FIGURES ‾‾‾
 *
 * A record never states a pass rate or a verdict: the schema is strict, so a
 * `passRate` member is an unknown key and a refusal. Grading is RECOMPUTED on
 * every check by REPLAYING the record: each case is run through the product's
 * own round engine (`produceRound`: parse, validate, deduplicate, fill gaps,
 * order) with a generator that returns the recorded outputs in order, and the
 * engine's result is graded against the case. So the evaluation measures the
 * engine the product runs, and a record edited by hand is graded on what it
 * now says.
 *
 * ‾‾‾ WHAT CODE GRADES, AND WHAT IT LEAVES ‾‾‾
 *
 * Per case: the round targets the case's expected frontier (a craft case's
 * `targetsAnyOf`; for a persona's situation, the frontier the product computes
 * from it, which for S1–S3 is the formats' expected key) — at least one
 * generated FRONTIER question on an expected core key, or no question at all
 * when nothing is expected; no question of any origin on another core key; and
 * none of the behaviours the case's `mustNot` lists that the engine had to
 * prevent (a candidate dropped for a code-checkable reason counts as
 * attempted). The behaviours only a reader can judge — story content, prose,
 * leading wording, a persona's tone — are listed per case as UNGRADED; a judge
 * grades them in 2.H. Optional fields are not asked about in an evaluation run
 * (core fields only, formats 1.9), and no challenge is planned (a craft case
 * whose frontier is empty expects no question).
 *
 * A pack passes when every case is answered once and the recomputed pass rate
 * reaches `PACK_EVAL_PASS_RATE`.
 */
import { z } from 'zod';
import type { BibleKind } from '@/lib/bible/kinds';
import { getTemplate } from '@/lib/bible/templates';
import { DROP_REASONS } from './candidates';
import type { AskedQuestion } from './dedupe';
import type { Dials } from './dials';
import { computeFrontier, type AnswerFact } from './frontier';
import type { GenerationResult, QuestionGenerator } from './generator';
import type { PackFile, PackPriorAnswer, PackRegistry, Situation } from './packs';
import { planRound } from './plan';
import { QUESTION_PROMPT_VERSION, type PromptAnswer } from './prompt';
import { produceRound, type RoundElement, type RoundOutput } from './round';
import { isPersonaKey, type PersonaKey } from './vocabulary';

export const PACK_RECORD_FORMAT = 'inkquisitor-pack-evaluation/1';

/**
 * What produced a record. `structural`: the deterministic structural
 * generator (`evals/structural-generator.ts`), no model — proves the set runs
 * and the code-graded expectations hold, nothing about a model's wording.
 * `model`: a real model through the wired generator.
 */
export const RECORD_KINDS = ['structural', 'model'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** Every case must pass its code-graded checks. A starting bar for real-model records to argue down, with evidence. */
export const PACK_EVAL_PASS_RATE = 1;

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CASE_ID = z.string().regex(/^[a-z_-]+-\d{2}$/);
/** Generation calls one case makes: one per persona, and an evaluation mounts at most one. */
const OUTPUTS_PER_CASE_MAX = 2;
const CASES_MAX = 15;

export const PackEvaluationRecordSchema = z
    .object({
        format: z.literal(PACK_RECORD_FORMAT),
        pack: z.object({ name: z.string().min(1).max(64), version: z.number().int().min(1), contentHash: SHA256 }).strict(),
        set: z.object({ hash: SHA256 }).strict(),
        /** The question prompt's version the outputs were produced under (rule 9). */
        promptVersion: z.string().min(1).max(64),
        generator: z
            .object({
                kind: z.enum(RECORD_KINDS),
                /** The structural generator's id, or the model id a real run resolved to. */
                id: z.string().min(1).max(128),
            })
            .strict(),
        ranAt: z.iso.datetime(),
        answers: z
            .array(
                z
                    .object({
                        caseId: CASE_ID,
                        /** Each generation call's raw output, in call order; null for a call that produced nothing. */
                        outputs: z.array(z.unknown()).max(OUTPUTS_PER_CASE_MAX),
                    })
                    .strict(),
            )
            .max(CASES_MAX),
    })
    .strict();
export type PackEvaluationRecord = z.infer<typeof PackEvaluationRecordSchema>;

// ─── The cases, normalised ─────────────────────────────────────────

/** One case of a pack's set, as the runner and the grader read it. */
export interface PackEvalCase {
    id: string;
    kind: BibleKind;
    elementName: string;
    customLabel: string | null;
    bibleState: Readonly<Record<string, string | string[] | number | null>>;
    priorAnswers: readonly PackPriorAnswer[];
    dials: Dials;
    /** The persona the case mounts (a persona pack's cases), or none (a craft pack's). */
    persona: PersonaKey | null;
    /** The core keys a right round targets; empty when it should ask nothing. */
    expectTargets: readonly string[];
    mustNot: readonly string[];
    /** A persona case's expected tone words (judge-graded), or null. */
    tone: readonly string[] | null;
}

function coreFields(kind: BibleKind) {
    return getTemplate(kind).fields.filter((f) => f.required);
}

function elementIdOf(caseId: string): string {
    return `eval-${caseId}`;
}

function answerFacts(caseId: string, prior: readonly PackPriorAnswer[]): AnswerFact[] {
    const elementId = elementIdOf(caseId);
    return prior.map((a) => ({ status: a.status, targets: a.targetsFieldKeys.map((fieldKey) => ({ elementId, fieldKey })) }));
}

/** The frontier the product computes for a situation, over core fields (formats 1.9): a persona case's expected targets. */
export function situationFrontier(id: string, s: Pick<Situation, 'kind' | 'bibleState' | 'priorAnswers' | 'dials'>): string[] {
    const stored = new Set(Object.entries(s.bibleState).filter(([, v]) => v !== null).map(([k]) => k));
    const result = computeFrontier({
        elements: [{ elementId: elementIdOf(id), kind: s.kind, fields: coreFields(s.kind), storedKeys: stored }],
        sessionAnswers: answerFacts(id, s.priorAnswers),
        depth: s.dials.depth,
    });
    return result.frontier.map((f) => f.fieldKey);
}

/** Every case of the named pack's set, normalised. */
export function evalCasesOf(registry: Pick<PackRegistry, 'files' | 'craftEvals' | 'personaEvals' | 'situations'>, name: string): PackEvalCase[] {
    const file = registry.files[name];
    if (!file) throw new Error(`no pack named ${name}`);
    if (file.group === 'craft') {
        const kind = file.key as BibleKind;
        return registry.craftEvals[kind].map((c) => ({
            id: c.id,
            kind,
            elementName: c.elementName,
            customLabel: c.customLabel ?? null,
            bibleState: c.bibleState,
            priorAnswers: c.priorAnswers,
            dials: c.dials,
            persona: null,
            expectTargets: c.expect.targetsAnyOf,
            mustNot: c.expect.mustNot,
            tone: null,
        }));
    }
    if (!isPersonaKey(file.key)) throw new Error(`pack ${name} names an unknown persona`);
    const persona = file.key;
    return registry.personaEvals[persona].map((c) => {
        const s: Situation = typeof c.situation === 'string' ? registry.situations[c.situation] : c.situation;
        return {
            id: c.id,
            kind: s.kind,
            elementName: s.elementName,
            customLabel: s.customLabel ?? null,
            bibleState: s.bibleState,
            priorAnswers: s.priorAnswers,
            dials: s.dials,
            persona,
            expectTargets: situationFrontier(c.id, s),
            mustNot: c.expect.mustNot,
            tone: c.expect.tone,
        };
    });
}

// ─── Running a case ────────────────────────────────────────────────

function valueText(v: string | string[] | number): string {
    return Array.isArray(v) ? v.join('; ') : String(v);
}

/**
 * Run one case through the product's round engine with `generator`: one
 * round, core fields only, no challenge. Returns the engine's round and each
 * generation call's raw output (null for a call that failed).
 */
export async function runEvalCase(
    c: PackEvalCase,
    packs: Pick<PackRegistry, 'craft' | 'personas'>,
    generator: QuestionGenerator,
): Promise<{ round: RoundOutput; outputs: unknown[] }> {
    const elementId = elementIdOf(c.id);
    const fields = coreFields(c.kind);
    const storedText = new Map(Object.entries(c.bibleState).flatMap(([k, v]) => (v === null ? [] : [[k, valueText(v)] as const])));
    const element: RoundElement = { elementId, kind: c.kind, name: c.elementName, customLabel: c.customLabel, fields, storedText };
    const facts = answerFacts(c.id, c.priorAnswers);
    const sessionAnswers: PromptAnswer[] = c.priorAnswers.map((a) => ({
        answerId: a.id,
        elementId,
        targetsFieldKeys: a.targetsFieldKeys,
        questionKind: a.questionKind,
        question: a.question,
        status: a.status,
        answer: a.answer === null ? null : String(a.answer),
    }));
    const asked: AskedQuestion[] = c.priorAnswers.map((a) => ({
        id: `prior-${a.id}`,
        scope: 'SESSION',
        elementId,
        targetsFieldKeys: a.targetsFieldKeys,
        kind: a.questionKind,
        text: a.question,
        options: a.options ?? null,
        scaleLabels: a.scaleLabels ?? null,
    }));
    const frontier = computeFrontier({
        elements: [{ elementId, kind: c.kind, fields, storedKeys: new Set(storedText.keys()) }],
        sessionAnswers: facts,
        depth: c.dials.depth,
    });
    const plan = planRound({
        frontier: frontier.frontier,
        challengeable: [],
        challenged: [],
        challengesPlanned: 0,
        depth: c.dials.depth,
        detail: c.dials.detail,
        personaKeys: c.persona ? [c.persona] : [],
        roundNumber: 1,
    });
    const outputs: unknown[] = [];
    const capturing: QuestionGenerator = {
        unavailableReason: () => generator.unavailableReason(),
        async generateCandidates(request, signal): Promise<GenerationResult> {
            try {
                const result = await generator.generateCandidates(request, signal);
                outputs.push(result.failure ? null : (result.output ?? null));
                return result;
            } catch (err) {
                outputs.push(null);
                throw err;
            }
        },
    };
    const round = await produceRound(
        {
            bookId: null,
            dials: c.dials,
            offerRecommended: true,
            preferChoice: false,
            personaKeys: c.persona ? [c.persona] : [],
            plan,
            elements: [element],
            related: [],
            sessionAnswers,
            asked,
            packs,
        },
        { generator: capturing },
    );
    return { round, outputs };
}

/** A generator that answers with recorded outputs, in order; a call past them, or a recorded null, fails INVALID_OUTPUT. */
export function replayGenerator(outputs: readonly unknown[]): QuestionGenerator {
    let next = 0;
    return {
        unavailableReason: () => null,
        async generateCandidates(): Promise<GenerationResult> {
            const output = next < outputs.length ? outputs[next] : null;
            next++;
            if (output === null || output === undefined) return { output: null, tokensUsed: 0, failure: { kind: 'INVALID_OUTPUT', errorCode: 'NOT_RECORDED' } };
            return { output, tokensUsed: 0 };
        },
    };
}

// ─── Grading ───────────────────────────────────────────────────────

/**
 * The behaviour codes (content formats 1.11) code can decide: every reason the
 * engine drops a candidate for, plus the frontier's own (a question on a core
 * key off the expected frontier is graded as targeting the wrong field).
 */
export const CODE_GRADED_BEHAVIOURS: ReadonlySet<string> = new Set<string>([...Object.values(DROP_REASONS), 'SKIPS_DEPENDENCY', 'EXCEEDS_DEPTH']);

export interface CaseGrade {
    caseId: string;
    passed: boolean;
    /** The expected frontier was empty and nothing was asked, or a generated question reached it. */
    reachedExpected: boolean;
    /** Core keys asked about that the expected frontier does not hold. */
    wronglyTargeted: string[];
    /** `mustNot` behaviours the generator attempted (the engine dropped a candidate for one). */
    attempted: string[];
    /** `mustNot` behaviours (and a persona's tone) only a judge can grade. */
    ungraded: string[];
}

export function gradeCase(c: PackEvalCase, round: RoundOutput): CaseGrade {
    const core = new Set(coreFields(c.kind).map((f) => f.key));
    const frontierQs = round.questions.filter((q) => q.mode === 'FRONTIER');
    const generated = new Set(frontierQs.filter((q) => q.origin === 'MODEL').flatMap((q) => q.targetsFieldKeys));
    const asked = new Set(round.questions.flatMap((q) => q.targetsFieldKeys).filter((k) => core.has(k)));
    const reachedExpected = c.expectTargets.length === 0 ? round.questions.length === 0 : c.expectTargets.some((k) => generated.has(k));
    const wronglyTargeted = [...asked].filter((k) => !c.expectTargets.includes(k)).sort();
    const prevented = round.metrics.preventedBehaviours as Record<string, number | undefined>;
    const attempted = c.mustNot.filter((code) => (prevented[code] ?? 0) > 0);
    const ungraded = [...c.mustNot.filter((code) => !CODE_GRADED_BEHAVIOURS.has(code)), ...(c.tone ? ['TONE'] : [])];
    return { caseId: c.id, passed: reachedExpected && wronglyTargeted.length === 0 && attempted.length === 0, reachedExpected, wronglyTargeted, attempted, ungraded };
}

// ─── Records: made and checked ─────────────────────────────────────

/** Run the named pack's set through `generator` and write the record (not to disk: the caller does). */
export async function evaluatePack(
    registry: PackRegistry,
    name: string,
    generator: QuestionGenerator,
    who: { kind: RecordKind; id: string },
    ranAt: Date,
): Promise<{ record: PackEvaluationRecord; grades: CaseGrade[] }> {
    const file = registry.files[name];
    if (!file) throw new Error(`no pack named ${name}`);
    const cases = evalCasesOf(registry, name);
    const answers: PackEvaluationRecord['answers'] = [];
    const grades: CaseGrade[] = [];
    for (const c of cases) {
        const { round, outputs } = await runEvalCase(c, registry, generator);
        answers.push({ caseId: c.id, outputs });
        grades.push(gradeCase(c, round));
    }
    return {
        record: {
            format: PACK_RECORD_FORMAT,
            pack: { name: file.name, version: file.version, contentHash: file.contentHash },
            set: { hash: file.setHash },
            promptVersion: QUESTION_PROMPT_VERSION,
            generator: { kind: who.kind, id: who.id },
            ranAt: ranAt.toISOString(),
            answers,
        },
        grades,
    };
}

export type RecordRefusal =
    | 'MALFORMED'
    | 'PACK_MISMATCH'
    | 'HASH_MISMATCH'
    | 'SET_MISMATCH'
    | 'PROMPT_VERSION_MISMATCH'
    | 'UNKNOWN_ANSWER'
    | 'DUPLICATE_ANSWER'
    | 'UNANSWERED_CASE'
    | 'BELOW_THRESHOLD';

export type RecordCheck =
    | { ok: true; record: PackEvaluationRecord; grades: CaseGrade[]; passRate: number }
    | { ok: false; reason: RecordRefusal; detail: string };

/**
 * Does this record show this exact pack passing its committed set under the
 * current prompt? Every figure is recomputed by replaying the record's
 * outputs through the round engine.
 */
export async function checkPackRecord(raw: unknown, file: PackFile, registry: PackRegistry): Promise<RecordCheck> {
    const parsed = PackEvaluationRecordSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED', detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    const record = parsed.data;
    if (record.pack.name !== file.name || record.pack.version !== file.version) {
        return { ok: false, reason: 'PACK_MISMATCH', detail: `the record is for ${record.pack.name} v${record.pack.version}` };
    }
    if (record.pack.contentHash !== file.contentHash) return { ok: false, reason: 'HASH_MISMATCH', detail: 'the pack changed since the record was made; re-run npm run packs:evaluate' };
    if (record.set.hash !== file.setHash) return { ok: false, reason: 'SET_MISMATCH', detail: 'the record answered a different evaluation set; re-run npm run packs:evaluate' };
    if (record.promptVersion !== QUESTION_PROMPT_VERSION) {
        return { ok: false, reason: 'PROMPT_VERSION_MISMATCH', detail: `recorded under ${record.promptVersion}, the prompt is ${QUESTION_PROMPT_VERSION}` };
    }
    const cases = evalCasesOf(registry, file.name);
    const byCase = new Map<string, unknown[]>();
    for (const a of record.answers) {
        if (!cases.some((c) => c.id === a.caseId)) return { ok: false, reason: 'UNKNOWN_ANSWER', detail: a.caseId };
        if (byCase.has(a.caseId)) return { ok: false, reason: 'DUPLICATE_ANSWER', detail: a.caseId };
        byCase.set(a.caseId, a.outputs);
    }
    const grades: CaseGrade[] = [];
    for (const c of cases) {
        const outputs = byCase.get(c.id);
        if (outputs === undefined) return { ok: false, reason: 'UNANSWERED_CASE', detail: c.id };
        const { round } = await runEvalCase(c, registry, replayGenerator(outputs));
        grades.push(gradeCase(c, round));
    }
    // Rule 6: a set of no cases is never a pass (the loader refuses one; this is the second line).
    const passRate = grades.length === 0 ? 0 : grades.filter((g) => g.passed).length / grades.length;
    if (grades.length === 0 || passRate < PACK_EVAL_PASS_RATE) {
        const failed = grades.filter((g) => !g.passed).map((g) => g.caseId);
        return { ok: false, reason: 'BELOW_THRESHOLD', detail: `${grades.length - failed.length}/${grades.length} cases pass (${failed.join(', ') || 'no cases'})` };
    }
    return { ok: true, record, grades, passRate };
}
