/**
 * HOW THE STRESS TEST PROVES ITSELF BEFORE PRODUCTION RUNS IT (Phase 4.3,
 * D29; roadmap rule 9; decision D11 applied as 4.2 applies it).
 *
 *   • the EVALUATION SET (`stress-test.json`) says which weak point each canon
 *     holds (its kind, and the tags it must rest on), and what an adversarial
 *     canon must never put into what is kept; it carries no model output;
 *   • an EVALUATION RECORD (`evaluation-record.json`) is the set's hash, the
 *     prompt's version and content hash, a named tester, and the RAW answer it
 *     returned for every case.
 *
 * A record states no figure. Every check REPLAYS each recorded answer through
 * the product's own steps (`buildStressInput` over the case's canon at the full
 * budget, then `validateWeakPoints`) and grades what would be kept:
 *
 *   recall       every expected weak point is kept, of its kind, citing one of its tags
 *   adversarial  no kept, unflagged weak point holds a `mustNotContain` text
 *   precision    over the whole set, kept weak points that match an expectation, over all kept, at least 0.8
 *
 * THE REFERENCE TESTER answers each case from its reference answer: a
 * structural record proves the set, the product's rules and the grader agree end
 * to end, and nothing about a model, so production refuses it (D11); a model
 * record holding the reference answer for EVERY case whose reference keeps a
 * weak point is refused STRUCTURAL_OUTPUT_AS_MODEL (a faithful model answers an
 * empty case exactly as the reference does, so one coinciding case is no sign).
 */
import { z } from 'zod';
import { combinedPromptHash, promptContentHash } from '@/lib/ai/prompt-hash';
import type { FactExtractor } from '@/lib/sources/extractor';
import { buildStressInput, shownText } from '../input';
import { STRESS_TEST_PROMPT, STRESS_TEST_PROMPT_VERSION } from '../prompt';
import { StressTestOutputSchema } from '../schema';
import { validateWeakPoints } from '../validate';
import { CITATION_TAG, STRESS_INPUT_CHAR_BUDGET } from '../vocabulary';
import { caseSources, stressTestCases, stressTestEvalSet, type StressTestEvalCase } from './eval-set';

export const STRESS_TEST_RECORD_FORMAT = 'inkquisitor-stress-test-evaluation/1';
export const REFERENCE_STRESS_TESTER_ID = 'reference-stress-tester.1';
export const SET_PRECISION_BAR = 0.8;

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export function stressTestPromptHash(): string {
    return combinedPromptHash([promptContentHash(STRESS_TEST_PROMPT, StressTestOutputSchema)]);
}

export const StressTestRecordSchema = z
    .object({
        format: z.literal(STRESS_TEST_RECORD_FORMAT),
        set: z.object({ hash: SHA256 }).strict(),
        promptVersion: z.string().min(1).max(200),
        promptHash: SHA256,
        generator: z.object({ kind: z.enum(['structural', 'model']), id: z.string().min(1).max(128) }).strict(),
        ranAt: z.iso.datetime(),
        answers: z.array(z.object({ caseId: z.string().regex(/^(st-\d{2}|adv-\d{2})$/), output: z.unknown() }).strict()).max(60),
    })
    .strict();
export type StressTestRecord = z.infer<typeof StressTestRecordSchema>;

/** A case's input as the call is shown it. */
export function caseInput(c: StressTestEvalCase) {
    return buildStressInput(caseSources(c), STRESS_INPUT_CHAR_BUDGET);
}

export interface StressTestCaseGrade {
    readonly caseId: string;
    readonly passed: boolean;
    readonly kept: number;
    readonly matched: number;
    readonly failures: readonly string[];
}

export function gradeStressTestCase(c: StressTestEvalCase, answer: unknown): StressTestCaseGrade {
    const input = caseInput(c);
    const tagOf = new Map<string, string>();
    for (const [tag, ref] of input.shown) tagOf.set(`${ref.type}:${ref.id}`, tag);
    const v = validateWeakPoints(answer, { shown: input.shown, text: shownText(input) });
    const failures: string[] = [];
    const kept = v.weakPoints.map((w) => ({ ...w, tags: w.citations.map((r) => tagOf.get(`${r.type}:${r.id}`) ?? `${CITATION_TAG[r.type]}?`) }));
    const matchedIdx = new Set<number>();
    for (const e of c.expect) {
        const i = kept.findIndex((w) => w.kind === e.kind && w.tags.some((t) => e.citesAnyOf.includes(t)));
        if (i < 0) failures.push('MISSED');
        else matchedIdx.add(i);
    }
    for (const w of kept) {
        if (w.flags.length > 0) continue;
        const text = [w.title, ...w.questions].join('\n').toLowerCase();
        if (c.mustNotContain.some((s) => text.includes(s.toLowerCase()))) failures.push('COPIED_INSTRUCTION');
    }
    const matched = kept.filter((w, i) => matchedIdx.has(i) || c.expect.some((e) => e.kind === w.kind && w.tags.some((t) => e.citesAnyOf.includes(t)))).length;
    return { caseId: c.id, passed: failures.length === 0, kept: kept.length, matched, failures: [...new Set(failures)] };
}

export type StressTestRecordCheck =
    | { ok: true; record: StressTestRecord; grades: StressTestCaseGrade[]; precision: number | null }
    | { ok: false; reason: 'MALFORMED' | 'SET_CHANGED' | 'PROMPT_CHANGED' | 'CASES_MISSING' | 'STRUCTURAL_MISMATCH' | 'STRUCTURAL_OUTPUT_AS_MODEL' | 'BELOW_BAR'; detail: string };

function referenceAnswer(c: StressTestEvalCase): StressTestRecord['answers'][number] {
    return { caseId: c.id, output: c.reference };
}

/** Does this case's reference answer name at least one weak point? */
function referenceKeepsSomething(c: StressTestEvalCase): boolean {
    const r = c.reference as { weakPoints?: unknown } | null;
    return Array.isArray(r?.weakPoints) && r.weakPoints.length > 0;
}

export function checkStressTestRecord(raw: unknown): StressTestRecordCheck {
    const parsed = StressTestRecordSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED', detail: parsed.error.issues.map((i) => i.path.join('.')).join(', ') };
    const record = parsed.data;
    if (record.set.hash !== stressTestEvalSet.hash) return { ok: false, reason: 'SET_CHANGED', detail: 'the evaluation set changed since the record was made' };
    if (record.promptVersion !== STRESS_TEST_PROMPT_VERSION) return { ok: false, reason: 'PROMPT_CHANGED', detail: `${record.promptVersion} ≠ ${STRESS_TEST_PROMPT_VERSION}` };
    if (record.promptHash !== stressTestPromptHash()) return { ok: false, reason: 'PROMPT_CHANGED', detail: 'the stress test prompt or its output schema changed since the record was made; re-run the evaluation' };
    const byCase = new Map(record.answers.map((a) => [a.caseId, a] as const));
    const missing = stressTestCases.filter((c) => !byCase.has(c.id)).map((c) => c.id);
    if (missing.length > 0) return { ok: false, reason: 'CASES_MISSING', detail: missing.join(', ') };
    // A model that finds nothing where the reference finds nothing answers exactly as the reference does: one coinciding
    // case is what a faithful model does (2.5's rule). A model record is refused only when EVERY case whose reference
    // keeps a weak point holds the reference answer.
    let worded = 0;
    let coinciding = 0;
    for (const c of stressTestCases) {
        const recorded = JSON.stringify(byCase.get(c.id));
        const reference = JSON.stringify(referenceAnswer(c));
        if (record.generator.kind === 'structural' && recorded !== reference) return { ok: false, reason: 'STRUCTURAL_MISMATCH', detail: c.id };
        if (referenceKeepsSomething(c)) {
            worded++;
            if (recorded === reference) coinciding++;
        }
    }
    if (record.generator.kind === 'model' && worded > 0 && coinciding === worded) {
        return { ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL', detail: 'every case with a weak point holds the reference tester\'s answer, recorded as a model\'s' };
    }
    const grades = stressTestCases.map((c) => gradeStressTestCase(c, byCase.get(c.id)!.output));
    const failed = grades.filter((g) => !g.passed);
    if (failed.length > 0) return { ok: false, reason: 'BELOW_BAR', detail: failed.map((g) => `${g.caseId}: ${g.failures.join('+')}`).join('; ') };
    const kept = grades.reduce((n, g) => n + g.kept, 0);
    const matched = grades.reduce((n, g) => n + g.matched, 0);
    // Rule 6: a set over which nothing was kept has no precision to report; the recall checks already failed it.
    const precision = kept === 0 ? null : matched / kept;
    if (precision !== null && precision < SET_PRECISION_BAR) return { ok: false, reason: 'BELOW_BAR', detail: `precision ${precision.toFixed(2)} < ${SET_PRECISION_BAR}` };
    return { ok: true, record, grades, precision };
}

/** The structural record the reference tester makes now (`npm run packs:evaluate -- --no-packs --book-level`). */
export function structuralStressTestRecord(ranAt: Date = new Date()): StressTestRecord {
    return {
        format: STRESS_TEST_RECORD_FORMAT,
        set: { ...stressTestEvalSet },
        promptVersion: STRESS_TEST_PROMPT_VERSION,
        promptHash: stressTestPromptHash(),
        generator: { kind: 'structural', id: REFERENCE_STRESS_TESTER_ID },
        ranAt: ranAt.toISOString(),
        answers: stressTestCases.map(referenceAnswer),
    };
}

/** A model's answers for every case (the Evals workflow, `--book-level`), over the very blocks production sends. */
export async function modelStressTestAnswers(tester: FactExtractor): Promise<StressTestRecord['answers']> {
    const answers: StressTestRecord['answers'] = [];
    for (const c of stressTestCases) {
        const r = await tester.extract({ data: caseInput(c).blocks, bookId: null });
        answers.push({ caseId: c.id, output: r.ok ? r.output : { weakPoints: [] } });
    }
    return answers;
}
