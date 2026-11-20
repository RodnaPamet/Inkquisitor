/**
 * "Ask me this differently" (Phase 2.4; design 5.2): the pure rephrase step.
 * The replacement is held to the round's rules for the SAME targets, must not
 * repeat what was asked, and falls back to the pack; the old wording travels
 * as author data, never in the system prompt.
 */
import { getTemplate } from '@/lib/bible/templates';
import { getPacks } from '@/lib/interview/packs';
import { GenerationStop } from '@/lib/interview/generator';
import { buildRephraseRequest, produceRephrase, REPHRASE_PROMPT, REPHRASE_PROMPT_VERSION, type RephraseInput } from '@/lib/interview/rephrase';
import { fakeGenerator, fakeQuestion } from '../../helpers/fake-question-generator';

const packs = getPacks();
const EL = 'el-1';

function input(overrides: Partial<RephraseInput['original']> = {}): RephraseInput {
    const original = { ...fakeQuestion(EL, 'role', ['OPEN']), options: null, scaleLabels: null };
    return {
        bookId: 'b',
        dials: { depth: 2, detail: 3 },
        offerRecommended: true,
        preferChoice: false,
        persona: null,
        craft: packs.craft,
        element: { elementId: EL, kind: 'CHARACTER', name: 'Dov Hartigan', customLabel: null, fields: getTemplate('CHARACTER').fields, storedText: new Map() },
        original: { id: 'q-1', scope: 'SESSION', challengeQuote: null, personaKey: null, ...original, mode: 'FRONTIER', ...overrides },
        related: [],
        sessionAnswers: [],
        asked: [],
    };
}

const rewording = fakeGenerator({ mutate: (q) => ({ ...q, text: 'Picture a stranger meeting them on a bad day: what do they see them doing for a living?' }) });

it('is its own prompt, on the fast tier, with a version and a per-call cost budget (rule 9)', () => {
    expect(REPHRASE_PROMPT).toMatchObject({ id: 'interview.rephrase', version: REPHRASE_PROMPT_VERSION, tier: 'fast' });
    expect(REPHRASE_PROMPT.costBudgetMicroUsd).toBeGreaterThan(0);
});

it('sends the old wording as a data block and the same targets, never the wording in the system prompt', () => {
    const request = buildRephraseRequest(input());
    const previous = request.data.find((b) => b.label === 'previous-wording');
    expect(JSON.parse(previous!.text)).toMatchObject({ kind: 'OPEN', targetsFieldKeys: ['role'] });
    expect(request.template.system).not.toContain(input().original.text);
    expect(JSON.parse(request.data.find((b) => b.label === 'targets.1')!.text)).toMatchObject({ allowed_targets: ['role'], may_challenge: null });
});

it('takes a replacement for the same target that does not repeat the question', async () => {
    const out = await produceRephrase(input(), { generator: rewording });
    expect(out.question).toMatchObject({ origin: 'REPHRASE', elementId: EL, targetsFieldKeys: ['role'], mode: 'FRONTIER' });
});

it('refuses a repeat, and a question about another field, then asks the pack instead', async () => {
    const repeat = await produceRephrase(input(), { generator: fakeGenerator() });
    expect(repeat.dropped.DUPLICATE).toBe(1);
    expect(repeat.question?.origin).toBe('PACK_FALLBACK');
    expect(repeat.question?.text).not.toBe(input().original.text);
    const other = await produceRephrase(input(), { generator: fakeGenerator({ mutate: (q) => ({ ...q, targetsFieldKeys: ['want'] }) }) });
    expect(other.dropped.NOT_ASSIGNED).toBe(1);
});

it('offers no pack question for a challenge: nothing, rather than a different question', async () => {
    const out = await produceRephrase(input({ mode: 'CHALLENGE', challengeQuote: 'a quote of four words' }), { generator: fakeGenerator({ failWith: 'PROVIDER' }) });
    expect(out).toMatchObject({ question: null, failure: 'PROVIDER' });
});

it('carries the guard’s flag on the replacement, and rethrows a session stop', async () => {
    const flagged = await produceRephrase(input(), {
        generator: { ...rewording, generateCandidates: async (r, s) => ({ ...(await rewording.generateCandidates(r, s)), reviewRequired: true }) },
    });
    expect(flagged.question?.reviewRequired).toBe(true);
    await expect(
        produceRephrase(input(), {
            generator: { unavailableReason: () => null, generateCandidates: async () => Promise.reject(new GenerationStop('KILL_SWITCH', 'AI_DISABLED', null, 0)) },
        }),
    ).rejects.toBeInstanceOf(GenerationStop);
});
