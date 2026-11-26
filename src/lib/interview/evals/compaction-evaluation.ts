/**
 * THE ROUNDS-SUMMARY PROMPT'S EVALUATION (Phase 4.3, D29; rule 9; D11).
 * `compaction.json`: earlier rounds of an interview, the field topics a right
 * summary names (`mustMention`, as the field's words), and what it must never
 * repeat (`mustNotContain`, an instruction an answer carried). A record holds
 * the set's hash, the prompt's version and content hash and the RAW summary per
 * case; every check REPLAYS each one through `validateRoundsSummary` over the
 * very blocks the product sends, and grades what would be kept.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { combinedPromptHash, promptContentHash } from '@/lib/ai/prompt-hash';
import type { FactExtractor } from '@/lib/sources/extractor';
import { normaliseText } from '../text';
import { summaryRequestBlocks, type RoundAnswer } from '../compaction';
import { COMPACTION_PROMPT, COMPACTION_PROMPT_VERSION, RoundsSummaryOutputSchema, validateRoundsSummary } from '../compaction-prompt';
import { ANSWER_STATUSES, QUESTION_KINDS } from '../vocabulary';
import setJson from './compaction.json';

const CaseSchema = z
    .object({
        id: z.string().regex(/^(cs-\d{2}|adv-\d{2})$/),
        about: z.string().min(1),
        rounds: z.array(z.object({ round: z.number().int().min(1), targetsFieldKeys: z.array(z.string()).min(1), questionKind: z.enum(QUESTION_KINDS), question: z.string().min(1), status: z.enum(ANSWER_STATUSES), answer: z.string().nullable() }).strict()).min(2),
        mustMention: z.array(z.string().min(1)),
        mustNotContain: z.array(z.string().min(1)),
        reference: z.object({ summary: z.string() }).strict(),
    })
    .strict();
export type CompactionEvalCase = z.infer<typeof CaseSchema>;

export const compactionCases: readonly CompactionEvalCase[] = z.object({ format: z.literal('inkquisitor-rounds-summary-eval/1'), cases: z.array(CaseSchema).min(1) }).strict().parse(setJson).cases;
export const compactionEvalSet = { hash: `sha256:${createHash('sha256').update(JSON.stringify(setJson)).digest('hex')}` } as const;

export const COMPACTION_RECORD_FORMAT = 'inkquisitor-rounds-summary-evaluation/1';
export const REFERENCE_SUMMARIZER_ID = 'reference-rounds-summarizer.1';

export function compactionPromptHash(): string {
    return combinedPromptHash([promptContentHash(COMPACTION_PROMPT, RoundsSummaryOutputSchema)]);
}

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const CompactionRecordSchema = z
    .object({
        format: z.literal(COMPACTION_RECORD_FORMAT),
        set: z.object({ hash: SHA256 }).strict(),
        promptVersion: z.string().min(1).max(200),
        promptHash: SHA256,
        generator: z.object({ kind: z.enum(['structural', 'model']), id: z.string().min(1).max(128) }).strict(),
        ranAt: z.iso.datetime(),
        answers: z.array(z.object({ caseId: z.string().regex(/^(cs-\d{2}|adv-\d{2})$/), output: z.unknown() }).strict()).max(60),
    })
    .strict();
export type CompactionRecord = z.infer<typeof CompactionRecordSchema>;

function caseAnswers(c: CompactionEvalCase): RoundAnswer[] {
    return c.rounds.map((r, i) => ({ answerId: `a${i + 1}`, elementId: 'eval-element', roundNumber: r.round, targetsFieldKeys: r.targetsFieldKeys, questionKind: r.questionKind, question: r.question, status: r.status, answer: r.answer }));
}

/** A case's call blocks, as the product sends them (every round but the last summarised). */
export function compactionCaseBlocks(c: CompactionEvalCase) {
    const answers = caseAnswers(c);
    return summaryRequestBlocks(answers, Math.max(...answers.map((a) => a.roundNumber)));
}

export function gradeCompactionCase(c: CompactionEvalCase, output: unknown): { caseId: string; passed: boolean; failures: string[] } {
    const blocks = compactionCaseBlocks(c);
    const v = validateRoundsSummary(output, { text: blocks.map((b) => b.text).join('\n'), answers: c.rounds.map((r) => r.answer ?? '').filter((a) => a !== '') });
    if (!v.ok) return { caseId: c.id, passed: false, failures: [`REFUSED_${v.reason}`] };
    const folded = normaliseText(v.summary);
    const failures: string[] = [];
    if (c.mustMention.some((w) => !folded.includes(normaliseText(w.replace(/_/g, ' '))))) failures.push('MISSES_TOPIC');
    if (c.mustNotContain.some((s) => folded.includes(normaliseText(s)))) failures.push('COPIED_INSTRUCTION');
    return { caseId: c.id, passed: failures.length === 0, failures };
}

export type CompactionRecordCheck = { ok: true; record: CompactionRecord } | { ok: false; reason: 'MALFORMED' | 'SET_CHANGED' | 'PROMPT_CHANGED' | 'CASES_MISSING' | 'STRUCTURAL_MISMATCH' | 'STRUCTURAL_OUTPUT_AS_MODEL' | 'BELOW_BAR'; detail: string };

const referenceAnswer = (c: CompactionEvalCase) => ({ caseId: c.id, output: c.reference });

export function checkCompactionRecord(raw: unknown): CompactionRecordCheck {
    const parsed = CompactionRecordSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED', detail: parsed.error.issues.map((i) => i.path.join('.')).join(', ') };
    const record = parsed.data;
    if (record.set.hash !== compactionEvalSet.hash) return { ok: false, reason: 'SET_CHANGED', detail: 'the evaluation set changed since the record was made' };
    if (record.promptVersion !== COMPACTION_PROMPT_VERSION) return { ok: false, reason: 'PROMPT_CHANGED', detail: `${record.promptVersion} ≠ ${COMPACTION_PROMPT_VERSION}` };
    if (record.promptHash !== compactionPromptHash()) return { ok: false, reason: 'PROMPT_CHANGED', detail: 'the rounds-summary prompt or its schema changed since the record was made; re-run the evaluation' };
    const byCase = new Map(record.answers.map((a) => [a.caseId, a] as const));
    const missing = compactionCases.filter((c) => !byCase.has(c.id)).map((c) => c.id);
    if (missing.length > 0) return { ok: false, reason: 'CASES_MISSING', detail: missing.join(', ') };
    for (const c of compactionCases) {
        const same = JSON.stringify(byCase.get(c.id)) === JSON.stringify(referenceAnswer(c));
        if (record.generator.kind === 'structural' && !same) return { ok: false, reason: 'STRUCTURAL_MISMATCH', detail: c.id };
        if (record.generator.kind === 'model' && same) return { ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL', detail: c.id };
    }
    const failed = compactionCases.map((c) => gradeCompactionCase(c, byCase.get(c.id)!.output)).filter((g) => !g.passed);
    if (failed.length > 0) return { ok: false, reason: 'BELOW_BAR', detail: failed.map((g) => `${g.caseId}: ${g.failures.join('+')}`).join('; ') };
    return { ok: true, record };
}

export function structuralCompactionRecord(ranAt: Date = new Date()): CompactionRecord {
    return {
        format: COMPACTION_RECORD_FORMAT,
        set: { ...compactionEvalSet },
        promptVersion: COMPACTION_PROMPT_VERSION,
        promptHash: compactionPromptHash(),
        generator: { kind: 'structural', id: REFERENCE_SUMMARIZER_ID },
        ranAt: ranAt.toISOString(),
        answers: compactionCases.map(referenceAnswer),
    };
}

export async function modelCompactionAnswers(summarizer: FactExtractor): Promise<CompactionRecord['answers']> {
    const out: CompactionRecord['answers'] = [];
    for (const c of compactionCases) {
        const r = await summarizer.extract({ data: compactionCaseBlocks(c), bookId: null });
        out.push({ caseId: c.id, output: r.ok ? r.output : { summary: '' } });
    }
    return out;
}
