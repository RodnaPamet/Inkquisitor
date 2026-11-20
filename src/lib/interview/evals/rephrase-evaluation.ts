/**
 * HOW "ASK ME THIS DIFFERENTLY" PROVES ITSELF (Phase 2.H item 7; issue #36,
 * item 4; roadmap rule 9; decision D11 applied to the rephrase prompt).
 *
 * The packs' and reconcile's split:
 *
 *   • the EVALUATION SET (`rephrase.json`) is ten unanswered questions of an
 *     open round, each with the element it is about; it carries no output;
 *   • an EVALUATION RECORD (`rephrase-evaluation-record.json`) is the set's
 *     hash, the rephrase prompt's version and content hash, a named generator
 *     and the RAW structured output it returned for every case. Only a run
 *     makes one (`npm run packs:evaluate -- --no-packs --rephrase`).
 *
 * Grading is RECOMPUTED on every check by REPLAYING each recorded output
 * through the product's own step, `produceRephrase` (validation, the same
 * element, targets and mode, not a repeat of anything asked). A case passes
 * when the product would ask the MODEL's own rephrase: a pack example taking
 * its place is the step falling back, not the prompt working (as the coverage
 * evaluation counts only the generator's own questions). What code cannot
 * grade — the persona's tone, leading wording, whether the angle is really new
 * — is listed per case as UNGRADED, for the judge (`src/lib/evals/judge.ts`).
 * The bar is every case (`REPHRASE_EVAL_PASS_RATE = 1`).
 *
 * THE STRUCTURAL REPHRASER reads the request's `previous-wording` block and
 * asks the same target from a reader's angle, deterministically: a record of
 * it proves the set, the step's rules and the grader agree, and nothing about
 * a model — development and test mount it, production never does
 * (`rephrase-record-gate.ts`). A structural record must be exactly what it
 * produces today; a model record holding its output for every case is
 * refused STRUCTURAL_OUTPUT_AS_MODEL.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJsonStringify } from '@/lib/audit/canonical-hash';
import type { BibleKind } from '@/lib/bible/kinds';
import { BIBLE_KINDS } from '@/lib/bible/kinds';
import { getTemplate } from '@/lib/bible/templates';
import { promptContentHash } from '@/lib/ai/prompt-hash';
import { GeneratedQuestionsSchema, type GeneratedQuestion } from '../candidates';
import type { GenerationRequest, GenerationResult, QuestionGenerator } from '../generator';
import type { PackRegistry } from '../packs';
import { produceRephrase, REPHRASE_PROMPT, REPHRASE_PROMPT_VERSION } from '../rephrase';
import { kindsInPrompt } from './structural-generator';
import rephraseJson from './rephrase.json';

export const REPHRASE_RECORD_FORMAT = 'inkquisitor-rephrase-evaluation/1';
export const STRUCTURAL_REPHRASER_ID = 'structural-rephraser.1';
export const REPHRASE_EVAL_PASS_RATE = 1;
const RECORD_KINDS = ['structural', 'model'] as const;
export type RephraseRecordKind = (typeof RECORD_KINDS)[number];

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const hash = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

const CaseSchema = z
    .object({
        id: z.string().regex(/^rp-\d{2}$/),
        kind: z.enum(BIBLE_KINDS),
        elementName: z.string().min(1).max(120),
        detail: z.number().int().min(1).max(5),
        stored: z.record(z.string(), z.string().max(500)),
        original: z.object({ fieldKey: z.string().min(1), kind: z.enum(['OPEN', 'CHOICE', 'EITHER_OR', 'SCALE', 'SCENARIO']), text: z.string().min(1).max(400) }).strict(),
        ungraded: z.array(z.string().max(120)).max(8),
    })
    .strict();
export type RephraseEvalCase = z.infer<typeof CaseSchema>;
const SetSchema = z.object({ format: z.literal('inkquisitor-rephrase-set/1'), description: z.string(), cases: z.array(CaseSchema).min(1).max(40) }).strict();

let cachedSet: { cases: RephraseEvalCase[]; hash: string } | null = null;
/** The set, validated once: every field a template's, never one the element stores. */
export function rephraseEvalSet(): { cases: RephraseEvalCase[]; hash: string } {
    if (cachedSet) return cachedSet;
    const set = SetSchema.parse(rephraseJson);
    for (const c of set.cases) {
        const keys = getTemplate(c.kind).fields.map((f) => f.key);
        if (!keys.includes(c.original.fieldKey)) throw new Error(`rephrase set ${c.id}: ${c.original.fieldKey} is not a ${c.kind} field`);
        if (c.original.fieldKey in c.stored) throw new Error(`rephrase set ${c.id}: the bible answers ${c.original.fieldKey} already`);
        for (const k of Object.keys(c.stored)) if (!keys.includes(k)) throw new Error(`rephrase set ${c.id}: ${k} is not a ${c.kind} field`);
    }
    if (new Set(set.cases.map((c) => c.id)).size !== set.cases.length) throw new Error('rephrase set: duplicate case ids');
    cachedSet = { cases: set.cases, hash: hash(JSON.stringify(rephraseJson)) };
    return cachedSet;
}

/** The rephrase prompt's content hash: its static template and the output schema (`promptContentHash`). */
export function rephrasePromptHash(): string {
    return promptContentHash(REPHRASE_PROMPT, GeneratedQuestionsSchema);
}

export const RephraseRecordSchema = z
    .object({
        format: z.literal(REPHRASE_RECORD_FORMAT),
        set: z.object({ hash: SHA256 }).strict(),
        promptVersion: z.string().min(1).max(64),
        promptHash: SHA256,
        generator: z.object({ kind: z.enum(RECORD_KINDS), id: z.string().min(1).max(128) }).strict(),
        ranAt: z.iso.datetime(),
        answers: z.array(z.object({ caseId: z.string().regex(/^rp-\d{2}$/), output: z.unknown() }).strict()).max(40),
    })
    .strict();
export type RephraseRecord = z.infer<typeof RephraseRecordSchema>;

const elementIdOf = (c: RephraseEvalCase) => `eval-${c.id}`;

/** The structural rephraser: the same target, asked from a reader's angle. Always available; no tokens. */
export function structuralRephraser(): QuestionGenerator {
    return {
        unavailableReason: () => null,
        async generateCandidates(request: GenerationRequest): Promise<GenerationResult> {
            const block = request.data.find((b) => b.label === 'previous-wording');
            const previous = block ? (JSON.parse(block.text) as { elementId: string; targetsFieldKeys: string[]; mode: 'FRONTIER' | 'CHALLENGE'; kind: string }) : null;
            if (!previous) return { output: { questions: [], declined: [] }, tokensUsed: 0 };
            const words = previous.targetsFieldKeys[0].split('_').join(' ');
            const kinds = kindsInPrompt(request);
            const base = { elementId: previous.elementId, targetsFieldKeys: [...previous.targetsFieldKeys], mode: previous.mode, rationale: `Asks for the ${words} from a reader's side.` };
            const q: GeneratedQuestion =
                kinds.includes('OPEN')
                    ? { ...base, kind: 'OPEN', text: `Picture a reader meeting the ${words} for the first time: what do they notice first?` }
                    : { ...base, kind: 'SCALE', text: `How much does a reader feel the ${words}?`, scaleLabels: { low: 'barely', high: 'constantly' } };
            return { output: { questions: [q], declined: [] }, tokensUsed: 0 };
        },
    };
}

/** One case, through the product's step, with `generator` answering the call. Returns the raw output and whether the model's rephrase is asked. */
export async function runRephraseCase(c: RephraseEvalCase, registry: PackRegistry, generator: QuestionGenerator): Promise<{ output: unknown; asked: boolean; origin: string | null }> {
    const kind = c.kind as BibleKind;
    const elementId = elementIdOf(c);
    let output: unknown = null;
    const recording: QuestionGenerator = {
        unavailableReason: () => generator.unavailableReason(),
        async generateCandidates(request, signal) {
            const r = await generator.generateCandidates(request, signal);
            output = r.output ?? null;
            return r;
        },
    };
    const result = await produceRephrase(
        {
            bookId: null,
            dials: { depth: 2, detail: c.detail },
            offerRecommended: false,
            preferChoice: false,
            persona: null,
            craft: registry.craft,
            element: { elementId, kind, name: c.elementName, customLabel: null, fields: getTemplate(kind).fields, storedText: new Map(Object.entries(c.stored)) },
            original: {
                id: `q-${c.id}`,
                scope: 'SESSION',
                elementId,
                targetsFieldKeys: [c.original.fieldKey],
                kind: c.original.kind,
                text: c.original.text,
                options: null,
                scaleLabels: null,
                mode: 'FRONTIER',
                challengeQuote: null,
                personaKey: null,
            },
            related: [],
            sessionAnswers: [],
            asked: [],
        },
        { generator: recording },
    );
    return { output, asked: result.question?.origin === 'REPHRASE', origin: result.question?.origin ?? null };
}

/** A generator that answers each call with the recorded output for the case at hand. */
function replaying(output: unknown): QuestionGenerator {
    return { unavailableReason: () => null, generateCandidates: async () => ({ output, tokensUsed: 0 }) };
}

export interface RephraseCaseGrade {
    caseId: string;
    passed: boolean;
    failure: 'NO_REPHRASE' | null;
    ungraded: readonly string[];
}

/** Run every case with `generator` and make the record. */
export async function evaluateRephrase(registry: PackRegistry, generator: QuestionGenerator, who: { kind: RephraseRecordKind; id: string }, ranAt: Date = new Date()): Promise<{ record: RephraseRecord; grades: RephraseCaseGrade[] }> {
    const set = rephraseEvalSet();
    const answers: RephraseRecord['answers'] = [];
    const grades: RephraseCaseGrade[] = [];
    for (const c of set.cases) {
        const r = await runRephraseCase(c, registry, generator);
        answers.push({ caseId: c.id, output: r.output });
        grades.push({ caseId: c.id, passed: r.asked, failure: r.asked ? null : 'NO_REPHRASE', ungraded: c.ungraded });
    }
    return {
        record: { format: REPHRASE_RECORD_FORMAT, set: { hash: set.hash }, promptVersion: REPHRASE_PROMPT_VERSION, promptHash: rephrasePromptHash(), generator: who, ranAt: ranAt.toISOString(), answers },
        grades,
    };
}

export type RephraseRecordCheck =
    | { ok: true; record: RephraseRecord; grades: RephraseCaseGrade[] }
    | {
          ok: false;
          reason: 'MALFORMED' | 'SET_MISMATCH' | 'PROMPT_VERSION_MISMATCH' | 'PROMPT_HASH_MISMATCH' | 'UNANSWERED_CASE' | 'UNKNOWN_ANSWER' | 'GENERATOR_MISMATCH' | 'STRUCTURAL_OUTPUT_AS_MODEL' | 'BELOW_THRESHOLD';
          detail: string;
      };

/** Does this record show the rephrase prompt passing the committed set? Every figure recomputed by replay. */
export async function checkRephraseRecord(raw: unknown, registry: PackRegistry): Promise<RephraseRecordCheck> {
    const parsed = RephraseRecordSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED', detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    const record = parsed.data;
    const set = rephraseEvalSet();
    if (record.set.hash !== set.hash) return { ok: false, reason: 'SET_MISMATCH', detail: 'the record answered a different set; re-run npm run packs:evaluate -- --no-packs --rephrase' };
    if (record.promptVersion !== REPHRASE_PROMPT_VERSION) return { ok: false, reason: 'PROMPT_VERSION_MISMATCH', detail: `recorded under ${record.promptVersion}, the prompt is ${REPHRASE_PROMPT_VERSION}` };
    if (record.promptHash !== rephrasePromptHash()) return { ok: false, reason: 'PROMPT_HASH_MISMATCH', detail: 'the rephrase prompt changed since the record was made; re-run npm run packs:evaluate -- --no-packs --rephrase' };
    const byCase = new Map(record.answers.map((a) => [a.caseId, a.output]));
    for (const a of record.answers) if (!set.cases.some((c) => c.id === a.caseId)) return { ok: false, reason: 'UNKNOWN_ANSWER', detail: a.caseId };
    const grades: RephraseCaseGrade[] = [];
    let structuralMatches = 0;
    for (const c of set.cases) {
        if (!byCase.has(c.id)) return { ok: false, reason: 'UNANSWERED_CASE', detail: c.id };
        const recorded = byCase.get(c.id);
        const reproduced = (await runRephraseCase(c, registry, structuralRephraser())).output;
        const same = canonicalJsonStringify(recorded ?? null) === canonicalJsonStringify(reproduced ?? null);
        if (record.generator.kind === 'structural') {
            if (record.generator.id !== STRUCTURAL_REPHRASER_ID || !same) return { ok: false, reason: 'GENERATOR_MISMATCH', detail: `${c.id}: not what ${STRUCTURAL_REPHRASER_ID} produces; re-run the rephrase evaluation` };
        } else if (same) structuralMatches++;
        const r = await runRephraseCase(c, registry, replaying(recorded));
        grades.push({ caseId: c.id, passed: r.asked, failure: r.asked ? null : 'NO_REPHRASE', ungraded: c.ungraded });
    }
    if (record.generator.kind === 'model') {
        if (record.generator.id === STRUCTURAL_REPHRASER_ID) return { ok: false, reason: 'GENERATOR_MISMATCH', detail: 'a model record names the structural rephraser' };
        if (structuralMatches === set.cases.length) return { ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL', detail: 'every case holds the structural rephraser’s output, recorded as a model’s' };
    }
    const passed = grades.filter((g) => g.passed).length;
    if (passed / grades.length < REPHRASE_EVAL_PASS_RATE) {
        return { ok: false, reason: 'BELOW_THRESHOLD', detail: `${passed}/${grades.length} cases pass (${grades.filter((g) => !g.passed).map((g) => g.caseId).join(', ')})` };
    }
    return { ok: true, record, grades };
}
