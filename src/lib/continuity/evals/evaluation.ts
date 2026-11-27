/**
 * HOW THE DEEP CONTINUITY CHECK PROVES ITSELF BEFORE PRODUCTION RUNS IT
 * (Phase 4.2, D28; roadmap rule 9; decision D11 applied as 4.1 applies it).
 *
 *   • the EVALUATION SET (`continuity.json`) says which pairs of each page are
 *     contradictions, and which near misses are not; it carries no model output;
 *   • an EVALUATION RECORD (`evaluation-record.json`) is the set's hash, the
 *     prompt's version and content hash, a named checker, and the RAW answer it
 *     returned for every case.
 *
 * A record states no figure. Every check REPLAYS each recorded answer through
 * the product's own step (`validateContinuityPairs` over the case's facts, in
 * the order the call is shown them) and grades what would be proposed:
 *
 *   recall       every expected pair is proposed, of its kind
 *   near misses  no `mustNotPair` pair is proposed (a case fails on one)
 *   precision    over the whole set, proposed pairs that are expected, over all
 *                proposed, at least 0.9: fewer than one false alarm in ten
 *
 * Every check also REPORTS (4.H-b, roadmap 4.H item 2) the false-alarm rate —
 * proposed pairs no case expects, over all proposed — the false alarms by case,
 * and the recall over every expected pair. The set holds near misses of each
 * class the roadmap names (a name and a description of one place, negation,
 * two subjects sharing a name, a relative age, knowing that against not
 * knowing who, story positions that do not overlap, two orders the clock
 * cannot compare, synonyms), so the rate means something.
 *
 * THE REFERENCE CHECKER answers each case from its reference answer: a
 * structural record proves the set, the product's rules and the grader agree end
 * to end, and nothing about a model, so production refuses it (D11); a model
 * record holding the reference answers is refused STRUCTURAL_OUTPUT_AS_MODEL.
 */
import { z } from 'zod';
import { combinedPromptHash, promptContentHash } from '@/lib/ai/prompt-hash';
import type { FactExtractor } from '@/lib/sources/extractor';
import { CONTINUITY_PROMPT, CONTINUITY_PROMPT_VERSION, continuityBlocks } from '../prompt';
import { ContinuityOutputSchema } from '../schema';
import { validateContinuityPairs } from '../validate';
import { continuityCases, continuityEvalSet, type ContinuityEvalCase } from './eval-set';

export const CONTINUITY_RECORD_FORMAT = 'inkquisitor-continuity-evaluation/1';
export const REFERENCE_CONTINUITY_CHECKER_ID = 'reference-continuity-checker.1';
export const SET_PRECISION_BAR = 0.9;

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export function continuityPromptHash(): string {
    return combinedPromptHash([promptContentHash(CONTINUITY_PROMPT, ContinuityOutputSchema)]);
}

export const ContinuityRecordSchema = z
    .object({
        format: z.literal(CONTINUITY_RECORD_FORMAT),
        set: z.object({ hash: SHA256 }).strict(),
        promptVersion: z.string().min(1).max(200),
        promptHash: SHA256,
        generator: z.object({ kind: z.enum(['structural', 'model']), id: z.string().min(1).max(128) }).strict(),
        ranAt: z.iso.datetime(),
        answers: z.array(z.object({ caseId: z.string().regex(/^(cc-\d{2}|adv-\d{2})$/), output: z.unknown() }).strict()).max(60),
    })
    .strict();
export type ContinuityRecord = z.infer<typeof ContinuityRecordSchema>;

/** A case's page as the call is shown it. */
export function caseBlocks(c: ContinuityEvalCase) {
    return continuityBlocks({
        facts: c.facts.map((f) => ({ predicate: f.predicate, subjectName: f.subject, statement: f.statement, storyTimeFrom: f.storyTimeFrom, storyTimeTo: f.storyTimeTo, at: f.at })),
        orders: c.orders,
    });
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface ContinuityCaseGrade {
    readonly caseId: string;
    readonly passed: boolean;
    readonly proposed: number;
    readonly correct: number;
    /** 4.H-b: expected pairs in the case, and proposed pairs it does not expect. */
    readonly expected: number;
    readonly falseAlarms: number;
    readonly failures: readonly string[];
}

/** 4.H-b: what a set of grades amounts to (reported with every check, never a figure stored in a record). */
export interface ContinuitySetReport {
    readonly proposed: number;
    readonly correct: number;
    readonly expected: number;
    /** correct / proposed; null when nothing was proposed (rule 6). */
    readonly precision: number | null;
    /** (proposed - correct) / proposed; null when nothing was proposed. */
    readonly falseAlarmRate: number | null;
    /** correct / expected; null when the set expects nothing. */
    readonly recall: number | null;
    readonly falseAlarmsByCase: ReadonlyArray<{ caseId: string; count: number }>;
}

export function continuitySetReport(grades: readonly ContinuityCaseGrade[]): ContinuitySetReport {
    const proposed = grades.reduce((n, g) => n + g.proposed, 0);
    const correct = grades.reduce((n, g) => n + g.correct, 0);
    const expected = grades.reduce((n, g) => n + g.expected, 0);
    return {
        proposed,
        correct,
        expected,
        precision: proposed === 0 ? null : correct / proposed,
        falseAlarmRate: proposed === 0 ? null : (proposed - correct) / proposed,
        recall: expected === 0 ? null : correct / expected,
        falseAlarmsByCase: grades.filter((g) => g.falseAlarms > 0).map((g) => ({ caseId: g.caseId, count: g.falseAlarms })),
    };
}

export function gradeContinuityCase(c: ContinuityEvalCase, answer: unknown): ContinuityCaseGrade {
    const failures: string[] = [];
    const v = validateContinuityPairs(answer, c.facts.map((f) => f.ref));
    const proposed = new Map(v.pairs.map((p) => [pairKey(p.a, p.b), p.kind] as const));
    for (const e of c.expect) {
        const kind = proposed.get(pairKey(e.a, e.b));
        if (!kind) failures.push('MISSED');
        else if (kind !== e.kind) failures.push('WRONG_KIND');
    }
    for (const [a, b] of c.mustNotPair) if (proposed.has(pairKey(a, b))) failures.push('FALSE_ALARM');
    const expected = new Set(c.expect.map((e) => pairKey(e.a, e.b)));
    const correct = [...proposed.keys()].filter((k) => expected.has(k) && proposed.get(k) === c.expect.find((e) => pairKey(e.a, e.b) === k)?.kind).length;
    return { caseId: c.id, passed: failures.length === 0, proposed: proposed.size, correct, expected: expected.size, falseAlarms: proposed.size - correct, failures: [...new Set(failures)] };
}

export type ContinuityRecordCheck =
    | { ok: true; record: ContinuityRecord; grades: ContinuityCaseGrade[]; precision: number | null; report: ContinuitySetReport }
    | { ok: false; reason: 'MALFORMED' | 'SET_CHANGED' | 'PROMPT_CHANGED' | 'CASES_MISSING' | 'STRUCTURAL_MISMATCH' | 'STRUCTURAL_OUTPUT_AS_MODEL' | 'BELOW_BAR'; detail: string; report?: ContinuitySetReport };

function referenceAnswer(c: ContinuityEvalCase): ContinuityRecord['answers'][number] {
    return { caseId: c.id, output: c.reference };
}

/** Does this case's reference answer name at least one contradiction? */
function referenceNamesSomething(c: ContinuityEvalCase): boolean {
    const r = c.reference as { contradictions?: unknown } | null;
    return Array.isArray(r?.contradictions) && r.contradictions.length > 0;
}

export function checkContinuityRecord(raw: unknown): ContinuityRecordCheck {
    const parsed = ContinuityRecordSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED', detail: parsed.error.issues.map((i) => i.path.join('.')).join(', ') };
    const record = parsed.data;
    if (record.set.hash !== continuityEvalSet.hash) return { ok: false, reason: 'SET_CHANGED', detail: 'the evaluation set changed since the record was made' };
    if (record.promptVersion !== CONTINUITY_PROMPT_VERSION) return { ok: false, reason: 'PROMPT_CHANGED', detail: `${record.promptVersion} ≠ ${CONTINUITY_PROMPT_VERSION}` };
    if (record.promptHash !== continuityPromptHash()) return { ok: false, reason: 'PROMPT_CHANGED', detail: 'the continuity prompt or its output schema changed since the record was made; re-run the evaluation' };
    const byCase = new Map(record.answers.map((a) => [a.caseId, a] as const));
    const missing = continuityCases.filter((c) => !byCase.has(c.id)).map((c) => c.id);
    if (missing.length > 0) return { ok: false, reason: 'CASES_MISSING', detail: missing.join(', ') };
    // A model that finds nothing where the reference finds nothing (cc-05) answers exactly as the reference does: one
    // coinciding case is what a faithful model does (2.5's rule, 4.3's stress test; #63). A model record is refused only
    // when EVERY case whose reference names a contradiction holds the reference answer.
    let named = 0;
    let coinciding = 0;
    for (const c of continuityCases) {
        const recorded = JSON.stringify(byCase.get(c.id));
        const reference = JSON.stringify(referenceAnswer(c));
        if (record.generator.kind === 'structural' && recorded !== reference) return { ok: false, reason: 'STRUCTURAL_MISMATCH', detail: c.id };
        if (referenceNamesSomething(c)) {
            named++;
            if (recorded === reference) coinciding++;
        }
    }
    if (record.generator.kind === 'model' && named > 0 && coinciding === named) {
        return { ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL', detail: 'every case with a contradiction holds the reference checker\'s answer, recorded as a model\'s' };
    }
    const grades = continuityCases.map((c) => gradeContinuityCase(c, byCase.get(c.id)!.output));
    const report = continuitySetReport(grades);
    const failed = grades.filter((g) => !g.passed);
    if (failed.length > 0) return { ok: false, reason: 'BELOW_BAR', detail: failed.map((g) => `${g.caseId}: ${g.failures.join('+')}`).join('; '), report };
    // Rule 6: a set over which nothing was proposed has no precision to report; the recall checks already failed it.
    const precision = report.precision;
    if (precision !== null && precision < SET_PRECISION_BAR) return { ok: false, reason: 'BELOW_BAR', detail: `precision ${precision.toFixed(2)} < ${SET_PRECISION_BAR}`, report };
    return { ok: true, record, grades, precision, report };
}

/** The structural record the reference checker makes now (`npm run packs:evaluate -- --no-packs --continuity`). */
export function structuralContinuityRecord(ranAt: Date = new Date()): ContinuityRecord {
    return {
        format: CONTINUITY_RECORD_FORMAT,
        set: { ...continuityEvalSet },
        promptVersion: CONTINUITY_PROMPT_VERSION,
        promptHash: continuityPromptHash(),
        generator: { kind: 'structural', id: REFERENCE_CONTINUITY_CHECKER_ID },
        ranAt: ranAt.toISOString(),
        answers: continuityCases.map(referenceAnswer),
    };
}

/** A model's answers for every case (the Evals workflow, `--continuity`), over the very blocks production sends. */
export async function modelContinuityAnswers(checker: FactExtractor): Promise<ContinuityRecord['answers']> {
    const answers: ContinuityRecord['answers'] = [];
    for (const c of continuityCases) {
        const r = await checker.extract({ data: caseBlocks(c), bookId: null });
        answers.push({ caseId: c.id, output: r.ok ? r.output : { contradictions: [] } });
    }
    return answers;
}
