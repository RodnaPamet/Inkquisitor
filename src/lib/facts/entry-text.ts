/**
 * AN ACCEPTED VERSION AS TEXT (Phase 4.1, D27). Pure.
 *
 * A bible version is a snapshot (an element and its fields, or a relation, its
 * note and its fields). Facts are drawn from it as from a passage, so it is
 * rendered — deterministically, from the snapshot alone — into SECTIONS, one a
 * line: `Label: value`. A fact's quote is located in the rendered entry, and
 * its stored span is an offset into it.
 *
 * INCREMENTAL. Only the sections that changed since the element's last
 * extracted version (its BASELINE) are sent to the model, after the header
 * that names the entry: an unchanged field is never re-read, so a fact it
 * stated is never re-worded into a second fact or a false contradiction. With
 * no baseline every section is new.
 *
 * Values are already sanitised (1.1's write path): rich text is read as plain
 * text through `plainBlock`, a list joined with "; ", a choice by its label; a
 * scale states no fact and is left out.
 */
import { plainBlock } from '@/lib/bible/text';
import type { BibleKind } from '@/lib/bible/kinds';
import type { BibleSnapshot } from '@/lib/bible/snapshot';
import type { RelationSnapshot } from '@/lib/bible/relation-snapshot';
import { getFieldDef, getRelationFieldDef, getRelationType } from '@/lib/bible/templates';

export interface EntrySection {
    /** `name`, `kind`, `relation` (the header) or `summary`, `custom_label`, `note`, a field key. */
    readonly key: string;
    readonly label: string;
    readonly text: string;
}

export interface RenderedEntry {
    /** The sections that name the entry (always sent). */
    readonly header: readonly EntrySection[];
    /** The sections that may state facts. */
    readonly body: readonly EntrySection[];
}

/** A kind code as a reader's words ("PLOT_BEAT" → "Plot beat"). Product text, never the author's. */
export function kindWords(kind: string): string {
    const lower = kind.toLowerCase().replace(/_/g, ' ');
    return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function line(s: EntrySection): string {
    return `${s.label}: ${s.text}`;
}

function oneLine(text: string): string {
    return plainBlock(text).split('\n').map((l) => l.trim()).filter((l) => l !== '').join(' ');
}

/** An element version's sections. */
export function renderElementEntry(snapshot: BibleSnapshot): RenderedEntry {
    const kind = snapshot.element.kind as BibleKind;
    const header: EntrySection[] = [
        { key: 'name', label: 'Name', text: oneLine(snapshot.element.name) },
        { key: 'kind', label: 'Kind', text: snapshot.element.customLabel ? `${kindWords(kind)} (${oneLine(snapshot.element.customLabel)})` : kindWords(kind) },
    ];
    const body: EntrySection[] = [];
    if (snapshot.element.summary) body.push({ key: 'summary', label: 'Summary', text: oneLine(snapshot.element.summary) });
    for (const f of snapshot.fields) {
        const def = getFieldDef(kind, f.key);
        if (!def || def.type === 'scale') continue;
        let text: string;
        if (Array.isArray(f.value)) text = f.value.map(oneLine).filter((v) => v !== '').join('; ');
        else if (typeof f.value === 'number') continue;
        else if (def.type === 'choice') text = def.options?.find((o) => o.value === f.value)?.label ?? oneLine(f.value);
        else text = oneLine(f.value);
        if (text !== '') body.push({ key: f.key, label: def.label, text });
    }
    return { header, body };
}

/** A relation version's sections, its ends named as the book names them now. */
export function renderRelationEntry(snapshot: RelationSnapshot, ends: { fromKind: BibleKind; fromName: string; toName: string }): RenderedEntry {
    const type = getRelationType(ends.fromKind, snapshot.relation.type);
    const label = type?.label ?? snapshot.relation.type.replace(/_/g, ' ');
    const header: EntrySection[] = [{ key: 'relation', label: 'Relation', text: `${oneLine(ends.fromName)} — ${label} — ${oneLine(ends.toName)}` }];
    const body: EntrySection[] = [];
    if (snapshot.relation.note) body.push({ key: 'note', label: 'Note', text: oneLine(snapshot.relation.note) });
    for (const f of snapshot.fields) {
        const def = getRelationFieldDef(ends.fromKind, snapshot.relation.type, f.key);
        const text = oneLine(f.value);
        if (text !== '') body.push({ key: f.key, label: def?.label ?? f.key, text });
    }
    return { header, body };
}

/** The whole entry as one text: header then body, a section a line. The span every bible fact's quote is located in. */
export function entryText(entry: RenderedEntry): string {
    return [...entry.header, ...entry.body].map(line).join('\n');
}

/**
 * The body sections that changed since the baseline (a section whose key is new, or whose text differs), in
 * the entry's order. No baseline: every section. A section the baseline had and this version dropped states
 * nothing new and is not sent (what it stated is checked against the whole new entry: NO_LONGER_STATED).
 */
export function changedSections(current: RenderedEntry, baseline: RenderedEntry | null): EntrySection[] {
    if (!baseline) return [...current.body];
    const before = new Map(baseline.body.map((s) => [s.key, s.text] as const));
    return current.body.filter((s) => before.get(s.key) !== s.text);
}

/** What the model is shown: the header and the changed sections. Code validates every quote against exactly this. */
export function sentText(current: RenderedEntry, changed: readonly EntrySection[]): string {
    return [...current.header, ...changed].map(line).join('\n');
}
