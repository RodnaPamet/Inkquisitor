/**
 * THE GAP HUNT RANKING'S EVALUATION SET (Phase 4.3, D29; roadmap rule 9),
 * loaded and checked when the module loads: `gap-hunt.json`, small books (their
 * elements, which fields each fills, and each kind's signals), so the CODE's
 * candidates are computed from them exactly as the product computes them, and
 * what a right ranking puts first (`expect.topAnyOf`, kind:field). An
 * adversarial book tries to steer the ranker. Each case has a reference answer.
 *
 * Original content written for Inkquisitor.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { getTemplate } from '@/lib/bible/templates';
import { computeGapCandidates, type GapKindSignals } from '../candidates';
import { gapRankBlocks } from '../prompt';
import type { GapCandidate } from '../vocabulary';
import setJson from './gap-hunt.json';

const Signals = z.object({ relations: z.number().int().min(0), facts: z.number().int().min(0), citations: z.number().int().min(0) }).strict();

const CaseSchema = z
    .object({
        id: z.string().regex(/^(gh-\d{2}|adv-\d{2})$/),
        about: z.string().min(1),
        book: z.object({ title: z.string().min(1), logline: z.string().nullable() }).strict(),
        elements: z.array(z.object({ ref: z.string().regex(/^e\d{1,2}$/), kind: z.enum(BIBLE_KINDS), name: z.string().min(1), summary: z.string().nullable(), filled: z.array(z.string()) }).strict()).min(1),
        signals: z.partialRecord(z.enum(BIBLE_KINDS), Signals),
        expect: z.object({ topAnyOf: z.array(z.string().regex(/^[A-Z_]+:[a-z_]+$/)).min(1) }).strict(),
        mustNotContain: z.array(z.string().min(1)),
        reference: z.object({ picks: z.array(z.unknown()) }).strict(),
    })
    .strict();
export type GapHuntEvalCase = z.infer<typeof CaseSchema>;

const SetSchema = z.object({ format: z.literal('inkquisitor-gap-hunt-eval/1'), cases: z.array(CaseSchema).min(1) }).strict();

export const gapHuntCases: readonly GapHuntEvalCase[] = SetSchema.parse(setJson).cases;

export const gapHuntEvalSet = { hash: `sha256:${createHash('sha256').update(JSON.stringify(setJson)).digest('hex')}` } as const;

/** A case's candidates, as the product computes them. */
export function caseCandidates(c: GapHuntEvalCase): GapCandidate[] {
    const signals = new Map<BibleKind, GapKindSignals>(Object.entries(c.signals) as Array<[BibleKind, GapKindSignals]>);
    return computeGapCandidates({ elements: c.elements.map((e) => ({ id: e.ref, kind: e.kind, filledKeys: new Set(e.filled) })), signals, template: getTemplate });
}

/** A case's call blocks, as the product sends them. */
export function caseBlocks(c: GapHuntEvalCase) {
    return gapRankBlocks({ candidates: caseCandidates(c), book: c.book, elements: c.elements.map((e) => ({ kind: e.kind, name: e.name, summary: e.summary })) });
}
