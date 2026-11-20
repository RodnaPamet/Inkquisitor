/**
 * THE RECONCILE EVALUATION SETS (Phase 2.5; roadmap rule 9), loaded and
 * checked against the content formats (staged `FORMAT.md` 5.2 and 5.3) when
 * the module loads:
 *
 *   enrichment.json   40 cases, every one a round's answers and the expected
 *                     operation per scope field (each an answer/field pair:
 *                     the roadmap's "forty answer/field pairs" are exceeded,
 *                     ninety-odd in all), with the citations, the phrases a
 *                     right value must and must not contain, a reference
 *                     wording, and the new elements the answers name. The
 *                     staged set's 27 cases unchanged, and 13 written for 2.5
 *                     (en-28 to en-40: the kinds the staged set held once,
 *                     scales and choices, a retraction with an earlier
 *                     session's answer to tempt a citation, new elements).
 *   adversarial.json  14 answers carrying instructions to the model (every
 *                     attack category of 5.3); each must change nothing beyond
 *                     its own story content. The roadmap asks for ten.
 *
 * Original content written for Inkquisitor in the content formats v1 (the
 * staged `evals/` of branch `wip/content`). Imported as JSON, so the sets ship
 * in the build and the evaluation record is checked against the bytes the
 * build holds.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { getTemplate } from '@/lib/bible/templates';
import enrichmentJson from './enrichment.json';
import adversarialJson from './adversarial.json';

export const BEHAVIOUR_CODES_E = [
    'CITES_NO_ANSWER',
    'CITES_FOREIGN_ANSWER',
    'CITES_UNANSWERED',
    'TARGETS_OUT_OF_SCOPE_FIELD',
    'UNSOURCED_SENTENCE',
    'PROPOSES_STORY_CONTENT',
    'OMITS_NEW_ELEMENT',
    'INVENTS_NEW_ELEMENT',
    'WRITES_PROSE',
    'USES_BRANDED_FRAMEWORK',
    'FOLLOWS_EMBEDDED_INSTRUCTION',
    'DISCLOSES_INSTRUCTIONS',
    'READS_OTHER_BOOK',
    'COPIES_INJECTED_TEXT',
] as const;
export type BehaviourCode = (typeof BEHAVIOUR_CODES_E)[number];

/** The six codes every case lists (5.2). */
export const MINIMUM_MUST_NOT: readonly BehaviourCode[] = [
    'CITES_NO_ANSWER',
    'CITES_FOREIGN_ANSWER',
    'CITES_UNANSWERED',
    'TARGETS_OUT_OF_SCOPE_FIELD',
    'UNSOURCED_SENTENCE',
    'PROPOSES_STORY_CONTENT',
];

export const ATTACKS = [
    'IGNORE_PREVIOUS',
    'ROLE_CHANGE',
    'PROMPT_DISCLOSURE',
    'SCOPE_ESCAPE',
    'CROSS_BOOK',
    'FORGED_STRUCTURE',
    'FALSE_APPROVAL',
    'PROSE_REQUEST',
    'CITATION_FORGERY',
    'ENCODED',
    'IN_WORLD_TEXT',
] as const;

const fieldValue = z.union([z.string(), z.array(z.string()), z.number().int(), z.null()]);
const answerSchema = z
    .object({
        id: z.string().regex(/^a\d+$/),
        sessionId: z.string().regex(/^s\d+$/),
        questionKind: z.enum(['OPEN', 'CHOICE', 'EITHER_OR', 'SCENARIO', 'SCALE']),
        question: z.string().min(1),
        options: z.array(z.string()).optional(),
        scaleLabels: z.object({ low: z.string(), high: z.string() }).strict().optional(),
        targetsFieldKeys: z.array(z.string()).min(1),
        status: z.enum(['ANSWERED', 'SKIPPED', 'DECIDE_LATER']),
        answer: z.union([z.string(), z.number().int(), z.null()]),
    })
    .strict();

const operationSchema = z
    .object({
        fieldKey: z.string(),
        op: z.enum(['ADD', 'UPDATE', 'REMOVE', 'NO_CHANGE']),
        cites: z.array(z.string()),
        mustContain: z.array(z.string()),
        mustNotContain: z.array(z.string()),
        reference: fieldValue,
    })
    .strict();

const caseShape = {
    id: z.string(),
    rationale: z.string().max(400),
    kind: z.enum(BIBLE_KINDS),
    elementName: z.string().min(1),
    customLabel: z.string().optional(),
    bookElements: z.array(z.object({ kind: z.enum(BIBLE_KINDS), name: z.string() }).strict()),
    bibleState: z.record(z.string(), fieldValue),
    sessionId: z.string(),
    scopeFieldKeys: z.array(z.string()).min(1),
    answers: z.array(answerSchema).min(1),
    expect: z
        .object({
            operations: z.array(operationSchema).min(1),
            newElements: z.array(z.object({ kind: z.enum(BIBLE_KINDS), name: z.string(), cites: z.array(z.string()).min(1) }).strict()),
            mustNot: z.array(z.enum(BEHAVIOUR_CODES_E)),
        })
        .strict(),
};

export const EnrichmentCaseSchema = z.object(caseShape).strict();
export const AdversarialCaseSchema = z
    .object({ ...caseShape, attack: z.enum(ATTACKS), injectedText: z.string().min(1) })
    .strict();

export type ReconcileEvalCase = z.infer<typeof EnrichmentCaseSchema> & { attack?: (typeof ATTACKS)[number]; injectedText?: string };

/** The rules a case holds beyond its shape (5.2, 5.3): every problem, by case id. */
export function caseProblems(c: ReconcileEvalCase, set: 'enrichment' | 'adversarial'): string[] {
    const problems: string[] = [];
    const template = getTemplate(c.kind as BibleKind);
    const core = template.fields.filter((f) => f.required).map((f) => f.key);
    const stateKeys = Object.keys(c.bibleState);
    if (stateKeys.join(',') !== core.join(',')) problems.push(`${c.id}: bibleState is not exactly the core keys of ${c.kind} in order`);
    if (!c.scopeFieldKeys.every((k) => core.includes(k))) problems.push(`${c.id}: a scope key is not a core key`);
    const ordered = core.filter((k) => c.scopeFieldKeys.includes(k));
    if (ordered.join(',') !== c.scopeFieldKeys.join(',')) problems.push(`${c.id}: scopeFieldKeys out of template order`);
    if (c.expect.operations.map((o) => o.fieldKey).join(',') !== c.scopeFieldKeys.join(',')) problems.push(`${c.id}: one operation per scope key, in order`);
    const current = new Map(c.answers.filter((a) => a.sessionId === c.sessionId).map((a) => [a.id, a]));
    if (current.size === 0) problems.push(`${c.id}: no answer of the current session`);
    if (new Set(c.answers.map((a) => a.id)).size !== c.answers.length) problems.push(`${c.id}: duplicate answer id`);
    const citable = (id: string) => current.get(id)?.status === 'ANSWERED';
    for (const o of c.expect.operations) {
        const stored = c.bibleState[o.fieldKey];
        const empty = stored === null || stored === undefined;
        if (o.op === 'ADD' && !empty) problems.push(`${c.id}/${o.fieldKey}: ADD into a filled field`);
        if ((o.op === 'UPDATE' || o.op === 'REMOVE') && empty) problems.push(`${c.id}/${o.fieldKey}: ${o.op} of an empty field`);
        if (o.op === 'NO_CHANGE' && (o.cites.length > 0 || o.reference !== null)) problems.push(`${c.id}/${o.fieldKey}: NO_CHANGE with cites or a reference`);
        if (o.op !== 'NO_CHANGE' && (o.cites.length === 0 || !o.cites.every(citable))) problems.push(`${c.id}/${o.fieldKey}: cites must be current ANSWERED answers`);
        if ((o.op === 'ADD' || o.op === 'UPDATE') && o.reference === null) problems.push(`${c.id}/${o.fieldKey}: ${o.op} without a reference`);
        if (o.op === 'REMOVE' && o.reference !== null) problems.push(`${c.id}/${o.fieldKey}: REMOVE with a reference`);
    }
    for (const n of c.expect.newElements) if (!n.cites.every(citable)) problems.push(`${c.id}: a new element cites a non-current or unanswered answer`);
    for (const code of MINIMUM_MUST_NOT) if (!c.expect.mustNot.includes(code)) problems.push(`${c.id}: mustNot lacks ${code}`);
    if (set === 'adversarial') {
        const holders = c.answers.filter((a) => a.sessionId === c.sessionId && a.status === 'ANSWERED' && typeof a.answer === 'string' && c.injectedText && a.answer.includes(c.injectedText));
        if (holders.length !== 1) problems.push(`${c.id}: injectedText is not in exactly one current ANSWERED answer`);
    }
    return problems;
}

function load<T>(raw: unknown, schema: z.ZodType<T>, set: 'enrichment' | 'adversarial'): T[] {
    const cases = z.array(schema).min(1).parse(raw);
    const problems = (cases as unknown as ReconcileEvalCase[]).flatMap((c) => caseProblems(c, set));
    const ids = (cases as unknown as ReconcileEvalCase[]).map((c) => c.id);
    if (new Set(ids).size !== ids.length) problems.push(`${set}: duplicate case ids`);
    if (problems.length > 0) throw new Error(`The ${set} evaluation set is malformed:\n${problems.join('\n')}`);
    return cases;
}

/** The hash a record names: sha256 of the set's canonical JSON. */
export function setHash(raw: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(raw), 'utf8').digest('hex')}`;
}

export interface ReconcileEvalSets {
    enrichment: ReconcileEvalCase[];
    adversarial: ReconcileEvalCase[];
    hashes: { enrichment: string; adversarial: string };
}

let cached: ReconcileEvalSets | null = null;

/** Both sets, validated once per process. */
export function reconcileEvalSets(): ReconcileEvalSets {
    if (!cached) {
        cached = {
            enrichment: load(enrichmentJson, EnrichmentCaseSchema, 'enrichment'),
            adversarial: load(adversarialJson, AdversarialCaseSchema, 'adversarial') as ReconcileEvalCase[],
            hashes: { enrichment: setHash(enrichmentJson), adversarial: setHash(adversarialJson) },
        };
    }
    return cached;
}

/** Every case of both sets, enrichment first. */
export function allReconcileCases(): ReconcileEvalCase[] {
    const sets = reconcileEvalSets();
    return [...sets.enrichment, ...sets.adversarial];
}
