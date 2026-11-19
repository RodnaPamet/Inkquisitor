/**
 * THE FRONTIER — which fields a round may ask about (Phase 2.2).
 *
 * The interview algorithm is ported from the MIT-licensed mattpocock/skills
 * grilling skill (credited in NOTICE): treat the bible as a decision tree,
 * and each round ask the whole FRONTIER — every open field whose
 * prerequisites are settled — after first removing everything the bible
 * already answers; recompute after the answers. The rules are the content
 * formats' (section 1.9), applied per field reference `(elementId, fieldKey)`:
 *
 *   answered(k)   an ALREADY-ANSWERED CHECK says the book holds it. The first
 *                 check is always the bible's stored values (roadmap rule 5:
 *                 never ask what the bible already answers); more plug in
 *                 behind it — a concept note's verified seed, a fact (4.1) —
 *                 each a pure function over data the usecase loaded.
 *   satisfied(k)  answered, or an ANSWERED answer in THIS session targeted it
 *                 (whatever the author later does with the proposal).
 *   touched(k)    an answer of any status in this session targeted it.
 *   open(k)       neither answered nor touched.
 *   eligible(k)   open, every `dependsOn` key satisfied, and level(k) ≤ depth.
 *
 * A SKIPPED or DECIDE_LATER answer neither reopens its field for the session
 * nor satisfies its dependants. Answers of earlier sessions do not count: a
 * new session reopens whatever is still empty.
 *
 * Pure: no database, no clock, no network. Every open field that is not on
 * the frontier is EXPLAINED in `blocked`, so a session that stops can say
 * which fields wait on what (design 4, 10.1).
 */
import type { FieldDef } from '@/lib/bible/template-schema';
import type { BibleKind } from '@/lib/bible/kinds';
import type { AnswerStatus } from './vocabulary';

/** One field of one bible element. */
export interface FieldRef {
    elementId: string;
    fieldKey: string;
}

export function refKey(ref: FieldRef): string {
    return `${ref.elementId}\u0000${ref.fieldKey}`;
}

export function sameRef(a: FieldRef, b: FieldRef): boolean {
    return a.elementId === b.elementId && a.fieldKey === b.fieldKey;
}

/** What a field definition must say for the frontier: its key, prerequisites, whether it is core, its order. */
export type FrontierFieldDef = Pick<FieldDef, 'key' | 'dependsOn' | 'required' | 'order'>;

/** One element in a session's scope, as the frontier sees it. */
export interface FrontierElement {
    elementId: string;
    kind: BibleKind;
    /**
     * The fields considered (the kind's template, or a subset of it — the
     * coverage evaluation considers core fields only). A `dependsOn` key
     * outside this list is treated as unsatisfiable.
     */
    fields: readonly FrontierFieldDef[];
    /** Keys with a value stored in the bible. */
    storedKeys: ReadonlySet<string>;
}

/** An answer of this session, as the frontier reads it: its status and the fields its question targeted. */
export interface AnswerFact {
    status: AnswerStatus;
    targets: readonly FieldRef[];
}

/**
 * A step that says which fields the book already answers, run before the
 * session's own answers are considered. Pure: whatever it reads, the usecase
 * loaded first and closed over.
 */
export interface AlreadyAnsweredCheck {
    /** A stable name, reported with every field it answers (`answered[].by`). */
    readonly name: string;
    answered(element: FrontierElement): Iterable<string>;
}

/** Roadmap rule 5's first layer: a stored value answers its field. */
export const BIBLE_VALUES_CHECK: AlreadyAnsweredCheck = Object.freeze({
    name: 'bible-values',
    answered: (element: FrontierElement) => element.storedKeys,
});

/** A check over a fixed set of references (a concept's stated fields, a verified seed, a fact). */
export function refsCheck(name: string, refs: readonly FieldRef[]): AlreadyAnsweredCheck {
    const byElement = new Map<string, Set<string>>();
    for (const r of refs) {
        const set = byElement.get(r.elementId) ?? new Set<string>();
        set.add(r.fieldKey);
        byElement.set(r.elementId, set);
    }
    return { name, answered: (element) => byElement.get(element.elementId) ?? [] };
}

export interface FrontierEntry extends FieldRef {
    kind: BibleKind;
    level: number;
    /** A core field of its kind (content formats 1.2). */
    required: boolean;
}

export type BlockedReason =
    /** Its level is above the depth dial. */
    | 'TOO_DEEP'
    /** A prerequisite is still open. */
    | 'WAITS_ON'
    /** A prerequisite was skipped or set aside for later in this session. */
    | 'WAITS_ON_DEFERRED'
    /** It was asked in this session and skipped or set aside: not asked again. */
    | 'TOUCHED';

export interface BlockedField extends FieldRef {
    level: number;
    reason: BlockedReason;
    /** The prerequisite keys it waits on (WAITS_ON, WAITS_ON_DEFERRED). */
    waitsOn?: string[];
}

export interface FrontierResult {
    /** The eligible fields, in frontier order: element order, then core before optional, then template order. */
    frontier: FrontierEntry[];
    /** Every field neither answered, satisfied nor on the frontier, and why. */
    blocked: BlockedField[];
    /** Fields an already-answered check removed, and which check. */
    answered: Array<FieldRef & { by: string; level: number }>;
    /** Fields satisfied by an ANSWERED answer of this session. */
    answeredInSession: FieldRef[];
}

export interface FrontierInput {
    /** The elements in scope, in the order the session asks about them (kind order, then creation order). */
    elements: readonly FrontierElement[];
    /** This session's answers (the latest revision of each). */
    sessionAnswers: readonly AnswerFact[];
    /** The already-answered checks, in order. Defaults to `[BIBLE_VALUES_CHECK]`; the bible's own is always run first. */
    checks?: readonly AlreadyAnsweredCheck[];
    depth: number;
}

/**
 * The level of every field of a list (content formats 1.4): 1 with no
 * prerequisite, else one more than its deepest prerequisite. A prerequisite
 * outside the list, or a cycle, makes a field unreachable (`Infinity`) — a
 * template's schema refuses both, so neither happens for a real one.
 */
export function fieldLevels(fields: readonly FrontierFieldDef[]): Map<string, number> {
    const byKey = new Map(fields.map((f) => [f.key, f] as const));
    const levels = new Map<string, number>();
    const visiting = new Set<string>();
    const level = (key: string): number => {
        const known = levels.get(key);
        if (known !== undefined) return known;
        const field = byKey.get(key);
        if (!field || visiting.has(key)) return Infinity;
        visiting.add(key);
        const deps = field.dependsOn.map(level);
        visiting.delete(key);
        const value = deps.length === 0 ? 1 : 1 + Math.max(...deps);
        levels.set(key, value);
        return value;
    };
    for (const f of fields) level(f.key);
    return levels;
}

const levelCache = new WeakMap<readonly FrontierFieldDef[], Map<string, number>>();

function cachedLevels(fields: readonly FrontierFieldDef[]): Map<string, number> {
    let levels = levelCache.get(fields);
    if (!levels) {
        levels = fieldLevels(fields);
        levelCache.set(fields, levels);
    }
    return levels;
}

/** Core fields first, then optional ones, each in template order. */
function frontierOrder(fields: readonly FrontierFieldDef[]): FrontierFieldDef[] {
    return [...fields].sort((a, b) => (a.required === b.required ? a.order - b.order : a.required ? -1 : 1));
}

export function computeFrontier(input: FrontierInput): FrontierResult {
    const checks = [BIBLE_VALUES_CHECK, ...(input.checks ?? []).filter((c) => c !== BIBLE_VALUES_CHECK)];
    const satisfiedInSession = new Set<string>();
    const touched = new Set<string>();
    for (const answer of input.sessionAnswers) {
        for (const ref of answer.targets) {
            touched.add(refKey(ref));
            if (answer.status === 'ANSWERED') satisfiedInSession.add(refKey(ref));
        }
    }

    const result: FrontierResult = { frontier: [], blocked: [], answered: [], answeredInSession: [] };
    for (const element of input.elements) {
        const levels = cachedLevels(element.fields);
        const known = new Set(element.fields.map((f) => f.key));
        const answeredBy = new Map<string, string>();
        for (const check of checks) {
            for (const key of check.answered(element)) {
                if (known.has(key) && !answeredBy.has(key)) answeredBy.set(key, check.name);
            }
        }
        const ref = (key: string): FieldRef => ({ elementId: element.elementId, fieldKey: key });
        const satisfied = (key: string) => answeredBy.has(key) || satisfiedInSession.has(refKey(ref(key)));
        const isTouched = (key: string) => touched.has(refKey(ref(key)));

        for (const field of frontierOrder(element.fields)) {
            const level = levels.get(field.key) ?? Infinity;
            const by = answeredBy.get(field.key);
            if (by !== undefined) {
                result.answered.push({ ...ref(field.key), by, level });
                continue;
            }
            if (satisfiedInSession.has(refKey(ref(field.key)))) {
                result.answeredInSession.push(ref(field.key));
                continue;
            }
            if (isTouched(field.key)) {
                result.blocked.push({ ...ref(field.key), level, reason: 'TOUCHED' });
                continue;
            }
            // A prerequisite set aside blocks the field whatever the depth:
            // raising the dial would not reach it, so it is reported first.
            const unsatisfied = field.dependsOn.filter((d) => !satisfied(d));
            const deferred = unsatisfied.filter(isTouched);
            if (deferred.length > 0) {
                result.blocked.push({ ...ref(field.key), level, reason: 'WAITS_ON_DEFERRED', waitsOn: deferred });
                continue;
            }
            if (level > input.depth) {
                result.blocked.push({ ...ref(field.key), level, reason: 'TOO_DEEP' });
                continue;
            }
            if (unsatisfied.length > 0) {
                result.blocked.push({ ...ref(field.key), level, reason: 'WAITS_ON', waitsOn: unsatisfied });
                continue;
            }
            result.frontier.push({ ...ref(field.key), kind: element.kind, level, required: field.required });
        }
    }
    return result;
}

/**
 * Why an empty frontier ends a session (design 4.1): when every field still
 * open is out of reach only because of the depth dial, raising it would find
 * more (`NOTHING_AT_DEPTH`); otherwise everything this depth reaches is
 * answered or set aside (`FRONTIER_EMPTY`).
 */
export function emptyFrontierReason(blocked: readonly BlockedField[]): 'FRONTIER_EMPTY' | 'NOTHING_AT_DEPTH' {
    const open = blocked.filter((b) => b.reason !== 'TOUCHED');
    return open.length > 0 && open.every((b) => b.reason === 'TOO_DEEP') ? 'NOTHING_AT_DEPTH' : 'FRONTIER_EMPTY';
}
