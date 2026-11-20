/**
 * "Ask me this differently" is evaluated like every other prompt (Phase 2.H
 * item 7; issue #36, item 4): its set, its record replayed through the
 * product's own step. No gate reads it on the request path (D17): a
 * rephrase runs in production without a real-model record.
 */
import { getPacks } from '@/lib/interview/packs';
import committed from '@/lib/interview/evals/rephrase-evaluation-record.json';
import { checkRephraseRecord, rephraseEvalSet, STRUCTURAL_REPHRASER_ID, type RephraseRecord } from '@/lib/interview/evals/rephrase-evaluation';

const registry = getPacks();
const record = committed as unknown as RephraseRecord;
const clone = (): RephraseRecord => JSON.parse(JSON.stringify(record)) as RephraseRecord;

describe('the rephrase evaluation', () => {
    it('the set holds ten questions, each on a field its element leaves open', () => {
        expect(rephraseEvalSet().cases).toHaveLength(10);
    });

    it('the committed structural record passes, replayed', async () => {
        const check = await checkRephraseRecord(record, registry);
        expect(check).toMatchObject({ ok: true });
        if (check.ok) expect(check.grades.every((g) => g.passed)).toBe(true);
    });

    it('a record made under another prompt text is refused PROMPT_HASH_MISMATCH, whatever its version says', async () => {
        const r = clone();
        r.promptHash = `sha256:${'0'.repeat(64)}`;
        await expect(checkRephraseRecord(r, registry)).resolves.toMatchObject({ ok: false, reason: 'PROMPT_HASH_MISMATCH' });
    });

    it('a structural record that is not what the structural rephraser produces is refused; relabelled as a model’s it is refused too', async () => {
        const edited = clone();
        edited.answers[0].output = { questions: [], declined: [] };
        await expect(checkRephraseRecord(edited, registry)).resolves.toMatchObject({ ok: false, reason: 'GENERATOR_MISMATCH' });
        const relabelled = clone();
        relabelled.generator = { kind: 'model', id: 'claude-haiku-5-5' };
        await expect(checkRephraseRecord(relabelled, registry)).resolves.toMatchObject({ ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL' });
        expect(record.generator.id).toBe(STRUCTURAL_REPHRASER_ID);
    });

    it('a model that repeats the question it was asked to reword fails its cases (NO_REPHRASE), and the record does not pass', async () => {
        const set = rephraseEvalSet();
        const r = clone();
        r.generator = { kind: 'model', id: 'claude-haiku-5-5' };
        r.answers = set.cases.map((c) => ({
            caseId: c.id,
            output: { questions: [{ elementId: `eval-${c.id}`, targetsFieldKeys: [c.original.fieldKey], mode: 'FRONTIER', kind: c.original.kind, text: c.original.text, rationale: 'Asks it again.' }], declined: [] },
        }));
        await expect(checkRephraseRecord(r, registry)).resolves.toMatchObject({ ok: false, reason: 'BELOW_THRESHOLD' });
    });
});
