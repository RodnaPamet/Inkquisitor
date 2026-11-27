/**
 * A stored scene's text as BLOCKS of styled RUNS (Phase 5.H-a, D36: the manuscript in the full export, as DOCX and
 * Markdown). Server-only (htmlparser2).
 *
 * The stored text is the prose profile's HTML (`sanitizeSceneHtml`: p, br, hr, strong, em, u, s, blockquote, ul, ol,
 * li, and a mention span). It is read with a real parser — never a pattern — and becomes paragraphs, quoted
 * paragraphs, list items and rules, each a list of runs that carry their bold / italic / underline / strike-through
 * marks. A mention is its text (`@Name`, the element's name as the editor wrote it). Entities are decoded once by
 * the parser; a `br` is a line break inside its block. Nothing here writes a scene: the export only reads.
 */
import { Parser } from 'htmlparser2';

export interface SceneRun {
    text: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
}

export type SceneBlockKind = 'paragraph' | 'quote' | 'bullet' | 'number' | 'rule';

export interface SceneBlock {
    kind: SceneBlockKind;
    runs: SceneRun[];
}

const MARKS = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', u: 'underline', s: 'strike', del: 'strike', strike: 'strike' } as const;
type Mark = (typeof MARKS)[keyof typeof MARKS];
const NON_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'iframe', 'object', 'embed', 'svg', 'math']);

/** The stored HTML of one scene as blocks (an empty text is no block). */
export function sceneBlocks(html: string): SceneBlock[] {
    const blocks: SceneBlock[] = [];
    const depth: Record<Mark, number> = { bold: 0, italic: 0, underline: 0, strike: 0 };
    const lists: Array<'ul' | 'ol'> = [];
    let quote = 0;
    let skipping = 0;
    let current: SceneBlock | null = null;

    const kindHere = (): SceneBlockKind => (lists.length > 0 ? (lists[lists.length - 1] === 'ol' ? 'number' : 'bullet') : quote > 0 ? 'quote' : 'paragraph');
    const open = (): SceneBlock => {
        current ??= { kind: kindHere(), runs: [] };
        return current;
    };
    const flush = () => {
        if (current && current.runs.some((r) => r.text.trim() !== '')) {
            // A block's edges carry no stray line breaks or spaces.
            const runs = current.runs;
            runs[0] = { ...runs[0], text: runs[0].text.trimStart() };
            const last = runs.length - 1;
            runs[last] = { ...runs[last], text: runs[last].text.trimEnd() };
            blocks.push({ kind: current.kind, runs: runs.filter((r) => r.text !== '') });
        }
        current = null;
    };
    const push = (text: string) => {
        if (text === '') return;
        const block = open();
        const style = { bold: depth.bold > 0, italic: depth.italic > 0, underline: depth.underline > 0, strike: depth.strike > 0 };
        const prev = block.runs[block.runs.length - 1];
        if (prev && prev.bold === style.bold && prev.italic === style.italic && prev.underline === style.underline && prev.strike === style.strike) {
            prev.text += text;
        } else {
            block.runs.push({ text, ...style });
        }
    };

    const parser = new Parser(
        {
            onopentag(name) {
                if (NON_TEXT_ELEMENTS.has(name)) {
                    skipping++;
                    return;
                }
                if (skipping > 0) return;
                if (name in MARKS) depth[MARKS[name as keyof typeof MARKS]]++;
                else if (name === 'p') {
                    if (lists.length === 0) flush();
                    open();
                } else if (name === 'li') {
                    flush();
                    open();
                } else if (name === 'ul' || name === 'ol') {
                    flush();
                    lists.push(name);
                } else if (name === 'blockquote') {
                    flush();
                    quote++;
                } else if (name === 'br') push('\n');
                else if (name === 'hr') {
                    flush();
                    blocks.push({ kind: 'rule', runs: [] });
                }
            },
            ontext(text) {
                if (skipping > 0) return;
                push(text.replace(/[\r\n\t]+/g, ' '));
            },
            onclosetag(name) {
                if (NON_TEXT_ELEMENTS.has(name)) {
                    skipping = Math.max(0, skipping - 1);
                    return;
                }
                if (skipping > 0) return;
                if (name in MARKS) {
                    const mark = MARKS[name as keyof typeof MARKS];
                    depth[mark] = Math.max(0, depth[mark] - 1);
                } else if (name === 'p') {
                    if (lists.length === 0) flush();
                } else if (name === 'li') flush();
                else if (name === 'ul' || name === 'ol') {
                    flush();
                    lists.pop();
                } else if (name === 'blockquote') {
                    flush();
                    quote = Math.max(0, quote - 1);
                }
            },
        },
        { decodeEntities: true, lowerCaseTags: true },
    );
    parser.parseComplete(html);
    flush();
    return blocks;
}
