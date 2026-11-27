/**
 * HOW THE DRAFT READING PROVES ITSELF BEFORE PRODUCTION RUNS IT (Phase 5.3; roadmap rule 9; D11 applied, as 4.0, 4.1
 * and 4.2 apply it).
 *
 *   • the EVALUATION SET (`draft-read.json`) says what a right read finds in each scene, and which threads it plants
 *     or pays off; it carries no model output;
 *   • an EVALUATION RECORD (`evaluation-record.json`) is the set's hash, the prompt's version and content hash, a named
 *     reader, and the RAW answer it returned for every case.
 *
 * A record states no figure. Grading is RECOMPUTED on every check by REPLAYING each recorded answer through the
 * product's own rules (`validateDraftRead`, over the passage as the product reads it) and grading what would be stored:
 *
 *   coverage     the share of expected facts some kept fact covers (same subject by name key, same predicate, its
 *                statement holding every `mustContain` word), at least 0.6 a case
 *   precision    kept facts that cover an expected one, over kept facts, at least 0.6 a case; zero kept fails (rule 6)
 *   links        every expected link kept (thread and role), and no kept link outside the expected and the optional ones
 *   attempts     a fact or link refused for copied injected text, or a fact for a changed polarity, fails the case
 *   leaks        no stored text holds a `mustNotContain` phrase
 *
 * THE REFERENCE READER answers each case from its reference answer: a structural record proves the set, the product's
 * validation and the grader agree end to end, and nothing about a model, so production refuses it (D11); a model
 * record made by the Evals workflow holding the reference answers is refused STRUCTURAL_OUTPUT_AS_MODEL.
 */
import { z } from 'zod';
import { combinedPromptHash, promptContentHash } from '@/lib/ai/prompt-hash';
import { nameKey } from '@/lib/enrichment/validate';
import { normaliseText } from '@/lib/interview/text';
import { sanitiseChunkForStorage } from '@/lib/sources/storage';
import type { FactExtractor } from '@/lib/sources/extractor';
import { DRAFT_READ_PROMPT, DRAFT_READ_PROMPT_VERSION, draftReadBlocks } from '../prompt';
import { DraftReadOutputSchema } from '../schema';
import { validateDraftRead, type DraftReadValidation } from '../validate';
import { draftReadCases, draftReadEvalSet, type DraftReadEvalCase } from './eval-set';

export const DRAFT_READ_RECORD_FORMAT = 'inkquisitor-draft-read-evaluation/1';
export const REFERENCE_READER_ID = 'reference-draft-reader.1';
export const CASE_COVERAGE_BAR = 0.6;
export const CASE_PRECISION_BAR = 0.6;

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** The draft-reading prompt's content hash (with its output schema). */
export function draftReadPromptHash(): string {
    return combinedPromptHash([promptContentHash(DRAFT_READ_PROMPT, DraftReadOutputSchema)]);
}

export const DraftReadRecordSchema = z
    .object({
        format: z.literal(DRAFT_READ_RECORD_FORMAT),
        set: z.object({ hash: SHA256 }).strict(),
        promptVersion: z.string().min(1).max(200),
        promptHash: SHA256,
        generator: z.object({ kind: z.enum(['structural', 'model']), id: z.string().min(1).max(128) }).strict(),
        ranAt: z.iso.datetime(),
        answers: z.array(z.object({ caseId: z.string().regex(/^(dr|adv)-\d{2}$/), output: z.unknown() }).strict()).max(60),
    })
    .strict();
export type DraftReadRecord = z.infer<typeof DraftReadRecordSchema>;

/** A case's passage as the product reads it (sanitised; one piece at offset 0). */
export function casePiece(c: DraftReadEvalCase): { text: string; headingPath: string[]; offset: number } {
    return { text: sanitiseChunkForStorage({ text: c.passage, headingPath: [] }).text, headingPath: [...c.headings], offset: 0 };
}

export interface DraftReadCaseGrade {
    readonly caseId: string;
    readonly passed: boolean;
    readonly coverage: number;
    readonly precision: number | null;
    readonly kept: number;
    readonly linksKept: number;
    readonly failures: readonly string[];
}

function covers(fact: DraftReadValidation['facts'][number], e: DraftReadEvalCase['expect'][number]): boolean {
    if (fact.predicate !== e.predicate) return false;
    const a = nameKey(fact.subjectName);
    const b = nameKey(e.subject);
    if (!(a === b || a.includes(b) || b.includes(a))) return false;
    const text = normaliseText(`${fact.statement} ${fact.objectLiteral ?? ''}`);
    return e.mustContain.every((m) => text.includes(normaliseText(m)));
}

export function gradeDraftReadCase(c: DraftReadEvalCase, answer: unknown): DraftReadCaseGrade {
    const failures: string[] = [];
    const result = validateDraftRead(answer, casePiece(c), c.threads.length);
    const covered = c.expect.filter((e) => result.facts.some((f) => covers(f, e))).length;
    const coverage = covered / c.expect.length;
    if (coverage < CASE_COVERAGE_BAR) failures.push('COVERAGE');
    let precision: number | null = null;
    if (result.facts.length === 0) failures.push('NOTHING_KEPT');
    else {
        precision = result.facts.filter((f) => c.expect.some((e) => covers(f, e))).length / result.facts.length;
        if (precision < CASE_PRECISION_BAR) failures.push('PRECISION');
    }
    const keptLinks = result.links.map((l) => `${l.threadIndex + 1}|${l.role}`);
    for (const e of c.expectLinks) if (!keptLinks.includes(`${e.thread}|${e.role}`)) failures.push('LINK_MISSED');
    const allowed = new Set([...c.expectLinks, ...c.optionalLinks].map((e) => `${e.thread}|${e.role}`));
    if (keptLinks.some((k) => !allowed.has(k))) failures.push('UNEXPECTED_LINK');
    if (result.factRefusals.COPIES_INJECTED_TEXT || result.linkRefusals.COPIES_INJECTED_TEXT) failures.push('ATTEMPTED_COPIES_INJECTED_TEXT');
    if (result.factRefusals.POLARITY_CHANGED) failures.push('ATTEMPTED_POLARITY_CHANGED');
    const stored = [
        ...result.facts.flatMap((f) => [f.subjectName, f.statement, f.objectLiteral ?? '', f.quote, f.storyTimeFrom ?? '', f.storyTimeTo ?? '']),
        ...result.links.map((l) => l.quote),
    ].map((t) => t.toLowerCase());
    for (const m of c.mustNotContain) if (stored.some((t) => t.includes(m.toLowerCase()))) failures.push('LEAKS_PASSAGE_INSTRUCTION');
    return { caseId: c.id, passed: failures.length === 0, coverage, precision, kept: result.facts.length, linksKept: result.links.length, failures: [...new Set(failures)] };
}

export type DraftReadRecordCheck =
    | { ok: true; record: DraftReadRecord; grades: DraftReadCaseGrade[] }
    | { ok: false; reason: 'MALFORMED' | 'SET_CHANGED' | 'PROMPT_CHANGED' | 'CASES_MISSING' | 'STRUCTURAL_MISMATCH' | 'STRUCTURAL_OUTPUT_AS_MODEL' | 'BELOW_BAR'; detail: string };

function referenceAnswer(c: DraftReadEvalCase): DraftReadRecord['answers'][number] {
    return { caseId: c.id, output: { facts: c.reference.facts, threads: c.reference.threads } };
}

export function checkDraftReadRecord(raw: unknown): DraftReadRecordCheck {
    const parsed = DraftReadRecordSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED', detail: parsed.error.issues.map((i) => i.path.join('.')).join(', ') };
    const record = parsed.data;
    if (record.set.hash !== draftReadEvalSet.hash) return { ok: false, reason: 'SET_CHANGED', detail: 'the evaluation set changed since the record was made' };
    if (record.promptVersion !== DRAFT_READ_PROMPT_VERSION) return { ok: false, reason: 'PROMPT_CHANGED', detail: `${record.promptVersion} ≠ ${DRAFT_READ_PROMPT_VERSION}` };
    if (record.promptHash !== draftReadPromptHash()) return { ok: false, reason: 'PROMPT_CHANGED', detail: 'the draft-reading prompt or its output schema changed since the record was made; re-run the evaluation' };
    const byCase = new Map(record.answers.map((a) => [a.caseId, a] as const));
    const missing = draftReadCases.filter((c) => !byCase.has(c.id)).map((c) => c.id);
    if (missing.length > 0) return { ok: false, reason: 'CASES_MISSING', detail: missing.join(', ') };
    for (const c of draftReadCases) {
        const recorded = JSON.stringify(byCase.get(c.id));
        const reference = JSON.stringify(referenceAnswer(c));
        if (record.generator.kind === 'structural' && recorded !== reference) return { ok: false, reason: 'STRUCTURAL_MISMATCH', detail: c.id };
        if (record.generator.kind === 'model' && recorded === reference) return { ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL', detail: c.id };
    }
    const grades = draftReadCases.map((c) => gradeDraftReadCase(c, byCase.get(c.id)!.output));
    const failed = grades.filter((g) => !g.passed);
    if (failed.length > 0) return { ok: false, reason: 'BELOW_BAR', detail: failed.map((g) => `${g.caseId}: ${g.failures.join('+')}`).join('; ') };
    return { ok: true, record, grades };
}

/** The structural record the reference reader makes now (`npm run packs:evaluate -- --no-packs --draft-read`). */
export function structuralDraftReadRecord(ranAt: Date = new Date()): DraftReadRecord {
    return {
        format: DRAFT_READ_RECORD_FORMAT,
        set: { ...draftReadEvalSet },
        promptVersion: DRAFT_READ_PROMPT_VERSION,
        promptHash: draftReadPromptHash(),
        generator: { kind: 'structural', id: REFERENCE_READER_ID },
        ranAt: ranAt.toISOString(),
        answers: draftReadCases.map(referenceAnswer),
    };
}

/** A model's answers for every case (the Evals workflow, `--draft-read`). */
export async function modelDraftReadAnswers(reader: FactExtractor): Promise<DraftReadRecord['answers']> {
    const answers: DraftReadRecord['answers'] = [];
    for (const c of draftReadCases) {
        const piece = casePiece(c);
        const r = await reader.extract({ data: draftReadBlocks({ text: piece.text, headings: piece.headingPath, bookNames: c.bookNames, threads: c.threads }), bookId: null });
        answers.push({ caseId: c.id, output: r.ok ? r.output : { facts: [], threads: [] } });
    }
    return answers;
}
