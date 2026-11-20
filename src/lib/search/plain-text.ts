/**
 * Every searchable source as PLAIN TEXT (Phase 3.4, decision D21), before a
 * word is cut from it. Search tokenises, ranks and highlights plain text
 * only, and the snippets it answers with are plain text too: no HTML ever
 * leaves the search.
 *
 * A rich-text field is stored as the editor's HTML (sanitised on write,
 * `sanitizeRichTextHtml`). `htmlToPlainText` reads it with htmlparser2 — a
 * real parser, never a tag-stripping pattern: entities are decoded once by
 * the parser, tags are dropped, the contents of script-like elements are
 * dropped (they never survive the write sanitiser, but the reader does not
 * rely on it), and every block element breaks the line, so words in
 * neighbouring blocks never fuse ("end</p><p>Start" is two words).
 *
 * Every other source is stored as plain text already (`sanitizePlainText`
 * decoded its entities and removed every tag on write), so it is NOT parsed
 * as HTML again — a literal "a < b" in a summary stays as written. A list is
 * its items, one per line; a choice is its option's label (the template's
 * words, which is what the author picked and sees); a scale (a number from 1
 * to 5) is not searchable text and yields nothing.
 *
 * `tidyPlainText` gives every source one shape: line endings `\n`, each
 * line's runs of horizontal space one space and trimmed, no empty lines.
 */
import { Parser } from 'htmlparser2';
import type { FieldDef } from '@/lib/bible/templates';
import type { FieldValue } from '@/lib/bible/field-values';

/** Elements that end a line of text (block-level, list items, table cells, line breaks). */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
    'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** Elements whose contents are not text. */
const NON_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'iframe', 'object', 'embed', 'svg', 'math']);

/** Horizontal whitespace (no line breaks): one quantified class, nothing nested. */
const HORIZONTAL_SPACE = /[^\S\n]+/g;

/** One shape for every source: `\n` line endings, single spaces, trimmed lines, no empty ones. */
export function tidyPlainText(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(HORIZONTAL_SPACE, ' ').trim())
        .filter((line) => line !== '')
        .join('\n');
}

/**
 * Reads rich-text HTML as plain text, reusing one parser for every value it
 * reads (a search reads thousands). One per request: it keeps nothing
 * between values.
 */
export class HtmlTextReader {
    private parts: string[] = [];
    private skipping = 0;
    private readonly parser = new Parser(
        {
            onopentag: (name) => {
                if (NON_TEXT_ELEMENTS.has(name)) this.skipping++;
                else if (BLOCK_ELEMENTS.has(name)) this.parts.push('\n');
            },
            onclosetag: (name) => {
                if (NON_TEXT_ELEMENTS.has(name)) this.skipping = Math.max(0, this.skipping - 1);
                else if (BLOCK_ELEMENTS.has(name)) this.parts.push('\n');
            },
            ontext: (text) => {
                if (this.skipping === 0) this.parts.push(text);
            },
        },
        { decodeEntities: true, lowerCaseTags: true },
    );

    read(html: string): string {
        // No tag and no entity: there is nothing to parse.
        if (!html.includes('<') && !html.includes('&')) return tidyPlainText(html);
        this.parts = [];
        this.skipping = 0;
        this.parser.parseComplete(html);
        const text = tidyPlainText(this.parts.join(''));
        this.parts = [];
        return text;
    }
}

/** A rich-text field's HTML as plain text. */
export function htmlToPlainText(html: string): string {
    return new HtmlTextReader().read(html);
}

/** A stored field value as plain text (empty when it holds no searchable text). */
export function fieldValuePlainText(
    def: Pick<FieldDef, 'type'> & { options?: ReadonlyArray<{ value: string; label: string }> },
    value: FieldValue,
    html: HtmlTextReader = new HtmlTextReader(),
): string {
    switch (def.type) {
        case 'richtext':
            return typeof value === 'string' ? html.read(value) : '';
        case 'list':
            return Array.isArray(value) ? tidyPlainText(value.join('\n')) : '';
        case 'choice':
            return typeof value === 'string' ? tidyPlainText(def.options?.find((o) => o.value === value)?.label ?? value) : '';
        case 'scale':
            return '';
        default:
            return typeof value === 'string' ? tidyPlainText(value) : '';
    }
}
