/**
 * The setup seam (Phase 2.4, src/lib/interview/setup.ts) over 2.3's API: what
 * the sheet offers from `GET interview-packs` and the book's
 * `GET interview-defaults`, the previews, the start body it sends, the pack
 * names a refusal lists, and the setup carried through the new-interview
 * page's query. And the order a round's questions are shown in once a
 * rephrase replaced one (`askedInOrder`).
 */
import {
    CODE_SETUP_DEFAULTS,
    SETUP_API,
    interviewSetupQuery,
    loadSetupOptions,
    packOfName,
    previewEffects,
    setupFromQuery,
    startRequestBody,
} from '@/lib/interview/setup';
import { InterviewStartInput } from '@/app-layer/schemas/interview';
import { askedInOrder } from '@/app-layer/usecases/interview-state';
import type { QuestionRow } from '@/app-layer/repositories/interview.repository';
import type { DefaultsView } from '@/app-layer/usecases/interview-defaults';
import type { PacksView, PackView } from '@/app-layer/usecases/interview-packs';
import { PERSONAS_PER_SESSION_MAX, dialEffects, resolveDials } from '@/lib/interview/dial-settings';
import { PERSONA_KEYS } from '@/lib/interview/vocabulary';
import type { MountRefusal } from '@/lib/interview/pack-mount';

function persona(key: string, mountable: boolean, reason: MountRefusal = 'STRUCTURAL_RECORD_REFUSED'): PackView {
    return {
        name: `persona-${key}`,
        group: 'persona',
        key,
        displayName: key,
        version: 1,
        description: '',
        contentHash: 'sha256:0',
        coverage: null,
        evaluationCases: 3,
        mountable,
        refusal: mountable ? null : { reason, detail: 'x' },
        recordKind: mountable ? 'structural' : null,
    };
}

/** What the server would answer for a book whose defaults set depth and the personas (the book's layer). */
function server(bookLayer: { depth?: number; personaKeys?: string[] }, unmountable: string[] = []) {
    const resolved = resolveDials({ book: bookLayer as never });
    const packs: PacksView = {
        recordMode: 'structural',
        personas: PERSONA_KEYS.map((k) => persona(k, !unmountable.includes(k))),
        craft: [],
        mountable: 0,
        total: 0,
    };
    const defaults: DefaultsView = {
        stored: { depth: null, detail: null, personaKeys: null, offerRecommended: null, preferChoice: null },
        effective: resolved.settings,
        sources: resolved.sources,
        effects: dialEffects(resolved.settings),
    };
    const asked: string[] = [];
    const get = async <T,>(url: string): Promise<T> => {
        asked.push(url);
        if (url === SETUP_API.packs('ada')) return packs as T;
        if (url === SETUP_API.bookDefaults('ada', 'b 1')) return { defaults } as T;
        throw new Error(`unexpected ${url}`);
    };
    return { get, asked, defaults };
}

describe('loadSetupOptions (2.3: the packs and the book defaults)', () => {
    it('reads both routes and offers the effective defaults, their sources and their effects', async () => {
        const s = server({ depth: 4, personaKeys: ['socratic', 'ruthless-editor'] });
        const o = await loadSetupOptions('ada', 'b 1', s.get);
        expect(s.asked.sort()).toEqual([SETUP_API.bookDefaults('ada', 'b 1'), SETUP_API.packs('ada')].sort());
        expect(SETUP_API.bookDefaults('ada', 'b 1')).toBe('/api/w/ada/books/b%201/interview-defaults');
        expect(o.maxPersonas).toBe(PERSONAS_PER_SESSION_MAX);
        expect(o.defaults).toEqual({ ...CODE_SETUP_DEFAULTS, depth: 4, personaKeys: ['socratic', 'ruthless-editor'] });
        expect(o.sources).toEqual({ depth: 'book', detail: 'code', personaKeys: 'book', offerRecommended: 'code', preferChoice: 'code' });
        expect(o.effects).toEqual(s.defaults.effects);
        expect(o.personas.map((p) => p.key)).toEqual([...PERSONA_KEYS]);
    });

    it('offers a persona that does not mount disabled, with its refusal, and never opens on it', async () => {
        const s = server({ personaKeys: ['socratic', 'gentle-mentor'] }, ['socratic']);
        const o = await loadSetupOptions('ada', 'b 1', s.get);
        expect(o.personas.find((p) => p.key === 'socratic')).toEqual({ key: 'socratic', mountable: false, refusal: 'STRUCTURAL_RECORD_REFUSED' });
        expect(o.personas.find((p) => p.key === 'gentle-mentor')).toEqual({ key: 'gentle-mentor', mountable: true, refusal: null });
        expect(o.defaults.personaKeys).toEqual(['gentle-mentor']);
    });

    it('fails when a read fails (the sheet says the options could not be loaded)', async () => {
        await expect(loadSetupOptions('ada', 'b', async () => Promise.reject(new Error('503')))).rejects.toThrow('503');
    });
});

it('previews the server effects for the defaults, and the same rule once a dial moves', async () => {
    const o = await loadSetupOptions('ada', 'b 1', server({ depth: 2 }).get);
    expect(previewEffects(o, o.defaults)).toBe(o.effects);
    const moved = { ...o.defaults, depth: 5, personaKeys: ['socratic' as const, 'target-reader' as const] };
    expect(previewEffects(o, moved)).toEqual(dialEffects(moved));
    expect(previewEffects(o, moved).roundBudget).not.toBe(o.effects.roundBudget);
    expect(previewEffects(o, moved).generationCallsPerRound).toBe(2);
});

it('sends personaKeys and both toggles in a body the start route accepts, for every target', () => {
    const setup = { ...CODE_SETUP_DEFAULTS, depth: 4, offerRecommended: false, preferChoice: true, personaKeys: ['socratic' as const, 'gentle-mentor' as const, 'ruthless-editor' as const] };
    for (const target of [{ scope: 'ELEMENT' as const, elementId: 'el-1' }, { scope: 'KIND' as const, kind: 'SETTING' as const }, { scope: 'BOOK' as const }]) {
        const body = startRequestBody(target, setup);
        const parsed = InterviewStartInput.safeParse(body);
        expect(parsed.success).toBe(true);
        expect(parsed.data).toMatchObject({ personaKeys: setup.personaKeys, offerRecommended: false, preferChoice: true, depth: 4 });
        expect(body).not.toHaveProperty('persona');
    }
    expect(startRequestBody({ scope: 'BOOK' }, CODE_SETUP_DEFAULTS)).toMatchObject({ personaKeys: [] });
});

it('names the persona or kind of a pack, and nothing for a name it does not know', () => {
    expect(packOfName('persona-socratic')).toEqual({ group: 'persona', key: 'socratic' });
    expect(packOfName('craft-timeline_event')).toEqual({ group: 'craft', kind: 'TIMELINE_EVENT' });
    expect(packOfName('persona-nobody')).toBeNull();
    expect(packOfName('craft-nothing')).toBeNull();
    expect(packOfName('<script>')).toBeNull();
});

it('round-trips a setup through the query, and refuses a query that names no interview', () => {
    const target = { scope: 'KIND' as const, kind: 'CHARACTER' as const };
    const setup = { depth: 5, detail: 1, personaKeys: ['ruthless-editor' as const, 'socratic' as const], offerRecommended: false, preferChoice: true };
    expect(setupFromQuery(Object.fromEntries(new URLSearchParams(interviewSetupQuery(target, setup))))).toEqual({ target, setup });
    expect(setupFromQuery({})).toBeNull();
    expect(setupFromQuery({ scope: 'ELEMENT' })).toBeNull();
    expect(setupFromQuery({ scope: 'KIND', kind: 'NOT_A_KIND' })).toBeNull();
    expect(setupFromQuery({ scope: 'BOOK', depth: '9', personas: 'nobody,socratic,socratic' })?.setup).toMatchObject({ depth: CODE_SETUP_DEFAULTS.depth, personaKeys: ['socratic'] });
    expect(setupFromQuery({ scope: 'BOOK', personas: PERSONA_KEYS.join(',') })?.setup.personaKeys).toHaveLength(PERSONAS_PER_SESSION_MAX);
});

it('shows a rephrase in the place of the question it replaced, and never the replaced one', () => {
    const row = (id: string, position: number, replacesQuestionId: string | null = null, superseded = false) =>
        ({ id, position, replacesQuestionId, supersededAt: superseded ? new Date() : null }) as unknown as QuestionRow;
    const rows = [row('a', 1, null, true), row('b', 2), row('c', 3), row('a2', 4, 'a', true), row('a3', 5, 'a2')];
    expect(askedInOrder(rows).map((q) => q.id)).toEqual(['a3', 'b', 'c']);
});
