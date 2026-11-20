/**
 * THE INTERVIEW DIALS AS SETTINGS (Phase 2.3): what a session runs with, and
 * where each value came from. Pure and client-safe (no server import), so the
 * usecases, the API and 2.4's setup sheet read one rule.
 *
 *   depth             1..5  how far down the field dependencies, and how many rounds
 *   detail            1..5  how specific a question is and how long a reply it invites
 *   personaKeys       0..3  the manner: the interviewer personas (STORM's perspectives)
 *   offerRecommended        "offer a recommended answer"
 *   preferChoice            "multiple choice where possible"
 *
 * PRECEDENCE, per dial and independently: the session's own request, then the
 * book's default, then the workspace's default, then the code default
 * (`CODE_DEFAULT_DIALS`). A layer that does not set a dial (undefined or null)
 * passes it on; a layer that sets the personas to `[]` sets "no persona", which
 * is a choice, not an absence.
 *
 * A DIAL CHANGES PROMPTS AND BUDGETS ONLY (roadmap 2.3): which fields are in
 * reach and how many rounds (depth), how many questions a round holds, which
 * question kinds and how long a reply (detail), who words the questions and
 * how (manner). It never changes what may be written to the bible: no module
 * on the bible's write path imports this file or `dials.ts`
 * (tests/guards/dials-stay-off-the-bible-write-path.test.ts), and no dial
 * reaches a write-path type.
 */
import {
    DEFAULT_DIALS,
    DEPTH,
    DETAIL,
    DIAL_MAX,
    DIAL_MIN,
    TOKENS_PER_GENERATION_CALL,
    TOKENS_PER_RECONCILE_CALL,
    answerTextMax,
    isDial,
    kindsAllowed,
    roundBudgetFor,
    roundCapFor,
    tokenBudgetFor,
} from './dials';
import { PERSONA_KEYS, isPersonaKey, type PersonaKey, type QuestionKind } from './vocabulary';

/** At most this many personas question one session (design 8.3: one generation call each per round). */
export const PERSONAS_PER_SESSION_MAX = 3;

export const DIAL_KEYS = ['depth', 'detail', 'personaKeys', 'offerRecommended', 'preferChoice'] as const;
export type DialKey = (typeof DIAL_KEYS)[number];

export interface DialSettings {
    depth: number;
    detail: number;
    /** In the order the author chose them: the first leads round 1, and the lead rotates (design 4.2). */
    personaKeys: PersonaKey[];
    offerRecommended: boolean;
    preferChoice: boolean;
}

/** One layer of defaults or a request: each dial set, or left to the layer below (undefined or null). */
export type DialLayer = {
    [K in DialKey]?: DialSettings[K] | null;
};

/** What a session runs with when no layer sets a dial. */
export const CODE_DEFAULT_DIALS: Readonly<DialSettings> = Object.freeze({
    depth: DEFAULT_DIALS.depth,
    detail: DEFAULT_DIALS.detail,
    personaKeys: [],
    offerRecommended: true,
    preferChoice: false,
});

export const DIAL_SOURCES = ['session', 'book', 'workspace', 'code'] as const;
export type DialSource = (typeof DIAL_SOURCES)[number];

export interface ResolvedDials {
    settings: DialSettings;
    /** Which layer each dial came from. */
    sources: Record<DialKey, DialSource>;
}

/** Is this a persona list a layer may store: known keys, no repeats, at most three? */
export function isPersonaList(value: unknown): value is PersonaKey[] {
    return (
        Array.isArray(value) &&
        value.length <= PERSONAS_PER_SESSION_MAX &&
        value.every(isPersonaKey) &&
        new Set(value).size === value.length
    );
}

/** Is `value` an acceptable setting of `key` (never null: null means "not set")? */
export function isDialValue<K extends DialKey>(key: K, value: unknown): value is DialSettings[K] {
    switch (key) {
        case 'depth':
        case 'detail':
            return isDial(value);
        case 'personaKeys':
            return isPersonaList(value);
        default:
            return typeof value === 'boolean';
    }
}

/**
 * Resolve the dials a session runs with: session > book > workspace > code
 * default, dial by dial. A value a layer holds that is not acceptable (a row
 * written before a rule tightened) is passed over, never used. Pure.
 */
export function resolveDials(layers: { session?: DialLayer | null; book?: DialLayer | null; workspace?: DialLayer | null }): ResolvedDials {
    const order: Array<[DialSource, DialLayer | null | undefined]> = [
        ['session', layers.session],
        ['book', layers.book],
        ['workspace', layers.workspace],
    ];
    const settings = { ...CODE_DEFAULT_DIALS, personaKeys: [...CODE_DEFAULT_DIALS.personaKeys] } as DialSettings;
    const sources = {} as Record<DialKey, DialSource>;
    for (const key of DIAL_KEYS) {
        sources[key] = 'code';
        for (const [source, layer] of order) {
            const value = layer?.[key];
            if (value === undefined || value === null || !isDialValue(key, value)) continue;
            (settings as unknown as Record<DialKey, unknown>)[key] = key === 'personaKeys' ? [...(value as PersonaKey[])] : value;
            sources[key] = source;
            break;
        }
    }
    return { settings, sources };
}

/**
 * WHAT A SETTING DOES — the prompts and budgets it moves, and nothing else. A
 * dial's whole effect is this table plus the sentences the prompt carries for
 * it (`DEPTH[d].emphasis`, `DETAIL[d].reply`, the toggles, the persona packs);
 * 2.4's setup sheet previews it.
 */
export interface DialEffects {
    /** Fields of at most this dependency level are in reach. */
    levelsInReach: number;
    /** Rounds the session runs at most. */
    roundBudget: number;
    /** Questions a round holds at most. */
    roundCap: number;
    /** The question kinds a question may take. */
    kindsAllowed: readonly QuestionKind[];
    /** The longest written answer accepted (refused beyond, never cut). */
    answerTextMax: number;
    /** A generation call's answer budget in tokens, before the thinking allowance. */
    answerOutputTokens: number;
    /** Generation calls a round makes: one per persona (one when the session has none). */
    generationCallsPerRound: number;
    /** The session's token budget, input and output together (design 8.4). */
    tokenBudget: number;
    /** The sentences the prompt carries for depth and detail. */
    depthEmphasis: string;
    detailReply: string;
    offerRecommended: boolean;
    preferChoice: boolean;
}

export function dialEffects(settings: DialSettings): DialEffects {
    const personas = settings.personaKeys.length;
    return {
        levelsInReach: settings.depth,
        roundBudget: roundBudgetFor(settings.depth),
        roundCap: roundCapFor(settings.detail),
        kindsAllowed: kindsAllowed(settings.detail),
        answerTextMax: answerTextMax(settings.detail),
        answerOutputTokens: DETAIL[settings.detail].maxOutputTokens,
        generationCallsPerRound: nextRoundGenerationCalls(personas),
        tokenBudget: tokenBudgetFor(settings.depth, personas),
        depthEmphasis: DEPTH[settings.depth].emphasis,
        detailReply: DETAIL[settings.detail].reply,
        offerRecommended: settings.offerRecommended,
        preferChoice: settings.preferChoice,
    };
}

/** The generation calls one more round makes at most: one per persona, one when the session has none. */
export function nextRoundGenerationCalls(personaCount: number): number {
    return Math.max(1, personaCount);
}

/** The tokens one more round of this session would spend at most on generation. */
export function nextRoundGenerationTokens(personaCount: number): number {
    return nextRoundGenerationCalls(personaCount) * TOKENS_PER_GENERATION_CALL;
}

/**
 * The tokens one more round would spend at most, its reconcile call included
 * (Phase 2.H item 2): a round is not opened unless the session's budget can
 * also take the reconcile of its answers, so the last round's answers are not
 * left un-proposed by a budget the questions spent. `tokenBudgetFor` gives
 * every round both shares.
 */
export function nextRoundTokens(personaCount: number): number {
    return nextRoundGenerationTokens(personaCount) + TOKENS_PER_RECONCILE_CALL;
}

export { DIAL_MAX, DIAL_MIN, PERSONA_KEYS };
