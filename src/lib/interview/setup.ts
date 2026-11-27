/**
 * ════════════════════════════════════════════════════════════════════
 *  THE SETUP SEAM — the one place the setup sheet meets the dials API
 * ════════════════════════════════════════════════════════════════════
 *
 * The setup sheet (Phase 2.4, `src/components/interview/InterviewSetupSheet.tsx`)
 * shows what a new interview will run with and sends it. Phase 2.3's API is
 * read and written here and nowhere else on the client:
 *
 *   `loadSetupOptions`     `GET /api/w/<slug>/interview-packs` (the personas,
 *                          each with the mount gate's verdict) and
 *                          `GET …/books/<bookId>/interview-defaults` (the
 *                          EFFECTIVE dials a session would start on — book,
 *                          then workspace, then code — their `sources`, and the
 *                          `effects` those dials have)
 *   `previewEffects`       what the one-line previews show: the server's
 *                          `effects` while the sheet still holds the defaults,
 *                          `dialEffects` (the same pure function the server
 *                          ran) once the author moves a dial
 *   `startRequestBody`     the start route's body: the target, depth, detail,
 *                          up to three `personaKeys` in the author's order, the
 *                          two toggles, and since Phase 4.4 the generators
 *                          switched off (D30) and the session's length (D23:
 *                          rounds, questions, or until the author stops)
 *   `packOfName`           which persona or kind a pack name (a 503
 *                          `PACKS_NOT_MOUNTABLE`, a `PACK_CHANGED` stop) is
 *   `interviewSetupQuery` / `setupFromQuery`  the setup as the new-interview
 *                          page's query string, and back
 *   `panelSetup`           Phase 4.3 (D29): THE PANEL PRESET — the book-level
 *                          panel's three personas (Target Reader, Ruthless
 *                          Editor, Genre Specialist; 2.3's limit is three), the
 *                          other dials as the sheet holds them. The panel's
 *                          personas are offered ONLY through it: the persona
 *                          picker lists the six of 2.3 (`SetupOptions.personas`)
 *
 * A persona whose pack does not mount here is offered disabled with its
 * refusal (`PersonaOption.refusal`), and is never among the defaults the sheet
 * opens on: a stored default naming it would only start an interview the
 * server refuses.
 *
 * Client-safe: no server import (types only from the usecases).
 */
import type { DefaultsView } from '@/app-layer/usecases/interview-defaults';
import type { PacksView } from '@/app-layer/usecases/interview-packs';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { bibleFetch } from '@/lib/bible/api-client';
import { CODE_DEFAULT_DIALS, PERSONAS_PER_SESSION_MAX, dialEffects, isGeneratorList, type DialEffects } from './dial-settings';
import { DIAL_MAX, DIAL_MIN, isDial } from './dials';
import { DEFAULT_SESSION_LENGTH, SESSION_QUESTIONS_CHOSEN_MAX, SESSION_ROUNDS_MAX, isSessionLength, type SessionLength } from './session-length';
import { INTERVIEW_SCOPES, PANEL_PERSONA_KEYS, PERSONA_KEYS, QUESTION_GENERATORS, isPanelPersona, isPersonaKey, isQuestionGenerator, type PersonaKey, type QuestionGeneratorKey } from './vocabulary';

/**
 * What a new interview asks about. Phase 3.3 (the canvas): a SELECTION of
 * elements and relations ("Grill this"; an edge alone is a selection of one
 * relation), or the place BETWEEN two neighbouring beats.
 */
export type InterviewTarget =
    | { scope: 'ELEMENT'; elementId: string }
    | { scope: 'KIND'; kind: BibleKind }
    | { scope: 'BOOK' }
    /** Phase 4.2 (D28): "Grill me on what changed" names the stale flag; its selection is that flag's one element. */
    | { scope: 'SELECTION'; elementIds: string[]; relationIds: string[]; staleFlagId?: string; /** Phase 4.3 (D29): a session from a stress test's weak points. */ stressTestId?: string }
    | { scope: 'BETWEEN'; afterElementId: string; beforeElementId: string }
    /** Phase 5.3 (D35): "Grill me on this scene" — the scene's card (goal, conflict, outcome, what changed), never its prose. */
    | { scope: 'SCENE'; sceneId: string };

/** Ids a selection's query carries at most (the server's own bound, `SELECTION_ELEMENTS_MAX`). */
export const SELECTION_QUERY_MAX = 60;

/** The dials and toggles a new interview starts with. */
export interface InterviewSetup {
    depth: number;
    detail: number;
    /** In the author's order (the first leads round 1, and the lead rotates). */
    personaKeys: PersonaKey[];
    offerRecommended: boolean;
    preferChoice: boolean;
    /** Phase 4.4 (D30): the question generators switched off, in `QUESTION_GENERATORS` order (never all five). */
    generatorsOff: QuestionGeneratorKey[];
    /** Phase 4.4 (D23): how long the session runs: rounds, questions, or until the author stops. */
    length: SessionLength;
}

/** Where a default came from (2.3's `sources` for a book's defaults). */
export type SetupSource = 'book' | 'workspace' | 'code';

export interface PersonaOption {
    key: PersonaKey;
    /** False when the pack does not mount here (the sheet offers it disabled). */
    mountable: boolean;
    /** Why it does not mount: the mount gate's refusal code (`MountRefusal`), worded by the sheet; null when it mounts. */
    refusal: string | null;
}

export interface SetupOptions {
    /** The personas the picker offers (2.3's six; never the panel's). */
    personas: PersonaOption[];
    /** Phase 4.3: the Panel preset, mountable only when all three of its personas mount here. */
    panel: { mountable: boolean; refusal: string | null };
    /** How many personas one interview may carry (2.3: three). */
    maxPersonas: number;
    /** The effective dials a session would start on, unmountable personas left out. */
    defaults: InterviewSetup;
    sources: Record<Exclude<keyof InterviewSetup, 'length'>, SetupSource>;
    /** What the server says the defaults do (`DefaultsView.effects`). */
    effects: DialEffects;
}

/** The code defaults: what the start route uses for a dial no layer sets. */
export const CODE_SETUP_DEFAULTS: Readonly<InterviewSetup> = Object.freeze({
    depth: CODE_DEFAULT_DIALS.depth,
    detail: CODE_DEFAULT_DIALS.detail,
    personaKeys: [],
    offerRecommended: CODE_DEFAULT_DIALS.offerRecommended,
    preferChoice: CODE_DEFAULT_DIALS.preferChoice,
    generatorsOff: [],
    length: DEFAULT_SESSION_LENGTH,
});

const SETUP_KEYS = ['depth', 'detail', 'personaKeys', 'offerRecommended', 'preferChoice', 'generatorsOff'] as const satisfies ReadonlyArray<keyof InterviewSetup>;

const enc = encodeURIComponent;
export const SETUP_API = {
    packs: (slug: string) => `/api/w/${enc(slug)}/interview-packs`,
    bookDefaults: (slug: string, bookId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/interview-defaults`,
} as const;

type Fetcher = <T>(url: string) => Promise<T>;

function sourceOf(s: string | undefined): SetupSource {
    return s === 'book' || s === 'workspace' ? s : 'code';
}

/**
 * What the sheet may offer for a book: the personas and their mount status,
 * and the book's effective defaults with where each came from and what they
 * do. Throws (`BibleApiError`) when either read fails; the sheet says so.
 */
export async function loadSetupOptions(slug: string, bookId: string, get: Fetcher = (url) => bibleFetch(url)): Promise<SetupOptions> {
    const [packs, { defaults }] = await Promise.all([get<PacksView>(SETUP_API.packs(slug)), get<{ defaults: DefaultsView }>(SETUP_API.bookDefaults(slug, bookId))]);
    const byKey = new Map(packs.personas.filter((p) => isPersonaKey(p.key)).map((p) => [p.key as PersonaKey, p] as const));
    const all: PersonaOption[] = PERSONA_KEYS.filter((k) => byKey.has(k)).map((key) => {
        const p = byKey.get(key)!;
        return { key, mountable: p.mountable === true, refusal: p.mountable === true ? null : (p.refusal?.reason ?? 'NO_RECORD') };
    });
    const personas = all.filter((p) => !isPanelPersona(p.key));
    const panelOptions = PANEL_PERSONA_KEYS.map((k) => all.find((p) => p.key === k));
    const panelRefusal = panelOptions.find((p) => !p || !p.mountable);
    const panel = { mountable: panelRefusal === undefined, refusal: panelRefusal === undefined ? null : (panelRefusal?.refusal ?? 'NO_RECORD') };
    const mountable = new Set(personas.filter((p) => p.mountable).map((p) => p.key));
    const e = defaults.effective;
    return {
        personas,
        panel,
        maxPersonas: PERSONAS_PER_SESSION_MAX,
        defaults: {
            depth: e.depth,
            detail: e.detail,
            personaKeys: e.personaKeys.filter((k) => mountable.has(k) && !isPanelPersona(k)).slice(0, PERSONAS_PER_SESSION_MAX),
            offerRecommended: e.offerRecommended,
            preferChoice: e.preferChoice,
            generatorsOff: [...(e.generatorsOff ?? [])],
            length: DEFAULT_SESSION_LENGTH,
        },
        sources: Object.fromEntries(SETUP_KEYS.map((k) => [k, sourceOf(defaults.sources[k])])) as Record<Exclude<keyof InterviewSetup, 'length'>, SetupSource>,
        effects: defaults.effects,
    };
}

function sameSetup(a: InterviewSetup, b: InterviewSetup): boolean {
    return (
        a.depth === b.depth &&
        a.detail === b.detail &&
        a.offerRecommended === b.offerRecommended &&
        a.preferChoice === b.preferChoice &&
        a.personaKeys.length === b.personaKeys.length &&
        a.personaKeys.every((k, i) => b.personaKeys[i] === k) &&
        a.generatorsOff.length === b.generatorsOff.length &&
        a.generatorsOff.every((g, i) => b.generatorsOff[i] === g) &&
        JSON.stringify(a.length) === JSON.stringify(b.length)
    );
}

/** What the previews show for `setup`: the server's effects while it is the defaults, the same pure rule once the author changes a dial. */
export function previewEffects(options: SetupOptions, setup: InterviewSetup): DialEffects {
    return sameSetup(options.defaults, setup) ? options.effects : dialEffects(setup, setup.length);
}

/** THE PANEL PRESET (Phase 4.3, D29): the panel's three personas in order, every other dial as `setup` holds it. */
export function panelSetup(setup: InterviewSetup): InterviewSetup {
    return { ...setup, personaKeys: [...PANEL_PERSONA_KEYS] };
}

/** Is this setup the panel (its personas exactly the panel's)? */
export function isPanelSetup(setup: Pick<InterviewSetup, 'personaKeys'>): boolean {
    return setup.personaKeys.length === PANEL_PERSONA_KEYS.length && PANEL_PERSONA_KEYS.every((k, i) => setup.personaKeys[i] === k);
}

/** The start route's body for a target and a setup (2.3's `InterviewStartInput`). */
export function startRequestBody(target: InterviewTarget, setup: InterviewSetup): Record<string, unknown> {
    return {
        ...target,
        depth: setup.depth,
        detail: setup.detail,
        personaKeys: setup.personaKeys.slice(0, PERSONAS_PER_SESSION_MAX),
        offerRecommended: setup.offerRecommended,
        preferChoice: setup.preferChoice,
        generatorsOff: QUESTION_GENERATORS.filter((g) => setup.generatorsOff.includes(g)),
        length: setup.length,
    };
}

/** A generator switched on or off in a setup, never all five off (D30): switching off the last one on is refused (the setup unchanged). */
export function withGenerator(setup: InterviewSetup, generator: QuestionGeneratorKey, on: boolean): InterviewSetup {
    const off = on ? setup.generatorsOff.filter((g) => g !== generator) : [...new Set([...setup.generatorsOff, generator])];
    const ordered = QUESTION_GENERATORS.filter((g) => off.includes(g));
    return isGeneratorList(ordered) ? { ...setup, generatorsOff: ordered } : setup;
}

/** A session length from the sheet's controls: the mode and the number typed, clamped to the mode's bounds. */
export function sessionLengthFrom(mode: SessionLength['mode'], n: number): SessionLength {
    const whole = Number.isFinite(n) ? Math.round(n) : 1;
    if (mode === 'ROUNDS') return { mode, rounds: Math.min(SESSION_ROUNDS_MAX, Math.max(1, whole)) };
    if (mode === 'QUESTIONS') return { mode, questions: Math.min(SESSION_QUESTIONS_CHOSEN_MAX, Math.max(1, whole)) };
    return { mode: 'UNTIL_STOPPED' };
}

/** Which persona or kind a pack name (`persona-<key>`, `craft-<kind>`, `relations`) is; null for a name this client does not know. */
export function packOfName(name: string): { group: 'persona'; key: PersonaKey } | { group: 'craft'; kind: BibleKind } | { group: 'relations' } | null {
    if (name === 'relations') return { group: 'relations' };
    if (name.startsWith('persona-')) {
        const key = name.slice('persona-'.length);
        return isPersonaKey(key) ? { group: 'persona', key } : null;
    }
    if (name.startsWith('craft-')) {
        const kind = name.slice('craft-'.length).toUpperCase();
        return (BIBLE_KINDS as readonly string[]).includes(kind) ? { group: 'craft', kind: kind as BibleKind } : null;
    }
    return null;
}

/** The target and setup as the new-interview page's query (`APP_ROUTES.newInterview`). */
export function interviewSetupQuery(target: InterviewTarget, setup: InterviewSetup): string {
    const q = new URLSearchParams();
    q.set('scope', target.scope);
    if (target.scope === 'ELEMENT') q.set('element', target.elementId);
    if (target.scope === 'KIND') q.set('kind', target.kind);
    if (target.scope === 'SELECTION') {
        if (target.elementIds.length > 0) q.set('elements', target.elementIds.join(','));
        if (target.relationIds.length > 0) q.set('relations', target.relationIds.join(','));
        if (target.staleFlagId) q.set('stale', target.staleFlagId);
        if (target.stressTestId) q.set('stress', target.stressTestId);
    }
    if (target.scope === 'BETWEEN') {
        q.set('after', target.afterElementId);
        q.set('before', target.beforeElementId);
    }
    if (target.scope === 'SCENE') q.set('scene', target.sceneId);
    q.set('depth', String(setup.depth));
    q.set('detail', String(setup.detail));
    if (setup.personaKeys.length > 0) q.set('personas', setup.personaKeys.join(','));
    q.set('recommend', setup.offerRecommended ? '1' : '0');
    q.set('choice', setup.preferChoice ? '1' : '0');
    if (setup.generatorsOff.length > 0) q.set('off', setup.generatorsOff.join(','));
    q.set('length', setup.length.mode === 'ROUNDS' ? `rounds:${setup.length.rounds}` : setup.length.mode === 'QUESTIONS' ? `questions:${setup.length.questions}` : 'open');
    return q.toString();
}

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, key: string): string | undefined => {
    const v = q[key];
    return Array.isArray(v) ? v[0] : v;
};

/**
 * The target and setup a query names, or null when it names no valid target.
 * A dial out of range falls back to the code default (the server checks
 * everything again; this only decides what the page asks for).
 */
export function setupFromQuery(q: Query): { target: InterviewTarget; setup: InterviewSetup } | null {
    const scope = one(q, 'scope');
    if (!scope || !(INTERVIEW_SCOPES as readonly string[]).includes(scope)) return null;
    let target: InterviewTarget;
    if (scope === 'ELEMENT') {
        const elementId = one(q, 'element');
        if (!elementId || elementId.length > 64) return null;
        target = { scope: 'ELEMENT', elementId };
    } else if (scope === 'KIND') {
        const kind = one(q, 'kind');
        if (!kind || !(BIBLE_KINDS as readonly string[]).includes(kind)) return null;
        target = { scope: 'KIND', kind: kind as BibleKind };
    } else if (scope === 'SELECTION') {
        const ids = (key: string) => (one(q, key) ?? '').split(',').filter((id) => id.length > 0 && id.length <= 64);
        const elementIds = [...new Set(ids('elements'))];
        const relationIds = [...new Set(ids('relations'))];
        if (elementIds.length + relationIds.length === 0 || elementIds.length > SELECTION_QUERY_MAX || relationIds.length > SELECTION_QUERY_MAX) return null;
        const stale = one(q, 'stale');
        const stress = one(q, 'stress');
        target =
            stale && stale.length <= 64 && elementIds.length === 1 && relationIds.length === 0
                ? { scope: 'SELECTION', elementIds, relationIds, staleFlagId: stale }
                : stress && stress.length <= 64 && elementIds.length > 0 && relationIds.length === 0
                  ? { scope: 'SELECTION', elementIds, relationIds, stressTestId: stress }
                  : { scope: 'SELECTION', elementIds, relationIds };
    } else if (scope === 'BETWEEN') {
        const after = one(q, 'after');
        const before = one(q, 'before');
        if (!after || !before || after.length > 64 || before.length > 64 || after === before) return null;
        target = { scope: 'BETWEEN', afterElementId: after, beforeElementId: before };
    } else if (scope === 'SCENE') {
        const sceneId = one(q, 'scene');
        if (!sceneId || sceneId.length > 64) return null;
        target = { scope: 'SCENE', sceneId };
    } else target = { scope: 'BOOK' };
    const dial = (key: string, fallback: number) => {
        const n = Number(one(q, key));
        return isDial(n) ? n : fallback;
    };
    const personas = (one(q, 'personas') ?? '')
        .split(',')
        .filter((k): k is PersonaKey => isPersonaKey(k));
    const personaKeys = [...new Set(personas)].slice(0, PERSONAS_PER_SESSION_MAX);
    return {
        target,
        setup: {
            depth: dial('depth', CODE_SETUP_DEFAULTS.depth),
            detail: dial('detail', CODE_SETUP_DEFAULTS.detail),
            personaKeys,
            offerRecommended: one(q, 'recommend') !== '0',
            preferChoice: one(q, 'choice') === '1',
            generatorsOff: generatorsFromQuery(one(q, 'off')),
            length: lengthFromQuery(one(q, 'length')),
        },
    };
}

/** The generators a query switches off, known only, never all five (then none). */
function generatorsFromQuery(raw: string | undefined): QuestionGeneratorKey[] {
    const off = QUESTION_GENERATORS.filter((g) => (raw ?? '').split(',').filter(isQuestionGenerator).includes(g));
    return isGeneratorList(off) ? off : [];
}

/** A query's session length (`rounds:4`, `questions:20`, `open`), else the default. */
function lengthFromQuery(raw: string | undefined): SessionLength {
    if (raw === 'open') return { mode: 'UNTIL_STOPPED' };
    const m = /^(rounds|questions):(\d{1,3})$/.exec(raw ?? '');
    if (!m) return DEFAULT_SESSION_LENGTH;
    const value = m[1] === 'rounds' ? { mode: 'ROUNDS' as const, rounds: Number(m[2]) } : { mode: 'QUESTIONS' as const, questions: Number(m[2]) };
    return isSessionLength(value) ? value : DEFAULT_SESSION_LENGTH;
}

export { DIAL_MAX, DIAL_MIN };
