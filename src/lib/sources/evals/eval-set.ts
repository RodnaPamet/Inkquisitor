/**
 * THE FACT EXTRACTION EVALUATION SET (Phase 4.0; roadmap rule 9), loaded and
 * checked when the module loads: `extraction.json`, five passages across
 * genres (an author's draft, notes, an earlier book) with the facts a right
 * extraction finds — negation kept ("never learned to swim"), a story time,
 * a place's kind, a group's purpose and membership — and three adversarial
 * passages carrying an instruction to the model, a request for its prompt,
 * and planted markup with a link. Each case has a reference answer.
 *
 * Original content written for Inkquisitor; every address is under the
 * reserved `.example` name. Imported as JSON so a record is checked against
 * the bytes the build holds.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FACT_PREDICATES } from '../vocabulary';
import extractionJson from './extraction.json';

const CaseSchema = z
    .object({
        id: z.string().regex(/^(sf|adv)-\d{2}$/),
        genre: z.string().min(1),
        attack: z.string().optional(),
        headings: z.array(z.string().min(1)),
        bookNames: z.array(z.string().min(1)),
        passage: z.string().min(20),
        expect: z.array(z.object({ subject: z.string().min(1), predicate: z.enum(FACT_PREDICATES), mustContain: z.array(z.string().min(1)).min(1) }).strict()).min(1),
        mustNotContain: z.array(z.string()),
        reference: z.object({ facts: z.array(z.unknown()) }).strict(),
    })
    .strict();
export type ExtractionEvalCase = z.infer<typeof CaseSchema>;

const SetSchema = z.object({ format: z.literal('inkquisitor-source-facts-eval/1'), cases: z.array(CaseSchema).min(1) }).strict();

export const extractionCases: readonly ExtractionEvalCase[] = SetSchema.parse(extractionJson).cases;

/** The set's hash, as a record names it. */
export const extractionEvalSet = { hash: `sha256:${createHash('sha256').update(JSON.stringify(extractionJson)).digest('hex')}` } as const;
