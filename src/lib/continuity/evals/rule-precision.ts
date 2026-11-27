/**
 * THE RULES' PRECISION SET (Phase 4.H-b, roadmap 4.H item 2): seeded
 * contradictions and NEAR MISSES for the code detectors, graded so that fewer
 * than one false alarm in ten is raised (precision ≥ `RULE_PRECISION_BAR` over
 * every alarm raised), with recall reported beside it. Pure: no model, no
 * database. `tests/unit/continuity/rule-precision.test.ts` holds the bar.
 *
 * Two paths are graded over the same cases, because two paths raise rule
 * contradictions in production:
 *
 *   NIGHTLY   4.2's sweep: `detectRuleContradictions` over a book's facts.
 *   RESOLVE   4.1's extraction: `resolveFacts`, each fact arriving in the order
 *             the case lists it and resolved against every earlier one (a
 *             restated claim, by its claim parts, is provenance, never a pair).
 *
 * A raised pair is a TRUE alarm when the case expects it, of its kind; every
 * other raised pair — a near miss raised, a pair of the wrong kind — is a FALSE
 * alarm. The near misses (`nm-*`) are the classes the roadmap names: another
 * story time, another subject sharing a name fragment, negation, a name and a
 * description of one thing, story positions that do not overlap, positions in
 * two orders the clock cannot compare, and one residual the rules cannot avoid
 * (two synonyms of one shape), counted honestly.
 *
 * Original content written for Inkquisitor.
 */
import { z } from 'zod';
import { claimParts, resolveFacts, type LiveFact, type NewFact } from '@/lib/facts/dedupe';
import { FACT_PREDICATES } from '@/lib/sources/vocabulary';
import { detectRuleContradictions, type RuleFact } from '../rules';
import { storyClock, type StoryClock } from '../story-clock';
import { CONTRADICTION_KINDS, type ContradictionKind } from '../vocabulary';
import setJson from './rule-precision.json';

/** Fewer than one false alarm in ten (roadmap 4.H item 2). */
export const RULE_PRECISION_BAR = 0.9;

const Fact = z
    .object({
        ref: z.string().regex(/^f\d{1,2}$/),
        predicate: z.enum(FACT_PREDICATES),
        subject: z.string().min(1),
        object: z.string().nullable(),
        statement: z.string().min(1),
        from: z.string().nullable(),
        to: z.string().nullable(),
        owner: z.string().nullable(),
    })
    .strict();

const CaseSchema = z
    .object({
        id: z.string().regex(/^(rp|nm)-\d{2}$/),
        about: z.string().min(1),
        facts: z.array(Fact).min(2),
        expect: z.array(z.object({ a: z.string(), b: z.string(), kind: z.enum(CONTRADICTION_KINDS) }).strict()),
        mustNotPair: z.array(z.tuple([z.string(), z.string()])),
    })
    .strict()
    .refine((c) => (c.id.startsWith('rp') ? c.expect.length > 0 : c.expect.length === 0 && c.mustNotPair.length > 0), 'a seeded case expects a pair; a near miss names one it must not raise');

const SetSchema = z
    .object({
        format: z.literal('inkquisitor-rule-precision/1'),
        placed: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string(), orderRank: z.string() }).strict()),
        cases: z.array(CaseSchema).min(1),
    })
    .strict();

const parsed = SetSchema.parse(setJson);
export type RulePrecisionCase = z.infer<typeof CaseSchema>;
export const rulePrecisionCases: readonly RulePrecisionCase[] = parsed.cases;

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function ruleFactOf(f: RulePrecisionCase['facts'][number]): RuleFact {
    return { id: f.ref, predicate: f.predicate, subjectElementId: f.subject, objectLiteral: f.object, statement: f.statement, storyTimeFrom: f.from, storyTimeTo: f.to, ownerElementId: f.owner };
}

/** 4.1's path: each fact resolved, in order, against the earlier ones (its claim parts are its key, unkeyed: pure). */
function resolvedPairs(c: RulePrecisionCase, clock: StoryClock): Map<string, ContradictionKind> {
    const out = new Map<string, ContradictionKind>();
    const live: LiveFact[] = [];
    for (const f of c.facts) {
        const owner = { kind: 'BIBLE_VERSION' as const, id: f.owner ?? `entry-${f.ref}` };
        const r = ruleFactOf(f);
        const key = claimParts(owner, r).join('\u0000');
        const fresh: NewFact = { ...r, key, contradicts: [] };
        const plan = resolveFacts({ fresh: [fresh], shown: [], live, entry: f.statement, clock });
        for (const p of plan.contradictions) out.set(pairKey(p.olderId, f.ref), p.kind);
        if (plan.insert.length > 0) live.push({ ...r, key, quote: f.statement, sameOwner: false, versionId: null });
    }
    return out;
}

export interface RulePathGrade {
    /** Pairs raised over the whole set. */
    readonly alarms: number;
    /** Raised pairs a case expects, of their kind. */
    readonly trueAlarms: number;
    /** Every other raised pair: case id and the pair. */
    readonly falseAlarms: ReadonlyArray<{ caseId: string; pair: string }>;
    /** Expected pairs over the whole set, and those not raised (or raised of another kind). */
    readonly expected: number;
    readonly missed: ReadonlyArray<{ caseId: string; pair: string }>;
    /** trueAlarms / alarms; null when nothing was raised (rule 6: no precision over no alarm). */
    readonly precision: number | null;
    /** trueAlarms / expected; null when nothing was expected. */
    readonly recall: number | null;
}

function grade(path: (c: RulePrecisionCase, clock: StoryClock) => Map<string, ContradictionKind>): RulePathGrade {
    const clock = storyClock(parsed.placed);
    let alarms = 0;
    let trueAlarms = 0;
    let expected = 0;
    const falseAlarms: Array<{ caseId: string; pair: string }> = [];
    const missed: Array<{ caseId: string; pair: string }> = [];
    for (const c of rulePrecisionCases) {
        const raised = path(c, clock);
        const want = new Map(c.expect.map((e) => [pairKey(e.a, e.b), e.kind] as const));
        expected += want.size;
        for (const [pair, kind] of raised) {
            alarms++;
            if (want.get(pair) === kind) trueAlarms++;
            else falseAlarms.push({ caseId: c.id, pair });
        }
        for (const [pair, kind] of want) if (raised.get(pair) !== kind) missed.push({ caseId: c.id, pair });
    }
    return { alarms, trueAlarms, falseAlarms, expected, missed, precision: alarms === 0 ? null : trueAlarms / alarms, recall: expected === 0 ? null : trueAlarms / expected };
}

/** The set graded over both production paths (the header). */
export function gradeRulePrecision(): { nightly: RulePathGrade; resolve: RulePathGrade } {
    return {
        nightly: grade((c, clock) => {
            const r = detectRuleContradictions(c.facts.map(ruleFactOf), clock);
            return new Map(r.pairs.map((p) => [pairKey(p.a, p.b), p.kind] as const));
        }),
        resolve: grade(resolvedPairs),
    };
}
