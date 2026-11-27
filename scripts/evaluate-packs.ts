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
 *   npm run packs:evaluate -- --sources [--no-packs]
 *       also source fact extraction's set (Phase 4.0): the reference
 *       extractor's record beside the set (src/lib/sources/evals/
 *       evaluation-record.json). Re-run after editing the set, the extraction
 *       prompt or its output schema.
 *
 *   npm run packs:evaluate -- --bible-facts [--no-packs]
 *       also bible fact extraction's set (Phase 4.1, D27): the reference
 *       extractor's record beside the set (src/lib/facts/evals/
 *       evaluation-record.json). Re-run after editing the set, the bible fact
 *       prompt or its output schema.
 *
 *   npm run packs:evaluate -- --continuity [--no-packs]
 *       also the deep continuity check's set (Phase 4.2, D28): the reference
 *       checker's record beside the set (src/lib/continuity/evals/
 *       evaluation-record.json). Re-run after editing the set, the continuity
 *       prompt or its output schema.
 *
 *   npm run packs:evaluate -- --question-order [--no-packs]
 *       also the interview tie-break's set (Phase 4.4, D30 item 4): its record
 *       beside it (src/lib/interview/question-order/evals/).
 *
 *   npm run packs:evaluate -- --book-level [--no-packs]
 *       also the book-level interrogation sets (Phase 4.3, D29): the stress
 *       test's, the gap hunt ranking's and the long-session rounds summary's,
 *       each reference's record beside its set (src/lib/stress-test/evals/,
 *       src/lib/gap-hunt/evals/, src/lib/interview/evals/compaction-*).
 *       Re-run after editing a set, one of those prompts or its schema.
 *
 *   npm run packs:evaluate -- --research [--no-packs]
 *       also the research agent's evaluation sets (Phase 2.6): the
 *       deterministic researcher's record is written beside the sets
 *       (src/lib/research/evals/evaluation-record.json). Re-run after editing
 *       the sets, the research prompts or their output schemas.
 *
 *   npm run packs:evaluate -- --rephrase [--no-packs]
 *       also the rephrase prompt's set (Phase 2.H, "Ask me this
 *       differently"): the structural rephraser's record is written beside
 *       the set (src/lib/interview/evals/rephrase-evaluation-record.json).
 *       Re-run after editing the set or the rephrase prompt.
 *
 *   npm run packs:evaluate -- --judge
 *       also judge the ungraded behaviours of the pack records the run wrote
 *       (the structural judge here; the model judge on a model run). The
 *       report is evals-out/judge-report.json (or under --out); it gates
 *       nothing: no pass bar is set until real-model evidence argues one.
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
import { meteredReconciler, reconcilerWithinRunMonth, RECONCILE_RECORD_RELATIVE, REPHRASE_RECORD_RELATIVE, runReconcileEvaluation, runRephraseEvaluation } from '../src/lib/interview/evals/run-evaluations';
import { STRUCTURAL_REPHRASER_ID, structuralRephraser } from '../src/lib/interview/evals/rephrase-evaluation';
import { modelJudge, structuralJudge, type Judge } from '../src/lib/evals/judge';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { FactExtractor } from '../src/lib/sources/extractor';
import { checkExtractionRecord, EXTRACTION_RECORD_FORMAT, extractionPromptHash, modelExtractionAnswers, structuralExtractionRecord } from '../src/lib/sources/evals/evaluation';
import { extractionEvalSet } from '../src/lib/sources/evals/eval-set';
import { EXTRACT_PROMPT_VERSION } from '../src/lib/sources/prompt';

import { BIBLE_FACTS_RECORD_FORMAT, bibleFactsPromptHash, checkBibleFactsRecord, modelBibleFactsAnswers, structuralBibleFactsRecord } from '../src/lib/facts/evals/evaluation';
import { bibleFactEvalSet } from '../src/lib/facts/evals/eval-set';
import { BIBLE_FACTS_PROMPT_VERSION } from '../src/lib/facts/prompt';

import { CONTINUITY_RECORD_FORMAT, continuityPromptHash, checkContinuityRecord, modelContinuityAnswers, structuralContinuityRecord, type ContinuitySetReport } from '../src/lib/continuity/evals/evaluation';
import { continuityEvalSet } from '../src/lib/continuity/evals/eval-set';
import { CONTINUITY_PROMPT_VERSION } from '../src/lib/continuity/prompt';

import { checkStressTestRecord, modelStressTestAnswers, STRESS_TEST_RECORD_FORMAT, stressTestPromptHash, structuralStressTestRecord } from '../src/lib/stress-test/evals/evaluation';
import { stressTestEvalSet } from '../src/lib/stress-test/evals/eval-set';
import { STRESS_TEST_PROMPT_VERSION } from '../src/lib/stress-test/prompt';
import { checkGapRankRecord, GAP_RANK_RECORD_FORMAT, gapRankPromptHash, modelGapRankAnswers, structuralGapRankRecord } from '../src/lib/gap-hunt/evals/evaluation';
import { gapHuntEvalSet } from '../src/lib/gap-hunt/evals/eval-set';
import { GAP_RANK_PROMPT_VERSION } from '../src/lib/gap-hunt/prompt';
import { checkCompactionRecord, COMPACTION_RECORD_FORMAT, compactionEvalSet, compactionPromptHash, modelCompactionAnswers, structuralCompactionRecord } from '../src/lib/interview/evals/compaction-evaluation';
import { COMPACTION_PROMPT_VERSION } from '../src/lib/interview/compaction-prompt';
import { checkQuestionOrderRecord, modelQuestionOrderAnswers, QUESTION_ORDER_RECORD_FORMAT, questionOrderPromptHash, structuralQuestionOrderRecord } from '../src/lib/interview/question-order/evals/evaluation';
import { questionOrderEvalSet } from '../src/lib/interview/question-order/evals/eval-set';
import { QUESTION_ORDER_PROMPT_VERSION } from '../src/lib/interview/question-order/prompt';

/** Where the structural tie-break record is written (beside the set), relative to the repository. */
const QUESTION_ORDER_RECORD_RELATIVE = 'src/lib/interview/question-order/evals/evaluation-record.json';

/** The interview tie-break's set (4.4): the record written to `file` and checked as the gate checks it. */
async function runQuestionOrderEvaluation(orderer: FactExtractor | null, modelId: string | null, file: string): Promise<{ passed: boolean; detail: string }> {
    const record = orderer
        ? {
              format: QUESTION_ORDER_RECORD_FORMAT,
              set: { ...questionOrderEvalSet },
              promptVersion: QUESTION_ORDER_PROMPT_VERSION,
              promptHash: questionOrderPromptHash(),
              generator: { kind: 'model' as const, id: modelId ?? 'model' },
              ranAt: new Date().toISOString(),
              answers: await modelQuestionOrderAnswers(orderer),
          }
        : structuralQuestionOrderRecord();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    const check = checkQuestionOrderRecord(record);
    return { passed: check.ok, detail: check.ok ? 'passed' : `${check.reason}: ${check.detail}` };
}

/** The book-level interrogation sets (4.3): each record written beside its set (or under --out) and checked as its gate checks it. */
async function runBookLevelEvaluations(
    model: { stressTester: FactExtractor; stressTesterId: string; gapRanker: FactExtractor; gapRankerId: string; summarizer: FactExtractor; summarizerId: string } | null,
    outRoot: string | null,
): Promise<Array<{ name: string; passed: boolean; detail: string }>> {
    const write = (rel: string, sub: string, record: unknown) => {
        const file = outRoot ? path.join(outRoot, sub, 'evaluation-record.json') : path.resolve(rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    };
    const ranAt = new Date().toISOString();
    const stress = model
        ? { format: STRESS_TEST_RECORD_FORMAT, set: { ...stressTestEvalSet }, promptVersion: STRESS_TEST_PROMPT_VERSION, promptHash: stressTestPromptHash(), generator: { kind: 'model' as const, id: model.stressTesterId }, ranAt, answers: await modelStressTestAnswers(model.stressTester) }
        : structuralStressTestRecord();
    write('src/lib/stress-test/evals/evaluation-record.json', 'stress-test', stress);
    const gap = model
        ? { format: GAP_RANK_RECORD_FORMAT, set: { ...gapHuntEvalSet }, promptVersion: GAP_RANK_PROMPT_VERSION, promptHash: gapRankPromptHash(), generator: { kind: 'model' as const, id: model.gapRankerId }, ranAt, answers: await modelGapRankAnswers(model.gapRanker) }
        : structuralGapRankRecord();
    write('src/lib/gap-hunt/evals/evaluation-record.json', 'gap-hunt', gap);
    const summary = model
        ? { format: COMPACTION_RECORD_FORMAT, set: { ...compactionEvalSet }, promptVersion: COMPACTION_PROMPT_VERSION, promptHash: compactionPromptHash(), generator: { kind: 'model' as const, id: model.summarizerId }, ranAt, answers: await modelCompactionAnswers(model.summarizer) }
        : structuralCompactionRecord();
    write('src/lib/interview/evals/compaction-evaluation-record.json', 'compaction', summary);
    const verdict = (name: string, c: { ok: true } | { ok: false; reason: string; detail: string }) => ({ name, passed: c.ok, detail: c.ok ? 'passed' : `${c.reason}: ${c.detail}` });
    return [verdict('Stress test', checkStressTestRecord(stress)), verdict('Gap ranking', checkGapRankRecord(gap)), verdict('Rounds summary', checkCompactionRecord(summary))];
}

/** Where the structural continuity record is written (beside the set), relative to the repository. */
const CONTINUITY_RECORD_RELATIVE = 'src/lib/continuity/evals/evaluation-record.json';

/** The deep continuity check's set (4.2): the record written to `file` and checked as the gate checks it. */
async function runContinuityEvaluation(checker: FactExtractor | null, modelId: string | null, file: string): Promise<{ passed: boolean; detail: string }> {
    const record = checker
        ? {
              format: CONTINUITY_RECORD_FORMAT,
              set: { ...continuityEvalSet },
              promptVersion: CONTINUITY_PROMPT_VERSION,
              promptHash: continuityPromptHash(),
              generator: { kind: 'model' as const, id: modelId ?? 'model' },
              ranAt: new Date().toISOString(),
              answers: await modelContinuityAnswers(checker),
          }
        : structuralContinuityRecord();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    const check = checkContinuityRecord(record);
    const fmt = (x: number | null) => (x === null ? 'not assessed' : x.toFixed(2));
    // 4.H-b: the false-alarm rate and the recall are reported with every check (never stored in the record).
    const rates = (r: ContinuitySetReport | undefined) => (r ? `, false-alarm rate ${fmt(r.falseAlarmRate)}, recall ${fmt(r.recall)}${r.falseAlarmsByCase.length > 0 ? ` (false alarms: ${r.falseAlarmsByCase.map((f) => `${f.caseId} ×${f.count}`).join(', ')})` : ''}` : '');
    return check.ok
        ? { passed: true, detail: `${check.grades.length} cases, precision ${fmt(check.precision)}${rates(check.report)}` }
        : { passed: false, detail: `${check.reason}: ${check.detail}${rates(check.report)}` };
}

/** Where the structural bible fact record is written (beside the set), relative to the repository. */
const BIBLE_FACTS_RECORD_RELATIVE = 'src/lib/facts/evals/evaluation-record.json';

/** Bible fact extraction's set (4.1): the record written to `file` and checked as the gate checks it. */
async function runBibleFactsEvaluation(extractor: FactExtractor | null, modelId: string | null, file: string): Promise<{ passed: boolean; detail: string }> {
    const record = extractor
        ? {
              format: BIBLE_FACTS_RECORD_FORMAT,
              set: { ...bibleFactEvalSet },
              promptVersion: BIBLE_FACTS_PROMPT_VERSION,
              promptHash: bibleFactsPromptHash(),
              generator: { kind: 'model' as const, id: modelId ?? 'model' },
              ranAt: new Date().toISOString(),
              answers: await modelBibleFactsAnswers(extractor),
          }
        : structuralBibleFactsRecord();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    const check = checkBibleFactsRecord(record);
    return check.ok ? { passed: true, detail: `${check.grades.length} cases` } : { passed: false, detail: `${check.reason}: ${check.detail}` };
}

/** Where the structural extraction record is written (beside the set), relative to the repository. */
const SOURCES_RECORD_RELATIVE = 'src/lib/sources/evals/evaluation-record.json';

/** Source fact extraction's set (4.0): the record written to `file` and checked as the gate checks it. */
async function runSourcesEvaluation(extractor: FactExtractor | null, modelId: string | null, file: string): Promise<{ passed: boolean; detail: string }> {
    const record = extractor
        ? {
              format: EXTRACTION_RECORD_FORMAT,
              set: { ...extractionEvalSet },
              promptVersion: EXTRACT_PROMPT_VERSION,
              promptHash: extractionPromptHash(),
              generator: { kind: 'model' as const, id: modelId ?? 'model' },
              ranAt: new Date().toISOString(),
              answers: await modelExtractionAnswers(extractor),
          }
        : structuralExtractionRecord();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    const check = checkExtractionRecord(record);
    return check.ok ? { passed: true, detail: `${check.grades.length} cases` } : { passed: false, detail: check.reason };
}
import { runJudge } from '../src/lib/interview/evals/run-evaluations';
import type { Researcher } from '../src/lib/research/researcher';
import { checkResearchRecord, modelAnswersWith, researchPromptHash, RESEARCH_RECORD_FORMAT, structuralRecord } from '../src/lib/research/evals/evaluation';
import { researchEvalSets } from '../src/lib/research/evals/eval-set';
import { RESEARCH_PROMPT_VERSION } from '../src/lib/research/prompt';
import * as fs from 'node:fs';

/** Where the structural research record is written (beside the sets), relative to the repository. */
const RESEARCH_RECORD_RELATIVE = 'src/lib/research/evals/evaluation-record.json';

/** The research agent's sets (2.6): the record written to `file` and checked as the gate checks it. */
async function runResearchEvaluation(researcher: Researcher | null, modelId: string | null, file: string): Promise<{ passed: boolean; detail: string }> {
    const now = new Date();
    const record = researcher
        ? {
              format: RESEARCH_RECORD_FORMAT,
              sets: { research: { ...researchEvalSets.research }, adversarial: { ...researchEvalSets.adversarial } },
              promptVersion: RESEARCH_PROMPT_VERSION,
              promptHash: researchPromptHash(),
              generator: { kind: 'model' as const, id: modelId ?? 'model' },
              ranAt: now.toISOString(),
              answers: await modelAnswersWith(researcher),
          }
        : structuralRecord(now);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    const check = await checkResearchRecord(record);
    return check.ok ? { passed: true, detail: `citation validity ${check.validity.toFixed(2)}` } : { passed: false, detail: check.reason };
}

function out(line: string): void {
    process.stdout.write(line + '\n');
}

function fail(message: string, code: number): never {
    process.stderr.write(`packs:evaluate: ${message}\n`);
    process.exit(code);
}

/** The wired model generator in a throwaway workspace, and what it closes. */
async function modelGenerator(): Promise<{ generator: QuestionGenerator; reconciler: Reconciler; researcher: Researcher; extractor: FactExtractor; extractorId: string; bibleExtractor: FactExtractor; bibleExtractorId: string; continuityChecker: FactExtractor; continuityCheckerId: string; stressTester: FactExtractor; stressTesterId: string; gapRanker: FactExtractor; gapRankerId: string; summarizer: FactExtractor; summarizerId: string; orderer: FactExtractor; ordererId: string; judge: Judge; id: string; reconcilerId: string; rephraserId: string; close: () => Promise<void> }> {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) fail('ANTHROPIC_API_KEY is not set: a model run never falls back to the structural generator', 2);
    if (!process.env.DATABASE_URL) fail('a model run needs DATABASE_URL (a migrated database: the call ledger and the spend ceiling live there)', 2);
    const budget = (() => {
        try {
            return modelRunBudgetUsd(process.env);
        } catch (err) {
            return fail(err instanceof Error ? err.message : String(err), 2);
        }
    })();
    const [{ provisionAccountWithWorkspace }, { defaultQuestionGenerator }, { getPermissionsForRole }, { modelForTier }, { QUESTION_PROMPT }, { prisma }, { defaultReconciler }, { RECONCILE_PROMPT }, { defaultResearcher }] =
        await Promise.all([
            import('../src/app-layer/usecases/sign-up'),
            import('../src/lib/interview/model-seam'),
            import('../src/lib/permissions'),
            import('../src/lib/ai/tiers'),
            import('../src/lib/interview/prompt'),
            import('../src/lib/db'),
            import('../src/lib/enrichment/model-seam'),
            import('../src/lib/enrichment/prompt'),
            import('../src/lib/research/model-seam'),
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
    const researcher = defaultResearcher(ctx);
    const unavailable = generator.unavailableReason();
    if (unavailable) fail(`no model call can be made (${unavailable})`, 2);
    const id = modelForTier(QUESTION_PROMPT.tier);
    out(`packs:evaluate: model ${id}, budget $${budget} (the run's workspace ceiling)`);
    const { REPHRASE_PROMPT } = await import('../src/lib/interview/rephrase');
    const { callStructured } = await import('../src/app-layer/usecases/model-calls');
    // The judge's calls go through the same ledger and ceiling as the run's (2.1), in the same throwaway workspace.
    const judge = modelJudge((input) => callStructured(ctx, { ...input, bookId: null }));
    const { defaultFactExtractor } = await import('../src/lib/sources/model-seam');
    const { EXTRACT_PROMPT } = await import('../src/lib/sources/prompt');
    const extractor = defaultFactExtractor(ctx);
    const { defaultBibleFactExtractor } = await import('../src/lib/facts/model-seam');
    const { BIBLE_FACTS_PROMPT } = await import('../src/lib/facts/prompt');
    const bibleExtractor = defaultBibleFactExtractor(ctx);
    const { defaultContinuityChecker } = await import('../src/lib/continuity/model-seam');
    const { CONTINUITY_PROMPT } = await import('../src/lib/continuity/prompt');
    const continuityChecker = defaultContinuityChecker(ctx);
    const { defaultStressTester } = await import('../src/lib/stress-test/model-seam');
    const { STRESS_TEST_PROMPT } = await import('../src/lib/stress-test/prompt');
    const { defaultGapRanker } = await import('../src/lib/gap-hunt/model-seam');
    const { GAP_RANK_PROMPT } = await import('../src/lib/gap-hunt/prompt');
    const { defaultRoundsSummarizer } = await import('../src/lib/interview/compaction-seam');
    const { COMPACTION_PROMPT } = await import('../src/lib/interview/compaction-prompt');
    const { defaultQuestionOrderer } = await import('../src/lib/interview/question-order/model-seam');
    const { QUESTION_ORDER_PROMPT } = await import('../src/lib/interview/question-order/prompt');
    const book = {
        stressTester: defaultStressTester(ctx),
        stressTesterId: modelForTier(STRESS_TEST_PROMPT.tier),
        gapRanker: defaultGapRanker(ctx),
        gapRankerId: modelForTier(GAP_RANK_PROMPT.tier),
        summarizer: defaultRoundsSummarizer(ctx),
        summarizerId: modelForTier(COMPACTION_PROMPT.tier),
        orderer: defaultQuestionOrderer(ctx),
        ordererId: modelForTier(QUESTION_ORDER_PROMPT.tier),
    };
    return { ...book, generator, reconciler, researcher, extractor, extractorId: modelForTier(EXTRACT_PROMPT.tier), bibleExtractor, bibleExtractorId: modelForTier(BIBLE_FACTS_PROMPT.tier), continuityChecker, continuityCheckerId: modelForTier(CONTINUITY_PROMPT.tier), judge, id, reconcilerId: modelForTier(RECONCILE_PROMPT.tier), rephraserId: modelForTier(REPHRASE_PROMPT.tier), close: () => prisma.$disconnect() };
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
        let rephrase = null;
        if (args.rephrase) {
            const file = args.out ? path.join(path.resolve(args.out), 'rephrase', 'evaluation-record.json') : path.resolve(REPHRASE_RECORD_RELATIVE);
            const rephraser = model ? generator : structuralRephraser();
            const rWho = model ? { kind: 'model' as const, id: model.rephraserId } : { kind: 'structural' as const, id: STRUCTURAL_REPHRASER_ID };
            rephrase = await runRephraseEvaluation(registry, rephraser, rWho, file);
        }
        const judgeReport = args.judge ? await runJudge(registry, results, model?.judge ?? structuralJudge(), args.out ? path.resolve(args.out) : path.resolve('evals-out')) : null;
        let research = null;
        if (args.research) {
            const file = args.out ? path.join(path.resolve(args.out), 'research', 'evaluation-record.json') : path.resolve(RESEARCH_RECORD_RELATIVE);
            research = await runResearchEvaluation(model?.researcher ?? null, model?.reconcilerId ?? null, file);
        }
        let sources = null;
        if (args.sources) {
            const file = args.out ? path.join(path.resolve(args.out), 'sources', 'evaluation-record.json') : path.resolve(SOURCES_RECORD_RELATIVE);
            sources = await runSourcesEvaluation(model?.extractor ?? null, model?.extractorId ?? null, file);
        }
        let bibleFacts = null;
        if (args.bibleFacts) {
            const file = args.out ? path.join(path.resolve(args.out), 'bible-facts', 'evaluation-record.json') : path.resolve(BIBLE_FACTS_RECORD_RELATIVE);
            bibleFacts = await runBibleFactsEvaluation(model?.bibleExtractor ?? null, model?.bibleExtractorId ?? null, file);
        }
        let continuity = null;
        if (args.continuity) {
            const file = args.out ? path.join(path.resolve(args.out), 'continuity', 'evaluation-record.json') : path.resolve(CONTINUITY_RECORD_RELATIVE);
            continuity = await runContinuityEvaluation(model?.continuityChecker ?? null, model?.continuityCheckerId ?? null, file);
        }
        const bookLevel = args.bookLevel ? await runBookLevelEvaluations(model, args.out ? path.resolve(args.out) : null) : null;
        let questionOrder = null;
        if (args.questionOrder) {
            const file = args.out ? path.join(path.resolve(args.out), 'question-order', 'evaluation-record.json') : path.resolve(QUESTION_ORDER_RECORD_RELATIVE);
            questionOrder = await runQuestionOrderEvaluation(model?.orderer ?? null, model?.ordererId ?? null, file);
        }
        for (const line of summaryLines(results, coverage, model ? spent : null, reconcile)) out(line);
        for (const b of bookLevel ?? []) out(`${b.name}: ${b.passed ? 'passed' : 'NOT passed'} (${b.detail}).`);
        if (questionOrder) out(`Question order: ${questionOrder.passed ? 'passed' : 'NOT passed'} (${questionOrder.detail}).`);
        if (continuity) out(`Continuity: ${continuity.passed ? 'passed' : 'NOT passed'} (${continuity.detail}).`);
        if (bibleFacts) out(`Bible facts: ${bibleFacts.passed ? 'passed' : 'NOT passed'} (${bibleFacts.detail}).`);
        if (sources) out(`Sources: ${sources.passed ? 'passed' : 'NOT passed'} (${sources.detail}).`);
        if (research) out(`Research: ${research.passed ? 'passed' : 'NOT passed'} (${research.detail}).`);
        if (judgeReport) out(`Judge (${judgeReport.basis}): ${judgeReport.status}; ${judgeReport.failures.length} failing items; ${judgeReport.behaviours.map((b) => `${b.behaviour} ${b.passRate === null ? 'not judged' : `${(b.passRate * 100).toFixed(0)}%`}`).join(', ')}.`);
        if (rephrase) out(`Rephrase: ${rephrase.passed ? 'passed' : 'NOT passed'}; ${rephrase.cases - rephrase.failedCases.length}/${rephrase.cases} cases pass${rephrase.refusal ? ` (${rephrase.refusal})` : ''}; ${rephrase.ungraded} ungraded behaviours.`);
        const ok =
            results.every((r) => r.passed) &&
            results.length === names.length &&
            (!coverage || coverage.status === 'NOT_ASSESSED' || coverage.passed === coverage.sessions.length) &&
            (!reconcile || reconcile.passed) &&
            (!research || research.passed) &&
            (!sources || sources.passed) &&
            (!bibleFacts || bibleFacts.passed) &&
            (!continuity || continuity.passed) &&
            (!bookLevel || bookLevel.every((b) => b.passed)) &&
            (!questionOrder || questionOrder.passed) &&
            (!rephrase || rephrase.passed);
        process.exitCode = ok ? 0 : 1;
    } finally {
        await model?.close();
    }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.name : 'error', 1));
