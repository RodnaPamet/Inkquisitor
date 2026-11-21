/**
 * Cutting a source into CHUNKS of about 1–2k tokens along its chapters and
 * scenes (Phase 4.0). Pure.
 *
 *   • A chunk is cut at a heading of level 1–3 (a chapter, a part, a scene
 *     title) or a break once it holds `CHUNK_MIN_TOKENS`, and always before it
 *     would pass `CHUNK_MAX_TOKENS`: a paragraph that does not fit starts the
 *     next chunk.
 *   • A "heading" longer than `HEADING_MAX_CHARS` (a whole document in one
 *     `<h1>`, a Markdown line of a chapter after `# `) is not a heading: it is
 *     read as a paragraph, so it is split like one and never rides in every
 *     later chunk's heading path. No chunk passes `maxChars`.
 *   • A paragraph longer than a whole chunk is split at the last sentence end
 *     before the bound, else the last space, else (one unbroken run) at the
 *     bound itself, never inside a surrogate pair.
 *   • Each chunk carries the heading path above its first block (`Part One ›
 *     Chapter 3`), and its start and end in the document's text as the
 *     chunker lays it out (`blocksText`: blocks joined by blank lines), so a
 *     chunk is always that text's slice from start to end.
 *
 * Tokens are estimated from characters (`CHARS_PER_TOKEN`); the estimate is
 * the cost estimate's input, never a provider's count.
 */
import type { DocBlock } from './document';
import { CHARS_PER_TOKEN, CHUNK_MAX_TOKENS, CHUNK_MIN_TOKENS } from './vocabulary';

export interface ChunkDraft {
    readonly position: number;
    readonly text: string;
    readonly headingPath: readonly string[];
    readonly startOffset: number;
    readonly endOffset: number;
    readonly tokenEstimate: number;
}

export interface ChunkBounds {
    minChars: number;
    maxChars: number;
}

export const DEFAULT_CHUNK_BOUNDS: ChunkBounds = { minChars: CHUNK_MIN_TOKENS * CHARS_PER_TOKEN, maxChars: CHUNK_MAX_TOKENS * CHARS_PER_TOKEN };

const SEPARATOR = '\n\n';

/** A heading is a title: longer than this, it is read as the paragraph it is. */
export const HEADING_MAX_CHARS = 300;

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Where to cut `text` at or before `max` characters: a sentence end, else a space, else `max` (never inside a surrogate pair). */
export function cutPoint(text: string, max: number): number {
    if (text.length <= max) return text.length;
    const window = text.slice(0, max);
    let sentence = -1;
    for (let i = window.length - 1; i > max / 2; i--) {
        const ch = window[i];
        if ((ch === '.' || ch === '!' || ch === '?' || ch === '…') && (i + 1 >= window.length || window[i + 1] === ' ')) {
            sentence = i + 1;
            break;
        }
    }
    if (sentence > 0) return sentence;
    const space = window.lastIndexOf(' ');
    if (space > max / 2) return space;
    const code = text.charCodeAt(max - 1);
    return code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
}

export function chunkBlocks(blocks: readonly DocBlock[], bounds: ChunkBounds = DEFAULT_CHUNK_BOUNDS): ChunkDraft[] {
    const chunks: ChunkDraft[] = [];
    /** The heading text at each level 1–6 above the current block. */
    const levels: Array<string | undefined> = [];
    let parts: string[] = [];
    let partsChars = 0;
    let chunkStart = 0;
    let chunkPath: string[] = [];
    /** The offset in the document text where the next block's text starts. */
    let offset = 0;
    let first = true;
    /** The open chunk holds headings and nothing else yet. */
    let headingsOnly = true;

    const flush = () => {
        if (parts.length === 0) return;
        const text = parts.join(SEPARATOR);
        chunks.push({ position: chunks.length, text, headingPath: chunkPath, startOffset: chunkStart, endOffset: chunkStart + text.length, tokenEstimate: estimateTokens(text) });
        parts = [];
        partsChars = 0;
        headingsOnly = true;
    };
    const add = (text: string) => {
        const at = first ? 0 : offset + SEPARATOR.length;
        if (parts.length === 0) {
            chunkStart = at;
            chunkPath = levels.filter((l): l is string => l !== undefined);
        } else if (at !== chunkStart + partsChars + SEPARATOR.length) {
            // A block always follows the previous one directly; the invariant keeps the chunk the document's slice.
            throw new Error('chunk offsets out of step');
        }
        parts.push(text);
        partsChars += (parts.length > 1 ? SEPARATOR.length : 0) + text.length;
        offset = at + text.length;
        first = false;
    };

    for (const original of blocks) {
        const block: DocBlock = original.kind === 'heading' && original.text.length > HEADING_MAX_CHARS ? { kind: 'para', text: original.text } : original;
        if (block.kind === 'break') {
            if (partsChars >= bounds.minChars) flush();
            continue;
        }
        if (block.kind === 'heading') {
            if (block.level <= 3 && partsChars >= bounds.minChars) flush();
            const level = Math.min(6, Math.max(1, block.level));
            levels.length = level - 1;
            levels[level - 1] = block.text;
            if (partsChars + SEPARATOR.length + block.text.length > bounds.maxChars) flush();
            add(block.text);
            // A chunk that so far holds only headings is under the deepest of them.
            if (headingsOnly) chunkPath = levels.filter((l): l is string => l !== undefined);
            continue;
        }
        let rest = block.text;
        if (partsChars > 0 && partsChars + SEPARATOR.length + rest.length > bounds.maxChars) flush();
        while (rest.length > bounds.maxChars) {
            const at = cutPoint(rest, bounds.maxChars);
            const head = rest.slice(0, at).trimEnd();
            // A split paragraph's pieces are separate blocks in the document text: the next piece follows after the separator.
            add(head);
            flush();
            rest = rest.slice(at).trimStart();
        }
        if (rest !== '') {
            add(rest);
            headingsOnly = false;
        }
    }
    flush();
    return chunks;
}

/**
 * The document text the chunks are slices of, rebuilt from them (a split
 * paragraph's pieces joined by the separator). Pure; tests hold every chunk
 * to `documentText.slice(start, end) === text`.
 */
export function documentTextOf(chunks: readonly ChunkDraft[]): string {
    return chunks.map((c) => c.text).join(SEPARATOR);
}
