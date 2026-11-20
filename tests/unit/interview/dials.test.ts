/**
 * The dials (Phase 2.3): their precedence (session > book > workspace > code
 * default, dial by dial), and what each one moves — prompts and budgets, and
 * nothing else. No database.
 */
import { getTemplate } from '@/lib/bible/templates';
import { computeFrontier } from '@/lib/interview/frontier';
import { CODE_DEFAULT_DIALS, dialEffects, isPersonaList, nextRoundGenerationTokens, resolveDials, type DialSettings } from '@/lib/interview/dial-settings';
import { DETAIL, DEPTH, MAX_ROUNDS, TOKENS_PER_GENERATION_CALL, TOKENS_PER_RECONCILE_CALL } from '@/lib/interview/dials';
import { getPacks } from '@/lib/interview/packs';
import { planRound } from '@/lib/interview/plan';
import { buildGenerationRequest, maxOutputTokensFor } from '@/lib/interview/prompt';

describe('precedence: session > book > workspace > code default, per dial', () => {
    it('with no layer, the code default', () => {
        expect(resolveDials({})).toEqual({
            settings: { ...CODE_DEFAULT_DIALS, personaKeys: [] },
            sources: { depth: 'code', detail: 'code', personaKeys: 'code', offerRecommended: 'code', preferChoice: 'code' },
        });
    });

    it('each dial comes from the highest layer that sets it, independently of the others', () => {
        const r = resolveDials({
            session: { personaKeys: ['socratic'] },
            book: { detail: 4, personaKeys: ['gentle-mentor', 'ruthless-editor'] },
            workspace: { depth: 2, detail: 1, offerRecommended: false },
        });
        expect(r.settings).toEqual({ depth: 2, detail: 4, personaKeys: ['socratic'], offerRecommended: false, preferChoice: false });
        expect(r.sources).toEqual({ depth: 'workspace', detail: 'book', personaKeys: 'session', offerRecommended: 'workspace', preferChoice: 'code' });
    });

    it('null and undefined pass the dial on; false and [] are settings', () => {
        const r = resolveDials({ session: { depth: null, preferChoice: undefined, personaKeys: [] }, book: { depth: 5, offerRecommended: false }, workspace: { personaKeys: ['socratic'], preferChoice: true } });
        expect(r.settings).toMatchObject({ depth: 5, personaKeys: [], offerRecommended: false, preferChoice: true });
        expect(r.sources).toMatchObject({ depth: 'book', personaKeys: 'session', offerRecommended: 'book', preferChoice: 'workspace' });
    });

    it('a stored value that is no longer acceptable is passed over, never used', () => {
        const r = resolveDials({ book: { depth: 9 as number, personaKeys: ['socratic', 'socratic'] as never }, workspace: { depth: 2, personaKeys: ['the-critic'] as never } });
        expect(r.settings.depth).toBe(2);
        expect(r.settings.personaKeys).toEqual([]);
        expect(r.sources.personaKeys).toBe('code');
    });

    it('a persona list is at most three known keys, none twice', () => {
        expect(isPersonaList(['socratic', 'gentle-mentor', 'target-reader'])).toBe(true);
        expect(isPersonaList([])).toBe(true);
        expect(isPersonaList(['socratic', 'gentle-mentor', 'target-reader', 'devils-advocate'])).toBe(false);
        expect(isPersonaList(['socratic', 'socratic'])).toBe(false);
        expect(isPersonaList(['socratic', 'the-critic'])).toBe(false);
    });

    it('the result is a copy: changing it changes no layer', () => {
        const book = { personaKeys: ['socratic' as const] };
        const r = resolveDials({ book });
        r.settings.personaKeys.push('gentle-mentor');
        expect(book.personaKeys).toEqual(['socratic']);
    });
});

describe('what a dial moves: budgets', () => {
    const base: DialSettings = { depth: 3, detail: 3, personaKeys: [], offerRecommended: true, preferChoice: false };

    it('depth: the levels in reach and the rounds, increasing, at most six', () => {
        const rounds = [1, 2, 3, 4, 5].map((depth) => dialEffects({ ...base, depth }));
        expect(rounds.map((e) => e.levelsInReach)).toEqual([1, 2, 3, 4, 5]);
        expect(rounds.map((e) => e.roundBudget)).toEqual([2, 3, 4, 5, 6]);
        expect(Math.max(...rounds.map((e) => e.roundBudget))).toBe(MAX_ROUNDS);
        expect(rounds.map((e) => e.depthEmphasis)).toEqual([1, 2, 3, 4, 5].map((d) => DEPTH[d].emphasis));
    });

    it('detail: fewer, longer questions as it rises; one-line picks at 1, scenarios at 5', () => {
        const e = [1, 2, 3, 4, 5].map((detail) => dialEffects({ ...base, detail }));
        expect(e.map((x) => x.roundCap)).toEqual([8, 7, 6, 4, 3]);
        expect(e[0].kindsAllowed).toEqual(['CHOICE', 'EITHER_OR', 'SCALE']);
        expect(e[4].kindsAllowed).toEqual(['OPEN', 'SCENARIO']);
        expect(e.map((x) => x.answerTextMax)).toEqual([300, 300, 600, 1_500, 4_000]);
        expect(e.map((x) => x.answerOutputTokens)).toEqual([1, 2, 3, 4, 5].map((d) => DETAIL[d].maxOutputTokens));
        expect(e.map((x) => x.detailReply)).toEqual([1, 2, 3, 4, 5].map((d) => DETAIL[d].reply));
    });

    it('manner: one generation call per persona a round, and the token budget grows with them', () => {
        const none = dialEffects(base);
        const three = dialEffects({ ...base, personaKeys: ['socratic', 'gentle-mentor', 'ruthless-editor'] });
        expect(none.generationCallsPerRound).toBe(1);
        expect(three.generationCallsPerRound).toBe(3);
        expect(three.tokenBudget).toBe(4 * 3 * TOKENS_PER_GENERATION_CALL + 4 * TOKENS_PER_RECONCILE_CALL);
        expect(three.tokenBudget).toBeGreaterThan(none.tokenBudget);
        expect(nextRoundGenerationTokens(0)).toBe(TOKENS_PER_GENERATION_CALL);
        expect(nextRoundGenerationTokens(3)).toBe(3 * TOKENS_PER_GENERATION_CALL);
    });
});

describe('what a dial moves: the prompt', () => {
    const packs = getPacks();
    const EL = 'el-1';
    const fields = getTemplate('CHARACTER').fields;

    function request(settings: DialSettings, persona: 'socratic' | 'gentle-mentor' | null = null) {
        const frontier = computeFrontier({ elements: [{ elementId: EL, kind: 'CHARACTER', fields, storedKeys: new Set() }], sessionAnswers: [], depth: settings.depth });
        const plan = planRound({ frontier: frontier.frontier, challengeable: [], challenged: [], challengesPlanned: 0, depth: settings.depth, detail: settings.detail, personaKeys: persona ? [persona] : [], roundNumber: 1 });
        return {
            plan,
            req: buildGenerationRequest({
                bookId: null,
                dials: { depth: settings.depth, detail: settings.detail },
                offerRecommended: settings.offerRecommended,
                preferChoice: settings.preferChoice,
                personaKey: persona,
                persona: persona ? packs.personas[persona] : null,
                craftPacks: [packs.craft.CHARACTER],
                elements: [{ elementId: EL, kind: 'CHARACTER', name: 'X', customLabel: null, fields, stored: [], assignedKeys: plan.targets.map((t) => t.fieldKey), challengeKey: null }],
                related: [],
                sessionAnswers: [],
            }),
        };
    }
    const base: DialSettings = { depth: 3, detail: 3, personaKeys: [], offerRecommended: true, preferChoice: false };

    it('depth changes the emphasis sentence and how far the targets reach', () => {
        const shallow = request({ ...base, depth: 1 });
        const deep = request({ ...base, depth: 5 });
        expect(shallow.req.template.system).toContain(DEPTH[1].emphasis);
        expect(deep.req.template.system).toContain(DEPTH[5].emphasis);
        expect(shallow.req.template.system).not.toContain(DEPTH[5].emphasis);
    });

    it('detail changes the kinds, the reply sentence and the output budget', () => {
        const one = request({ ...base, detail: 1 });
        const five = request({ ...base, detail: 5 });
        expect(one.req.template.system).toContain('Use only these question kinds: CHOICE, EITHER_OR, SCALE.');
        expect(five.req.template.system).toContain('Use only these question kinds: OPEN, SCENARIO.');
        expect(one.req.template.maxOutputTokens).toBe(maxOutputTokensFor(1));
        expect(five.req.template.maxOutputTokens).toBe(maxOutputTokensFor(5));
        expect(one.plan.cap).toBe(8);
        expect(five.plan.cap).toBe(3);
    });

    it('the toggles change the prompt’s sentences', () => {
        expect(request({ ...base, offerRecommended: false }).req.template.system).toContain('Offer no recommended answers.');
        expect(request(base).req.template.system).toContain('Offer a recommended answer where');
        expect(request({ ...base, preferChoice: true }).req.template.system).toContain('Prefer CHOICE and EITHER_OR questions');
        // "Multiple choice where possible" asks only where the detail allows a pick.
        expect(request({ ...base, detail: 5, preferChoice: true }).req.template.system).not.toContain('Prefer CHOICE');
    });

    it('a persona adds its pack to the system prompt and its name to the call’s version', () => {
        const plain = request(base).req;
        const socratic = request(base, 'socratic').req;
        expect(socratic.template.system).toContain(packs.personas.socratic.text.trim());
        expect(plain.template.system).not.toContain('# Socratic');
        expect(socratic.template.version).not.toBe(plain.template.version);
        expect(socratic.personaKey).toBe('socratic');
    });

    it('no dial changes the output schema, the task or the trust boundary', () => {
        const all = [request(base), request({ ...base, depth: 5, detail: 1, offerRecommended: false, preferChoice: true }, 'gentle-mentor')].map((r) => r.req);
        expect(all[0].schema).toBe(all[1].schema);
        expect(all[0].template.task).toBe(all[1].template.task);
        expect(all[0].template.id).toBe(all[1].template.id);
    });
});
