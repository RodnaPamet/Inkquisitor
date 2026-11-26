/**
 * EVERY PROMPT AND PACK HAS A CURRENT, PASSING EVALUATION RECORD (Phase 2.H
 * item 7; issue #36, item 6). CI runs this, so a change to a prompt or a pack
 * without a fresh evaluation run fails the Test check — rather than reaching
 * main and being refused at mount time in production.
 *
 * Recomputed here, from the source as it stands:
 *
 *   • every product prompt declared with `definePrompt` (an exported
 *     `…_PROMPT`) is named below with the record that evaluates it, so a new
 *     prompt with no evaluation fails until it has one;
 *   • each record's prompt CONTENT hash (`promptContentHash`: system, task,
 *     version, output schema, …) equals the prompt's now — a text change that
 *     kept the version is caught;
 *   • each pack record's pack content hash and set hash equal the pack's now;
 *   • each record passes the check its gate makes (replayed and graded).
 *
 * The fix for a failure is always the same: re-run the evaluation
 * (`npm run packs:evaluate` with the flag named) and commit the record, or, for
 * a real-model record, run the Evals workflow.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRelativeFiles } from '../helpers/repo-files';
import { getPacks, PACKS_DIR, PACK_RECORD_FILE } from '@/lib/interview/packs';
import { checkPackRecord, questionPromptHash } from '@/lib/interview/pack-evaluation';
import { checkReconcileRecord, reconcilePromptHash } from '@/lib/enrichment/evals/evaluation';
import { checkResearchRecord, researchPromptHash } from '@/lib/research/evals/evaluation';
import { checkRephraseRecord, rephrasePromptHash } from '@/lib/interview/evals/rephrase-evaluation';
import reconcileRecord from '@/lib/enrichment/evals/evaluation-record.json';
import researchRecord from '@/lib/research/evals/evaluation-record.json';
import rephraseRecord from '@/lib/interview/evals/rephrase-evaluation-record.json';
import { checkExtractionRecord, extractionPromptHash } from '@/lib/sources/evals/evaluation';
import sourcesRecord from '@/lib/sources/evals/evaluation-record.json';
import { bibleFactsPromptHash, checkBibleFactsRecord } from '@/lib/facts/evals/evaluation';
import bibleFactsRecord from '@/lib/facts/evals/evaluation-record.json';
import { checkContinuityRecord, continuityPromptHash } from '@/lib/continuity/evals/evaluation';
import continuityRecord from '@/lib/continuity/evals/evaluation-record.json';
import { checkStressTestRecord, stressTestPromptHash } from '@/lib/stress-test/evals/evaluation';
import stressTestRecord from '@/lib/stress-test/evals/evaluation-record.json';
import { checkGapRankRecord, gapRankPromptHash } from '@/lib/gap-hunt/evals/evaluation';
import gapRankRecord from '@/lib/gap-hunt/evals/evaluation-record.json';
import { checkCompactionRecord, compactionPromptHash } from '@/lib/interview/evals/compaction-evaluation';
import compactionRecord from '@/lib/interview/evals/compaction-evaluation-record.json';

/** Every exported product prompt, and how its evaluation is re-run. */
const EVALUATED_PROMPTS: Readonly<Record<string, string>> = {
    QUESTION_PROMPT: 'npm run packs:evaluate (every pack record pins it)',
    REPHRASE_PROMPT: 'npm run packs:evaluate -- --no-packs --rephrase',
    RECONCILE_PROMPT: 'npm run packs:evaluate -- --no-packs --reconcile',
    GATHER_PROMPT: 'npm run packs:evaluate -- --no-packs --research',
    FINDINGS_PROMPT: 'npm run packs:evaluate -- --no-packs --research',
    FIT_PROMPT: 'npm run packs:evaluate -- --no-packs --research',
    EXTRACT_PROMPT: 'npm run packs:evaluate -- --no-packs --sources',
    BIBLE_FACTS_PROMPT: 'npm run packs:evaluate -- --no-packs --bible-facts',
    CONTINUITY_PROMPT: 'npm run packs:evaluate -- --no-packs --continuity',
    STRESS_TEST_PROMPT: 'npm run packs:evaluate -- --no-packs --book-level',
    GAP_RANK_PROMPT: 'npm run packs:evaluate -- --no-packs --book-level',
    COMPACTION_PROMPT: 'npm run packs:evaluate -- --no-packs --book-level',
};

/** Prompts that are not product features, each with the reason it has no product evaluation record. */
const NOT_PRODUCT_PROMPTS: Readonly<Record<string, string>> = {
    JUDGE_PROMPT: 'the evaluation-time judge (src/lib/evals/judge.ts): it grades records in the Evals workflow and is never reached from a product path',
};

const recordOf = (rel: string) => (rel ? (JSON.parse(fs.readFileSync(path.join(PACKS_DIR, rel, PACK_RECORD_FILE), 'utf8')) as Record<string, unknown>) : null);

describe('every product prompt is evaluated', () => {
    it('each definePrompt template is named with its evaluation (a new prompt needs a record)', () => {
        // EVERY call of definePrompt, not only an exported `…_PROMPT`: a
        // template that is unexported or named otherwise is a prompt all the
        // same. Each call is a named declaration (whatever its name, which must
        // then be listed below) or a per-call derivation of a declared one
        // (`definePrompt({ ...QUESTION_PROMPT, … })`, whose base the record pins).
        const declared = new Set<string>();
        const derivedFrom: string[] = [];
        const unrecognised: string[] = [];
        for (const rel of repoRelativeFiles()) {
            if (!rel.startsWith('src/') || !/\.tsx?$/.test(rel)) continue;
            const text = fs.readFileSync(rel, 'utf8');
            for (const m of text.matchAll(/\bdefinePrompt\(/g)) {
                const at = m.index;
                if (text.slice(Math.max(0, at - 16), at).endsWith('function ')) continue; // its own definition
                const line = text.slice(text.lastIndexOf('\n', at) + 1, at);
                const named = /^\s*(?:export\s+)?const\s+(\w+)\s*(?::\s*[\w<>.,\s]+)?=\s*$/.exec(line);
                const derived = /^definePrompt\(\{\s*\.\.\.(\w+)\b/.exec(text.slice(at, at + 200));
                if (derived) derivedFrom.push(derived[1]);
                else if (named) declared.add(named[1]);
                else unrecognised.push(`${rel}: a definePrompt call that is neither a named template nor a derivation of one`);
            }
        }
        expect(unrecognised).toEqual([]);
        expect(declared.size).toBeGreaterThanOrEqual(6);
        const unaccounted = [...declared].filter((name) => !(name in EVALUATED_PROMPTS) && !(name in NOT_PRODUCT_PROMPTS));
        expect(unaccounted).toEqual([]);
        // A derivation builds on a declared, evaluated template.
        expect(derivedFrom.filter((name) => !(name in EVALUATED_PROMPTS))).toEqual([]);
        // And no name is listed for a prompt that no longer exists.
        expect(Object.keys(EVALUATED_PROMPTS).filter((n) => !declared.has(n))).toEqual([]);
    });
});

describe('every record pins the prompt and packs as they are now', () => {
    const registry = getPacks();

    it('each pack record names its pack’s content hash, its set’s hash and the question prompt’s content hash', () => {
        const stale: string[] = [];
        for (const file of Object.values(registry.files)) {
            const record = recordOf(file.dir) as { pack?: { contentHash?: string }; set?: { hash?: string }; promptHash?: string } | null;
            if (record?.pack?.contentHash !== file.contentHash) stale.push(`${file.name}: pack changed`);
            if (record?.set?.hash !== file.setHash) stale.push(`${file.name}: evaluation set changed`);
            if (record?.promptHash !== questionPromptHash()) stale.push(`${file.name}: question prompt changed`);
        }
        expect([stale, EVALUATED_PROMPTS.QUESTION_PROMPT]).toEqual([[], EVALUATED_PROMPTS.QUESTION_PROMPT]);
    });

    it.each([
        ['RECONCILE_PROMPT', reconcileRecord, reconcilePromptHash],
        ['GATHER_PROMPT · FINDINGS_PROMPT · FIT_PROMPT', researchRecord, researchPromptHash],
        ['REPHRASE_PROMPT', rephraseRecord, rephrasePromptHash],
        ['EXTRACT_PROMPT', sourcesRecord, extractionPromptHash],
        ['BIBLE_FACTS_PROMPT', bibleFactsRecord, bibleFactsPromptHash],
        ['CONTINUITY_PROMPT', continuityRecord, continuityPromptHash],
        ['STRESS_TEST_PROMPT', stressTestRecord, stressTestPromptHash],
        ['GAP_RANK_PROMPT', gapRankRecord, gapRankPromptHash],
        ['COMPACTION_PROMPT', compactionRecord, compactionPromptHash],
    ] as const)('the %s record names the prompt’s content hash now', (_name, record, current) => {
        expect((record as { promptHash?: string }).promptHash).toBe(current());
    });

    it('every record passes the check its gate makes', async () => {
        const refusals: string[] = [];
        for (const file of Object.values(registry.files)) {
            const check = await checkPackRecord(recordOf(file.dir), file, registry);
            if (!check.ok) refusals.push(`${file.name}: ${check.reason}`);
        }
        const reconcile = await checkReconcileRecord(reconcileRecord);
        if (!reconcile.ok) refusals.push(`reconcile: ${reconcile.reason}`);
        const research = await checkResearchRecord(researchRecord);
        if (!research.ok) refusals.push(`research: ${research.reason}`);
        const rephrase = await checkRephraseRecord(rephraseRecord, registry);
        if (!rephrase.ok) refusals.push(`rephrase: ${rephrase.reason}`);
        const sources = checkExtractionRecord(sourcesRecord);
        if (!sources.ok) refusals.push(`sources: ${sources.reason}`);
        const bibleFacts = checkBibleFactsRecord(bibleFactsRecord);
        if (!bibleFacts.ok) refusals.push(`bible facts: ${bibleFacts.reason}`);
        const continuity = checkContinuityRecord(continuityRecord);
        if (!continuity.ok) refusals.push(`continuity: ${continuity.reason}`);
        const stressTest = checkStressTestRecord(stressTestRecord);
        if (!stressTest.ok) refusals.push(`stress test: ${stressTest.reason}`);
        const gapRank = checkGapRankRecord(gapRankRecord);
        if (!gapRank.ok) refusals.push(`gap ranking: ${gapRank.reason}`);
        const compaction = checkCompactionRecord(compactionRecord);
        if (!compaction.ok) refusals.push(`rounds summary: ${compaction.reason}`);
        expect(refusals).toEqual([]);
    });
});
