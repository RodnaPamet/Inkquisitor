/**
 * THE BIBLE FACT EVALUATION SET (Phase 4.1, D27; roadmap rule 9), loaded and
 * checked when the module loads: `bible-facts.json`, FIVE SYNTHETIC BIBLES
 * (fantasy, science fiction, mystery, historical, contemporary), two entries
 * each — a first version, then a later one — with the facts a right
 * extraction finds and how they resolve against the facts already recorded:
 * a restatement (DEDUPE: one live fact), a changed age and occupation and a
 * rewritten membership (CONTRADICTION, by rule and by the model), a location
 * at another story time (a near miss: no contradiction), a cleared field (NO
 * LONGER STATED); plus three adversarial entries (an instruction, a request for
 * the prompt, a planted link). Each case has a reference answer.
 *
 * Original content written for Inkquisitor; every address is under the
 * reserved `.example` name. Imported as JSON so a record is checked against
 * the bytes the build holds.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FACT_PREDICATES } from '@/lib/sources/vocabulary';
import setJson from './bible-facts.json';

const Section = z.object({ key: z.string().min(1), label: z.string().min(1), text: z.string().min(1) }).strict();
const Existing = z
    .object({
        subject: z.number().int().min(0),
        predicate: z.enum(FACT_PREDICATES),
        objectLiteral: z.string().nullable(),
        statement: z.string().min(1),
        quote: z.string().min(1),
        storyTimeFrom: z.string().nullable(),
        storyTimeTo: z.string().nullable(),
        sameOwner: z.boolean(),
    })
    .strict();
const Index = z.number().int().min(1);

const CaseSchema = z
    .object({
        id: z.string().regex(/^(bb-\d{2}-e\d|adv-\d{2})$/),
        bible: z.string().min(1),
        genre: z.string().min(1),
        attack: z.string().optional(),
        kind: z.enum(['element', 'relation']),
        subjects: z.array(z.string().min(1)).min(1).max(2),
        header: z.array(Section).min(1),
        body: z.array(Section).min(1),
        changed: z.array(z.string().min(1)),
        bookNames: z.array(z.string().min(1)),
        existing: z.array(Existing),
        expect: z.array(z.object({ subject: z.string().min(1), predicate: z.enum(FACT_PREDICATES), mustContain: z.array(z.string().min(1)).min(1) }).strict()).min(1),
        expectRestated: z.array(Index),
        expectContradicted: z.array(Index),
        mustNotContradict: z.array(Index),
        expectNoLongerStated: z.array(Index),
        mustNotContain: z.array(z.string()),
        reference: z.object({ facts: z.array(z.unknown()) }).strict(),
    })
    .strict();
export type BibleFactEvalCase = z.infer<typeof CaseSchema>;

const SetSchema = z.object({ format: z.literal('inkquisitor-bible-facts-eval/1'), cases: z.array(CaseSchema).min(1) }).strict();

export const bibleFactCases: readonly BibleFactEvalCase[] = SetSchema.parse(setJson).cases;

/** The set's hash, as a record names it. */
export const bibleFactEvalSet = { hash: `sha256:${createHash('sha256').update(JSON.stringify(setJson)).digest('hex')}` } as const;

/** Five synthetic bibles, each with a first and a later entry (rule 9 as the roadmap words it for 4.1). */
export const SYNTHETIC_BIBLES = [...new Set(bibleFactCases.filter((c) => c.bible.startsWith('bb-')).map((c) => c.bible))];
