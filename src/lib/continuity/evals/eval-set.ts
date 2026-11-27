/**
 * THE DEEP CONTINUITY CHECK'S EVALUATION SET (Phase 4.2, D28; roadmap rule 9),
 * loaded and checked when the module loads: `continuity.json`, pages of facts
 * with SEEDED CONTRADICTIONS (a value, someone in two places at once, who knows
 * what when, an impossible order) and NEAR MISSES (the same detail at another
 * story time, two values a thing can hold, a vague and a precise fact that
 * agree, learning something later), plus an adversarial fact that tries to
 * instruct the checker. Each case has a reference answer. Since D35 addendum A
 * a case may carry DRAFT facts (the manuscript's claims, after the bible's):
 * draft-vs-bible clashes to find, and near misses (a synonym, another story
 * time, two draft facts that disagree only with each other, which code never
 * pairs).
 *
 * Original content written for Inkquisitor. Imported as JSON so a record is
 * checked against the bytes the build holds.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FACT_PREDICATES } from '@/lib/sources/vocabulary';
import { CONTRADICTION_KINDS } from '../vocabulary';
import setJson from './continuity.json';

const Fact = z
    .object({
        ref: z.string().regex(/^f\d{1,2}$/),
        predicate: z.enum(FACT_PREDICATES),
        subject: z.string().min(1),
        statement: z.string().min(1),
        storyTimeFrom: z.string().nullable(),
        storyTimeTo: z.string().nullable(),
        at: z.object({ element: z.string().min(1), position: z.number().int().min(1), order: z.string().min(1) }).strict().nullable(),
        /** D35 addendum A: a DRAFT fact (the manuscript's claim, its scene named), shown in the "draft-facts" block. */
        draft: z.object({ scene: z.string().min(1) }).strict().optional(),
    })
    .strict();

const CaseSchema = z
    .object({
        id: z.string().regex(/^(cc-\d{2}|adv-\d{2})$/),
        about: z.string().min(1),
        orders: z.array(z.object({ order: z.string().min(1), names: z.array(z.string().min(1)) }).strict()),
        facts: z.array(Fact).min(2),
        expect: z.array(z.object({ a: z.string(), b: z.string(), kind: z.enum(CONTRADICTION_KINDS) }).strict()),
        mustNotPair: z.array(z.tuple([z.string(), z.string()])),
        reference: z.object({ contradictions: z.array(z.unknown()) }).strict(),
    })
    .strict()
    // The call numbers the bible's facts first and the draft's after them: a case lists them in that order, so its
    // references and its reference answer's numbers mean what the call is shown.
    .refine((c) => c.facts.every((f, i) => !c.facts[i - 1]?.draft || f.draft), { message: 'draft facts come after the bible facts' });
export type ContinuityEvalCase = z.infer<typeof CaseSchema>;

const SetSchema = z.object({ format: z.literal('inkquisitor-continuity-eval/1'), cases: z.array(CaseSchema).min(1) }).strict();

export const continuityCases: readonly ContinuityEvalCase[] = SetSchema.parse(setJson).cases;

/** The set's hash, as a record names it. */
export const continuityEvalSet = { hash: `sha256:${createHash('sha256').update(JSON.stringify(setJson)).digest('hex')}` } as const;
