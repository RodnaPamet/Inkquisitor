/**
 * THE STRESS TEST'S EVALUATION SET (Phase 4.3, D29; roadmap rule 9), loaded
 * and checked when the module loads: `stress-test.json`, small canons with a
 * SEEDED weak point each (a turn nothing motivates, a protagonist who pays
 * nothing, a theme nothing tests, a promise never paid, a turn a draft shows),
 * a SOUND canon where the right answer names nothing, and adversarial canons
 * that try to instruct the model or make it cite tags it was not shown. Each
 * case has a reference answer.
 *
 * Original content written for Inkquisitor. Imported as JSON so a record is
 * checked against the bytes the build holds.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StressInputSources } from '../input';
import { WEAK_POINT_KINDS } from '../vocabulary';
import setJson from './stress-test.json';

const Ref = z.string().regex(/^[efpt]\d{1,2}$/);

const CanonSchema = z
    .object({
        book: z.object({ title: z.string().min(1), logline: z.string().nullable() }).strict(),
        elements: z.array(z.object({ ref: Ref, kind: z.string().min(1), name: z.string().min(1), summary: z.string().nullable(), place: z.object({ order: z.string(), position: z.number().int().min(1) }).strict().optional() }).strict()).min(1),
        facts: z.array(z.object({ ref: Ref, subject: z.string().min(1), statement: z.string().min(1) }).strict()),
        threads: z.array(z.object({ ref: Ref, kind: z.string().min(1), title: z.string().min(1) }).strict()),
        passages: z.array(z.object({ ref: Ref, headings: z.string(), text: z.string().min(1) }).strict()),
        orders: z.array(z.object({ order: z.string().min(1), elementRefs: z.array(Ref) }).strict()),
    })
    .strict();

const CaseSchema = z
    .object({
        id: z.string().regex(/^(st-\d{2}|adv-\d{2})$/),
        about: z.string().min(1),
        canon: CanonSchema,
        expect: z.array(z.object({ kind: z.enum(WEAK_POINT_KINDS), citesAnyOf: z.array(z.string().regex(/^[EFTP]\d{1,2}$/)).min(1) }).strict()),
        mustNotContain: z.array(z.string().min(1)),
        reference: z.object({ weakPoints: z.array(z.unknown()) }).strict(),
    })
    .strict();
export type StressTestEvalCase = z.infer<typeof CaseSchema>;

const SetSchema = z.object({ format: z.literal('inkquisitor-stress-test-eval/1'), cases: z.array(CaseSchema).min(1) }).strict();

export const stressTestCases: readonly StressTestEvalCase[] = SetSchema.parse(setJson).cases;

/** The set's hash, as a record names it. */
export const stressTestEvalSet = { hash: `sha256:${createHash('sha256').update(JSON.stringify(setJson)).digest('hex')}` } as const;

/** A case's canon as the product's input builder reads it (refs are the rows' ids). */
export function caseSources(c: StressTestEvalCase): StressInputSources {
    const k = c.canon;
    return {
        book: k.book,
        elements: k.elements.map((e) => ({ id: e.ref, kind: e.kind, name: e.name, summary: e.summary, place: e.place ?? null })),
        facts: k.facts.map((f) => ({ id: f.ref, subject: f.subject, statement: f.statement })),
        threads: k.threads.map((t) => ({ id: t.ref, kind: t.kind, title: t.title })),
        passages: k.passages.map((p) => ({ id: p.ref, headings: p.headings, text: p.text })),
        orders: k.orders.map((o) => ({ order: o.order, elementIds: o.elementRefs })),
        totals: { elements: k.elements.length, facts: k.facts.length, threads: k.threads.length, passages: k.passages.length },
    };
}
