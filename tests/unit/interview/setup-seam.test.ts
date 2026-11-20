/**
 * The setup seam (Phase 2.4, src/lib/interview/setup.ts): what the sheet
 * offers on 2.2's API, the start body it sends, and the setup carried through
 * the new-interview page's query. And the order a round's questions are shown
 * in once a rephrase replaced one (`askedInOrder`).
 */
import { CODE_SETUP_DEFAULTS, interviewSetupQuery, loadSetupOptions, MAX_PERSONAS_2_2, setupFromQuery, startRequestBody } from '@/lib/interview/setup';
import { InterviewStartInput } from '@/app-layer/schemas/interview';
import { askedInOrder } from '@/app-layer/usecases/interview-state';
import type { QuestionRow } from '@/app-layer/repositories/interview.repository';

it('offers the six personas, one at most, on the code defaults (2.2)', async () => {
    const o = await loadSetupOptions('w', 'b');
    expect(o.personas.map((p) => p.key)).toHaveLength(6);
    expect(o.maxPersonas).toBe(MAX_PERSONAS_2_2);
    expect(o.defaults).toEqual(CODE_SETUP_DEFAULTS);
});

it('sends a body the start route accepts, for every target', () => {
    const setup = { ...CODE_SETUP_DEFAULTS, depth: 4, personaKeys: ['socratic' as const] };
    for (const target of [{ scope: 'ELEMENT' as const, elementId: 'el-1' }, { scope: 'KIND' as const, kind: 'SETTING' as const }, { scope: 'BOOK' as const }]) {
        expect(InterviewStartInput.safeParse(startRequestBody(target, setup)).success).toBe(true);
    }
    expect(startRequestBody({ scope: 'BOOK' }, CODE_SETUP_DEFAULTS)).toMatchObject({ persona: null });
});

it('round-trips a setup through the query, and refuses a query that names no interview', () => {
    const target = { scope: 'KIND' as const, kind: 'CHARACTER' as const };
    const setup = { depth: 5, detail: 1, personaKeys: ['ruthless-editor' as const], offerRecommended: false, preferChoice: true };
    expect(setupFromQuery(Object.fromEntries(new URLSearchParams(interviewSetupQuery(target, setup))))).toEqual({ target, setup });
    expect(setupFromQuery({})).toBeNull();
    expect(setupFromQuery({ scope: 'ELEMENT' })).toBeNull();
    expect(setupFromQuery({ scope: 'KIND', kind: 'NOT_A_KIND' })).toBeNull();
    expect(setupFromQuery({ scope: 'BOOK', depth: '9', personas: 'nobody,socratic' })?.setup).toMatchObject({ depth: CODE_SETUP_DEFAULTS.depth, personaKeys: ['socratic'] });
});

it('shows a rephrase in the place of the question it replaced, and never the replaced one', () => {
    const row = (id: string, position: number, replacesQuestionId: string | null = null, superseded = false) =>
        ({ id, position, replacesQuestionId, supersededAt: superseded ? new Date() : null }) as unknown as QuestionRow;
    const rows = [row('a', 1, null, true), row('b', 2), row('c', 3), row('a2', 4, 'a', true), row('a3', 5, 'a2')];
    expect(askedInOrder(rows).map((q) => q.id)).toEqual(['a3', 'b', 'c']);
});
