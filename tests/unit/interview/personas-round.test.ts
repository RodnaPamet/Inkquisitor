/**
 * Several personas in one round (Phase 2.3; Stanford STORM's perspective
 * idea): each persona words its share of the frontier in its own call, with
 * its own pack, and every question it words carries its name; the lead
 * rotates by round; the Gentle Mentor's picks-first order applies only when
 * every persona of the session asks for it. No model, no database.
 */
import { getTemplate } from '@/lib/bible/templates';
import { computeFrontier } from '@/lib/interview/frontier';
import { getPacks } from '@/lib/interview/packs';
import { planRound } from '@/lib/interview/plan';
import { callPromptVersion } from '@/lib/interview/prompt';
import { orderRound, picksFirst, produceRound, type RoundElement, type RoundInput } from '@/lib/interview/round';
import type { Candidate } from '@/lib/interview/candidates';
import { fakeGenerator, fakeQuestion } from '../../helpers/fake-question-generator';

const packs = getPacks();

/** Three fresh characters: six level-1 fields on the frontier. */
function setup(personaKeys: string[], roundNumber = 1, detail = 3): RoundInput {
    const fields = getTemplate('CHARACTER').fields;
    const elements: RoundElement[] = ['a', 'b', 'c'].map((id) => ({ elementId: id, kind: 'CHARACTER', name: id.toUpperCase(), customLabel: null, fields, storedText: new Map() }));
    const frontier = computeFrontier({ elements: elements.map((e) => ({ elementId: e.elementId, kind: e.kind, fields, storedKeys: new Set() })), sessionAnswers: [], depth: 1 });
    const plan = planRound({ frontier: frontier.frontier, challengeable: [], challenged: [], challengesPlanned: 0, depth: 1, detail, personaKeys, roundNumber });
    return { bookId: 'b', dials: { depth: 1, detail }, offerRecommended: true, preferChoice: false, personaKeys, plan, elements, related: [], sessionAnswers: [], asked: [], packs };
}

it('one call per persona, each with its own pack and its share of the targets, every question tagged', async () => {
    const personas = ['socratic', 'devils-advocate', 'target-reader'];
    const input = setup(personas);
    const gen = fakeGenerator();
    const out = await produceRound(input, { generator: gen });
    expect(gen.calls.map((c) => c.personaKey)).toEqual(personas);
    for (const [i, call] of gen.calls.entries()) {
        const mine = input.plan.targets.filter((t) => t.personaKey === personas[i]);
        expect(mine.length).toBeGreaterThan(0);
        expect(call.template.system).toContain(packs.personas[personas[i] as 'socratic'].text.trim());
        for (const other of personas.filter((p) => p !== personas[i])) expect(call.template.system).not.toContain(`## Persona pack: persona-${other}`);
        expect(call.template.version).toBe(callPromptVersion([packs.craft.CHARACTER, packs.personas[personas[i] as 'socratic']]));
    }
    // Every target is asked once, by the persona it was dealt to.
    expect(out.questions).toHaveLength(input.plan.targets.length);
    for (const q of out.questions) {
        const t = input.plan.targets.find((x) => x.elementId === q.elementId && x.fieldKey === q.targetsFieldKeys[0])!;
        expect(q.personaKey).toBe(t.personaKey);
    }
    expect(out.metrics.calls.map((c) => [c.personaKey, c.packs, c.outcome])).toEqual(personas.map((p) => [p, ['craft-character@1', `persona-${p}@1`], 'OK']));
});

it('the lead persona rotates by round, and every persona keeps a share', () => {
    const personas = ['socratic', 'gentle-mentor'];
    const first = setup(personas, 1).plan.targets.map((t) => t.personaKey);
    const second = setup(personas, 2).plan.targets.map((t) => t.personaKey);
    expect(first[0]).toBe('socratic');
    expect(second[0]).toBe('gentle-mentor');
    expect(new Set(first)).toEqual(new Set(personas));
});

it('a persona whose call fails costs only its share: its fields go to the pack fallback, untagged', async () => {
    const input = setup(['socratic', 'ruthless-editor']);
    const gen = fakeGenerator();
    const failing = { ...gen, async generateCandidates(req: Parameters<typeof gen.generateCandidates>[0]) {
        if (req.personaKey === 'ruthless-editor') return { output: null, tokensUsed: 0, failure: { kind: 'PROVIDER' as const, errorCode: 'X' } };
        return gen.generateCandidates(req);
    } };
    const out = await produceRound(input, { generator: failing });
    const editors = input.plan.targets.filter((t) => t.personaKey === 'ruthless-editor').map((t) => `${t.elementId}:${t.fieldKey}`);
    for (const q of out.questions) {
        const key = `${q.elementId}:${q.targetsFieldKeys[0]}`;
        if (editors.includes(key)) expect([q.origin, q.personaKey]).toEqual(['PACK_FALLBACK', null]);
        else expect(q.personaKey).toBe('socratic');
    }
    expect(out.metrics.calls.map((c) => c.outcome)).toEqual(['OK', 'PROVIDER']);
});

describe('picks first (the Gentle Mentor’s order)', () => {
    it('a Gentle Mentor round leads each element with its picks; with another persona beside it, it does not', async () => {
        const run = async (personas: string[]) => {
            const input = setup(personas, 1, 3);
            // The model words each element's FIRST target open and its second as a scale.
            const firsts = new Set(['a', 'b', 'c'].map((id) => `${id}:${input.plan.targets.find((t) => t.elementId === id)!.fieldKey}`));
            const gen = fakeGenerator({ mutate: (q) => (firsts.has(`${q.elementId}:${q.targetsFieldKeys[0]}`) ? q : fakeQuestion(q.elementId, q.targetsFieldKeys[0], ['SCALE'])) });
            const out = await produceRound(input, { generator: gen });
            return out.questions.map((q) => `${q.elementId}:${q.kind}`);
        };
        expect(await run(['gentle-mentor'])).toEqual(['a:SCALE', 'a:OPEN', 'b:SCALE', 'b:OPEN', 'c:SCALE', 'c:OPEN']);
        expect(await run(['gentle-mentor', 'socratic'])).toEqual(['a:OPEN', 'a:SCALE', 'b:OPEN', 'b:SCALE', 'c:OPEN', 'c:SCALE']);
    });

    it('applies only when every persona of the session asks for it', () => {
        expect(picksFirst(['gentle-mentor'])).toBe(true);
        expect(picksFirst(['gentle-mentor', 'socratic'])).toBe(false);
        expect(picksFirst([])).toBe(false);
    });

    it('reorders one element’s questions by kind, keeping each element’s place and challenges last', () => {
        const input = setup(['gentle-mentor'], 1, 3);
        const plan = input.plan;
        const q = (elementId: string, key: string, kind: Candidate['kind']): Candidate => ({ ...fakeQuestion(elementId, key, ['OPEN']), kind, personaKey: 'gentle-mentor', options: null, scaleLabels: null, challengeQuote: null, recommendedAnswer: null, recommendationBasis: null, rationale: null } as Candidate);
        const [t1, t2, t3, t4] = plan.targets;
        const qs = [q(t1.elementId, t1.fieldKey, 'OPEN'), q(t2.elementId, t2.fieldKey, 'SCALE'), q(t3.elementId, t3.fieldKey, 'SCENARIO'), q(t4.elementId, t4.fieldKey, 'EITHER_OR')];
        const plain = orderRound(qs, plan);
        const picks = orderRound(qs, plan, { picksFirst: true });
        expect(plain.map((x) => x.kind)).toEqual(['OPEN', 'SCALE', 'SCENARIO', 'EITHER_OR']);
        // Two targets per element: a's two, then b's two.
        expect([t1.elementId, t2.elementId, t3.elementId, t4.elementId]).toEqual(['a', 'a', 'b', 'b']);
        // Within each element, picks lead; the elements keep their frontier order.
        expect(picks.map((x) => `${x.elementId}:${x.kind}`)).toEqual(['a:SCALE', 'a:OPEN', 'b:EITHER_OR', 'b:SCENARIO']);
        expect(picks.map((x) => x.elementId)).toEqual(plain.map((x) => x.elementId));
    });
});
