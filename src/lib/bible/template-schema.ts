/**
 * The shape of a bible field template (`src/lib/bible/templates/<kind>.json`),
 * as a Zod schema the registry parses every template with at load
 * (`src/lib/bible/templates.ts`). A template that breaks it stops the module
 * from loading, so a bad edit fails every test and the build, never a request.
 *
 * The format is the content format the templates were written to (Inkquisitor
 * content formats v1, section 2): per field a key, label, help line, type
 * (`text`, `richtext`, `list`, `choice`, `scale`), the options or scale
 * anchors the type needs, whether it is a core field, its order and the keys
 * it depends on; per relation type a key, a label read from the element, an
 * inverse label read from the target, and the kinds it may point at.
 *
 * Beyond each object's shape the schema holds the rules that span a template:
 * keys and labels unique, orders contiguous from 1, `dependsOn` naming only
 * keys of an EARLIER order (so the dependency graph has no cycle), relation
 * keys unique and never the built-in `related_to`, and a relation declared
 * only towards the template's own kind or a later one (a relation between
 * two kinds is declared once, on the earlier kind's template; a custom
 * element relates only to custom elements).
 */
import { z } from 'zod';
import { BIBLE_KINDS, IDENTIFIER_MAX, IDENTIFIER_PATTERN, kindRank, type BibleKind } from './kinds';

export const FIELD_TYPES = ['text', 'richtext', 'list', 'choice', 'scale'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Keys an element carries as COLUMNS, never as template fields. */
export const RESERVED_FIELD_KEYS: readonly string[] = ['name', 'slug', 'status', 'summary', 'kind', 'label'];

/** The relation every two elements may hold without a template declaring it. */
export const BUILT_IN_RELATION_KEY = 'related_to';

const identifier = z.string().max(IDENTIFIER_MAX).regex(IDENTIFIER_PATTERN);
const kind = z.enum(BIBLE_KINDS);
const label = z.string().min(1).max(40);
const help = z.string().min(1).max(200);

const optionSchema = z.object({ value: identifier, label }).strict();

const fieldBase = {
    key: identifier.refine((k) => !RESERVED_FIELD_KEYS.includes(k), { message: 'a reserved column name' }),
    label,
    help,
    required: z.boolean(),
    order: z.number().int().min(1),
    dependsOn: z.array(identifier),
};

const fieldSchema = z.discriminatedUnion('type', [
    z.object({ ...fieldBase, type: z.literal('text') }).strict(),
    z.object({ ...fieldBase, type: z.literal('richtext') }).strict(),
    z.object({ ...fieldBase, type: z.literal('list') }).strict(),
    z
        .object({
            ...fieldBase,
            type: z.literal('choice'),
            options: z.array(optionSchema).min(2).max(8),
        })
        .strict(),
    z
        .object({
            ...fieldBase,
            type: z.literal('scale'),
            scaleLabels: z.object({ low: label, high: label }).strict(),
        })
        .strict(),
]);

const relationTypeSchema = z
    .object({
        key: identifier.refine((k) => k !== BUILT_IN_RELATION_KEY, { message: 'related_to is built in' }),
        label: z.string().min(1).max(32),
        inverseLabel: z.string().min(1).max(32),
        targetKinds: z.array(kind).min(1),
    })
    .strict();

export const templateSchema = z
    .object({
        kind,
        label: z.string().min(1).max(40),
        description: z.string().min(1).max(300),
        fields: z.array(fieldSchema).min(1),
        relationTypes: z.array(relationTypeSchema),
    })
    .strict()
    .superRefine((t, ctx) => {
        const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: 'custom', message, path });
        const keys = t.fields.map((f) => f.key);
        const orderOf = new Map(t.fields.map((f) => [f.key, f.order] as const));

        duplicates(keys).forEach((k) => issue(`duplicate field key ${k}`, ['fields']));
        duplicates(t.fields.map((f) => f.label)).forEach((l) => issue(`duplicate field label ${l}`, ['fields']));
        const orders = t.fields.map((f) => f.order).sort((a, b) => a - b);
        if (orders.some((o, i) => o !== i + 1)) issue('field orders must run 1..n without gaps or repeats', ['fields']);

        t.fields.forEach((f, i) => {
            duplicates(f.dependsOn).forEach((d) => issue(`${f.key} lists ${d} twice`, ['fields', i, 'dependsOn']));
            for (const dep of f.dependsOn) {
                const depOrder = orderOf.get(dep);
                if (depOrder === undefined) issue(`${f.key} depends on unknown field ${dep}`, ['fields', i, 'dependsOn']);
                else if (depOrder >= f.order) issue(`${f.key} depends on ${dep}, which does not come before it`, ['fields', i, 'dependsOn']);
            }
            if (f.type === 'choice') {
                duplicates(f.options.map((o) => o.value)).forEach((v) => issue(`${f.key} repeats option ${v}`, ['fields', i, 'options']));
            }
        });

        duplicates(t.relationTypes.map((r) => r.key)).forEach((k) => issue(`duplicate relation key ${k}`, ['relationTypes']));
        t.relationTypes.forEach((r, i) => {
            duplicates(r.targetKinds).forEach((k) => issue(`${r.key} lists ${k} twice`, ['relationTypes', i, 'targetKinds']));
            for (const target of r.targetKinds) {
                if (kindRank(target) < kindRank(t.kind)) {
                    issue(`${r.key} targets ${target}, an earlier kind: declare it on that kind's template`, ['relationTypes', i, 'targetKinds']);
                }
                if (t.kind === 'CUSTOM' && target !== 'CUSTOM') issue(`${r.key}: a custom element relates only to custom elements`, ['relationTypes', i]);
            }
        });
    });

export type BibleTemplate = z.infer<typeof templateSchema> & { kind: BibleKind };
export type FieldDef = BibleTemplate['fields'][number];
export type RelationTypeDef = BibleTemplate['relationTypes'][number];

function duplicates<T>(values: readonly T[]): T[] {
    return [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
}
