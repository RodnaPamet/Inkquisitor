/**
 * The bible's field templates (src/lib/bible/templates/*.json) and the
 * registry over them (src/lib/bible/templates.ts).
 *
 * The registry parses every template at load, so a template that breaks the
 * schema already stops this suite from importing; these cases state the rules
 * one by one, against the shipped files, and prove the schema refuses each
 * kind of break on a mutated copy (a rule nothing can fail proves nothing).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BibleElementKind, BibleElementStatus, BibleVersionSource, BookStage } from '@prisma/client';
import { BIBLE_ELEMENT_STATUSES, BIBLE_KINDS, BIBLE_VERSION_SOURCES, BOOK_STAGES, IDENTIFIER_PATTERN, kindRank, type BibleKind } from '@/lib/bible/kinds';
import { templateSchema } from '@/lib/bible/template-schema';
import {
    BUILT_IN_RELATION,
    getFieldDef,
    getRelationType,
    getTemplate,
    loadTemplates,
    RAW_TEMPLATES,
    relationLookupCollisions,
    relationAllowed,
    relationTypesFrom,
    relationTypesInto,
} from '@/lib/bible/templates';

const TEMPLATE_DIR = path.resolve(__dirname, '../../../src/lib/bible/templates');

/** Framework names whose wording the templates must not borrow (roadmap 1.1: neutral labels). */
const BANNED_TERMS = ['save the cat', 'story grid', 'dramatica', 'snowflake', "hero's journey", 'hero’s journey', 'heros journey', 'monomyth'];

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}

/** Every string anywhere in a template. */
function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
}

describe('coverage', () => {
    it('the client-safe lists mirror the database enums, in the same order', () => {
        expect(Object.values(BibleElementKind)).toEqual([...BIBLE_KINDS]);
        expect(Object.values(BibleElementStatus)).toEqual([...BIBLE_ELEMENT_STATUSES]);
        expect(Object.values(BookStage)).toEqual([...BOOK_STAGES]);
        expect(Object.values(BibleVersionSource)).toEqual([...BIBLE_VERSION_SOURCES]);
    });

    it.each(BIBLE_KINDS)('%s has a template, filed under its own kind', (kind) => {
        expect(getTemplate(kind).kind).toBe(kind);
        expect(getTemplate(kind).fields.length).toBeGreaterThan(0);
    });

    it('there is exactly one template file per kind and no stray file', () => {
        const files = fs.readdirSync(TEMPLATE_DIR).sort();
        expect(files).toEqual(BIBLE_KINDS.map((k) => `${k.toLowerCase()}.json`).sort());
    });
});

describe.each(BIBLE_KINDS)('the %s template', (kind) => {
    const t = getTemplate(kind);

    it('has unique field keys in the identifier shape', () => {
        const keys = t.fields.map((f) => f.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const k of keys) expect(k).toMatch(IDENTIFIER_PATTERN);
    });

    it('has orders 1..n and is read in that order', () => {
        expect(t.fields.map((f) => f.order)).toEqual(t.fields.map((_f, i) => i + 1));
    });

    it('depends only on existing keys, with no cycle', () => {
        const keys = new Set(t.fields.map((f) => f.key));
        for (const f of t.fields) for (const d of f.dependsOn) expect(keys).toContain(d);
        // Walk the graph: every field must be reachable by repeatedly taking fields whose dependencies are met.
        const done = new Set<string>();
        let progress = true;
        while (progress) {
            progress = false;
            for (const f of t.fields) {
                if (!done.has(f.key) && f.dependsOn.every((d) => done.has(d))) {
                    done.add(f.key);
                    progress = true;
                }
            }
        }
        expect([...done].sort()).toEqual([...keys].sort());
    });

    it('declares relations whose target kinds exist and come no earlier than its own', () => {
        for (const r of t.relationTypes) {
            expect(r.targetKinds.length).toBeGreaterThan(0);
            for (const target of r.targetKinds) {
                expect(BIBLE_KINDS).toContain(target);
                expect(kindRank(target)).toBeGreaterThanOrEqual(kindRank(kind));
            }
        }
    });

    it('has a choice field with options and a scale field with anchors, never the other way about', () => {
        for (const f of t.fields) {
            if (f.type === 'choice') expect(f.options.length).toBeGreaterThanOrEqual(2);
            if (f.type === 'scale') expect(f.scaleLabels.low && f.scaleLabels.high).toBeTruthy();
            if (f.type !== 'choice') expect(f).not.toHaveProperty('options');
            if (f.type !== 'scale') expect(f).not.toHaveProperty('scaleLabels');
        }
    });

    it('borrows no branded framework name', () => {
        const text = strings(RAW_TEMPLATES[kind]).join('\n').toLowerCase();
        for (const term of BANNED_TERMS) expect(text).not.toContain(term);
    });
});

describe('the banned-term check itself', () => {
    it('would catch a framework name in a label', () => {
        const bad = clone(RAW_TEMPLATES.PLOT) as { fields: Array<{ label: string }> };
        bad.fields[0].label = 'Save the Cat beat';
        expect(BANNED_TERMS.some((t) => strings(bad).join(' ').toLowerCase().includes(t))).toBe(true);
    });
});

describe('the schema refuses a broken template', () => {
    const base = () => clone(RAW_TEMPLATES.CHARACTER) as {
        kind: string;
        fields: Array<{ key: string; label: string; order: number; dependsOn: string[]; type: string; options?: unknown }>;
        relationTypes: Array<{ key: string; targetKinds: string[] }>;
    };
    const refuses = (t: unknown) => expect(templateSchema.safeParse(t).success).toBe(false);

    it('accepts the shipped one (the controls below fail for their mutation)', () => {
        expect(templateSchema.safeParse(base()).success).toBe(true);
    });

    it('a duplicate key', () => {
        const t = base();
        t.fields[1].key = t.fields[0].key;
        refuses(t);
    });

    it('a dependency on a key that does not exist', () => {
        const t = base();
        t.fields[2].dependsOn = ['no_such_field'];
        refuses(t);
    });

    it('a cycle (a field depending on one that comes after it)', () => {
        const t = base();
        t.fields[0].dependsOn = [t.fields[t.fields.length - 1].key];
        refuses(t);
    });

    it('a gap in the orders', () => {
        const t = base();
        t.fields[t.fields.length - 1].order += 1;
        refuses(t);
    });

    it('an unknown target kind, and a target kind earlier than the template', () => {
        const t1 = base();
        t1.relationTypes[0].targetKinds = ['DRAGON'];
        refuses(t1);
        const t2 = base();
        t2.relationTypes[0].targetKinds = ['PREMISE'];
        refuses(t2);
    });

    it('a declared related_to, a reserved field key, a choice without options, an extra key', () => {
        const t1 = base();
        t1.relationTypes[0].key = 'related_to';
        refuses(t1);
        const t2 = base();
        t2.fields[0].key = 'summary';
        refuses(t2);
        const t3 = base();
        const choice = t3.fields.find((f) => f.type === 'choice')!;
        delete choice.options;
        refuses(t3);
        refuses({ ...base(), extra: true });
    });

    it('a relation key two kinds could each hold between the same two elements (#27: the symmetric lookup is by key)', () => {
        const base = { relationTypes: [] as Array<{ key: string; label: string; inverseLabel: string; targetKinds: BibleKind[] }> };
        const templates = Object.fromEntries(BIBLE_KINDS.map((k) => [k, { ...base, relationTypes: [] as typeof base.relationTypes }])) as Record<BibleKind, typeof base>;
        const allied = (targetKinds: BibleKind[]) => ({ key: 'allied_with', label: 'allied with', inverseLabel: 'allied with', targetKinds });
        templates.CHARACTER.relationTypes.push(allied(['CHARACTER', 'FACTION']));
        templates.FACTION.relationTypes.push(allied(['FACTION']));
        expect(relationLookupCollisions(templates)).toEqual([]);
        templates.FACTION.relationTypes[0] = allied(['FACTION', 'CHARACTER']);
        expect(relationLookupCollisions(templates)).toEqual(['allied_with: CHARACTER and FACTION']);
        // The shipped templates have none (loadTemplates would have thrown).
        expect(relationLookupCollisions(Object.fromEntries(BIBLE_KINDS.map((k) => [k, getTemplate(k)])) as Record<BibleKind, ReturnType<typeof getTemplate>>)).toEqual([]);
    });

    it('loadTemplates refuses a template filed under another kind', () => {
        const raw = { ...RAW_TEMPLATES, PLOT: RAW_TEMPLATES.CHARACTER } as Record<BibleKind, unknown>;
        expect(() => loadTemplates(raw)).toThrow(/filed as PLOT declares kind CHARACTER/);
    });
});

describe('the registry', () => {
    it('finds a field by kind and key, and nothing for another kind', () => {
        expect(getFieldDef('CHARACTER', 'want')?.type).toBe('text');
        expect(getFieldDef('SETTING', 'want')).toBeUndefined();
    });

    it('a relation type belongs to the kind that declares it; the target kind must be listed', () => {
        expect(getRelationType('CHARACTER', 'member_of')?.inverseLabel).toBe('has member');
        expect(relationAllowed('CHARACTER', 'member_of', 'FACTION')).toBe(true);
        expect(relationAllowed('CHARACTER', 'member_of', 'SETTING')).toBe(false);
        // Declared on CHARACTER, so a FACTION cannot start it.
        expect(relationAllowed('FACTION', 'member_of', 'CHARACTER')).toBe(false);
    });

    it('related_to is built in, both ways, for every pair of kinds', () => {
        for (const a of BIBLE_KINDS) for (const b of BIBLE_KINDS) expect(relationAllowed(a, 'related_to', b)).toBe(true);
        expect(BUILT_IN_RELATION.label).toBe(BUILT_IN_RELATION.inverseLabel);
        expect(relationTypesFrom('OBJECT').map((r) => r.key)).toContain('related_to');
    });

    it('lists the relations that may end at a kind, with the kind that starts them', () => {
        const into = relationTypesInto('FACTION');
        expect(into).toEqual(expect.arrayContaining([expect.objectContaining({ fromKind: 'CHARACTER', type: expect.objectContaining({ key: 'member_of' }) })]));
        for (const { fromKind, type } of into) expect(relationAllowed(fromKind, type.key, 'FACTION')).toBe(true);
    });

    it('is frozen: a caller cannot edit the templates it reads', () => {
        const t = getTemplate('CHARACTER');
        expect(() => {
            (t.fields as unknown as unknown[]).push({});
        }).toThrow();
    });
});
