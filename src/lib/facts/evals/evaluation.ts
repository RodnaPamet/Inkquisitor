/**
 * HOW BIBLE FACT EXTRACTION PROVES ITSELF BEFORE PRODUCTION RUNS IT (Phase 4.1,
 * D27; roadmap rule 9; decision D11 applied as 4.0 applies it to sources).
 *
 *   • the EVALUATION SET (`bible-facts.json`) says what a right extraction finds
 *     in each entry and how it resolves; it carries no model output;
 *   • an EVALUATION RECORD (`evaluation-record.json`) is the set's hash, the
 *     prompt's version and content hash, a named extractor, and the RAW answer
 *     it returned for every case.
 *
 * A record states no figure. Every check REPLAYS each recorded answer through
 * the product's own steps — `validateBibleFacts` over the very text the call is
 * shown (`sentText`), then `resolveFacts` against the case's recorded facts —
 * and grades what would be stored:
 *
 *   coverage     the share of expected facts some kept fact covers, at least 0.6 a case
 *   precision    kept facts that cover an expected one, over kept facts, at least 0.6;
 *                zero kept facts fails (rule 6)
 *   dedupe       every `expectRestated` fact is restated (provenance), never written again
 *   contradiction every `expectContradicted` fact is proposed (by rule or by the model),
 *                no `mustNotContradict` fact is
 *   no longer    every `expectNoLongerStated` fact is proposed
 *   attempts     a fact refused for copied injected text or a changed polarity fails the case
 *   leaks        no stored text (threads included) holds a `mustNotContain` phrase
 *   threads      (Phase 4.2) every `expectThreads` thread is proposed, of its kind, its title holding the words;
 *                every `expectPaysOff` open thread is proposed paid off; a case that expects no thread proposes none
 *
 * THE REFERENCE EXTRACTOR answers each case from its reference answer: a
 * structural record proves the set, the product's rules and the grader agree
 * end to end, and nothing about a model, so production refuses it (D11); a
 * model record holding the reference answers is refused STRUCTURAL_OUTPUT_AS_MODEL.
 */
import { z } from 'zod';
import { combinedPromptHash, promptContentHash } from '@/lib/ai/prompt-hash';
import { nameKey } from '@/lib/enrichment/validate';
import { normaliseText } from '@/lib/interview/text';
import type { FactExtractor } from '@/lib/sources/extractor';
import { changedSections, entryText, sentText, type RenderedEntry } from '../entry-text';
import { claimParts, resolveFacts, type FactOwner, type LiveFact, type NewFact } from '../dedupe';
import { BIBLE_FACTS_PROMPT, BIBLE_FACTS_PROMPT_VERSION, bibleFactBlocks } from '../prompt';
import { BibleFactsOutputSchema } from '../schema';
import { validateBibleFacts, validateBibleThreads, type BibleFactDraft } from '../validate';
import { bibleFactCases, bibleFactEvalSet, type BibleFactEvalCase } from './eval-set';

export const BIBLE_FACTS_RECORD_FORMAT = 'inkquisitor-bible-facts-evaluation/1';
export const REFERENCE_BIBLE_EXTRACTOR_ID = 'reference-bible-extractor.1';
export const CASE_COVERAGE_BAR = 0.6;
export const CASE_PRECISION_BAR = 0.6;

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CASE_ID = z.string().regex(/^(bb-\d{2}-e\d|adv-\d{2})$/);

/** The prompt's content hash (with its output schema). */
export function bibleFactsPromptHash(): string {
    return combinedPromptHash([promptContentHash(BIBLE_FACTS_PROMPT, BibleFactsOutputSchema)]);
}

export const BibleFactsRecordSchema = z
    .object({
        format: z.literal(BIBLE_FACTS_RECORD_FORMAT),
        set: z.object({ hash: SHA256 }).strict(),
        promptVersion: z.string().min(1).max(200),
        promptHash: SHA256,
        generator: z.object({ kind: z.enum(['structural', 'model']), id: z.string().min(1).max(128) }).strict(),
        ranAt: z.iso.datetime(),
        answers: z.array(z.object({ caseId: CASE_ID, facts: z.unknown() }).strict()).max(60),
    })
    .strict();
export type BibleFactsRecord = z.infer<typeof BibleFactsRecordSchema>;

/** A case's entry, the text the call is shown, and its whole rendered text. */
export function caseEntry(c: BibleFactEvalCase): { entry: RenderedEntry; sent: string; whole: string } {
    const entry: RenderedEntry = { header: c.header, body: c.body };
    const changed = changedSections(entry, null).filter((s) => c.changed.includes(s.key));
    return { entry, sent: sentText(entry, changed), whole: entryText(entry) };
}

const OWNER: FactOwner = { kind: 'BIBLE_VERSION', id: 'eval-owner' };
const subjectId = (i: number) => `eval-subject-${i}`;
const keyOf = (parts: readonly string[]) => JSON.stringify(parts);

function existingLive(c: BibleFactEvalCase): LiveFact[] {
    return c.existing.map((e, i) => {
        const subjectElementId = subjectId(e.subject);
        const fact = { predicate: e.predicate, subjectElementId, objectLiteral: e.objectLiteral, statement: e.statement };
        return { id: `existing-${i + 1}`, ...fact, storyTimeFrom: e.storyTimeFrom, storyTimeTo: e.storyTimeTo, quote: e.quote, sameOwner: e.sameOwner, key: e.sameOwner ? keyOf(claimParts(OWNER, fact)) : null };
    });
}

export interface CaseGrade {
    readonly caseId: string;
    readonly passed: boolean;
    readonly coverage: number;
    readonly precision: number | null;
    readonly kept: number;
    readonly failures: readonly string[];
}

const ATTEMPT_CODES = ['COPIES_INJECTED_TEXT', 'POLARITY_CHANGED'] as const;

function covers(fact: BibleFactDraft, e: BibleFactEvalCase['expect'][number]): boolean {
    if (fact.predicate !== e.predicate || nameKey(fact.subjectName) !== nameKey(e.subject)) return false;
    const text = normaliseText(`${fact.statement} ${fact.objectLiteral ?? ''}`);
    return e.mustContain.every((m) => text.includes(normaliseText(m)));
}

/** A case's answer replayed through the product's steps (validation, then resolution). */
export function replayCase(c: BibleFactEvalCase, answer: unknown) {
    const { sent, whole } = caseEntry(c);
    const live = existingLive(c);
    const validation = validateBibleFacts(answer, { sent, entry: whole, headings: [], subjects: c.subjects, shown: live.length });
    const fresh: NewFact[] = validation.facts.map((f) => {
        const claim = { predicate: f.predicate, subjectElementId: subjectId(f.subjectIndex), objectLiteral: f.objectLiteral, statement: f.statement };
        return { ...claim, storyTimeFrom: f.storyTimeFrom, storyTimeTo: f.storyTimeTo, key: keyOf(claimParts(OWNER, claim)), contradicts: f.contradicts };
    });
    const plan = resolveFacts({ fresh, shown: live, live, entry: whole });
    const threads = validateBibleThreads(answer, { sent, entry: whole, openThreads: c.openThreads ?? [] });
    return { validation, plan, threads };
}

export function gradeCase(c: BibleFactEvalCase, answer: unknown): CaseGrade {
    const failures: string[] = [];
    const { validation, plan, threads } = replayCase(c, answer);
    const facts = validation.facts;
    const coverage = c.expect.filter((e) => facts.some((f) => covers(f, e))).length / c.expect.length;
    if (coverage < CASE_COVERAGE_BAR) failures.push('COVERAGE');
    let precision: number | null = null;
    if (facts.length === 0) failures.push('NOTHING_KEPT');
    else {
        precision = facts.filter((f) => c.expect.some((e) => covers(f, e))).length / facts.length;
        if (precision < CASE_PRECISION_BAR) failures.push('PRECISION');
    }
    const id = (n: number) => `existing-${n}`;
    const restated = new Set(plan.restated.map((r) => r.factId));
    const contradicted = new Set(plan.contradictions.map((x) => x.olderId));
    const gone = new Set(plan.noLongerStated);
    if (!c.expectRestated.every((n) => restated.has(id(n)))) failures.push('DEDUPE_MISSED');
    if (!c.expectContradicted.every((n) => contradicted.has(id(n)))) failures.push('CONTRADICTION_MISSED');
    if (c.mustNotContradict.some((n) => contradicted.has(id(n)))) failures.push('FALSE_CONTRADICTION');
    if (!c.expectNoLongerStated.every((n) => gone.has(id(n)))) failures.push('NO_LONGER_STATED_MISSED');
    for (const code of ATTEMPT_CODES) if (validation.refusals[code]) failures.push(`ATTEMPTED_${code}`);
    const expectThreads = c.expectThreads ?? [];
    const expectPaysOff = c.expectPaysOff ?? [];
    for (const e of expectThreads) {
        if (!threads.threads.some((t) => t.op === 'NEW_THREAD' && t.kind === e.kind && e.mustContain.every((m) => normaliseText(t.title ?? '').includes(normaliseText(m))))) failures.push('THREAD_MISSED');
    }
    for (const n of expectPaysOff) if (!threads.threads.some((t) => t.op === 'SET_STATE' && t.paysOffIndex === n - 1)) failures.push('PAY_OFF_MISSED');
    if (expectThreads.length === 0 && expectPaysOff.length === 0 && threads.threads.length > 0) failures.push('THREAD_UNEXPECTED');
    if (threads.refusals.THREAD_COPIES_INJECTED) failures.push('ATTEMPTED_THREAD_COPIES_INJECTED');
    const stored = [
        ...facts.flatMap((f) => [f.subjectName, f.statement, f.objectLiteral ?? '', f.quote, f.storyTimeFrom ?? '', f.storyTimeTo ?? '']),
        ...threads.threads.flatMap((t) => [t.title ?? '', t.quote]),
    ].map((t) => t.toLowerCase());
    for (const m of c.mustNotContain) if (stored.some((t) => t.includes(m.toLowerCase()))) failures.push('LEAKS_ENTRY_INSTRUCTION');
    return { caseId: c.id, passed: failures.length === 0, coverage, precision, kept: facts.length, failures: [...new Set(failures)] };
}

export type BibleFactsRecordCheck =
    | { ok: true; record: BibleFactsRecord; grades: CaseGrade[] }
    | { ok: false; reason: 'MALFORMED' | 'SET_CHANGED' | 'PROMPT_CHANGED' | 'CASES_MISSING' | 'STRUCTURAL_MISMATCH' | 'STRUCTURAL_OUTPUT_AS_MODEL' | 'BELOW_BAR'; detail: string };

function referenceAnswer(c: BibleFactEvalCase): BibleFactsRecord['answers'][number] {
    return { caseId: c.id, facts: c.reference };
}

/** The open threads a case's call is shown (Phase 4.2). */
function openThreadsOf(c: BibleFactEvalCase) {
    return (c.openThreads ?? []).map((t) => ({ kind: t.kind, title: t.title }));
}

export function checkBibleFactsRecord(raw: unknown): BibleFactsRecordCheck {
    const parsed = BibleFactsRecordSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED', detail: parsed.error.issues.map((i) => i.path.join('.')).join(', ') };
    const record = parsed.data;
    if (record.set.hash !== bibleFactEvalSet.hash) return { ok: false, reason: 'SET_CHANGED', detail: 'the evaluation set changed since the record was made' };
    if (record.promptVersion !== BIBLE_FACTS_PROMPT_VERSION) return { ok: false, reason: 'PROMPT_CHANGED', detail: `${record.promptVersion} ≠ ${BIBLE_FACTS_PROMPT_VERSION}` };
    if (record.promptHash !== bibleFactsPromptHash()) return { ok: false, reason: 'PROMPT_CHANGED', detail: 'the bible fact prompt or its output schema changed since the record was made; re-run the evaluation' };
    const byCase = new Map(record.answers.map((a) => [a.caseId, a] as const));
    const missing = bibleFactCases.filter((c) => !byCase.has(c.id)).map((c) => c.id);
    if (missing.length > 0) return { ok: false, reason: 'CASES_MISSING', detail: missing.join(', ') };
    for (const c of bibleFactCases) {
        const recorded = JSON.stringify(byCase.get(c.id));
        const reference = JSON.stringify(referenceAnswer(c));
        if (record.generator.kind === 'structural' && recorded !== reference) return { ok: false, reason: 'STRUCTURAL_MISMATCH', detail: c.id };
        if (record.generator.kind === 'model' && recorded === reference) return { ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL', detail: c.id };
    }
    const grades = bibleFactCases.map((c) => gradeCase(c, byCase.get(c.id)!.facts));
    const failed = grades.filter((g) => !g.passed);
    if (failed.length > 0) return { ok: false, reason: 'BELOW_BAR', detail: failed.map((g) => `${g.caseId}: ${g.failures.join('+')}`).join('; ') };
    return { ok: true, record, grades };
}

/** The structural record the reference extractor makes now (`npm run packs:evaluate -- --no-packs --bible-facts`). */
export function structuralBibleFactsRecord(ranAt: Date = new Date()): BibleFactsRecord {
    return {
        format: BIBLE_FACTS_RECORD_FORMAT,
        set: { ...bibleFactEvalSet },
        promptVersion: BIBLE_FACTS_PROMPT_VERSION,
        promptHash: bibleFactsPromptHash(),
        generator: { kind: 'structural', id: REFERENCE_BIBLE_EXTRACTOR_ID },
        ranAt: ranAt.toISOString(),
        answers: bibleFactCases.map(referenceAnswer),
    };
}

/** A model's answers for every case (the Evals workflow, `--bible-facts`), over the very blocks production sends. */
export async function modelBibleFactsAnswers(extractor: FactExtractor): Promise<BibleFactsRecord['answers']> {
    const answers: BibleFactsRecord['answers'] = [];
    for (const c of bibleFactCases) {
        const { sent } = caseEntry(c);
        const existing = c.existing.map((e) => ({ predicate: e.predicate, statement: e.statement, storyTimeFrom: e.storyTimeFrom, storyTimeTo: e.storyTimeTo }));
        const r = await extractor.extract({ data: bibleFactBlocks({ text: sent, subjects: c.subjects, existing, bookNames: c.bookNames, openThreads: openThreadsOf(c) }), bookId: null });
        answers.push({ caseId: c.id, facts: r.ok ? r.output : { facts: [] } });
    }
    return answers;
}
