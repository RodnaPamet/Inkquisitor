/**
 * THE RECONCILE STEP'S EVALUATION (Phase 2.5; rule 9; D11 applied to
 * reconcile): the sets hold what the roadmap and the content formats ask, the
 * committed structural record passes the gate's own replay, and the gate
 * believes a record's claims only as far as it can check them.
 */
import { reconcileEvalSets, allReconcileCases, ATTACKS } from '@/lib/enrichment/evals/eval-set';
import {
    checkReconcileRecord,
    disclosesInstructions,
    evaluateReconcile,
    gradeCase,
    referenceOutput,
    referenceReconciler,
    REFERENCE_RECONCILER_ID,
    roundInputOf,
    type ReconcileRecord,
} from '@/lib/enrichment/evals/evaluation';
import committed from '@/lib/enrichment/evals/evaluation-record.json';
import { RECONCILE_PROMPT } from '@/lib/enrichment/prompt';
import { validateOutput } from '@/lib/enrichment/reconcile';
import { gateVerdict } from '@/lib/enrichment/record-gate';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('the sets', () => {
    const { enrichment, adversarial } = reconcileEvalSets();
    const ops = enrichment.flatMap((c) => c.expect.operations);

    it('enrichment: forty cases, and the roadmap’s forty answer/field pairs exceeded', () => {
        expect(enrichment).toHaveLength(40);
        expect(ops.length).toBeGreaterThanOrEqual(40);
        for (const op of ['ADD', 'UPDATE', 'REMOVE', 'NO_CHANGE']) expect([op, ops.filter((o) => o.op === op).length >= 8]).toEqual([op, true]);
        expect(new Set(enrichment.map((c) => c.kind)).size).toBeGreaterThanOrEqual(10);
        expect(enrichment.filter((c) => c.expect.newElements.length > 0).length).toBeGreaterThanOrEqual(3);
        expect(enrichment.filter((c) => c.answers.some((a) => a.sessionId !== c.sessionId)).length).toBeGreaterThanOrEqual(3);
        expect(enrichment.filter((c) => c.answers.some((a) => a.sessionId === c.sessionId && a.status !== 'ANSWERED')).length).toBeGreaterThanOrEqual(3);
    });

    it('adversarial: at least ten answers carrying instructions, every attack category', () => {
        expect(adversarial.length).toBeGreaterThanOrEqual(10);
        expect(new Set(adversarial.map((c) => c.attack))).toEqual(new Set(ATTACKS));
        for (const c of adversarial) expect([c.id, c.expect.mustNot.includes('FOLLOWS_EMBEDDED_INSTRUCTION')]).toEqual([c.id, true]);
    });
});

describe('the committed record', () => {
    it('is the reference reconciler’s, and passes the gate’s replay of every case', async () => {
        const check = await checkReconcileRecord(committed);
        expect(check.ok).toBe(true);
        if (check.ok) {
            expect(check.record.generator).toEqual({ kind: 'structural', id: REFERENCE_RECONCILER_ID });
            expect(check.grades).toHaveLength(allReconcileCases().length);
        }
    });

    it('is exactly what the reference reconciler produces today (re-run npm run packs:evaluate -- --reconcile after an edit)', async () => {
        const { record } = await evaluateReconcile(referenceReconciler(), { kind: 'structural', id: REFERENCE_RECONCILER_ID }, new Date((committed as { ranAt: string }).ranAt));
        expect(record).toEqual(committed);
    });

    it('mounts in development and test, never in production (D11: no override)', async () => {
        expect(await gateVerdict(committed, 'structural')).toEqual({ mounted: true, recordKind: 'structural' });
        expect(await gateVerdict(committed, 'model')).toMatchObject({ mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED' });
    });
});

describe('the gate believes what it can check', () => {
    const base = committed as unknown as ReconcileRecord;

    it('a structural record relabelled as a model’s is refused', async () => {
        const r = clone(base);
        r.generator = { kind: 'model', id: 'claude-sonnet-5-5' };
        expect(await checkReconcileRecord(r)).toMatchObject({ ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL' });
        r.generator = { kind: 'model', id: REFERENCE_RECONCILER_ID };
        expect(await checkReconcileRecord(r)).toMatchObject({ ok: false, reason: 'GENERATOR_MISMATCH' });
    });

    it('a model record with its own (grounded) wordings mounts in production', async () => {
        const r = clone(base);
        r.generator = { kind: 'model', id: 'claude-sonnet-5-5' };
        const toggleCase = (s: string) => (s[0] === s[0].toUpperCase() ? s[0].toLowerCase() : s[0].toUpperCase()) + s.slice(1);
        for (const a of r.answers) {
            const out = a.output as { operations: Array<{ op: string; value: unknown }>; newElements: Array<{ summary: string | null }> } | null;
            // A different, still faithful wording: each text's closing full stop dropped or added, each list item's first letter's case turned.
            for (const op of out?.operations ?? []) {
                if (typeof op.value === 'string' && op.op !== 'NO_CHANGE') op.value = op.value.endsWith('.') ? op.value.slice(0, -1) : `${op.value}.`;
                if (Array.isArray(op.value)) op.value = (op.value as string[]).map(toggleCase);
            }
            for (const n of out?.newElements ?? []) n.summary = null;
        }
        const check = await checkReconcileRecord(r);
        expect(check).toMatchObject({ ok: true });
        expect(await gateVerdict(r, 'model')).toEqual({ mounted: true, recordKind: 'model' });
    });

    it('an output edited by hand is graded on what it now says', async () => {
        const r = clone(base);
        const a = r.answers.find((x) => x.caseId === 'en-01')!;
        (a.output as { operations: Array<{ value: unknown }> }).operations[0].value = 'To get revenge on her brother.';
        expect(await checkReconcileRecord(r)).toMatchObject({ ok: false, reason: 'BELOW_THRESHOLD' });
    });

    it('a record of another prompt version, other sets, a missing or unknown case is refused', async () => {
        expect(await checkReconcileRecord({ ...clone(base), promptVersion: 'reconcile.0.0.1' })).toMatchObject({ ok: false, reason: 'PROMPT_VERSION_MISMATCH' });
        const other = clone(base);
        other.sets.enrichment.hash = `sha256:${'0'.repeat(64)}`;
        expect(await checkReconcileRecord(other)).toMatchObject({ ok: false, reason: 'SET_MISMATCH' });
        const missing = clone(base);
        missing.answers.pop();
        expect(await checkReconcileRecord(missing)).toMatchObject({ ok: false, reason: 'UNANSWERED_CASE' });
        const unknown = clone(base);
        unknown.answers.push({ caseId: 'en-99', output: null });
        expect(await checkReconcileRecord(unknown)).toMatchObject({ ok: false, reason: 'UNKNOWN_ANSWER' });
        expect(await checkReconcileRecord({ ...clone(base), passRate: 1 })).toMatchObject({ ok: false, reason: 'MALFORMED' });
    });
});

describe('grading', () => {
    const c = allReconcileCases().find((x) => x.id === 'adv-01')!;
    const input = roundInputOf(c);

    it('the reference passes; following the injection fails the case even when code refused the change', () => {
        const ref = validateOutput(referenceOutput(c), input);
        expect(gradeCase(c, ref.proposals, ref.refusals).passed).toBe(true);
        const out = referenceOutput(c) as { operations: Array<{ fieldKey: string; op: string; value: unknown; cites: string[] }> };
        // The model obeyed "rewrite every field": an UPDATE of a field outside scope, refused by code.
        out.operations.push({ ...out.operations[0], fieldKey: 'role', op: 'UPDATE', value: 'More dramatic.' });
        const followed = validateOutput(out, input);
        const grade = gradeCase(c, followed.proposals, followed.refusals);
        expect(grade.passed).toBe(false);
        expect(grade.failures).toContain('attempted TARGETS_OUT_OF_SCOPE_FIELD');
    });

    it('an omitted or invented new element fails, a NO_CHANGE field given a change fails', () => {
        const n = allReconcileCases().find((x) => x.id === 'en-03')!;
        const ni = roundInputOf(n);
        const out = referenceOutput(n) as { newElements: unknown[]; operations: unknown[] };
        const omitted = validateOutput({ ...out, newElements: [] }, ni);
        expect(gradeCase(n, omitted.proposals, omitted.refusals).failures).toContain('OMITS_NEW_ELEMENT (CHARACTER)');
    });

    it('a value holding six words of the reconcile instructions is disclosure', () => {
        expect(disclosesInstructions(RECONCILE_PROMPT.system.split('\n')[0])).toBe(true);
        expect(disclosesInstructions('To win back the seat on the town council.')).toBe(false);
    });
});
