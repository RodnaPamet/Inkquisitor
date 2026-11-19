/**
 * THE QUESTION-COVERAGE EVALUATION (Phase 2.2; roadmap rule 9: every model
 * feature has an evaluation set).
 *
 * `question-coverage.json` beside this file holds ten invented book concepts,
 * each with two to four sessions (content formats 5.1, original text written
 * for Inkquisitor): the kind, the dials, the core fields the concept already
 * states, what the simulated author replies when a field is asked, and the
 * expected outcome — the core keys a session MUST target (`mustCover`) and
 * those it must NOT (`mustNotTarget`: stated, too deep, or behind a deferred
 * prerequisite). The file is validated with Zod when loaded, and its
 * expectations are re-derived from the format's own simulation by
 * tests/unit/interview/coverage-eval.test.ts, so a hand edit that breaks them
 * fails there.
 *
 * `runCoverageEvaluation(generator)` runs the PRODUCT'S round engine
 * (`produceRound`) against every session, in memory: the concept's stated
 * fields count as answered (the pluggable already-answered check a concept
 * seed will use), each round's questions are answered from `authorKnows`
 * (a question counts as answered only when the author knows every key it
 * targets; otherwise "decide later"), and rounds run until nothing is asked
 * or six have run (format 5.1's grading, not the depth's round budget). A
 * session PASSES when the GENERATOR's own questions (not the pack fallback,
 * which would make any generator pass) target every `mustCover` key, no
 * question of any origin targets a `mustNotTarget` key, and the generator
 * attempted none of the code-checkable behaviours its `mustNot` lists (each
 * candidate the engine dropped for one is counted as attempted). Targets on
 * optional keys are ignored. The behaviours only a judge can grade (story
 * content, prose, tone) are listed as `ungraded`: 2.3's harness grades them.
 *
 * Rule 6: a report over no sessions reads NOT_ASSESSED, never 100 %.
 *
 * The report names the prompt version and the per-call output budget (rule
 * 9). Real records come from a real model once 2.1 is wired; this module is
 * exercised today with a deterministic fake generator.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { getTemplate } from '@/lib/bible/templates';
import { DROP_REASONS } from '../candidates';
import { DETAIL, MAX_ROUNDS } from '../dials';
import type { AskedQuestion } from '../dedupe';
import { computeFrontier, refsCheck, type AnswerFact } from '../frontier';
import type { QuestionGenerator } from '../generator';
import type { PackRegistry } from '../packs';
import { planRound } from '../plan';
import { QUESTION_PROMPT_VERSION, type PromptAnswer } from '../prompt';
import { produceRound, type RoundElement } from '../round';

export const COVERAGE_EVAL_PATH = path.join(process.cwd(), 'src/lib/interview/evals/question-coverage.json');

const AUDIENCES = ['children', 'middle_grade', 'young_adult', 'adult'] as const;
const VALUE = z.union([z.string().min(1).max(1_200), z.array(z.string().min(1).max(200)).min(1).max(12), z.number().int().min(1).max(5)]);

const SessionSchema = z
    .object({
        kind: z.enum(BIBLE_KINDS),
        elementName: z.string().min(1).max(60),
        customLabel: z.string().min(1).max(40).optional(),
        dials: z.object({ depth: z.number().int().min(1).max(5), detail: z.number().int().min(1).max(5) }).strict(),
        statedInConcept: z.array(z.string()),
        authorKnows: z.record(z.string(), VALUE),
        expect: z
            .object({
                mustCover: z.array(z.string()).min(1),
                mustNotTarget: z.array(z.string()),
                mustNot: z.array(z.string().regex(/^[A-Z_]+$/)).min(1),
            })
            .strict(),
    })
    .strict();

const CaseSchema = z
    .object({
        id: z.string().regex(/^qc-\d{2}$/),
        rationale: z.string().min(1).max(400),
        concept: z.string().min(1),
        genre: z.string().min(1).max(40),
        audience: z.enum(AUDIENCES),
        sessions: z.array(SessionSchema).min(2).max(4),
    })
    .strict();

export const CoverageEvalSchema = z
    .array(CaseSchema)
    .length(10)
    .superRefine((cases, ctx) => {
        cases.forEach((c, i) => {
            if (c.id !== `qc-${String(i + 1).padStart(2, '0')}`) ctx.addIssue({ code: 'custom', message: 'ids are not qc-01..qc-10 in order', path: [i, 'id'] });
            c.sessions.forEach((s, j) => {
                const core = getTemplate(s.kind)
                    .fields.filter((f) => f.required)
                    .map((f) => f.key);
                const keys = [...s.statedInConcept, ...Object.keys(s.authorKnows), ...s.expect.mustCover, ...s.expect.mustNotTarget];
                if (keys.some((k) => !core.includes(k))) ctx.addIssue({ code: 'custom', message: 'names a key that is not a core key of its kind', path: [i, 'sessions', j] });
                if ((s.kind === 'CUSTOM') !== (s.customLabel !== undefined)) ctx.addIssue({ code: 'custom', message: 'a custom label belongs to CUSTOM sessions only', path: [i, 'sessions', j] });
            });
        });
    });

export type CoverageCase = z.infer<typeof CaseSchema>;
export type CoverageSession = z.infer<typeof SessionSchema>;

export function loadCoverageEval(file: string = COVERAGE_EVAL_PATH): CoverageCase[] {
    const parsed = CoverageEvalSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success) throw new Error(`question-coverage.json is invalid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return parsed.data;
}

/** The format's own simulation (content formats 5.1): what `mustCover` and `mustNotTarget` must be. */
export function expectedCoverage(session: CoverageSession): { mustCover: string[]; mustNotTarget: string[] } {
    const fields = getTemplate(session.kind).fields.filter((f) => f.required);
    const level = new Map<string, number>();
    for (const f of fields) level.set(f.key, f.dependsOn.length === 0 ? 1 : 1 + Math.max(...f.dependsOn.map((d) => level.get(d) ?? Infinity)));
    const satisfied = new Set(session.statedInConcept);
    const deferred = new Set<string>();
    const covered = new Set<string>();
    for (let round = 0; round < MAX_ROUNDS; round++) {
        const eligible = fields.filter(
            (f) => !satisfied.has(f.key) && !deferred.has(f.key) && level.get(f.key)! <= session.dials.depth && f.dependsOn.every((d) => satisfied.has(d)),
        );
        if (eligible.length === 0) break;
        for (const f of eligible) {
            covered.add(f.key);
            (f.key in session.authorKnows ? satisfied : deferred).add(f.key);
        }
    }
    return {
        mustCover: fields.filter((f) => covered.has(f.key)).map((f) => f.key),
        mustNotTarget: fields.filter((f) => !covered.has(f.key)).map((f) => f.key),
    };
}

/** Behaviours the engine can see a generator attempt: every drop reason's code. */
const CODE_CHECKED = new Set<string>(Object.values(DROP_REASONS));

export interface SessionReport {
    caseId: string;
    kind: BibleKind;
    rounds: number;
    /** Core keys the generator's own questions targeted. */
    generatorCovered: string[];
    /** Core keys only the pack fallback asked. */
    fallbackOnly: string[];
    missed: string[];
    /** `mustNotTarget` keys some question targeted. */
    wronglyTargeted: string[];
    /** Code-checkable `mustNot` behaviours the generator attempted (dropped by the engine). */
    attempted: string[];
    /** `mustNot` behaviours this runner cannot grade (left to 2.3's judge). */
    ungraded: string[];
    passed: boolean;
}

export type CoverageReport =
    | { status: 'NOT_ASSESSED'; promptVersion: string; sessions: [] }
    | {
          status: 'MEASURED';
          promptVersion: string;
          /** The generation calls' output budgets used, by detail (rule 9). */
          maxOutputTokensByDetail: Record<number, number>;
          sessions: SessionReport[];
          passed: number;
          /** `mustCover` keys the generator reached, over all of them. */
          coverage: number;
      };

export interface CoverageRunOptions {
    /** Which template fields the simulated engine considers. Default: all (the product's configuration). */
    fields?: 'all' | 'core';
    packs: Pick<PackRegistry, 'craft' | 'personas'>;
}

async function runSession(caseId: string, session: CoverageSession, generator: QuestionGenerator, options: CoverageRunOptions): Promise<SessionReport> {
    const template = getTemplate(session.kind);
    const core = template.fields.filter((f) => f.required).map((f) => f.key);
    const fields = options.fields === 'core' ? template.fields.filter((f) => f.required) : template.fields;
    const elementId = `eval-${caseId}-${session.kind.toLowerCase()}`;
    const element: RoundElement = { elementId, kind: session.kind, name: session.elementName, customLabel: session.customLabel ?? null, fields, storedText: new Map() };
    const stated = refsCheck(
        'concept-stated',
        session.statedInConcept.map((fieldKey) => ({ elementId, fieldKey })),
    );
    const answers: Array<AnswerFact & PromptAnswer> = [];
    const asked: AskedQuestion[] = [];
    const generatorTargets = new Set<string>();
    const allTargets = new Set<string>();
    const attempted = new Set<string>();
    let rounds = 0;
    let challengesPlanned = 0;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
        const result = computeFrontier({
            elements: [{ elementId, kind: session.kind, fields, storedKeys: new Set() }],
            sessionAnswers: answers,
            checks: [stated],
            depth: session.dials.depth,
        });
        const plan = planRound({
            frontier: result.frontier,
            challengeable: [],
            challenged: [],
            challengesPlanned,
            depth: session.dials.depth,
            detail: session.dials.detail,
            personaKeys: [],
            roundNumber: round,
        });
        if (plan.targets.length === 0 && !plan.challenge) break;
        if (plan.challenge) challengesPlanned++;
        const out = await produceRound(
            {
                workspaceId: 'eval',
                dials: session.dials,
                offerRecommended: true,
                preferChoice: false,
                personaKeys: [],
                plan,
                elements: [element],
                related: [],
                sessionAnswers: answers,
                asked,
                packs: options.packs,
            },
            { generator },
        );
        for (const code of Object.keys(out.metrics.preventedBehaviours)) attempted.add(code);
        if (out.questions.length === 0) break;
        rounds++;
        for (const q of out.questions) {
            const id = `q${asked.length + 1}`;
            asked.push({ id, scope: 'SESSION', elementId, targetsFieldKeys: q.targetsFieldKeys, kind: q.kind, text: q.text, options: q.options, scaleLabels: q.scaleLabels });
            for (const k of q.targetsFieldKeys) {
                allTargets.add(k);
                if (q.origin === 'MODEL') generatorTargets.add(k);
            }
            const known = q.targetsFieldKeys.every((k) => k in session.authorKnows);
            const value = known ? session.authorKnows[q.targetsFieldKeys[0]] : null;
            answers.push({
                answerId: `a${answers.length + 1}`,
                elementId,
                targetsFieldKeys: q.targetsFieldKeys,
                targets: q.targetsFieldKeys.map((fieldKey) => ({ elementId, fieldKey })),
                questionKind: q.kind,
                question: q.text,
                status: known ? 'ANSWERED' : 'DECIDE_LATER',
                answer: value === null ? null : Array.isArray(value) ? value.join('; ') : String(value),
            });
        }
    }

    const { mustCover, mustNotTarget, mustNot } = session.expect;
    const generatorCovered = core.filter((k) => generatorTargets.has(k));
    const attemptedListed = mustNot.filter((code) => attempted.has(code));
    const report: SessionReport = {
        caseId,
        kind: session.kind,
        rounds,
        generatorCovered,
        fallbackOnly: core.filter((k) => allTargets.has(k) && !generatorTargets.has(k)),
        missed: mustCover.filter((k) => !generatorTargets.has(k)),
        wronglyTargeted: mustNotTarget.filter((k) => allTargets.has(k)),
        attempted: attemptedListed,
        ungraded: mustNot.filter((code) => !CODE_CHECKED.has(code)),
        passed: false,
    };
    report.passed = report.missed.length === 0 && report.wronglyTargeted.length === 0 && report.attempted.length === 0;
    return report;
}

export async function runCoverageEvaluation(cases: readonly CoverageCase[], generator: QuestionGenerator, options: CoverageRunOptions): Promise<CoverageReport> {
    const sessions: SessionReport[] = [];
    for (const c of cases) for (const s of c.sessions) sessions.push(await runSession(c.id, s, generator, options));
    if (sessions.length === 0) return { status: 'NOT_ASSESSED', promptVersion: QUESTION_PROMPT_VERSION, sessions: [] };
    const all = cases.flatMap((c) => c.sessions);
    const required = all.reduce((n, s) => n + s.expect.mustCover.length, 0);
    const reached = sessions.reduce((n, r, i) => n + all[i].expect.mustCover.filter((k) => r.generatorCovered.includes(k)).length, 0);
    return {
        status: 'MEASURED',
        promptVersion: QUESTION_PROMPT_VERSION,
        maxOutputTokensByDetail: Object.fromEntries(Object.entries(DETAIL).map(([d, row]) => [Number(d), row.maxOutputTokens])),
        sessions,
        passed: sessions.filter((r) => r.passed).length,
        coverage: required === 0 ? 0 : reached / required,
    };
}
