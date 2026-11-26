/**
 * `npm run redteam:injection` — the prompt-injection corpus against the REAL
 * model, through the product's own steps (Phase 2.H, roadmap item 1: "run
 * garak or an equivalent nightly"). Run by the `Injection red-team` workflow
 * (.github/workflows/injection-redteam.yml); see src/lib/redteam/injection-suite.ts
 * for what it checks.
 *
 *   npm run redteam:injection -- --out redteam-out
 *
 * Needs ANTHROPIC_API_KEY (no structural fallback: a run without the model
 * measures nothing), a migrated database (DATABASE_URL: the call ledger and
 * the spend ceiling live there) and the run's budget in
 * AI_MONTHLY_CEILING_USD_DEFAULT (at most REDTEAM_BUDGET_MAX_USD), the ceiling
 * of the throwaway workspace the run provisions, which 2.1 checks against
 * each call's worst case BEFORE it is sent.
 *
 * Every call goes through 2.1's `callStructured` (guard, fence, ledger,
 * ceiling). The SDK is handed a fetch that keeps each request body in memory,
 * so the TOOLS property and the request half of CROSS_BOOK are checked
 * against what was really sent; the bodies are the corpus's synthetic text and
 * are never written anywhere.
 *
 * Writes `<out>/redteam-report.json` (case ids, surfaces, attacks, outcomes,
 * violated properties, counts: never model text) and prints a summary.
 * Exit codes: 0 every case held every property; 1 a violation, or no case
 * reached the model (a night that probed nothing is not a pass); 2 the run
 * could not start.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

function out(line: string): void {
    process.stdout.write(line + '\n');
}

function fail(message: string, code: number): never {
    process.stderr.write(`redteam:injection: ${message}\n`);
    process.exit(code);
}

function outDirOf(argv: readonly string[]): string {
    const i = argv.indexOf('--out');
    const v = i >= 0 ? argv[i + 1] : 'redteam-out';
    if (!v || v.startsWith('-')) fail('--out needs a directory', 2);
    return v;
}

async function main(): Promise<void> {
    if (process.env.NODE_ENV === 'production') fail('the red-team does not run in production', 2);
    if (!process.env.ANTHROPIC_API_KEY?.trim()) fail('ANTHROPIC_API_KEY is not set: the red-team needs the real model', 2);
    if (!process.env.DATABASE_URL) fail('DATABASE_URL is required (the call ledger and the spend ceiling live there)', 2);
    const outDir = path.resolve(outDirOf(process.argv.slice(2)));
    const suite = await import('../src/lib/redteam/injection-suite');
    const raw = process.env.AI_MONTHLY_CEILING_USD_DEFAULT;
    const budget = raw && /^\d+(\.\d{1,2})?$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(budget > 0) || budget > suite.REDTEAM_BUDGET_MAX_USD) {
        fail(`AI_MONTHLY_CEILING_USD_DEFAULT must be the run's budget, more than 0 and at most ${suite.REDTEAM_BUDGET_MAX_USD} US dollars`, 2);
    }

    const [{ provisionAccountWithWorkspace }, { getPermissionsForRole }, { callStructured, modelUnavailableReason }, { questionGeneratorOver }, { reconcilerOver }, { defaultResearcher }, { prisma }, { defaultFactExtractor }, { defaultBibleFactExtractor }, { defaultContinuityChecker }, { defaultStressTester }, { defaultGapRanker }, { defaultRoundsSummarizer }] =
        await Promise.all([
            import('../src/app-layer/usecases/sign-up'),
            import('../src/lib/permissions'),
            import('../src/app-layer/usecases/model-calls'),
            import('../src/lib/interview/model-seam'),
            import('../src/lib/enrichment/model-seam'),
            import('../src/lib/research/model-seam'),
            import('../src/lib/db'),
            import('../src/lib/sources/model-seam'),
            import('../src/lib/facts/model-seam'),
            import('../src/lib/continuity/model-seam'),
            import('../src/lib/stress-test/model-seam'),
            import('../src/lib/gap-hunt/model-seam'),
            import('../src/lib/interview/compaction-seam'),
        ]);
    const unavailable = modelUnavailableReason();
    if (unavailable) fail(`no model call can be made (${unavailable})`, 2);

    const requestId = randomUUID();
    const account = await provisionAccountWithWorkspace({
        email: `redteam-${randomBytes(6).toString('hex')}@example.invalid`,
        name: 'Injection red-team',
        passwordHash: null,
        emailVerified: null,
        workspaceName: 'Injection red-team',
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

    // What left the process, kept in memory only (the corpus's synthetic text).
    const sent: Array<Record<string, unknown>> = [];
    const capture: typeof fetch = async (input, init) => {
        if (typeof init?.body === 'string') {
            try {
                sent.push(JSON.parse(init.body) as Record<string, unknown>);
            } catch {
                sent.push({});
            }
        }
        return fetch(input, init);
    };

    try {
        const report = await suite.runInjectionSuite({
            generator: questionGeneratorOver((input) => callStructured(ctx, input, { fetch: capture })),
            reconciler: reconcilerOver((input) => callStructured(ctx, input, { fetch: capture })),
            researcher: defaultResearcher(ctx, { fetch: capture }),
            extractor: defaultFactExtractor(ctx, { fetch: capture }),
            bibleExtractor: defaultBibleFactExtractor(ctx, { fetch: capture }),
            continuityChecker: defaultContinuityChecker(ctx, { fetch: capture }),
            stressTester: defaultStressTester(ctx, { fetch: capture }),
            gapRanker: defaultGapRanker(ctx, { fetch: capture }),
            roundsSummarizer: defaultRoundsSummarizer(ctx, { fetch: capture }),
            requests: () => sent,
        });
        const reached = report.cases.filter((v) => !suite.UNREACHED_OUTCOMES.has(v.outcome)).length;
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(
            path.join(outDir, 'redteam-report.json'),
            JSON.stringify({ format: 'inkquisitor-injection-redteam/1', ranAt: new Date().toISOString(), budgetUsd: budget, requests: sent.length, reached, ...report }, null, 2) + '\n',
        );
        out('## Injection red-team');
        out(`Corpus ${report.corpusHash}: ${report.cases.length} cases, ${reached} reached the model, ${sent.length} requests, budget $${budget}.`);
        for (const v of report.cases) {
            out(`- ${v.caseId} ${v.surface} ${v.attack}: ${v.outcome}; kept ${v.kept}; ${v.violations.length === 0 ? 'held' : `VIOLATED ${v.violations.join(', ')}`}`);
        }
        if (reached === 0) {
            out('No case reached the model: the night measured nothing (NO_MODEL_TURNS).');
            process.exitCode = 1;
        } else {
            process.exitCode = report.violations === 0 ? 0 : 1;
        }
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.name : 'error', 1));
