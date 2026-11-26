/**
 * The stress test's evaluation record check (Phase 4.3, D29; D11): a record
 * claiming a real model is refused STRUCTURAL_OUTPUT_AS_MODEL only when it is
 * the reference tester's output, never because a faithful model answered a case
 * whose reference keeps no weak point exactly as the reference does.
 */
import { checkStressTestRecord, structuralStressTestRecord } from '@/lib/stress-test/evals/evaluation';
import { stressTestCases } from '@/lib/stress-test/evals/eval-set';

function asModel(answers: ReturnType<typeof structuralStressTestRecord>['answers']) {
    return { ...structuralStressTestRecord(new Date('2026-11-26T00:00:00Z')), generator: { kind: 'model' as const, id: 'claude-test' }, answers };
}

it('the structural record passes as structural', () => {
    expect(checkStressTestRecord(structuralStressTestRecord()).ok).toBe(true);
});

it('a model record that IS the reference answers is refused STRUCTURAL_OUTPUT_AS_MODEL', () => {
    const check = checkStressTestRecord(asModel(structuralStressTestRecord().answers));
    expect(check).toMatchObject({ ok: false, reason: 'STRUCTURAL_OUTPUT_AS_MODEL' });
});

it('a faithful model that finds nothing where the reference finds nothing is NOT refused for it', () => {
    // The set holds cases whose reference keeps no weak point: a correct model answers those exactly as the reference.
    expect(stressTestCases.some((c) => c.reference.weakPoints.length === 0)).toBe(true);
    const answers = structuralStressTestRecord().answers.map((a) => {
        const out = a.output as { weakPoints: Array<{ title: string }> };
        // Its own wording elsewhere: the same weak points, labelled in its own words.
        return out.weakPoints.length === 0 ? a : { ...a, output: { weakPoints: out.weakPoints.map((w) => ({ ...w, title: `${w.title} here` })) } };
    });
    const check = checkStressTestRecord(asModel(answers));
    expect(check.ok).toBe(true);
});
