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
 * The fix DECODES FIRST, then strips, looping until the value stabilises so
 * that (a) `&lt;script&gt;` and even multi-level `&amp;lt;script&amp;gt;`
 * materialise into real tags and get removed, exactly like a raw
 * `<script>`, and (b) the final value, once decoded, can no longer form any
 * strippable tag (at the fixed point `sanitizeHtml(decode(x)) === x`, so
 * `decode(x)` is tag-free). Innocuous entities (`&amp;`, `&quot;`, `&#39;`)
 * still resolve to their readable characters.
 */
export function sanitizePlainText(input: string | null | undefined): string {
    if (input == null) return '';
    if (typeof input !== 'string') return '';

    const strip = (s: string) =>
        sanitizeHtml(decodeHtmlEntities(s), { allowedTags: [], allowedAttributes: {} });

    let current = input;
    let next = strip(current);
    // Peel one encoding layer per pass until stable. The bound is a backstop
    // against a pathological input; a handful of layers resolves any real one.
    for (let i = 0; next !== current && i < 8; i++) {
        current = next;
        next = strip(current);
    }
    if (next !== current) {
        // Did not converge — return the sanitiser's (entity-encoded, tag-free)
        // form, which is always safe, over a possibly-unsafe decode.
        return next;
    }
    // Fixed point: `current` is tag-free even after decoding, so the decoded
    // form is both safe AND the readable literal text.
    return decodeHtmlEntities(current);
}
