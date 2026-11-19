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
 *                            `EVAL_RUN_BUDGET_MAX_USD`) and --out: a model's
 *                            record is never written into the source tree by
 *                            the run that made it; a person commits it after
 *                            review.
 *   --packs all | a,b        which packs' sets to run (default all)
 *   --coverage               also run the question-coverage set (2.2's ten
 *                            concepts) and write `coverage-report.json`
 *   --no-packs               run no pack set (with --coverage: the coverage set alone)
 *   --out DIR                where records go: DIR/<pack dir>/evaluation-record.json
 *
 * Every figure in a record is recomputed by the mount gate when it is read;
 * the summary printed here is for the person reading the log.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { QuestionGenerator } from '../generator';
import { PACK_RECORD_FILE, type PackRegistry } from '../packs';
import { checkPackRecord, evaluatePack, type RecordKind } from '../pack-evaluation';
import { loadCoverageEval, runCoverageEvaluation, type CoverageReport } from './coverage';

/** The most a model run may be given to spend, in US dollars: a run asking for more is refused. */
export const EVAL_RUN_BUDGET_MAX_USD = 25;

export interface EvalArgs {
    generator: RecordKind;
    /** Pack names, or 'all'. Empty: no pack set. */
    packs: 'all' | string[];
    coverage: boolean;
    out: string | null;
}

/** Parse the command line. Throws a plain message on anything it does not understand. */
export function parseEvalArgs(argv: readonly string[]): EvalArgs {
    const args: EvalArgs = { generator: 'structural', packs: 'all', coverage: false, out: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = (): string => {
            const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
            if (v === undefined || v === '') throw new Error(`${a.split('=')[0]} needs a value`);
            return v;
        };
        if (a === '--coverage') args.coverage = true;
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

/** The question-coverage set (2.2) through `generator`, written to `<out>/coverage-report.json`. */
export async function runCoverage(registry: PackRegistry, generator: QuestionGenerator, out: string): Promise<CoverageReport> {
    const report = await runCoverageEvaluation(loadCoverageEval(), generator, { packs: registry });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'coverage-report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
}

/** The run's summary as Markdown lines (the log and the step summary): names, counts and codes, never text. */
export function summaryLines(results: readonly PackRunResult[], coverage: CoverageReport | null, spent: { microUsd: number; calls: number } | null): string[] {
    const lines = ['| pack | passed | cases | failed cases | ungraded behaviours |', '|---|---|---|---|---|'];
    for (const r of results) lines.push(`| ${r.name} | ${r.passed ? 'yes' : 'NO'} | ${r.cases} | ${r.error ?? (r.failedCases.join(', ') || '—')} | ${r.ungraded} |`);
    if (results.length === 0) lines.push('| (no pack set run) | | | | |');
    if (coverage) {
        lines.push('');
        lines.push(
            coverage.status === 'NOT_ASSESSED'
                ? 'Coverage: not assessed (no sessions).'
                : `Coverage: ${coverage.passed}/${coverage.sessions.length} sessions pass; ${(coverage.coverage * 100).toFixed(1)}% of must-cover keys reached by the generator.`,
        );
    }
    if (spent) lines.push('', `Model calls: ${spent.calls}; spent: $${(spent.microUsd / 1_000_000).toFixed(4)}.`);
    return lines;
}
