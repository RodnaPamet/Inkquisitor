/**
 * RUNNING THE PACK EVALUATIONS (Phase 2.3): what `npm run packs:evaluate`
 * (`scripts/evaluate-packs.ts`) and the `Evals` workflow
 * (`.github/workflows/evals.yml`) do, as functions a test can drive.
 *
 *   --generator structural   (default) the deterministic structural generator:
 *                            no model, no network, no database. Writes each
 *                            pack's record BESIDE the pack (or under --out).
 *                            Development and test mount on these; production
 *                            never does (decision D11).
 *   --generator model        the product's own wired generator over 2.1's
 *                            `callStructured`: the guard, the fence, the
 *                            ledger and the workspace's spend ceiling all
 *                            apply. Needs ANTHROPIC_API_KEY (never falls back
 *                            to the structural generator), a migrated
 *                            database, an explicit budget
 *                            (AI_MONTHLY_CEILING_USD_DEFAULT, at most
 *                            `EVAL_RUN_BUDGET_MAX_USD`, held to the month the
 *                            run started in: `withinRunMonth`) and --out: a model's
 *                            record is never written into the source tree by
 *                            the run that made it; a person commits it after
 *                            review.
 *   --packs all | a,b        which packs' sets to run (default all)
 *   --coverage               also run the question-coverage set (2.2's ten
 *                            concepts) and write `coverage-report.json`
 *   --no-packs               run no pack set (with --coverage: the coverage set alone)
 *   --reconcile              also run the reconcile step's sets (Phase 2.5:
 *                            enrichment and adversarial) and write its record:
 *                            beside the sets (src/lib/enrichment/evals/) for a
 *                            structural run, DIR/reconcile/ under --out. The
 *                            structural reconciler is the reference reconciler
 *                            (`src/lib/enrichment/evals/evaluation.ts`); the
 *                            model one is the product's wired reconciler.
 *   --sources                also run source fact extraction's set (Phase 4.0):
 *                            its record beside it (src/lib/sources/evals/), or
 *                            DIR/sources/ under --out.
 *   --bible-facts            also run bible fact extraction's set (Phase 4.1):
 *                            its record beside it (src/lib/facts/evals/), or
 *                            DIR/bible-facts/ under --out.
 *   --research               also run the research agent's sets (Phase 2.6:
 *                            research and adversarial briefs over a fake web)
 *                            and write its record: beside the sets
 *                            (src/lib/research/evals/) for a structural run,
 *                            DIR/research/ under --out. The structural
 *                            researcher is the deterministic one; the model
 *                            run makes the findings and fit calls over each
 *                            case's fake web (no live search).
 *   --rephrase               also run the rephrase prompt's set (Phase 2.H:
 *                            ten questions asked differently) and write its
 *                            record: beside the set
 *                            (src/lib/interview/evals/) for a structural run,
 *                            DIR/rephrase/ under --out. The model run is the
 *                            product's wired question generator.
 *   --judge                  also run the judge over the ungraded behaviours of
 *                            the pack records this run wrote (Phase 2.H,
 *                            `src/lib/evals/judge.ts`): the model judge on a
 *                            model run, the structural one otherwise; its
 *                            report is `judge-report.json` under --out (or
 *                            evals-out). A report, never a gate: no pass bar
 *                            is set yet.
 *   --out DIR                where records go: DIR/<pack dir>/evaluation-record.json
 *
 * Every figure in a record is recomputed by the mount gate when it is read;
 * the summary printed here is for the person reading the log.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spendPeriod } from '@/lib/ai/call-record';
import { GenerationStop, type QuestionGenerator } from '../generator';
import { PACK_RECORD_FILE, type PackRegistry } from '../packs';
import { checkPackRecord, evalCasesOf, evaluatePack, type RecordKind } from '../pack-evaluation';
import { judgeItemsOfPackRecord, judgeReport, type Judge, type JudgeReport } from '@/lib/evals/judge';
import { loadCoverageEval, runCoverageEvaluation, type CoverageReport } from './coverage';
import type { Reconciler } from '@/lib/enrichment/reconciler';
import { checkReconcileRecord, evaluateReconcile, type ReconcileRecordKind } from '@/lib/enrichment/evals/evaluation';
import { checkRephraseRecord, evaluateRephrase, type RephraseRecordKind } from './rephrase-evaluation';

/** The most a model run may be given to spend, in US dollars: a run asking for more is refused. */
export const EVAL_RUN_BUDGET_MAX_USD = 25;

export interface EvalArgs {
    generator: RecordKind;
    /** Pack names, or 'all'. Empty: no pack set. */
    packs: 'all' | string[];
    coverage: boolean;
    /** Also run the reconcile evaluation (Phase 2.5). */
    reconcile: boolean;
    /** Also run the research agent's evaluation (Phase 2.6). */
    research: boolean;
    /** Also run source fact extraction's evaluation (Phase 4.0). */
    sources?: boolean;
    bibleFacts?: boolean;
    /** Also run the rephrase prompt's evaluation (Phase 2.H). */
    rephrase: boolean;
    /** Also judge the ungraded behaviours of the pack records written (Phase 2.H). */
    judge: boolean;
    out: string | null;
}

/** Parse the command line. Throws a plain message on anything it does not understand. */
export function parseEvalArgs(argv: readonly string[]): EvalArgs {
    const args: EvalArgs = { generator: 'structural', packs: 'all', coverage: false, reconcile: false, research: false, rephrase: false, judge: false, out: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = (): string => {
            const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
            if (v === undefined || v === '') throw new Error(`${a.split('=')[0]} needs a value`);
            return v;
        };
        if (a === '--coverage') args.coverage = true;
        else if (a === '--reconcile') args.reconcile = true;
        else if (a === '--research') args.research = true;
        else if (a === '--sources') args.sources = true;
        else if (a === '--bible-facts') args.bibleFacts = true;
        else if (a === '--rephrase') args.rephrase = true;
        else if (a === '--judge') args.judge = true;
        else if (a === '--no-packs') args.packs = [];
        else if (a.startsWith('--generator')) {
            const v = value();
            if (v !== 'structural' && v !== 'model') throw new Error('--generator is structural or model');
            args.generator = v;
        } else if (a.startsWith('--packs')) {
            const v = value().trim();
            args.packs = v === 'all' ? 'all' : v.split(',').map((p) => p.trim()).filter(Boolean);
        } else if (a.startsWith('--out')) args.out = value();
        else throw new Error(`unknown argument ${a}`);
    }
    if (args.generator === 'model' && args.out === null) throw new Error('a model run writes its records under --out, never into the source tree');
    return args;
}

/** The packs a run covers, refusing a name the registry does not hold. */
export function selectedPacks(registry: PackRegistry, packs: EvalArgs['packs']): string[] {
    const all = Object.keys(registry.files);
    if (packs === 'all') return all;
    const unknown = packs.filter((p) => !all.includes(p));
    if (unknown.length > 0) throw new Error(`no pack named ${unknown.join(', ')}`);
    return packs;
}

/**
 * The run's budget from the environment, for a model run: the workspace
 * spend ceiling the run's throwaway workspace starts at zero against. It must
 * be set explicitly, and be at most `EVAL_RUN_BUDGET_MAX_USD`.
 */
export function modelRunBudgetUsd(e: { readonly AI_MONTHLY_CEILING_USD_DEFAULT?: string | undefined; readonly [key: string]: string | undefined }): number {
    const raw = e.AI_MONTHLY_CEILING_USD_DEFAULT;
    if (raw === undefined || !/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error('a model run needs its budget in AI_MONTHLY_CEILING_USD_DEFAULT (US dollars)');
    const usd = Number(raw);
    if (!(usd > 0) || usd > EVAL_RUN_BUDGET_MAX_USD) throw new Error(`a model run's budget is more than 0 and at most ${EVAL_RUN_BUDGET_MAX_USD} US dollars`);
    return usd;
}

export interface PackRunResult {
    name: string;
    /** The record was written and the mount gate's own check passes it (recomputed). */
    passed: boolean;
    cases: number;
    failedCases: string[];
    /** Behaviours left to a judge, over every case. */
    ungraded: number;
    file: string | null;
    error?: string;
}

/** A generator that adds what each call cost to `spent` (micro-dollars). */
export function metered(generator: QuestionGenerator, spent: { microUsd: number; calls: number }): QuestionGenerator {
    return {
        unavailableReason: () => generator.unavailableReason(),
        async generateCandidates(request, signal) {
            spent.calls++;
            const r = await generator.generateCandidates(request, signal);
            spent.microUsd += typeof r.costMicroUsd === 'number' && r.costMicroUsd > 0 ? r.costMicroUsd : 0;
            return r;
        },
    };
}

/**
 * A model run's budget is its throwaway workspace's MONTHLY ceiling, which 2.1
 * counts per UTC calendar month. A run that crossed a month boundary would
 * meet a fresh month with nothing spent, and could spend the budget again. So
 * a model run's calls are held to the month it started in: the first call
 * asked for in a later month stops the run (`GenerationStop`, nothing sent),
 * and the budget bounds the whole run, not each month of it.
 */
export function withinRunMonth(generator: QuestionGenerator, startedAt: Date, now: () => Date = () => new Date()): QuestionGenerator {
    const month = spendPeriod(startedAt);
    return {
        unavailableReason: () => generator.unavailableReason(),
        async generateCandidates(request, signal) {
            if (spendPeriod(now()) !== month) throw new GenerationStop('WORKSPACE_CEILING', 'RUN_CROSSED_MONTH', null, 0);
            return generator.generateCandidates(request, signal);
        },
    };
}

/**
 * Evaluate each named pack with `generator`, write its record to
 * `<outRoot>/<pack dir>/evaluation-record.json`, and check the written record
 * the way the mount gate will. A pack whose run throws (the budget spent, the
 * kill switch) is reported with the error's name and writes nothing; the
 * packs after it are not run.
 */
export async function runPackEvaluations(input: {
    registry: PackRegistry;
    names: readonly string[];
    generator: QuestionGenerator;
    who: { kind: RecordKind; id: string };
    outRoot: string;
    now?: () => Date;
}): Promise<PackRunResult[]> {
    const results: PackRunResult[] = [];
    for (const name of input.names) {
        const file = input.registry.files[name];
        try {
            const { record, grades } = await evaluatePack(input.registry, name, input.generator, input.who, (input.now ?? (() => new Date()))());
            const dir = path.join(input.outRoot, file.dir);
            fs.mkdirSync(dir, { recursive: true });
            const target = path.join(dir, PACK_RECORD_FILE);
            fs.writeFileSync(target, JSON.stringify(record, null, 2) + '\n');
            const check = await checkPackRecord(record, file, input.registry);
            results.push({
                name,
                passed: check.ok,
                cases: grades.length,
                failedCases: grades.filter((g) => !g.passed).map((g) => g.caseId),
                ungraded: grades.reduce((n, g) => n + g.ungraded.length, 0),
                file: target,
            });
        } catch (err) {
            results.push({ name, passed: false, cases: 0, failedCases: [], ungraded: 0, file: null, error: err instanceof Error ? err.name + (err.message ? `: ${err.message.split('\n')[0]}` : '') : 'error' });
            break;
        }
    }
    return results;
}

/** A reconciler that adds what each call cost to `spent` (micro-dollars). */
export function meteredReconciler(reconciler: Reconciler, spent: { microUsd: number; calls: number }): Reconciler {
    return {
        unavailableReason: () => reconciler.unavailableReason(),
        async reconcile(request, signal) {
            spent.calls++;
            const r = await reconciler.reconcile(request, signal);
            spent.microUsd += typeof r.costMicroUsd === 'number' && r.costMicroUsd > 0 ? r.costMicroUsd : 0;
            return r;
        },
    };
}

/** A model run's reconcile calls held to the month the run started in (`withinRunMonth`'s twin): a later month's call is refused unsent. */
export function reconcilerWithinRunMonth(reconciler: Reconciler, startedAt: Date, now: () => Date = () => new Date()): Reconciler {
    const month = spendPeriod(startedAt);
    return {
        unavailableReason: () => reconciler.unavailableReason(),
        async reconcile(request, signal) {
            if (spendPeriod(now()) !== month) return { output: null, tokensUsed: 0, failure: { outcome: 'WORKSPACE_CEILING', errorCode: 'RUN_CROSSED_MONTH' } };
            return reconciler.reconcile(request, signal);
        },
    };
}

/** Where a structural reconcile record is written (beside the sets), relative to the repository. */
export const RECONCILE_RECORD_RELATIVE = path.join('src', 'lib', 'enrichment', 'evals', 'evaluation-record.json');

export interface ReconcileRunResult {
    passed: boolean;
    cases: number;
    failedCases: string[];
    ungraded: number;
    file: string;
    /** Why the gate's own check refuses the written record, when it does. */
    refusal: string | null;
}

/** The reconcile step's sets (2.5) through `reconciler`, its record written to `file` and checked as the gate checks it. */
export async function runReconcileEvaluation(
    reconciler: Reconciler,
    who: { kind: ReconcileRecordKind; id: string },
    file: string,
    now: () => Date = () => new Date(),
): Promise<ReconcileRunResult> {
    const { record, grades } = await evaluateReconcile(reconciler, who, now());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    const check = await checkReconcileRecord(record);
    return {
        passed: check.ok,
        cases: grades.length,
        failedCases: grades.filter((g) => !g.passed).map((g) => g.caseId),
        ungraded: grades.reduce((n, g) => n + g.ungraded.length, 0),
        file,
        refusal: check.ok ? null : `${check.reason}: ${check.detail}`,
    };
}

/** Where a structural rephrase record is written (beside its set), relative to the repository. */
export const REPHRASE_RECORD_RELATIVE = path.join('src', 'lib', 'interview', 'evals', 'rephrase-evaluation-record.json');

/** The rephrase prompt's set (2.H) through `generator`, its record written to `file` and checked as the gate checks it. */
export async function runRephraseEvaluation(
    registry: PackRegistry,
    generator: QuestionGenerator,
    who: { kind: RephraseRecordKind; id: string },
    file: string,
    now: () => Date = () => new Date(),
): Promise<ReconcileRunResult> {
    const { record, grades } = await evaluateRephrase(registry, generator, who, now());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    const check = await checkRephraseRecord(record, registry);
    return {
        passed: check.ok,
        cases: grades.length,
        failedCases: grades.filter((g) => !g.passed).map((g) => g.caseId),
        ungraded: grades.reduce((n, g) => n + g.ungraded.length, 0),
        file,
        refusal: check.ok ? null : `${check.reason}: ${check.detail}`,
    };
}

/**
 * The judge over the pack records a run wrote (the files `results` names):
 * every question each case worded, once per behaviour the case lists as
 * ungraded. The report goes to `<out>/judge-report.json`; it gates nothing.
 */
export async function runJudge(registry: PackRegistry, results: readonly PackRunResult[], judge: Judge, out: string): Promise<JudgeReport> {
    const judged = [];
    for (const r of results) {
        if (!r.file) continue;
        const record = JSON.parse(fs.readFileSync(r.file, 'utf8')) as { answers: Array<{ caseId: string; outputs: unknown[] }> };
        const ungraded = new Map(evalCasesOf(registry, r.name).map((c) => [c.id, { behaviours: [...c.mustNot, ...(c.tone ? ['TONE'] : [])], tone: c.tone ?? undefined }]));
        judged.push(...(await judge.judge(judgeItemsOfPackRecord(record, ungraded))));
    }
    const report = judgeReport(judged, judge.basis);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'judge-report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
}

/** The question-coverage set (2.2) through `generator`, written to `<out>/coverage-report.json`. */
export async function runCoverage(registry: PackRegistry, generator: QuestionGenerator, out: string): Promise<CoverageReport> {
    const report = await runCoverageEvaluation(loadCoverageEval(), generator, { packs: registry });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'coverage-report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
}

/** The run's summary as Markdown lines (the log and the step summary): names, counts and codes, never text. */
export function summaryLines(
    results: readonly PackRunResult[],
    coverage: CoverageReport | null,
    spent: { microUsd: number; calls: number } | null,
    reconcile: ReconcileRunResult | null = null,
): string[] {
    const lines = ['| pack | passed | cases | failed cases | ungraded behaviours |', '|---|---|---|---|---|'];
    for (const r of results) lines.push(`| ${r.name} | ${r.passed ? 'yes' : 'NO'} | ${r.cases} | ${r.error ?? (r.failedCases.join(', ') || '—')} | ${r.ungraded} |`);
    if (results.length === 0) lines.push('| (no pack set run) | | | | |');
    if (coverage) {
        lines.push('');
        lines.push(
            coverage.status === 'NOT_ASSESSED'
                ? 'Coverage: not assessed (no sessions).'
                : `Coverage: ${coverage.passed}/${coverage.sessions.length} sessions pass; ${coverage.coverage === null ? 'must-cover keys not assessed (no session names one)' : `${(coverage.coverage * 100).toFixed(1)}% of must-cover keys reached by the generator`}.`,
        );
    }
    if (reconcile) {
        lines.push('');
        lines.push(
            `Reconcile: ${reconcile.passed ? 'passed' : 'NOT passed'}; ${reconcile.cases - reconcile.failedCases.length}/${reconcile.cases} cases pass` +
                (reconcile.failedCases.length > 0 ? ` (failed: ${reconcile.failedCases.join(', ')})` : '') +
                `; ${reconcile.ungraded} ungraded behaviours.`,
        );
    }
    if (spent) lines.push('', `Model calls: ${spent.calls}; spent: $${(spent.microUsd / 1_000_000).toFixed(4)}.`);
    return lines;
}
