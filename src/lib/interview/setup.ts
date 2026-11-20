/**
 * ════════════════════════════════════════════════════════════════════
 *  THE SETUP SEAM — the one place the setup sheet meets the dials API
 * ════════════════════════════════════════════════════════════════════
 *
 * The setup sheet (Phase 2.4, `src/components/interview/InterviewSetupSheet.tsx`)
 * shows what a new interview will run with and sends it. Phase 2.2's start
 * route stores depth, detail, AT MOST ONE persona and the two toggles, with
 * the code's defaults beneath them. Phase 2.3 (built in parallel) widens it:
 * up to three personas (`personaKeys`), the packs' own names and mount status
 * (`GET /api/w/<slug>/interview-packs`), and workspace and book defaults
 * (`GET …/books/<bookId>/interview-defaults`, with `effective` and `sources`).
 *
 * Everything the sheet needs from that API passes through this file and
 * nothing else does, so wiring 2.3 in is a change here:
 *
 *   `SetupOptions`         what the sheet may offer: the personas (key, whether
 *                          it mounts), how many may be chosen, the defaults the
 *                          sheet opens on and where each came from
 *   `loadSetupOptions`     2.2: no request — the six persona keys, one at most,
 *                          the code defaults (`DEFAULT_DIALS`).
 *                          2.3: read the packs and the book's defaults
 *   `startRequestBody`     2.2: `{ persona }` (the first chosen, or null).
 *                          2.3: `{ personaKeys }`
 *
 * The previews (one line per setting) are computed from the dial tables
 * (`dials.ts`), the ones 2.3's `effects` (`dialEffects`) is built from, so
 * they agree with what 2.3's defaults routes report.
 *   `interviewSetupQuery` / `setupFromQuery`  the setup as the new-interview
 *                          page's query string, and back
 *
 * Client-safe: no server import.
 */
import { DEFAULT_DIALS, DIAL_MAX, DIAL_MIN, isDial } from './dials';
import { INTERVIEW_SCOPES, PERSONA_KEYS, isPersonaKey, type PersonaKey } from './vocabulary';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';

/** What a new interview asks about. */
export type InterviewTarget = { scope: 'ELEMENT'; elementId: string } | { scope: 'KIND'; kind: BibleKind } | { scope: 'BOOK' };

/** The dials and toggles a new interview starts with. */
export interface InterviewSetup {
    depth: number;
    detail: number;
    /** In the author's order (2.3: the first leads round 1). */
    personaKeys: PersonaKey[];
    offerRecommended: boolean;
    preferChoice: boolean;
}

/** Where a default came from (2.3's `sources`; 2.2 has only the code's). */
export type SetupSource = 'book' | 'workspace' | 'code';

export interface PersonaOption {
    key: PersonaKey;
    /** 2.3: false when the pack does not mount here (the sheet offers it disabled). */
    mountable: boolean;
}

export interface SetupOptions {
    personas: PersonaOption[];
    /** How many personas one interview may carry: 1 in 2.2, 3 in 2.3. */
    maxPersonas: number;
    defaults: InterviewSetup;
    sources: Record<keyof InterviewSetup, SetupSource>;
}

/** The code defaults: what 2.2's start route uses for a dial the request leaves out. */
export const CODE_SETUP_DEFAULTS: Readonly<InterviewSetup> = Object.freeze({
    depth: DEFAULT_DIALS.depth,
    detail: DEFAULT_DIALS.detail,
    personaKeys: [],
    offerRecommended: true,
    preferChoice: false,
});

/** 2.2: one persona at most per interview (the session's CHECK). */
export const MAX_PERSONAS_2_2 = 1;

/**
 * What the sheet may offer for a book. 2.2: no request is made.
 * 2.3: `GET` the packs and the book's defaults here (the sheet awaits it).
 */
export async function loadSetupOptions(slug: string, bookId: string): Promise<SetupOptions> {
    void slug;
    void bookId;
    return {
        personas: PERSONA_KEYS.map((key) => ({ key, mountable: true })),
        maxPersonas: MAX_PERSONAS_2_2,
        defaults: { ...CODE_SETUP_DEFAULTS, personaKeys: [] },
        sources: { depth: 'code', detail: 'code', personaKeys: 'code', offerRecommended: 'code', preferChoice: 'code' },
    };
}

/** The start route's body for a target and a setup. 2.2 takes one `persona`; 2.3 takes `personaKeys`. */
export function startRequestBody(target: InterviewTarget, setup: InterviewSetup): Record<string, unknown> {
    return {
        ...target,
        depth: setup.depth,
        detail: setup.detail,
        persona: setup.personaKeys[0] ?? null,
        offerRecommended: setup.offerRecommended,
        preferChoice: setup.preferChoice,
    };
}

/** The target and setup as the new-interview page's query (`APP_ROUTES.newInterview`). */
export function interviewSetupQuery(target: InterviewTarget, setup: InterviewSetup): string {
    const q = new URLSearchParams();
    q.set('scope', target.scope);
    if (target.scope === 'ELEMENT') q.set('element', target.elementId);
    if (target.scope === 'KIND') q.set('kind', target.kind);
    q.set('depth', String(setup.depth));
    q.set('detail', String(setup.detail));
    if (setup.personaKeys.length > 0) q.set('personas', setup.personaKeys.join(','));
    q.set('recommend', setup.offerRecommended ? '1' : '0');
    q.set('choice', setup.preferChoice ? '1' : '0');
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
    } else target = { scope: 'BOOK' };
    const dial = (key: string, fallback: number) => {
        const n = Number(one(q, key));
        return isDial(n) ? n : fallback;
    };
    const personas = (one(q, 'personas') ?? '')
        .split(',')
        .filter((k): k is PersonaKey => isPersonaKey(k));
    return {
        target,
        setup: {
            depth: dial('depth', CODE_SETUP_DEFAULTS.depth),
            detail: dial('detail', CODE_SETUP_DEFAULTS.detail),
            personaKeys: [...new Set(personas)],
            offerRecommended: one(q, 'recommend') !== '0',
            preferChoice: one(q, 'choice') === '1',
        },
    };
}

export { DIAL_MAX, DIAL_MIN };
