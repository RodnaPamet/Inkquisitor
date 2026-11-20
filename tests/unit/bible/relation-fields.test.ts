/**
 * RELATION FIELDS (Phase 3.3, decision D24): every relation type a template
 * declares, and the built-in `related_to`, holds a modest set of PROSE fields
 * beside its type — the facts of a link the engine asks to fill — checked by
 * the same list rules as an element's fields; and a relation's version
 * snapshot reads back what it stored.
 */
import { BIBLE_KINDS } from '@/lib/bible/kinds';
import { buildRelationSnapshot, parseRelationSnapshot, serialiseRelationSnapshot } from '@/lib/bible/relation-snapshot';
import { RELATION_FIELD_TYPES, RELATION_FIELDS_MAX, templateSchema } from '@/lib/bible/template-schema';
import { allRelationFieldKeys, BUILT_IN_RELATION, getRelationFieldDef, getTemplate, RAW_TEMPLATES, relationFieldDefs } from '@/lib/bible/templates';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('every relation type holds a modest set of prose fields', () => {
    const types = BIBLE_KINDS.flatMap((kind) => getTemplate(kind).relationTypes.map((r) => [kind, r] as const));

    it.each(types.map(([kind, r]) => [`${kind}.${r.key}`, kind, r.key] as const))('%s', (_name, kind, key) => {
        const fields = relationFieldDefs(kind, key);
        expect(fields.length).toBeGreaterThanOrEqual(1);
        expect(fields.length).toBeLessThanOrEqual(RELATION_FIELDS_MAX);
        for (const f of fields) expect(RELATION_FIELD_TYPES).toContain(f.type);
        expect(fields.map((f) => f.order)).toEqual(fields.map((_, i) => i + 1));
    });

    it('related_to, the built-in type, has its own minimal generic set for every kind', () => {
        expect(BUILT_IN_RELATION.fields.map((f) => f.key)).toEqual(['nature', 'significance']);
        for (const kind of BIBLE_KINDS) expect(relationFieldDefs(kind, 'related_to').map((f) => f.key)).toEqual(['nature', 'significance']);
    });

    it('a field is found by its type and its declaring kind, and not by another type', () => {
        expect(getRelationFieldDef('CHARACTER', 'member_of', 'terms')?.label).toBeTruthy();
        expect(getRelationFieldDef('CHARACTER', 'member_of', 'history')).toBeUndefined();
        expect(getRelationFieldDef('FACTION', 'member_of', 'terms')).toBeUndefined();
        expect(allRelationFieldKeys().keys).toEqual(expect.arrayContaining(['nature', 'significance', 'terms', 'history', 'mechanism']));
    });
});

describe('the schema refuses a broken relation field list', () => {
    const base = () => clone(RAW_TEMPLATES.CHARACTER) as { relationTypes: Array<{ fields: Array<Record<string, unknown>> }> };
    const refuses = (t: unknown) => expect(templateSchema.safeParse(t).success).toBe(false);

    it('accepts the shipped one (the controls below fail for their mutation)', () => {
        expect(templateSchema.safeParse(base()).success).toBe(true);
    });

    it('no field, more than the maximum, a non-prose type, a duplicate key', () => {
        const none = base();
        none.relationTypes[0].fields = [];
        refuses(none);
        const many = base();
        const f = many.relationTypes[0].fields[0];
        many.relationTypes[0].fields = Array.from({ length: RELATION_FIELDS_MAX + 1 }, (_, i) => ({ ...f, key: `k${i}`, label: `Label ${i}`, order: i + 1, dependsOn: [] }));
        refuses(many);
        const scale = base();
        scale.relationTypes[0].fields[0] = { ...scale.relationTypes[0].fields[0], type: 'scale', scaleLabels: { low: 'a', high: 'b' } };
        refuses(scale);
        const dup = base();
        dup.relationTypes[0].fields[1] = { ...dup.relationTypes[0].fields[1], key: dup.relationTypes[0].fields[0].key };
        refuses(dup);
    });
});

describe('a relation version’s snapshot', () => {
    it('reads back what it stored, its fields in template order', () => {
        const snapshot = buildRelationSnapshot({
            relation: { type: 'member_of', fromElementId: 'e1', toElementId: 'e2', note: 'Reluctantly' },
            fields: [
                { key: 'terms', order: 2, value: 'Three crossings a season.' },
                { key: 'basis', order: 1, value: 'Born into it.' },
            ],
        });
        expect(snapshot.fields.map((f) => f.key)).toEqual(['basis', 'terms']);
        expect(parseRelationSnapshot(serialiseRelationSnapshot(snapshot))).toEqual(snapshot);
    });

    it('refuses a snapshot it cannot read, never reading it as an empty relation', () => {
        expect(() => parseRelationSnapshot('{"format":2}')).toThrow();
        expect(() => parseRelationSnapshot(JSON.stringify({ format: 1, relation: { type: 't', fromElementId: 'a', toElementId: 'b', note: null }, fields: [], extra: 1 }))).toThrow();
    });
});
