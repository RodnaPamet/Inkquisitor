/**
 * Server-side HTML sanitisation of author text, at the usecase layer.
 *
 * Every write path that persists author text routes it through one of these
 * helpers BEFORE the value is stored (Phase 1.1, ahead of roadmap 1.H's ask).
 * Render-time escaping in React helps, but is not enough: the bible is also
 * exported (Phase 1.3), sent to the model as fenced data (Phase 2) and read
 * back by whatever comes later, and each of those reads the stored value
 * verbatim. Sanitising on write means every reader inherits the same safety.
 * `tests/guards/encrypted-field-sanitiser-coverage.test.ts` fails for an
 * encrypted author-text field whose write path does not call one.
 *
 * Two profiles. Pick by what the field renders as:
 *
 *   - `sanitizeRichTextHtml(input)` — a rich-text field the editor stores as
 *     HTML (a template field of type `richtext`). A small allowlist of
 *     formatting tags and safe links.
 *
 *   - `sanitizePlainText(input)` — everything that has no formatting: titles,
 *     names, labels, summaries, notes, one-line and list fields. Strips ALL
 *     tags and decodes entities first, so a stored `&lt;script&gt;` cannot
 *     round-trip back into a `<script>` somewhere downstream.
 *
 * Library: `sanitize-html`, which runs on Node without a DOM polyfill and
 * takes a declarative allowlist.
 *
 * Lifted from inflect-compliance's `src/lib/security/sanitize.ts` (see
 * docs/carve-manifest.md): both profiles verbatim; the URL helper and the
 * policy-content dispatcher (compliance domain) are not carried, and the
 * heading `id` allowance (inflect's policy table of contents) is dropped.
 */

import sanitizeHtml from 'sanitize-html';

// ─── Rich-text profile ──────────────────────────────────────────────

/**
 * Tags allowed in the rich-text profile. Headings, paragraphs, lists,
 * inline emphasis, links, code blocks, blockquotes, tables. No
 * `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<form>`,
 * `<input>`, no SVG, no MathML. The `sanitize-html` defaults already
 * exclude these, but we re-state the allowed set explicitly so a
 * library default change can't quietly widen it.
 */
const RICH_TEXT_ALLOWED_TAGS: string[] = [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'u', 's', 'sub', 'sup', 'mark',
    'ul', 'ol', 'li',
    'blockquote',
    'code', 'pre',
    'a',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'div', 'span',
];

/**
 * Per-tag attribute allowlist. Anything not listed here is stripped.
 * Notably, NO `style`, `class`, `id`, or any `on*` handlers anywhere.
 */
const RICH_TEXT_ALLOWED_ATTRS: Record<string, string[]> = {
    a: ['href', 'title', 'rel', 'target'],
    th: ['scope', 'colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    code: ['data-language'],
    pre: ['data-language'],
};

/**
 * URL schemes accepted on `href` and friends. Note the deliberate
 * absence of `javascript:`, `data:` (except `data:image/...` which we
 * also exclude — embed images via the upload API instead), and
 * `vbscript:`. Relative URLs are accepted via
 * `allowProtocolRelative: false` + the schemes below being the only
 * legal protocol prefixes.
 */
const RICH_TEXT_ALLOWED_SCHEMES: string[] = ['http', 'https', 'mailto', 'tel'];

/**
 * Sanitise an HTML rich-text payload before persisting it.
 *
 * Behaviour:
 *   - Allowed tags: headings, paragraphs, lists, basic inline marks,
 *     links (`http`, `https`, `mailto`, `tel`), code blocks, tables.
 *   - All other tags are stripped (their text content is preserved).
 *   - All attributes outside the per-tag allowlist are stripped — no
 *     `style`, `class`, `id`, `on*`.
 *   - All `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>` are
 *     dropped along with their text content (XSS sinks).
 *   - Links get `rel="noopener noreferrer"` and `target` gets coerced
 *     to `_blank` only when explicitly set — a bare link stays
 *     same-tab.
 *   - Returns `''` for `null` / `undefined` so callers can pipe an
 *     optional field through unconditionally.
 */
export function sanitizeRichTextHtml(input: string | null | undefined): string {
    if (input == null) return '';
    if (typeof input !== 'string') return '';
    return sanitizeHtml(input, {
        allowedTags: RICH_TEXT_ALLOWED_TAGS,
        allowedAttributes: RICH_TEXT_ALLOWED_ATTRS,
        allowedSchemes: RICH_TEXT_ALLOWED_SCHEMES,
        allowedSchemesAppliedToAttributes: ['href'],
        allowProtocolRelative: false,
        // Drop disallowed tags AND their text content for known XSS
        // sinks; for everything else, keep the inner text. This
        // matches user intent ("they tried to insert <script> with
        // text — strip the script AND don't ship the script body as
        // plain text") while preserving e.g. `<custom-tag>hi</custom-tag>`
        // → `hi`.
        nonTextTags: ['script', 'style', 'textarea', 'noscript', 'iframe', 'object', 'embed'],
        // Coerce `<a target="...">`: keep target only when it's a
        // recognised value, and always pair with a safe rel.
        transformTags: {
            a: (tagName, attribs) => {
                const next: Record<string, string> = { ...attribs };
                // Force-safe relationship attrs.
                next.rel = 'noopener noreferrer';
                if (next.target && next.target !== '_blank' && next.target !== '_self') {
                    delete next.target;
                }
                return { tagName, attribs: next };
            },
        },
    });
}

// ─── Plain-text profile ─────────────────────────────────────────────

/**
 * Decode the HTML entities an attacker could use to smuggle a `<` or `>`
 * past a tag-stripper: named (`&lt;`), decimal-numeric (`&#60;`) and
 * hex-numeric (`&#x3c;`). `&amp;` is decoded LAST so a single pass turns
 * `&amp;lt;` into `&lt;` (not `<`) — the caller loops, peeling one layer per
 * pass, so multi-level encodings still fully resolve. Invalid code points are
 * left verbatim rather than throwing.
 */
function decodeHtmlEntities(s: string): string {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => codePointOrRaw(parseInt(hex, 16), m))
        .replace(/&#(\d+);/g, (m, dec: string) => codePointOrRaw(parseInt(dec, 10), m))
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;|&#39;|&#x27;/gi, "'")
        .replace(/&#47;|&#x2f;/gi, '/')
        .replace(/&amp;/gi, '&');
}

function codePointOrRaw(cp: number, raw: string): string {
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        return raw;
    }
    return String.fromCodePoint(cp);
}

/**
 * A `<` that can never close is text, not markup (issue #45, item 4).
 *
 * An HTML tokenizer reads `<` before a letter, `/`, `!` or `?` as the start
 * of a tag, comment or declaration, and one that reaches the end of the input
 * unclosed is DROPPED — with everything after it. So plain text such as
 * `if a<b then c` used to be stored as `if a`: the sanitiser threw away the
 * author's words, not markup. Here every `<` that cannot be closed is handed
 * to the parser as `&lt;`, so it stays text:
 *
 *   - a tag, a closing tag, a bogus comment or a processing instruction
 *     closes at a `>`, so a `<` with no `>` anywhere after it cannot close;
 *   - a comment (`<!--`) closes only at `-->`, so one with no `-->` after it
 *     cannot close (a lone `>` does not end it).
 *
 * Nothing that DOES close is touched: `<b>`, `</p>`, `<!-- x -->` and
 * `<img onerror=…>` are still markup and still stripped, so the guarantee
 * stands that what is returned forms no element under an HTML parser (a `<`
 * left as text has no `>` after it, and a tokenizer drops an unclosed tag at
 * the end of input rather than making an element of it). One linear pass: the
 * last `>` and the last `-->` are found once.
 *
 * What is still read as markup is what a browser would read as markup:
 * `a<b and b>c` holds a complete `<b and b>`, and is `ac`. Writing `a < b`
 * (a space after `<`) keeps it text, as in HTML.
 */
function escapeUnclosedMarkup(s: string): string {
    if (!s.includes('<')) return s;
    const lastClose = s.lastIndexOf('>');
    const lastCommentClose = s.lastIndexOf('-->');
    let out = '';
    let from = 0;
    for (let i = s.indexOf('<'); i !== -1; i = s.indexOf('<', i + 1)) {
        // `<!-->` and `<!--->` close themselves, so a `-->` from i + 2 on counts.
        const closes = s.startsWith('<!--', i) ? lastCommentClose >= i + 2 : i < lastClose;
        if (closes) continue;
        out += `${s.slice(from, i)}&lt;`;
        from = i + 1;
    }
    return out + s.slice(from);
}

/**
 * Strip all HTML from a field that has NO formatting (title, label,
 * single-line description, comment body).
 *
 * SECURITY — entity order matters. The naive "strip tags, THEN decode
 * entities" is a stored-XSS double-unescape: `sanitize-html` leaves an
 * entity-encoded `&lt;script&gt;` untouched (it isn't a tag), and decoding
 * afterwards reconstitutes a live `<script>` — the exact element the
 * sanitiser exists to remove. So an attacker only has to pre-encode their
 * payload to defeat it.
 *
 * The fix strips, then decodes, and LOOPS until the text stabilises: each
 * pass parses the value as HTML (removing what is markup), takes its text and
 * decodes one layer of entities, and the next pass parses THAT. So
 * `&lt;script&gt;` and even multi-level `&amp;lt;script&amp;gt;` materialise
 * into real tags on a later pass and are removed exactly like a raw
 * `<script>`, and the fixed point is text that a parse leaves unchanged: it
 * forms no markup. Innocuous entities (`&amp;`, `&quot;`, `&#39;`) still
 * resolve to their readable characters.
 *
 * The FIRST pass parses before it decodes (Phase 3.H). Decoding first turned
 * the text of a value that also holds real markup into markup of its own: a
 * rich-text `<p>if a&lt;b then c</p><p>…` decoded to `<p>if a<b then c<p>…`,
 * where `<b then c<p>` is one tag and the words went with it. Parsing first,
 * real markup goes and `&lt;b` becomes the text `<b`, which a later pass keeps
 * (`escapeUnclosedMarkup`: nothing after it closes it).
 *
 * The cost of decoding to a fixed point, kept on purpose: an entity written
 * as text (`&amp;lt;`, meant literally) is read as what it encodes (`<`). A
 * single decode would leave the stored value changing under a second
 * sanitise, so an exported value would not import back as itself, and would
 * let a pre-encoded tag through one layer down.
 */
export function sanitizePlainText(input: string | null | undefined): string {
    if (input == null) return '';
    if (typeof input !== 'string') return '';

    /**
     * One pass: what is markup goes, and the text is decoded one layer by OUR
     * decoder (the parser decodes nothing: `decodeEntities: false`), so an
     * encoded control character (`&#0;`) is the character, which the callers'
     * `stripControlChars` removes, not the parser's replacement character.
     */
    const strip = (s: string) => sanitizeHtml(escapeUnclosedMarkup(s), { allowedTags: [], allowedAttributes: {}, parser: { decodeEntities: false } });
    const pass = (s: string) => decodeHtmlEntities(strip(s));

    let current = pass(input);
    let next = pass(current);
    // Peel one encoding layer per pass until stable. The bound is a backstop
    // against a pathological input; a handful of layers resolves any real one.
    for (let i = 0; next !== current && i < 8; i++) {
        current = next;
        next = pass(current);
    }
    if (next !== current) {
        // Did not converge — return the sanitiser's (entity-encoded, tag-free)
        // form, which is always safe, over a possibly-unsafe decode.
        return strip(current);
    }
    // Fixed point: a parse of `current` leaves it as it is, so it forms no
    // markup, and it is the readable literal text.
    return current;
}

