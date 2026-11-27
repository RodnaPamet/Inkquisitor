/**
 * THE DRAFT-READING EVALUATION SET (Phase 5.3; roadmap rule 9), loaded and checked when the module loads:
 * `draft-read.json`, five scenes across genres with the facts a right read finds (whereabouts, a skill kept negated, an
 * age, knowledge, a place's kind, a backstory told in dialogue) and the threads each plants or pays off (a clue laid,
 * a promise kept, a promise answered in dialogue), and three adversarial scenes carrying an instruction to link every
 * thread, a request for the prompt, and planted markup with a link. Each case has a reference answer.
 *
 * Original content written for Inkquisitor; every address is under the reserved `.example` name. Imported as JSON so
 * a record is checked against the bytes the build holds.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FACT_PREDICATES } from '@/lib/sources/vocabulary';
import { LINK_ROLES } from '../vocabulary';
import draftReadJson from './draft-read.json';

const LinkSchema = z.object({ thread: z.number().int().min(1), role: z.enum(LINK_ROLES) }).strict();

const CaseSchema = z
    .object({
        id: z.string().regex(/^(dr|adv)-\d{2}$/),
        genre: z.string().min(1),
        attack: z.string().optional(),
        headings: z.array(z.string().min(1)),
        bookNames: z.array(z.string().min(1)),
        threads: z.array(z.object({ kind: z.enum(['PROMISE', 'CLUE', 'OPEN_QUESTION']), title: z.string().min(1) }).strict()),
        passage: z.string().min(20),
        expect: z.array(z.object({ subject: z.string().min(1), predicate: z.enum(FACT_PREDICATES), mustContain: z.array(z.string().min(1)).min(1) }).strict()).min(1),
        expectLinks: z.array(LinkSchema),
        optionalLinks: z.array(LinkSchema),
        mustNotContain: z.array(z.string()),
        reference: z.object({ facts: z.array(z.unknown()), threads: z.array(z.unknown()) }).strict(),
    })
    .strict();
export type DraftReadEvalCase = z.infer<typeof CaseSchema>;

const SetSchema = z.object({ format: z.literal('inkquisitor-draft-read-eval/1'), cases: z.array(CaseSchema).min(1) }).strict();

export const draftReadCases: readonly DraftReadEvalCase[] = SetSchema.parse(draftReadJson).cases;

/** The set's hash, as a record names it. */
export const draftReadEvalSet = { hash: `sha256:${createHash('sha256').update(JSON.stringify(draftReadJson)).digest('hex')}` } as const;
