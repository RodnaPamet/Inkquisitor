/**
 * The bible's Markdown bundle (Phase 1.3): what a book's bible looks like as
 * files, and how a file's frontmatter is read back safely.
 *
 *   manifest.json            {"format":"inkquisitor-bible","version":1,"templateFields":{…}}
 *   book.md                  the book's details as frontmatter; a contents list
 *   <kind>/_index.md         one per kind that has entries: the entries, linked
 *   <kind>/<slug>.md         one per element
 *
 * `<kind>` is the kind in lower case (`character`, `timeline_event`, `custom`),
 * the name of its template file. An index is `_index.md` because no slug can
 * start with `_`, so it never collides with an element's file.
 *
 * THE MANIFEST'S `templateFields` names, per kind directory, every field key
 * the kind's template had when the bundle was written, in template order. An
 * element file is its element's whole state over THOSE keys: a key the
 * template had and the file leaves out is cleared on import, while a key a
 * template has gained since the bundle was written is left alone (the file
 * never knew about it, so it says nothing about it). A manifest without
 * `templateFields` (written by hand) claims every current key.
 *
 * AN ELEMENT FILE is YAML frontmatter and a Markdown body:
 *
 *   ---
 *   kind: CHARACTER
 *   name: Mara Vell
 *   slug: mara-vell
 *   status: DRAFT
 *   customLabel: …         (a CUSTOM element only)
 *   summary: |-            (when it has one)
 *     …
 *   fields:                (filled fields only, in template order, by key)
 *     want: To leave the salt roads
 *     traits:              (a list field: a sequence of strings)
 *       - stubborn
 *     voice: <p>…</p>      (rich text: the stored, sanitised HTML, verbatim)
 *     temperament: 4       (a scale: the number)
 *     role: protagonist    (a choice: the option's value)
 *   relations:             (the relations STORED from this element, by target slug)
 *     - type: allied_with
 *       to: the-salt-guild
 *       note: …            (when it has one)
 *   ---
 *
 * The FRONTMATTER IS THE DATA. The body — the name as a heading, the summary,
 * every filled field under its template label (rich text reduced to its text,
 * a choice by its option label, a scale by its position), the relations both
 * ways — is generated from the frontmatter for a person to read, and an import
 * never reads it. Rich text stays HTML in the frontmatter rather than being
 * converted to Markdown, because a conversion is lossy both ways and the round
 * trip (export, import into an empty book, export again) must give the same
 * bytes.
 *
 * DETERMINISM. Every file is a function of the stored bible alone: elements in
 * kind order then slug, fields in template order, relations by type, target
 * and note, keys in a fixed order, no timestamps, no ids. `writeZip`
 * (src/lib/archive/zip.ts) adds no wall-clock data either.
 *
 * READING YAML SAFELY (`parseYamlFrontmatter`). YAML 1.2 core schema only:
 * an alias (`*a`) is refused outright — the billion-laughs expansion needs
 * one — and so is any explicit tag (`!!binary`, `!custom`), a duplicate key,
 * and any parse error or warning. The text is bounded before it is parsed
 * (the zip reader's per-entry bound).
 *
 * Server-only (it reaches the plain-text sanitiser to reduce rich text to its
 * text for the body).
 */
import { isAlias, isMap, isNode, isScalar, parseDocument, stringify, visit } from 'yaml';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { FieldValue } from './field-values';
import { BIBLE_KINDS, kindRank, type BibleElementStatus, type BibleKind, type BookStage } from './kinds';
import { getFieldDef, getRelationType, getTemplate } from './templates';

export const BUNDLE_FORMAT = 'inkquisitor-bible';
export const BUNDLE_VERSION = 1;

export const MANIFEST_FILE = 'manifest.json';
export const BOOK_FILE = 'book.md';
export const INDEX_FILE = '_index.md';

/** A kind's directory in the bundle: its name in lower case, as its template file is named. */
export function kindDirectory(kind: BibleKind): string {
    return kind.toLowerCase();
}

/** The kind a directory name stands for, or null. */
export function kindOfDirectory(dir: string): BibleKind | null {
    return BIBLE_KINDS.find((k) => kindDirectory(k) === dir) ?? null;
}

export function elementPath(kind: BibleKind, slug: string): string {
    return `${kindDirectory(kind)}/${slug}.md`;
}

// ─── The data a bundle carries ──────────────────────────────────────

export interface BundleBook {
    title: string;
    logline: string | null;
    genre: string | null;
    audience: string | null;
    targetLength: number | null;
    stage: BookStage;
}

export interface BundleRelation {
    type: string;
    /** The target element's slug. */
    to: string;
    note: string | null;
}

export interface BundleElement {
    kind: BibleKind;
    name: string;
    slug: string;
    status: BibleElementStatus;
    customLabel: string | null;
    summary: string | null;
    /** Filled fields by key. */
    fields: ReadonlyMap<string, FieldValue>;
    /** The relations stored FROM this element. */
    relations: readonly BundleRelation[];
}

export interface BibleBundle {
    book: BundleBook;
    elements: readonly BundleElement[];
}

// ─── Writing ────────────────────────────────────────────────────────

/** The manifest: the format, its version, and every kind's template field keys as of now. */
export function bundleManifest(): { format: string; version: number; templateFields: Record<string, string[]> } {
    const templateFields: Record<string, string[]> = {};
    for (const kind of BIBLE_KINDS) templateFields[kindDirectory(kind)] = getTemplate(kind).fields.map((f) => f.key);
    return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, templateFields };
}

export const STATUS_WORDS: Readonly<Record<BibleElementStatus, string>> = { DRAFT: 'Draft', IN_PROGRESS: 'In progress', SETTLED: 'Settled' };

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Elements in the bundle's order: kind order, then slug. */
export function sortElements<T extends { kind: BibleKind; slug: string }>(elements: readonly T[]): T[] {
    return [...elements].sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || compare(a.slug, b.slug));
}

function sortRelations(relations: readonly BundleRelation[]): BundleRelation[] {
    return [...relations].sort((a, b) => compare(a.type, b.type) || compare(a.to, b.to) || compare(a.note ?? '', b.note ?? ''));
}

function yaml(value: unknown): string {
    return stringify(value, {
        version: '1.2',
        schema: 'core',
        lineWidth: 0,
        minContentWidth: 0,
        blockQuote: 'literal',
        aliasDuplicateObjects: false,
        indent: 2,
        indentSeq: true,
    });
}

function withFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
    return `---\n${yaml(frontmatter)}---\n\n${body.trimEnd()}\n`;
}

/** A rich-text value's text, a line per block (the body is for reading; the HTML stays in the frontmatter). */
export function richTextLines(html: string): string[] {
    const broken = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr|ul|ol|table)>/gi, '\n');
    return sanitizePlainText(broken)
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter((l) => l !== '');
}

/** A field value as Markdown lines for the body (and the PDF). */
export function valueLines(kind: BibleKind, key: string, value: FieldValue): string[] {
    const def = getFieldDef(kind, key);
    if (Array.isArray(value)) return value.map((item) => `- ${item}`);
    if (def?.type === 'richtext' && typeof value === 'string') return richTextLines(value);
    if (def?.type === 'choice' && typeof value === 'string') return [def.options.find((o) => o.value === value)?.label ?? value];
    if (def?.type === 'scale' && typeof value === 'number') return [`${value} of 5 (${def.scaleLabels.low} to ${def.scaleLabels.high})`];
    return [String(value)];
}

/** The frontmatter object of an element file, keys in their fixed order. */
export function elementFrontmatter(e: BundleElement): Record<string, unknown> {
    const fields: Record<string, FieldValue> = {};
    for (const def of getTemplate(e.kind).fields) {
        const value = e.fields.get(def.key);
        if (value !== undefined) fields[def.key] = value;
    }
    return {
        kind: e.kind,
        name: e.name,
        slug: e.slug,
        status: e.status,
        ...(e.customLabel !== null ? { customLabel: e.customLabel } : {}),
        ...(e.summary !== null ? { summary: e.summary } : {}),
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
        ...(e.relations.length > 0
            ? { relations: sortRelations(e.relations).map((r) => ({ type: r.type, to: r.to, ...(r.note !== null ? { note: r.note } : {}) })) }
            : {}),
    };
}

export interface RelationLine {
    label: string;
    other: BundleElement;
    note: string | null;
}

function elementBody(e: BundleElement, relationLines: readonly RelationLine[]): string {
    const out: string[] = [`# ${e.name}`, ''];
    if (e.customLabel !== null) out.push(`Custom label: ${e.customLabel}`, '');
    out.push(`Status: ${STATUS_WORDS[e.status]}`, '');
    if (e.summary !== null) out.push(e.summary, '');
    for (const def of getTemplate(e.kind).fields) {
        const value = e.fields.get(def.key);
        if (value === undefined) continue;
        out.push(`## ${def.label}`, '', ...valueLines(e.kind, def.key, value), '');
    }
    if (relationLines.length > 0) {
        out.push('## Relations', '');
        for (const r of relationLines) {
            out.push(`- ${r.label} [${r.other.name}](../${elementPath(r.other.kind, r.other.slug)})${r.note !== null ? `: ${r.note.replace(/\s+/g, ' ')}` : ''}`);
        }
        out.push('');
    }
    return out.join('\n');
}

export function bookFrontmatter(book: BundleBook): Record<string, unknown> {
    return {
        title: book.title,
        ...(book.logline !== null ? { logline: book.logline } : {}),
        ...(book.genre !== null ? { genre: book.genre } : {}),
        ...(book.audience !== null ? { audience: book.audience } : {}),
        ...(book.targetLength !== null ? { targetLength: book.targetLength } : {}),
        stage: book.stage,
    };
}

/**
 * Every relation of the bible read from both ends, by element slug: from the
 * element that stores it with the type's label, from its target with the
 * inverse label; each element's lines in a fixed order.
 */
export function relationLinesBySlug(elements: readonly BundleElement[]): Map<string, RelationLine[]> {
    const bySlug = new Map(elements.map((e) => [e.slug, e] as const));
    const lines = new Map<string, RelationLine[]>();
    const add = (slug: string, line: RelationLine) => lines.set(slug, [...(lines.get(slug) ?? []), line]);
    for (const e of elements) {
        for (const r of e.relations) {
            const other = bySlug.get(r.to);
            if (!other) continue;
            const type = getRelationType(e.kind, r.type);
            add(e.slug, { label: type?.label ?? r.type, other, note: r.note });
            add(other.slug, { label: type?.inverseLabel ?? r.type, other: e, note: r.note });
        }
    }
    const order = (a: RelationLine, b: RelationLine) =>
        compare(a.label, b.label) || kindRank(a.other.kind) - kindRank(b.other.kind) || compare(a.other.slug, b.other.slug) || compare(a.note ?? '', b.note ?? '');
    for (const list of lines.values()) list.sort(order);
    return lines;
}

/**
 * Every file of the bundle, by path. The same bible always gives the same
 * map, in the same order, with the same bytes.
 */
export function bundleFiles(bundle: BibleBundle): Map<string, string> {
    const elements = sortElements(bundle.elements);
    const files = new Map<string, string>();

    files.set(MANIFEST_FILE, `${JSON.stringify(bundleManifest(), null, 2)}\n`);

    const lines = relationLinesBySlug(elements);

    const contents: string[] = [];
    for (const kind of BIBLE_KINDS) {
        const ofKind = elements.filter((e) => e.kind === kind);
        if (ofKind.length === 0) continue;
        const template = getTemplate(kind);
        contents.push(`- [${template.label}](${kindDirectory(kind)}/${INDEX_FILE}): ${ofKind.length === 1 ? '1 entry' : `${ofKind.length} entries`}`);
        const index = [`# ${template.label}`, '', template.description, '', ...ofKind.map((e) => `- [${e.name}](${e.slug}.md): ${STATUS_WORDS[e.status]}`)];
        files.set(`${kindDirectory(kind)}/${INDEX_FILE}`, `${index.join('\n')}\n`);
        for (const e of ofKind) {
            const relationLines = lines.get(e.slug) ?? [];
            files.set(elementPath(kind, e.slug), withFrontmatter(elementFrontmatter(e), elementBody(e, relationLines)));
        }
    }

    const bookBody = [`# ${bundle.book.title}`, ''];
    if (bundle.book.logline !== null) bookBody.push(bundle.book.logline, '');
    bookBody.push('## Contents', '', ...(contents.length > 0 ? contents : ['No entries yet.']), '');
    files.set(BOOK_FILE, withFrontmatter(bookFrontmatter(bundle.book), bookBody.join('\n')));

    return new Map([...files.entries()].sort(([a], [b]) => compare(a, b)));
}

// ─── Reading ────────────────────────────────────────────────────────

export const FRONTMATTER_REFUSALS = ['NOT_UTF8', 'FRONTMATTER_MISSING', 'YAML_INVALID', 'YAML_ALIAS', 'YAML_TAG'] as const;
export type FrontmatterRefusal = (typeof FRONTMATTER_REFUSALS)[number];

export class FrontmatterError extends Error {
    constructor(readonly reason: FrontmatterRefusal) {
        super(`frontmatter refused: ${reason}`);
        this.name = 'FrontmatterError';
    }
}

/** Bytes as UTF-8 text (a byte-order mark dropped, CRLF read as LF); refused if not UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new FrontmatterError('NOT_UTF8');
    }
    return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** The YAML between a file's opening `---` line and the next `---` line. */
export function frontmatterOf(text: string): string {
    if (!text.startsWith('---\n')) throw new FrontmatterError('FRONTMATTER_MISSING');
    const rest = text.slice(4);
    if (rest.startsWith('---\n') || rest === '---') return '';
    const end = rest.indexOf('\n---\n');
    if (end >= 0) return rest.slice(0, end + 1);
    if (rest.endsWith('\n---')) return rest.slice(0, -3);
    throw new FrontmatterError('FRONTMATTER_MISSING');
}

/**
 * The YAML as plain JavaScript values: YAML 1.2 core schema, no alias, no
 * explicit tag, no duplicate key, no error or warning — each refused by name.
 *
 * Duplicate keys are found HERE, with a set per mapping, not by the library's
 * `uniqueKeys`: that compares each key with every key before it, quadratic in
 * a mapping's size (Phase 1.H measured a 500 KB mapping of 20,000 keys at 4.9 s,
 * and one of 100,000 keys at two minutes). Read this way the parse is linear,
 * about 1.5 µs a character for the densest structure.
 */
export function parseYamlFrontmatter(source: string): unknown {
    let doc: ReturnType<typeof parseDocument>;
    try {
        doc = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: false, merge: false, prettyErrors: false });
    } catch {
        throw new FrontmatterError('YAML_INVALID');
    }
    if (doc.errors.length > 0 || doc.warnings.length > 0) {
        // A refused alias surfaces as an error too; name it when it is one.
        let aliased = false;
        try {
            visit(doc, { Alias: () => ((aliased = true), visit.BREAK) });
        } catch {
            // the document is already refused
        }
        throw new FrontmatterError(aliased ? 'YAML_ALIAS' : 'YAML_INVALID');
    }
    let refusal: FrontmatterRefusal | null = null;
    visit(doc, (_key, node) => {
        if (isAlias(node)) {
            refusal = 'YAML_ALIAS';
            return visit.BREAK;
        }
        if (isNode(node) && node.tag !== undefined) {
            refusal = 'YAML_TAG';
            return visit.BREAK;
        }
        if (isMap(node)) {
            // Every key a scalar, and each once as the object it becomes will
            // hold it (`1` and `"1"` are one key there): a set per mapping keeps it linear.
            const seen = new Set<string>();
            for (const pair of node.items) {
                const key = isScalar(pair.key) ? String(pair.key.value) : null;
                if (key === null || seen.has(key)) {
                    refusal = 'YAML_INVALID';
                    return visit.BREAK;
                }
                seen.add(key);
            }
        }
        return undefined;
    });
    if (refusal) throw new FrontmatterError(refusal);
    try {
        return doc.toJS({ maxAliasCount: 0 });
    } catch {
        throw new FrontmatterError('YAML_INVALID');
    }
}
