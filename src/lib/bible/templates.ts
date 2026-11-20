/**
 * The bible's field templates: what fields an element of each kind has, and
 * which typed relations it may hold (Phase 1.1).
 *
 * One JSON file per kind under `./templates/`, original content written under
 * neutral craft labels (no published framework's names or beats; the banned
 * list is a test, `tests/unit/bible/templates.test.ts`). Every file is parsed
 * with `templateSchema` when this module loads, so an invalid template stops
 * the module rather than reaching a request.
 *
 * Client-safe: no server import, so the bible UI (Phase 1.2) reads the same
 * registry the usecases enforce.
 *
 *   getTemplate(kind)                 the kind's template
 *   getFieldDef(kind, key)            one field, or undefined
 *   getRelationType(fromKind, key)    a relation an element of `fromKind` may
 *                                     START, or undefined; `related_to` is
 *                                     built in for every pair of kinds
 *   relationTypesFrom(kind)           every relation an element of `kind` may start
 *   relationTypesInto(kind)           every relation that may END at `kind`,
 *                                     with the kind that starts it (read from
 *                                     this end with its inverse label)
 *   relationFieldDefs(fromKind, key)  a relation type's fields (Phase 3.3,
 *                                     D24), in order; `related_to` has its own
 *                                     small generic set
 *   getRelationFieldDef(fromKind, key, field)  one of them, or undefined
 *
 * A relation type is identified by the kind that declares it plus its key (two
 * kinds may each declare an `allied_with`). It is declared once, on the
 * earlier kind's template, and stored once (`BibleRelation`, from the
 * declaring kind's element to the target), then read from both ends.
 */
import { BIBLE_KINDS, type BibleKind } from './kinds';
import { BUILT_IN_RELATION_KEY, relationFieldsSchema, templateSchema, type BibleTemplate, type FieldDef, type RelationFieldDef, type RelationTypeDef } from './template-schema';

import character from './templates/character.json';
import custom from './templates/custom.json';
import faction from './templates/faction.json';
import mood from './templates/mood.json';
import object from './templates/object.json';
import plot from './templates/plot.json';
import plotBeat from './templates/plot_beat.json';
import pov from './templates/pov.json';
import premise from './templates/premise.json';
import research from './templates/research.json';
import setting from './templates/setting.json';
import style from './templates/style.json';
import texture from './templates/texture.json';
import theme from './templates/theme.json';
import timelineEvent from './templates/timeline_event.json';
import worldRule from './templates/world_rule.json';

/** The raw template files, by kind (exported for the template tests). */
export const RAW_TEMPLATES: Readonly<Record<BibleKind, unknown>> = Object.freeze({
    PREMISE: premise,
    PLOT: plot,
    PLOT_BEAT: plotBeat,
    CHARACTER: character,
    SETTING: setting,
    THEME: theme,
    MOOD: mood,
    TEXTURE: texture,
    STYLE: style,
    POV: pov,
    WORLD_RULE: worldRule,
    TIMELINE_EVENT: timelineEvent,
    FACTION: faction,
    OBJECT: object,
    RESEARCH: research,
    CUSTOM: custom,
});

/**
 * Pairs of relation declarations a lookup by `(the two elements, type key)`
 * could not tell apart (Phase 1.H, #27): two kinds K1 and K2 that each declare
 * the key, where K1's declaration reaches K2 and K2's reaches K1. An element
 * of each could then be related "by that key" under either declaration, and a
 * symmetric lookup over the unordered pair (`findPair`, the
 * `BibleRelation_symmetric_pair_key` index) would take one for the other.
 * The schema's rule that a template targets no EARLIER kind already makes
 * this impossible; this check says so where the lookup depends on it, and
 * holds if that rule is ever relaxed.
 */
export function relationLookupCollisions(templates: Readonly<Record<BibleKind, { relationTypes: ReadonlyArray<Pick<RelationTypeDef, 'key' | 'targetKinds'>> }>>): string[] {
    const out: string[] = [];
    for (const [i, k1] of BIBLE_KINDS.entries()) {
        for (const k2 of BIBLE_KINDS.slice(i + 1)) {
            for (const d1 of templates[k1].relationTypes) {
                const d2 = templates[k2].relationTypes.find((r) => r.key === d1.key);
                if (d2 && d1.targetKinds.includes(k2) && d2.targetKinds.includes(k1)) out.push(`${d1.key}: ${k1} and ${k2}`);
            }
        }
    }
    return out;
}

/** Parse every raw template, refusing one whose `kind` is not the slot it is filed under. */
export function loadTemplates(raw: Readonly<Record<BibleKind, unknown>>): Readonly<Record<BibleKind, BibleTemplate>> {
    const out = {} as Record<BibleKind, BibleTemplate>;
    for (const kind of BIBLE_KINDS) {
        const parsed = templateSchema.safeParse(raw[kind]);
        if (!parsed.success) {
            const where = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
            throw new Error(`bible template ${kind} is invalid: ${where}`);
        }
        if (parsed.data.kind !== kind) throw new Error(`bible template filed as ${kind} declares kind ${parsed.data.kind}`);
        const sorted = [...parsed.data.fields].sort((a, b) => a.order - b.order);
        const relationTypes = parsed.data.relationTypes.map((r) => ({ ...r, fields: [...r.fields].sort((a, b) => a.order - b.order) }));
        out[kind] = deepFreeze({ ...parsed.data, kind, fields: sorted, relationTypes });
    }
    const collisions = relationLookupCollisions(out);
    if (collisions.length > 0) throw new Error(`bible templates declare a relation key two kinds could each hold between the same two elements: ${collisions.join('; ')}`);
    return Object.freeze(out);
}

const TEMPLATES = loadTemplates(RAW_TEMPLATES);

export function getTemplate(kind: BibleKind): BibleTemplate {
    return TEMPLATES[kind];
}

export function getFieldDef(kind: BibleKind, key: string): FieldDef | undefined {
    return TEMPLATES[kind].fields.find((f) => f.key === key);
}

/**
 * The built-in relation's fields (Phase 3.3, D24): a minimal generic set, as
 * `related_to` says nothing about what kind of link it is. Parsed with the
 * same schema as every declared type's, at load.
 */
const BUILT_IN_RELATION_FIELDS: readonly RelationFieldDef[] = relationFieldsSchema.parse([
    { key: 'nature', label: 'Nature of the link', help: 'What connects these two, in a sentence or two.', type: 'text', required: true, order: 1, dependsOn: [] },
    { key: 'significance', label: 'Why it matters', help: 'What this link does for the story, or would cost it if it were cut.', type: 'text', required: false, order: 2, dependsOn: [] },
]);

/** The built-in relation: any element to any other, read the same both ways. */
export const BUILT_IN_RELATION: RelationTypeDef = deepFreeze({
    key: BUILT_IN_RELATION_KEY,
    label: 'related to',
    inverseLabel: 'related to',
    targetKinds: [...BIBLE_KINDS],
    fields: [...BUILT_IN_RELATION_FIELDS],
});

/** A relation an element of `fromKind` may start, by key; undefined when the kind declares none by that key. */
export function getRelationType(fromKind: BibleKind, key: string): RelationTypeDef | undefined {
    if (key === BUILT_IN_RELATION_KEY) return BUILT_IN_RELATION;
    return TEMPLATES[fromKind].relationTypes.find((r) => r.key === key);
}

/** May an element of `fromKind` start a `key` relation to an element of `toKind`? */
export function relationAllowed(fromKind: BibleKind, key: string, toKind: BibleKind): boolean {
    return getRelationType(fromKind, key)?.targetKinds.includes(toKind) ?? false;
}

/** A relation reads the same from both ends (label equals inverse label). */
export function isSymmetric(type: RelationTypeDef): boolean {
    return type.label === type.inverseLabel;
}

/** A relation type's fields (D24), in order: empty for a type the kind does not declare. */
export function relationFieldDefs(fromKind: BibleKind, key: string): readonly RelationFieldDef[] {
    return getRelationType(fromKind, key)?.fields ?? [];
}

/** One field of a relation type, or undefined. */
export function getRelationFieldDef(fromKind: BibleKind, key: string, fieldKey: string): RelationFieldDef | undefined {
    return relationFieldDefs(fromKind, key).find((f) => f.key === fieldKey);
}

/**
 * Every relation field key any type declares (built-in included), each once,
 * in kind order then declaration order: the relations interview pack covers
 * all of them (Phase 3.3).
 */
export function allRelationFieldKeys(): { keys: string[]; required: string[] } {
    const keys: string[] = [];
    const required: string[] = [];
    const types = [...BIBLE_KINDS.flatMap((k) => TEMPLATES[k].relationTypes), BUILT_IN_RELATION];
    for (const t of types) {
        for (const f of t.fields) {
            if (!keys.includes(f.key)) keys.push(f.key);
            if (f.required && !required.includes(f.key)) required.push(f.key);
        }
    }
    return { keys, required };
}

export function relationTypesFrom(kind: BibleKind): readonly RelationTypeDef[] {
    return [...TEMPLATES[kind].relationTypes, BUILT_IN_RELATION];
}

export interface IncomingRelationType {
    fromKind: BibleKind;
    type: RelationTypeDef;
}

export function relationTypesInto(kind: BibleKind): readonly IncomingRelationType[] {
    return BIBLE_KINDS.flatMap((fromKind) =>
        TEMPLATES[fromKind].relationTypes.filter((r) => r.targetKinds.includes(kind)).map((type) => ({ fromKind, type })),
    );
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const v of Object.values(value)) deepFreeze(v);
        Object.freeze(value);
    }
    return value;
}

export type { BibleTemplate, FieldDef, RelationFieldDef, RelationTypeDef } from './template-schema';
