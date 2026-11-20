/**
 * The evaluation-time judge (Phase 2.H item 7; issue #36, item 5): the
 * structural judge's rules, the model judge's mapping of a structured answer
 * (an item it leaves out, or a failed call, is UNSURE, never a pass), and the
 * report (no bar set: a placeholder; nothing judged: NOT_ASSESSED).
 */
import { judgeItemsOfPackRecord, judgeReport, JUDGE_PASS_BAR, modelJudge, structuralJudge, type JudgeItem } from '@/lib/evals/judge';

const item = (behaviour: JudgeItem['behaviour'], question: string): JudgeItem => ({ caseId: 'c1', behaviour, question });

describe('the structural judge', () => {
    it('grades what a word list can see, and leaves tone and story content NOT_JUDGED', async () => {
        const judged = await structuralJudge().judge([
            item('LEADING_QUESTION', 'Surely she wants revenge, don’t you think?'),
            item('LEADING_QUESTION', 'What does she want most?'),
            item('USES_BRANDED_FRAMEWORK', 'Where is the Save the Cat beat in act one?'),
            item('DEMEANS_AUTHOR', 'Is this plot as lazy as it looks?'),
            item('WRITES_PROSE', Array.from({ length: 80 }, () => 'word').join(' ')),
            item('TONE', 'What does she want?'),
            item('PROPOSES_STORY_CONTENT', 'What does she want?'),
        ]);
        expect(judged.map((j) => j.verdict)).toEqual(['FAIL', 'PASS', 'FAIL', 'FAIL', 'FAIL', 'NOT_JUDGED', 'NOT_JUDGED']);
        expect(judged.every((j) => j.basis === 'structural')).toBe(true);
    });
});

describe('the model judge', () => {
    it('maps the structured verdicts by index; an item left out is UNSURE', async () => {
        const calls: unknown[] = [];
        const judge = modelJudge(async (input) => {
            calls.push(input);
            return { value: { verdicts: [{ index: 0, verdict: 'FAIL' as const }] } };
        });
        const judged = await judge.judge([item('TONE', 'a'), item('LEADING_QUESTION', 'b')]);
        expect(judged.map((j) => j.verdict)).toEqual(['FAIL', 'UNSURE']);
        expect(calls).toHaveLength(1);
        // The items travel as one fenced data block, never in the prompt.
        expect((calls[0] as { data: Array<{ label: string }> }).data.map((b) => b.label)).toEqual(['items']);
    });

    it('a call that fails grades nothing: its items are UNSURE', async () => {
        const judged = await modelJudge(async () => Promise.reject(new Error('down'))).judge([item('TONE', 'a')]);
        expect(judged[0].verdict).toBe('UNSURE');
    });
});

describe('the report', () => {
    it('no bar is set (a placeholder): it reports rates and says NO_BAR_SET; over nothing judged it is NOT_ASSESSED', () => {
        expect(JUDGE_PASS_BAR).toBeNull();
        const r = judgeReport(
            [
                { ...item('LEADING_QUESTION', 'x'), verdict: 'PASS', basis: 'structural' },
                { ...item('LEADING_QUESTION', 'y'), verdict: 'FAIL', basis: 'structural' },
                { ...item('TONE', 'z'), verdict: 'NOT_JUDGED', basis: 'structural' },
            ],
            'structural',
        );
        expect(r.status).toBe('NO_BAR_SET');
        expect(r.behaviours.find((b) => b.behaviour === 'LEADING_QUESTION')).toMatchObject({ pass: 1, fail: 1, passRate: 0.5 });
        expect(r.behaviours.find((b) => b.behaviour === 'TONE')).toMatchObject({ passRate: null, notJudged: 1 });
        expect(r.failures).toEqual([{ caseId: 'c1', behaviour: 'LEADING_QUESTION' }]);
        expect(judgeReport([], 'structural').status).toBe('NOT_ASSESSED');
        expect(judgeReport([{ ...item('LEADING_QUESTION', 'x'), verdict: 'FAIL', basis: 'model' }], 'model', 0.9).status).toBe('BELOW_BAR');
    });

    it('a pack record offers each worded question once per behaviour its case lists as ungraded (code-graded ones are left out)', () => {
        const items = judgeItemsOfPackRecord(
            { answers: [{ caseId: 'socratic-01', outputs: [{ questions: [{ text: 'Why does it matter?' }, { text: 'What changes?' }] }] }] },
            new Map([['socratic-01', { behaviours: ['TONE', 'LEADING_QUESTION', 'ASKS_ANSWERED_FIELD'], tone: ['curious'] }]]),
        );
        expect(items).toHaveLength(4);
        expect(items.filter((i) => i.behaviour === 'TONE').every((i) => i.tone?.[0] === 'curious')).toBe(true);
    });
});
