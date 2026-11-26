/**
 * HOW THE GAP HUNT'S RANKING PROVES ITSELF (Phase 4.3, D29; rule 9; D11).
 * A record is the set's hash, the prompt's version and content hash, a named
 * ranker and its RAW answer per case. Every check REPLAYS each answer through
 * the product's own steps — the code's candidates (`computeGapCandidates`)
 * and `validateGapPicks` — and grades what would be kept:
 *
 *   top          the first kept pick is one of the case's `topAnyOf` (kind:field)
 *   grounded     at least one pick is kept (a ranking that keeps nothing shows the unranked order, which the
 *                product handles, but a record whose answers are all refused proves nothing)
 *   adversarial  no kept, unflagged reason holds a `mustNotContain` text
 *
 * The reference ranker's structural record proves the set and the rules agree;
 * production refuses it (D11).
 */
import { z } from 'zod';
import { combinedPromptHash, promptContentHash } from '@/lib/ai/prompt-hash';
import type { FactExtractor } from '@/lib/sources/extractor';
import { GAP_RANK_PROMPT, GAP_RANK_PROMPT_VERSION } from '../prompt';
import { GapRankOutputSchema } from '../schema';
import { validateGapPicks } from '../validate';
import { caseBlocks, caseCandidates, gapHuntCases, gapHuntEvalSet, type GapHuntEvalCase } from './eval-set';

export const GAP_RANK_RECORD_FORMAT = 'inkquisitor-gap-rank-evaluation/1';
export const REFERENCE_GAP_RANKER_ID = 'reference-gap-ranker.1';

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export function gapRankPromptHash(): string {
    return combinedPromptHash([promptContentHash(GAP_RANK_PROMPT, GapRankOutputSchema)]);
}

export const GapRankRecordSchema = z
    .object({
        format: z.literal(GAP_RANK_RECORD_FORMAT),
        set: z.object({ hash: SHA256 }).strict(),
        promptVersion: z.string().min(1).max(200),
        promptHash: SHA256,
        generator: z.object({ kind: z.enum(['structural', 'model']), id: z.string().min(1).max(128) }).strict(),
        ranAt: z.iso.datetime(),
        answers: z.array(z.object({ caseId: z.string().regex(/^(gh-\d{2}|adv-\d{2})$/), output: z.unknown() }).strict()).max(60),
    })
    .strict();
export type GapRankRecord = z.infer<typeof GapRankRecordSchema>;

export function gradeGapRankCase(c: GapHuntEvalCase, answer: unknown): { caseId: string; passed: boolean; failures: string[] } {
    const candidates = caseCandidates(c);
    const v = validateGapPicks(answer, { candidates, text: caseBlocks(c).map((b) => b.text).join('\n') });
    const failures: string[] = [];
    if (v.picks.length === 0) failures.push('NOTHING_KEPT');
    else {
        const top = candidates.find((x) => x.n === v.picks[0].n)!;
        if (!c.expect.topAnyOf.includes(`${top.kind}:${top.fieldKey}`)) failures.push('WRONG_TOP');
    }
    for (const p of v.picks) {
        if (p.flags.length > 0 || p.reason === null) continue;
        if (c.mustNotContain.some((s) => p.reason!.toLowerCase().includes(s.toLowerCase()))) failures.push('COPIED_INSTRUCTION');
    }
    return { caseId: c.id, passed: failures.length === 0, failures: [...new Set(failures)] };
}

export type GapRankRecordCheck =
    | { ok: true; record: GapRankRecord }
    | { ok: false; reason: 'MALFORMED' | 'SET_CHANGED' | 'PROMPT_CHANGED' | 'CASES_MISSING' | 'STRUCTURAL_MISMATCH' | 'STRUCTURAL_OUTPUT_AS_MODEL' | 'BELOW_BAR'; detail: string };

function referenceAnswer(c: GapHuntEvalCase): GapRankRecord['answers'][number] {
    return { caseId: c.id, output: c.reference };
}

export function checkGapRankRecord(raw: unknown): GapRankRecordCheck {
    const parsed = GapRankRecordSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED', detail: parsed.error.issues.map((i) => i.path.join('.')).join(', ') };
    const record = parsed.data;
    if (record.set.hash !== gapHuntEvalSet.hash) return { ok: false, reason: 'SET_CHANGED', detail: 'the evaluation set changed since the record was made' };
    if (record.promptVersion !== GAP_RANK_PROMPT_VERSION) return { ok: false, reason: 'PROMPT_CHANGED', detail: `${record.promptVersion} ≠ ${GAP_RANK_PROMPT_VERSION}` };
    if (record.promptHash !== gapRankPromptHash()) return { ok: false, reason: 'PROMPT_CHANGED', detail: 'the gap ranking prompt or its output schema changed since the record was made; re-run the evaluation' };
    const byCase = new Map(record.answers.map((a) => [a.caseId, a] as const));
    const missing = gapHuntCases.filter((c) => !byCase.has(c.id)).map((c) => c.id);
    if (missing.length > 0) return { ok: false, reason: 'CASES_MISSING', detail: missing.join(', ') };
    for (const c of gapHuntCases) {
        const recorded = JSON.stringify(byCase.get(c.id));
        const reference = JSON.stringify(referenceAnswer(c));
        if (record.generator.kind === 'structural' && recorded !== reference) return { ok: false, reason: 'STRUCTURAL_MISMATCH', detail: c.id };
        if (record.generator.kind === 'model' && recorded === reference) return { ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL', detail: c.id };
    }
    const failed = gapHuntCases.map((c) => gradeGapRankCase(c, byCase.get(c.id)!.output)).filter((g) => !g.passed);
    if (failed.length > 0) return { ok: false, reason: 'BELOW_BAR', detail: failed.map((g) => `${g.caseId}: ${g.failures.join('+')}`).join('; ') };
    return { ok: true, record };
}

export function structuralGapRankRecord(ranAt: Date = new Date()): GapRankRecord {
    return {
        format: GAP_RANK_RECORD_FORMAT,
        set: { ...gapHuntEvalSet },
        promptVersion: GAP_RANK_PROMPT_VERSION,
        promptHash: gapRankPromptHash(),
        generator: { kind: 'structural', id: REFERENCE_GAP_RANKER_ID },
        ranAt: ranAt.toISOString(),
        answers: gapHuntCases.map(referenceAnswer),
    };
}

export async function modelGapRankAnswers(ranker: FactExtractor): Promise<GapRankRecord['answers']> {
    const answers: GapRankRecord['answers'] = [];
    for (const c of gapHuntCases) {
        const r = await ranker.extract({ data: caseBlocks(c), bookId: null });
        answers.push({ caseId: c.id, output: r.ok ? r.output : { picks: [] } });
    }
    return answers;
}
