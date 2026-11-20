/**
 * `npm run packs:evaluate` — run the interview packs' evaluation sets and
 * write their evaluation records (Phase 2.3). The options are in
 * src/lib/interview/evals/run-evaluations.ts.
 *
 *   npm run packs:evaluate
 *       the STRUCTURAL generator over every pack; each record is written
 *       beside its pack (src/lib/interview/packs/<group>/<dir>/evaluation-record.json).
 *       Development and test mount on these; production never does (D11).
 *       Re-run after editing a pack, its evals.json, the situations or the
 *       question prompt: the mount gate refuses a record that no longer matches.
 *
 *   npm run packs:evaluate -- --reconcile [--no-packs]
 *       also the reconcile step's evaluation sets (Phase 2.5): with the
 *       structural (reference) reconciler, its record is written beside the
 *       sets (src/lib/enrichment/evals/evaluation-record.json). Re-run after
 *       editing the sets, the reconcile prompt or its output schema.
 *
 *   npm run packs:evaluate -- --generator model --out evals-out [--packs a,b] [--coverage] [--reconcile]
 *       a REAL model, through the product's own wired generator and 2.1's
 *       `callStructured` (guard, fence, ledger and spend ceiling all apply),
 *       in a throwaway workspace provisioned for the run. Needs
 *       ANTHROPIC_API_KEY (it never falls back to the structural generator), a
 *       migrated database (DATABASE_URL) and the run's budget in
 *       AI_MONTHLY_CEILING_USD_DEFAULT (the throwaway workspace's ceiling, so
 *       2.1 stops the run when it is spent). Run by the `Evals` workflow
 *       (.github/workflows/evals.yml); its records are an artifact a person
 *       reviews and commits.
 *
 * Exit codes: 0 every pack run passed; 1 a pack failed or a run stopped; 2 the
 * run could not start (arguments, configuration, no key). Prints names, counts
 * and codes, never pack or model text.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { getPacks, PACKS_DIR } from '../src/lib/interview/packs';
import { structuralGenerator, STRUCTURAL_GENERATOR_ID } from '../src/lib/interview/evals/structural-generator';
import {
    metered,
    modelRunBudgetUsd,
    parseEvalArgs,
    runCoverage,
    runPackEvaluations,
    selectedPacks,
    summaryLines,
    withinRunMonth,
    type EvalArgs,
} from '../src/lib/interview/evals/run-evaluations';
import type { QuestionGenerator } from '../src/lib/interview/generator';
import type { Reconciler } from '../src/lib/enrichment/reconciler';
import { REFERENCE_RECONCILER_ID, referenceReconciler } from '../src/lib/enrichment/evals/evaluation';
import { meteredReconciler, reconcilerWithinRunMonth, RECONCILE_RECORD_RELATIVE, runReconcileEvaluation } from '../src/lib/interview/evals/run-evaluations';

function out(line: string): void {
    process.stdout.write(line + '\n');
}

function fail(message: string, code: number): never {
    process.stderr.write(`packs:evaluate: ${message}\n`);
    process.exit(code);
}

/** The wired model generator in a throwaway workspace, and what it closes. */
async function modelGenerator(): Promise<{ generator: QuestionGenerator; reconciler: Reconciler; id: string; reconcilerId: string; close: () => Promise<void> }> {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) fail('ANTHROPIC_API_KEY is not set: a model run never falls back to the structural generator', 2);
    if (!process.env.DATABASE_URL) fail('a model run needs DATABASE_URL (a migrated database: the call ledger and the spend ceiling live there)', 2);
    const budget = (() => {
        try {
            return modelRunBudgetUsd(process.env);
        } catch (err) {
            return fail(err instanceof Error ? err.message : String(err), 2);
        }
    })();
    const [{ provisionAccountWithWorkspace }, { defaultQuestionGenerator }, { getPermissionsForRole }, { modelForTier }, { QUESTION_PROMPT }, { prisma }, { defaultReconciler }, { RECONCILE_PROMPT }] =
        await Promise.all([
            import('../src/app-layer/usecases/sign-up'),
            import('../src/lib/interview/model-seam'),
            import('../src/lib/permissions'),
            import('../src/lib/ai/tiers'),
            import('../src/lib/interview/prompt'),
            import('../src/lib/db'),
            import('../src/lib/enrichment/model-seam'),
            import('../src/lib/enrichment/prompt'),
        ]);
    const requestId = randomUUID();
    const account = await provisionAccountWithWorkspace({
        email: `pack-evals-${randomBytes(6).toString('hex')}@example.invalid`,
        name: 'Pack evaluations',
        passwordHash: null,
        emailVerified: null,
        workspaceName: 'Pack evaluations',
        requestId,
    });
    const ctx = {
        requestId,
        userId: account.userId,
        workspaceId: account.workspaceId,
        workspaceSlug: account.workspaceSlug,
        role: 'OWNER' as const,
        permissions: getPermissionsForRole('OWNER'),
    };
    const generator = defaultQuestionGenerator(ctx);
    const reconciler = defaultReconciler(ctx);
    const unavailable = generator.unavailableReason();
    if (unavailable) fail(`no model call can be made (${unavailable})`, 2);
    const id = modelForTier(QUESTION_PROMPT.tier);
    out(`packs:evaluate: model ${id}, budget $${budget} (the run's workspace ceiling)`);
    return { generator, reconciler, id, reconcilerId: modelForTier(RECONCILE_PROMPT.tier), close: () => prisma.$disconnect() };
}

async function main(): Promise<void> {
    if (process.env.NODE_ENV === 'production') fail('evaluations do not run in production', 2);
    let args: EvalArgs;
    try {
        args = parseEvalArgs(process.argv.slice(2));
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err), 2);
    }
    const registry = getPacks();
    let names: string[];
    try {
        names = selectedPacks(registry, args.packs);
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err), 2);
    }

    const model = args.generator === 'model' ? await modelGenerator() : null;
    const spent = { microUsd: 0, calls: 0 };
    // A model run's budget is a monthly ceiling: its calls are held to the month the run started in.
    const generator = metered(model ? withinRunMonth(model.generator, new Date()) : structuralGenerator(), spent);
    const who = model ? { kind: 'model' as const, id: model.id } : { kind: 'structural' as const, id: STRUCTURAL_GENERATOR_ID };
    const outRoot = args.out ? path.resolve(args.out) : PACKS_DIR;

    try {
        const results = await runPackEvaluations({ registry, names, generator, who, outRoot });
        const coverage = args.coverage ? await runCoverage(registry, generator, args.out ? path.resolve(args.out) : path.resolve('evals-out')) : null;
        let reconcile = null;
        if (args.reconcile) {
            const reconciler = meteredReconciler(model ? reconcilerWithinRunMonth(model.reconciler, new Date()) : referenceReconciler(), spent);
            const rWho = model ? { kind: 'model' as const, id: model.reconcilerId } : { kind: 'structural' as const, id: REFERENCE_RECONCILER_ID };
            const file = args.out ? path.join(path.resolve(args.out), 'reconcile', 'evaluation-record.json') : path.resolve(RECONCILE_RECORD_RELATIVE);
            reconcile = await runReconcileEvaluation(reconciler, rWho, file);
        }
        for (const line of summaryLines(results, coverage, model ? spent : null, reconcile)) out(line);
        const ok =
            results.every((r) => r.passed) &&
            results.length === names.length &&
            (!coverage || coverage.status === 'NOT_ASSESSED' || coverage.passed === coverage.sessions.length) &&
            (!reconcile || reconcile.passed);
        process.exitCode = ok ? 0 : 1;
    } finally {
        await model?.close();
    }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.name : 'error', 1));
