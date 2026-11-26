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
import { htmlToPlainText } from '@/lib/search/plain-text';
import type { BibleKind } from '@/lib/bible/kinds';
import type { BibleSnapshot } from '@/lib/bible/snapshot';
import type { RelationSnapshot } from '@/lib/bible/relation-snapshot';
import { getFieldDef, getRelationFieldDef, getRelationType } from '@/lib/bible/templates';

export interface EntrySection {
    /** `name`, `kind`, `relation` (the header) or `summary`, `custom_label`, `note`, a field key. */
    readonly key: string;
    readonly label: string;
    readonly text: string;
    /**
     * Offsets into `text` where one block of the value ends and the next begins (a paragraph of rich text, a
     * list item): where a section too long for one call may be cut (`pieceSections`). Absent: no block boundary.
     */
    readonly breaks?: readonly number[];
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
    return joined(plainBlock(text).split('\n').map((l) => l.trim()).filter((l) => l !== ''), ' ').text;
}

/** Blocks joined into one line, with the offset where each block after the first begins. */
function joined(blocks: readonly string[], separator: string): { text: string; breaks: number[] } {
    const breaks: number[] = [];
    let text = '';
    for (const b of blocks) {
        if (text !== '') {
            text += separator;
            breaks.push(text.length);
        }
        text += b;
    }
    return { text, breaks };
}

/** A plain-text value's lines as one line and its line boundaries. */
function blocksOf(text: string): { text: string; breaks: number[] } {
    return joined(plainBlock(text).split('\n').map((l) => l.trim()).filter((l) => l !== ''), ' ');
}

/**
 * A rich-text value's blocks as one line and its block boundaries, read by 3.4's HTML reader (a parser: every
 * block element ends a block). Never through the plain-text sanitiser, which drops the tags and so fuses the last
 * word of one paragraph to the first of the next ("end</p><p>Start" read as "endStart").
 */
function richBlocksOf(html: string): { text: string; breaks: number[] } {
    return joined(htmlToPlainText(html).split('\n').map((l) => l.trim()).filter((l) => l !== ''), ' ');
}

/** An element version's sections. */
export function renderElementEntry(snapshot: BibleSnapshot): RenderedEntry {
    const kind = snapshot.element.kind as BibleKind;
    const header: EntrySection[] = [
        { key: 'name', label: 'Name', text: oneLine(snapshot.element.name) },
        { key: 'kind', label: 'Kind', text: snapshot.element.customLabel ? `${kindWords(kind)} (${oneLine(snapshot.element.customLabel)})` : kindWords(kind) },
    ];
    const body: EntrySection[] = [];
    if (snapshot.element.summary) {
        const v = blocksOf(snapshot.element.summary);
        if (v.text !== '') body.push({ key: 'summary', label: 'Summary', ...v });
    }
    for (const f of snapshot.fields) {
        const def = getFieldDef(kind, f.key);
        if (!def || def.type === 'scale') continue;
        let v: { text: string; breaks: number[] };
        if (Array.isArray(f.value)) v = joined(f.value.map(oneLine).filter((x) => x !== ''), '; ');
        else if (typeof f.value === 'number') continue;
        else if (def.type === 'choice') v = { text: def.options?.find((o) => o.value === f.value)?.label ?? oneLine(f.value), breaks: [] };
        else v = def.type === 'richtext' ? richBlocksOf(f.value) : blocksOf(f.value);
        if (v.text !== '') body.push({ key: f.key, label: def.label, ...v });
    }
    return { header, body };
}

/** A relation version's sections, its ends named as the book names them now. */
export function renderRelationEntry(snapshot: RelationSnapshot, ends: { fromKind: BibleKind; fromName: string; toName: string }): RenderedEntry {
    const type = getRelationType(ends.fromKind, snapshot.relation.type);
    const label = type?.label ?? snapshot.relation.type.replace(/_/g, ' ');
    const header: EntrySection[] = [{ key: 'relation', label: 'Relation', text: `${oneLine(ends.fromName)} — ${label} — ${oneLine(ends.toName)}` }];
    const body: EntrySection[] = [];
    if (snapshot.relation.note) {
        const v = blocksOf(snapshot.relation.note);
        if (v.text !== '') body.push({ key: 'note', label: 'Note', ...v });
    }
    for (const f of snapshot.fields) {
        const def = getRelationFieldDef(ends.fromKind, snapshot.relation.type, f.key);
        const v = def?.type === 'richtext' ? richBlocksOf(f.value) : blocksOf(f.value);
        if (v.text !== '') body.push({ key: f.key, label: def?.label ?? f.key, ...v });
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

/**
 * ONE CALL'S INPUT IS BOUNDED (owner decision, 2026-11-21; D27 addendum). The changed sections are sent in
 * BATCHES of at most `maxChars` characters of section text each (`BIBLE_FACT_PIECE_MAX_CHARS`): short sections are
 * packed together in the entry's order, and a section longer than the bound is cut into pieces — at a block
 * boundary (a paragraph, a list item) where one falls inside the bound, else after a sentence, else at a space,
 * else (one unbroken run) at the bound itself, never inside a surrogate pair. Every piece is a contiguous run of
 * its section's text under the section's own label, so a quote found in the piece is found in the whole entry and
 * its span is an offset into it, as before; a quote that would straddle a cut is in neither piece and is refused.
 */
export function pieceSections(changed: readonly EntrySection[], maxChars: number): EntrySection[][] {
    const out: EntrySection[][] = [];
    let batch: EntrySection[] = [];
    let size = 0;
    const flush = () => {
        if (batch.length > 0) out.push(batch);
        batch = [];
        size = 0;
    };
    for (const s of changed) {
        if (s.text.length > maxChars) {
            flush();
            for (const piece of cutText(s.text, s.breaks ?? [], maxChars)) out.push([{ key: s.key, label: s.label, text: piece.text, breaks: piece.breaks }]);
            continue;
        }
        if (size + s.text.length > maxChars) flush();
        batch.push(s);
        size += s.text.length;
    }
    flush();
    return out;
}

/** The total characters of section text a batch sends. */
export function batchChars(batch: readonly EntrySection[]): number {
    return batch.reduce((n, s) => n + s.text.length, 0);
}

function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}

/** A text cut into runs of at most `max` characters (the order of preference above), each trimmed, none empty. */
export function cutText(text: string, breaks: readonly number[], max: number): Array<{ text: string; breaks: number[] }> {
    const out: Array<{ text: string; breaks: number[] }> = [];
    let start = 0;
    while (start < text.length) {
        while (start < text.length && text[start] === ' ') start++;
        if (start >= text.length) break;
        let end: number;
        if (text.length - start <= max) end = text.length;
        else {
            const limit = start + max;
            const block = [...breaks].reverse().find((b) => b > start && b <= limit);
            if (block !== undefined) end = block;
            else {
                const window = text.slice(start, limit);
                let sentence = -1;
                for (let i = window.length - 1; i > 0; i--) {
                    if (window[i] === ' ' && /[.!?]/.test(window[i - 1])) {
                        sentence = i;
                        break;
                    }
                }
                const space = window.lastIndexOf(' ');
                end = sentence > 0 ? start + sentence : space > 0 ? start + space : limit;
                if (end === limit && isHighSurrogate(text.charCodeAt(end - 1))) end--;
            }
        }
        const raw = text.slice(start, end);
        const trimmed = raw.trimEnd();
        if (trimmed !== '') out.push({ text: trimmed, breaks: breaks.filter((b) => b > start && b < start + trimmed.length).map((b) => b - start) });
        start = end;
    }
    return out;
}
