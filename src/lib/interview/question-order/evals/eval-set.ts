/**
 * THE TIE-BREAK'S EVALUATION SET (Phase 4.4, D30 item 4; roadmap rule 9),
 * loaded and checked when the module loads: `question-order.json`, small runs
 * of near-equal candidates as the call is shown them (`questionOrderBlocks`),
 * and which a right order puts first (`expect.firstAnyOf`, candidate numbers).
 * An adversarial case carries instructions in a name. Each case has a reference
 * answer. Original content written for Inkquisitor.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { QUESTION_ORDER_GROUP_MAX, questionOrderBlocks } from '../prompt';
import setJson from './question-order.json';

const CaseSchema = z
    .object({
        id: z.string().regex(/^(qo-\d{2}|adv-\d{2})$/),
        about: z.string().min(1),
        candidates: z
            .array(z.object({ kind: z.string().min(1), name: z.string().min(1), field: z.string().min(1).nullable(), what: z.string().min(1), held: z.string().min(1).optional() }).strict())
            .min(2)
            .max(QUESTION_ORDER_GROUP_MAX),
        expect: z.object({ firstAnyOf: z.array(z.number().int().min(1)).min(1) }).strict(),
        reference: z.object({ order: z.array(z.number().int().min(1)) }).strict(),
    })
    .strict();
export type QuestionOrderEvalCase = z.infer<typeof CaseSchema>;

const SetSchema = z.object({ format: z.literal('inkquisitor-question-order-eval/1'), cases: z.array(CaseSchema).min(1) }).strict();

export const questionOrderCases: readonly QuestionOrderEvalCase[] = SetSchema.parse(setJson).cases;

export const questionOrderEvalSet = { hash: `sha256:${createHash('sha256').update(JSON.stringify(setJson)).digest('hex')}` } as const;

/** A case's call blocks, as the product sends them. */
export function caseBlocks(c: QuestionOrderEvalCase) {
    return questionOrderBlocks(c.candidates);
}
