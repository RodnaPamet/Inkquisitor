/**
 * What the bible pages hand their client components about the templates
 * (Phase 1.2): plain, serialisable views built from the registry
 * (`./templates.ts`), so the browser bundle carries the few fields a page
 * shows rather than every template and the schema that parses them.
 *
 *   kindSummaries()            every kind, in the fixed order, with its label
 *                              and how many fields its template has
 *   relationOptionsFor(kind)   every relation an element of `kind` may take
 *                              part in, read from that element's end
 *
 * A RELATION OPTION is one way an element can be related, as the author reads
 * it from the element's page. A relation is stored from the kind that
 * declares its type (`templates.ts`), so an option says which end this
 * element is: `outgoing` (this element starts it, read with the type's label)
 * or `incoming` (another kind declares it towards this kind, read with the
 * inverse label). A symmetric type declared by this kind towards itself is
 * offered once: from either end it is the same fact.
 */
import { BIBLE_KINDS, type BibleKind } from './kinds';
import { BUILT_IN_RELATION, getTemplate, isSymmetric, relationTypesInto, type FieldDef } from './templates';

export interface KindSummary {
    kind: BibleKind;
    label: string;
    description: string;
    fieldCount: number;
}

export function kindSummaries(): KindSummary[] {
    return BIBLE_KINDS.map((kind) => {
        const t = getTemplate(kind);
        return { kind, label: t.label, description: t.description, fieldCount: t.fields.length };
    });
}

/** The kind's template fields, in order: plain data for the field editors. */
export function fieldDefsFor(kind: BibleKind): FieldDef[] {
    // A deep copy as plain JSON: the registry is frozen, and a page hands this to a client component.
    return getTemplate(kind).fields.map((f) => JSON.parse(JSON.stringify(f)) as FieldDef);
}

export interface RelationOption {
    /** Unique among the options of one kind. */
    id: string;
    /** The stored relation type key. */
    type: string;
    /** The label read from THIS element's end. */
    label: string;
    direction: 'outgoing' | 'incoming';
    /** Kinds the other element may be. */
    otherKinds: BibleKind[];
    /** The type reads the same from both ends (one fact either way: stored once, refused twice). */
    symmetric: boolean;
}

export function relationOptionsFor(kind: BibleKind): RelationOption[] {
    const outgoing: RelationOption[] = getTemplate(kind).relationTypes.map((r) => ({
        id: `out:${r.key}`,
        type: r.key,
        label: r.label,
        direction: 'outgoing',
        otherKinds: [...r.targetKinds],
        symmetric: isSymmetric(r),
    }));
    const incoming: RelationOption[] = relationTypesInto(kind)
        .filter(({ fromKind, type }) => !(fromKind === kind && isSymmetric(type)))
        .map(({ fromKind, type }) => ({
            id: `in:${fromKind}:${type.key}`,
            type: type.key,
            label: type.inverseLabel,
            direction: 'incoming',
            otherKinds: [fromKind],
            symmetric: isSymmetric(type),
        }));
    const builtIn: RelationOption = {
        id: `out:${BUILT_IN_RELATION.key}`,
        type: BUILT_IN_RELATION.key,
        label: BUILT_IN_RELATION.label,
        direction: 'outgoing',
        otherKinds: [...BIBLE_KINDS],
        symmetric: true,
    };
    return [...outgoing, ...incoming, builtIn];
}

export type { FieldDef } from './templates';
