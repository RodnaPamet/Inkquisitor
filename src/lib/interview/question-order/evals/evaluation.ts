/**
 * HOW THE TIE-BREAK PROVES ITSELF (Phase 4.4, D30 item 4; rule 9; D11). A record
 * is the set's hash, the prompt's version and content hash, a named orderer and
 * its RAW answer per case. Every check REPLAYS each answer through the
 * product's own step (`validateQuestionOrder`) and grades what would be kept:
 *
 *   accepted     the answer is an exact permutation of the case's numbers (else the product keeps the code's order,
 *                which it handles, but a record whose answers are refused proves nothing)
 *   first        the first candidate of the accepted order is one of the case's `firstAnyOf` — for an adversarial
 *                case, never the candidate whose name asked to be put first
 *
 * The reference orderer's structural record proves the set and the rule agree; production refuses it (D11).
 */
import { z } from 'zod';
import { combinedPromptHash, promptContentHash } from '@/lib/ai/prompt-hash';
import type { FactExtractor } from '@/lib/sources/extractor';
import { QUESTION_ORDER_PROMPT, QUESTION_ORDER_PROMPT_VERSION } from '../prompt';
import { QuestionOrderOutputSchema } from '../schema';
import { validateQuestionOrder } from '../validate';
import { caseBlocks, questionOrderCases, questionOrderEvalSet, type QuestionOrderEvalCase } from './eval-set';

export const QUESTION_ORDER_RECORD_FORMAT = 'inkquisitor-question-order-evaluation/1';
export const REFERENCE_QUESTION_ORDERER_ID = 'reference-question-orderer.1';

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export function questionOrderPromptHash(): string {
    return combinedPromptHash([promptContentHash(QUESTION_ORDER_PROMPT, QuestionOrderOutputSchema)]);
}

export const QuestionOrderRecordSchema = z
    .object({
        format: z.literal(QUESTION_ORDER_RECORD_FORMAT),
        set: z.object({ hash: SHA256 }).strict(),
        promptVersion: z.string().min(1).max(200),
        promptHash: SHA256,
        generator: z.object({ kind: z.enum(['structural', 'model']), id: z.string().min(1).max(128) }).strict(),
        ranAt: z.iso.datetime(),
        answers: z.array(z.object({ caseId: z.string().regex(/^(qo-\d{2}|adv-\d{2})$/), output: z.unknown() }).strict()).max(60),
    })
    .strict();
export type QuestionOrderRecord = z.infer<typeof QuestionOrderRecordSchema>;

export function gradeQuestionOrderCase(c: QuestionOrderEvalCase, answer: unknown): { caseId: string; passed: boolean; failures: string[] } {
    const v = validateQuestionOrder(answer, c.candidates.length);
    const failures: string[] = [];
    if (!v.ok) failures.push(v.reason);
    else if (!c.expect.firstAnyOf.includes(v.order[0])) failures.push('WRONG_FIRST');
    return { caseId: c.id, passed: failures.length === 0, failures };
}

export type QuestionOrderRecordCheck =
    | { ok: true; record: QuestionOrderRecord }
    | { ok: false; reason: 'MALFORMED' | 'SET_CHANGED' | 'PROMPT_CHANGED' | 'CASES_MISSING' | 'STRUCTURAL_MISMATCH' | 'STRUCTURAL_OUTPUT_AS_MODEL' | 'BELOW_BAR'; detail: string };

function referenceAnswer(c: QuestionOrderEvalCase): QuestionOrderRecord['answers'][number] {
    return { caseId: c.id, output: c.reference };
}

export function checkQuestionOrderRecord(raw: unknown): QuestionOrderRecordCheck {
    const parsed = QuestionOrderRecordSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED', detail: parsed.error.issues.map((i) => i.path.join('.')).join(', ') };
    const record = parsed.data;
    if (record.set.hash !== questionOrderEvalSet.hash) return { ok: false, reason: 'SET_CHANGED', detail: 'the evaluation set changed since the record was made' };
    if (record.promptVersion !== QUESTION_ORDER_PROMPT_VERSION) return { ok: false, reason: 'PROMPT_CHANGED', detail: `${record.promptVersion} ≠ ${QUESTION_ORDER_PROMPT_VERSION}` };
    if (record.promptHash !== questionOrderPromptHash()) return { ok: false, reason: 'PROMPT_CHANGED', detail: 'the tie-break prompt or its output schema changed since the record was made; re-run the evaluation' };
    const byCase = new Map(record.answers.map((a) => [a.caseId, a] as const));
    const missing = questionOrderCases.filter((c) => !byCase.has(c.id)).map((c) => c.id);
    if (missing.length > 0) return { ok: false, reason: 'CASES_MISSING', detail: missing.join(', ') };
    for (const c of questionOrderCases) {
        const recorded = JSON.stringify(byCase.get(c.id));
        const reference = JSON.stringify(referenceAnswer(c));
        if (record.generator.kind === 'structural' && recorded !== reference) return { ok: false, reason: 'STRUCTURAL_MISMATCH', detail: c.id };
        if (record.generator.kind === 'model' && recorded === reference) return { ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL', detail: c.id };
    }
    const failed = questionOrderCases.map((c) => gradeQuestionOrderCase(c, byCase.get(c.id)!.output)).filter((g) => !g.passed);
    if (failed.length > 0) return { ok: false, reason: 'BELOW_BAR', detail: failed.map((g) => `${g.caseId}: ${g.failures.join('+')}`).join('; ') };
    return { ok: true, record };
}

export function structuralQuestionOrderRecord(ranAt: Date = new Date()): QuestionOrderRecord {
    return {
        format: QUESTION_ORDER_RECORD_FORMAT,
        set: { ...questionOrderEvalSet },
        promptVersion: QUESTION_ORDER_PROMPT_VERSION,
        promptHash: questionOrderPromptHash(),
        generator: { kind: 'structural', id: REFERENCE_QUESTION_ORDERER_ID },
        ranAt: ranAt.toISOString(),
        answers: questionOrderCases.map(referenceAnswer),
    };
}

export async function modelQuestionOrderAnswers(orderer: FactExtractor): Promise<QuestionOrderRecord['answers']> {
    const answers: QuestionOrderRecord['answers'] = [];
    for (const c of questionOrderCases) {
        const r = await orderer.extract({ data: caseBlocks(c), bookId: null });
        answers.push({ caseId: c.id, output: r.ok ? r.output : { order: [] } });
    }
    return answers;
}
