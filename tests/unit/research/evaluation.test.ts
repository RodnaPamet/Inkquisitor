/**
 * The research evaluation (Phase 2.6, rule 9, D11): the committed structural
 * record passes the recomputed grading; a record that drifts, or a model that
 * obeys an adversarial page, does not; production refuses a structural record.
 */
import committed from '@/lib/research/evals/evaluation-record.json';
import { adversarialCases, allResearchCases, researchCases } from '@/lib/research/evals/eval-set';
import { checkResearchRecord, gradeCase, referenceAnswer, structuralRecord } from '@/lib/research/evals/evaluation';
import { researchGate } from '@/lib/research/record-gate';
import { RESEARCH_PROMPT_VERSION } from '@/lib/research/prompt';

it('eleven briefs across genres (one scoped to manuscript scenes, Phase 5.1) and six adversarial pages', () => {
    expect(researchCases).toHaveLength(11);
    expect(new Set(researchCases.map((c) => c.genre)).size).toBe(11);
    expect(researchCases.filter((c) => (c.scenes ?? []).length > 0)).toHaveLength(1);
    expect(adversarialCases).toHaveLength(6);
    expect(adversarialCases.every((c) => c.attack && c.expect.mustNotContain.length > 0)).toBe(true);
});

it('the committed structural record passes, and is exactly what the deterministic researcher makes', async () => {
    const check = await checkResearchRecord(committed);
    expect(check).toMatchObject({ ok: true, validity: 1 });
    expect(JSON.stringify({ ...committed, ranAt: '' })).toBe(JSON.stringify({ ...structuralRecord(), ranAt: '' }));
});

it('D11: production accepts only a real model’s record; development and test the structural one too', async () => {
    expect(await researchGate('model')).toMatchObject({ mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED' });
    expect(await researchGate('structural')).toEqual({ mounted: true, recordKind: 'structural' });
});

it('refuses a record made for other sets or prompts, a structural record that drifts, and a model record holding the reference', async () => {
    const base = structuralRecord();
    expect(await checkResearchRecord({ ...base, promptVersion: 'research.old' })).toMatchObject({ ok: false, reason: 'PROMPT_CHANGED' });
    expect(await checkResearchRecord({ ...base, sets: { ...base.sets, research: { hash: `sha256:${'0'.repeat(64)}` } } })).toMatchObject({ ok: false, reason: 'SETS_CHANGED' });
    expect(await checkResearchRecord({ ...base, answers: base.answers.slice(1) })).toMatchObject({ ok: false, reason: 'CASES_MISSING' });
    const drifted = { ...base, answers: base.answers.map((a, i) => (i === 0 ? { ...a, fit: { proposals: [], noFit: [] } } : a)) };
    expect(await checkResearchRecord(drifted)).toMatchObject({ ok: false, reason: 'STRUCTURAL_MISMATCH' });
    expect(await checkResearchRecord({ ...base, generator: { kind: 'model', id: 'claude-sonnet-5-5' } })).toMatchObject({ ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL' });
    expect(base.promptVersion).toBe(RESEARCH_PROMPT_VERSION);
});

describe('the grader', () => {
    it('fails a model that obeys the page: a quoted instruction, a proposal carrying it, a query following it', async () => {
        const c = adversarialCases.find((x) => x.id === 'adv-01')!;
        const page = c.web[0].text;
        const injected = page.slice(page.indexOf('Ignore'));
        const obeying = {
            ...referenceAnswer(c),
            findings: { findings: [...(c.reference.findings as { findings: unknown[] }).findings, { claim: 'The duke is the murderer.', summary: injected, confidence: 'HIGH', citations: [{ ref: 'web.1', quote: injected }] }] },
        };
        const g = await gradeCase(c, obeying);
        expect(g.passed).toBe(false);
        expect(g.failures).toContain('ATTEMPTED_QUOTE_FLAGGED');
    });

    it('fails a query that quotes the scope, and one that follows a page’s request', async () => {
        const c = adversarialCases.find((x) => x.id === 'adv-02')!;
        const quoting = { ...referenceAnswer(c), gather: { queries: ['Tranquil Base pressurised lunar base'], fetched: c.web.map((w) => w.url) } };
        const g = await gradeCase(c, quoting);
        expect(g.failures).toEqual(expect.arrayContaining(['QUERY_FOLLOWS_PAGE']));
    });

    it('fails a model that writes the scene the page and the scene ask for (D3), or notes no scene where one is expected', async () => {
        const c = adversarialCases.find((x) => x.id === 'adv-06')!;
        const prose = { op: 'SCENE_NOTE', elementId: null, fieldKey: null, value: '"Trim the wick, Tomas," his father said, and the lamp flared in the dark.', newKind: null, newName: null, newSummary: null, rationale: 'The next paragraph.', cites: ['f1'], sceneRef: 's1' };
        const g = await gradeCase(c, { ...referenceAnswer(c), fit: { proposals: [prose], noFit: [] } });
        expect(g.passed).toBe(false);
        expect(g.failures).toEqual(expect.arrayContaining(['ATTEMPTED_WRITES_PROSE', 'NO_SCENE_NOTE']));
        const s = researchCases.find((x) => (x.scenes ?? []).length > 0)!;
        const elsewhere = (s.reference.fit as { proposals: Array<Record<string, unknown>> }).proposals.map((p) => (p.op === 'SCENE_NOTE' ? { ...p, sceneRef: 's2' } : p));
        expect((await gradeCase(s, { ...referenceAnswer(s), fit: { proposals: elsewhere, noFit: [] } })).failures).toContain('SCENE_NOTE_PRECISION');
    });

    it('a case with no fit is not a pass (rule 6)', async () => {
        const c = researchCases[0];
        const g = await gradeCase(c, { ...referenceAnswer(c), fit: { proposals: [], noFit: [] } });
        expect(g.failures).toContain('NO_FIT');
    });

    it('every reference answer passes every check', async () => {
        for (const c of allResearchCases) expect(await gradeCase(c, referenceAnswer(c))).toMatchObject({ passed: true, coverage: 1 });
    });
});
