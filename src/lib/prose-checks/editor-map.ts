/**
 * From the server's plain-text offsets to the editor's positions (Phase 5.2,
 * D34). CLIENT-SAFE and pure: no ProseMirror import, only the shape of a
 * document it walks.
 *
 * The worker found each note at offsets into the scene's plain text as 3.4's
 * `HtmlTextReader` reads the stored HTML: one line a text block (a paragraph,
 * a list item's paragraph, a quoted paragraph), a hard break a line break, a
 * mention its `@Name`, every run of space one space, each line trimmed, empty
 * lines dropped. `buildEditorTextMap` rebuilds THE SAME TEXT from the editor's
 * document, remembering the document position of every character, so a note's
 * offsets become a document range — and the note is placed only when the
 * editor's own text at that range is the text the server says it covered
 * (`matched`), so a document that drifted from the checked text places
 * nothing wrong: it places nothing.
 */

/** The parts of a ProseMirror node this module reads. */
export interface DocNodeLike {
    readonly isTextblock: boolean;
    readonly isText: boolean;
    readonly isLeaf: boolean;
    readonly text?: string | null;
    readonly nodeSize: number;
    readonly type: { readonly name: string };
    readonly attrs: Readonly<Record<string, unknown>>;
    descendants(f: (node: DocNodeLike, pos: number) => boolean | void): void;
    forEach(f: (node: DocNodeLike, offset: number) => void): void;
}

export interface EditorTextMap {
    text: string;
    /** For each character of `text`, the document position it starts at and the position after it. */
    from: number[];
    to: number[];
}

/** One space per run of horizontal whitespace (the reader's `[^\S\n]+`). */
const HSPACE = /[^\S\n]/;

/** How an inline leaf reads as text: a mention as `@Name`, a hard break as a line break, anything else as nothing. */
export function leafText(node: Pick<DocNodeLike, 'type' | 'attrs'>): string {
    if (node.type.name === 'mention') return `@${typeof node.attrs.label === 'string' ? node.attrs.label : ''}`;
    if (node.type.name === 'hardBreak') return '\n';
    return '';
}

export function buildEditorTextMap(doc: DocNodeLike): EditorTextMap {
    // 1. Raw: every text block's characters with their positions, blocks joined by line breaks.
    const raw: string[] = [];
    const rawFrom: number[] = [];
    const rawTo: number[] = [];
    let any = false;
    doc.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        if (any) {
            raw.push('\n');
            rawFrom.push(pos);
            rawTo.push(pos);
        }
        any = true;
        node.forEach((child, offset) => {
            const at = pos + 1 + offset;
            if (child.isText) {
                const t = child.text ?? '';
                for (let i = 0; i < t.length; i++) {
                    raw.push(t[i]);
                    rawFrom.push(at + i);
                    rawTo.push(at + i + 1);
                }
            } else {
                const t = leafText(child);
                for (let i = 0; i < t.length; i++) {
                    raw.push(t[i]);
                    rawFrom.push(at);
                    rawTo.push(at + child.nodeSize);
                }
            }
        });
        return false;
    });

    // 2. Tidy exactly as the reader does: per line, runs of space one space, trimmed; empty lines dropped.
    const text: string[] = [];
    const from: number[] = [];
    const to: number[] = [];
    let lineStart = 0;
    const flushLine = (endExclusive: number) => {
        let i = lineStart;
        while (i < endExclusive && HSPACE.test(raw[i])) i++;
        let j = endExclusive;
        while (j > i && HSPACE.test(raw[j - 1])) j--;
        if (j > i) {
            if (text.length > 0) {
                text.push('\n');
                from.push(rawFrom[i]);
                to.push(rawFrom[i]);
            }
            let k = i;
            while (k < j) {
                if (HSPACE.test(raw[k])) {
                    const start = k;
                    while (k < j && HSPACE.test(raw[k])) k++;
                    text.push(' ');
                    from.push(rawFrom[start]);
                    to.push(rawTo[k - 1]);
                } else {
                    text.push(raw[k]);
                    from.push(rawFrom[k]);
                    to.push(rawTo[k]);
                    k++;
                }
            }
        }
        lineStart = endExclusive + 1;
    };
    for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') flushLine(i);
    flushLine(raw.length);
    return { text: text.join(''), from, to };
}

export interface PlacedRange {
    from: number;
    to: number;
}

/** The document range of plain-text offsets [start, end), or null when they are out of range or the text there differs from `matched`. */
export function placeRange(map: EditorTextMap, start: number, end: number, matched?: string): PlacedRange | null {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > map.text.length) return null;
    if (matched !== undefined && map.text.slice(start, end) !== matched) return null;
    return { from: map.from[start], to: map.to[end - 1] };
}
