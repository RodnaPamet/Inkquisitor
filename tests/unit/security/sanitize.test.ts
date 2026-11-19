/**
 * Unit tests for `src/lib/security/sanitize.ts`.
 *
 * Two profiles to verify:
 *   - sanitizeRichTextHtml — keeps a small set of formatting tags +
 *     safe links; strips scripts, event handlers, javascript: URIs.
 *   - sanitizePlainText — strips ALL tags AND decodes entities so a
 *     stored `&lt;script&gt;` cannot roundtrip back into a `<script>`
 *     downstream.

 *
 * Lifted from inflect-compliance's tests/unit/security/sanitize.test.ts (see
 * docs/carve-manifest.md), without the cases for the helpers not carried
 * (URL text, policy content) and with headings asserted to carry no `id`.
 *
 * Adding a new dangerous payload? Add a positive case below; the
 * codebase's defence-in-depth posture is "block first, allow only on
 * an explicit allowlist", so a new attack should fail loudly here.
 */

import { sanitizeRichTextHtml, sanitizePlainText } from '@/lib/security/sanitize';

// ─── Rich text — XSS-stripping ─────────────────────────────────────

describe('sanitizeRichTextHtml — strips dangerous content', () => {
    it('drops <script> entirely (tag + body)', () => {
        const out = sanitizeRichTextHtml(
            'Hello<script>alert(1)</script>World',
        );
        expect(out).not.toMatch(/<script/i);
        expect(out).not.toMatch(/alert\(/);
    });

    it('drops <iframe> entirely', () => {
        const out = sanitizeRichTextHtml(
            '<p>safe</p><iframe src="https://evil"></iframe>',
        );
        expect(out).not.toMatch(/<iframe/i);
        expect(out).toContain('<p>safe</p>');
    });

    it('drops <object> and <embed>', () => {
        const out = sanitizeRichTextHtml(
            '<object data="x.swf"></object><embed src="y.swf">',
        );
        expect(out).not.toMatch(/<object/i);
        expect(out).not.toMatch(/<embed/i);
    });

    it('strips inline event handlers (onclick, onmouseover, …)', () => {
        const out = sanitizeRichTextHtml(
            '<p onclick="alert(1)" onmouseover="alert(2)">click me</p>',
        );
        expect(out).not.toMatch(/onclick=/i);
        expect(out).not.toMatch(/onmouseover=/i);
        expect(out).toContain('click me');
    });

    it('strips javascript: URIs from <a href>', () => {

        const out = sanitizeRichTextHtml('<a href="javascript:alert(1)">x</a>');
        expect(out).not.toMatch(/javascript:/i);
        // Tag may stay (the body 'x' is preserved); the dangerous href
        // must be gone either by attribute removal or full tag drop.
    });

    it('strips data: URIs from <a href>', () => {
        const out = sanitizeRichTextHtml(
            '<a href="data:text/html,<script>alert(1)</script>">x</a>',
        );
        expect(out).not.toMatch(/data:/i);
    });

    it('strips style attributes (so `expression(...)` etc cannot land)', () => {
        const out = sanitizeRichTextHtml(
            '<p style="background:url(javascript:alert(1))">x</p>',
        );
        expect(out).not.toMatch(/style=/i);
        expect(out).not.toMatch(/javascript:/i);
    });

    it('strips class and id attributes (no surface to inject CSS via global stylesheet)', () => {
        const out = sanitizeRichTextHtml(
            '<p class="x" id="y">hi</p>',
        );
        expect(out).not.toMatch(/class=/);
        expect(out).not.toMatch(/id=/);
    });

    it('strips id from headings too (no anchor targets are carried)', () => {
        expect(sanitizeRichTextHtml('<h2 id="anchor">Part one</h2>')).toBe('<h2>Part one</h2>');
    });

    it('drops <style> tag and its body', () => {
        const out = sanitizeRichTextHtml(
            '<style>body{display:none}</style><p>hi</p>',
        );
        expect(out).not.toMatch(/<style/i);
        expect(out).not.toMatch(/display:none/);
        expect(out).toContain('<p>hi</p>');
    });

    it('drops form/input/textarea (defence against credential-harvesting injects)', () => {
        const out = sanitizeRichTextHtml(
            '<form action="https://evil"><input name="pw" /></form>',
        );
        expect(out).not.toMatch(/<form/i);
        expect(out).not.toMatch(/<input/i);
    });
});

// ─── Rich text — formatting retention ──────────────────────────────

describe('sanitizeRichTextHtml — keeps legitimate formatting', () => {
    it('keeps headings, paragraphs, lists, inline marks', () => {
        const input =
            '<h2>Title</h2><p>Hello <strong>world</strong> with <em>emphasis</em></p>' +
            '<ul><li>a</li><li>b</li></ul>';
        const out = sanitizeRichTextHtml(input);
        expect(out).toContain('<h2>Title</h2>');
        expect(out).toContain('<strong>world</strong>');
        expect(out).toContain('<em>emphasis</em>');
        expect(out).toContain('<li>a</li>');
    });

    it('keeps tables', () => {
        const out = sanitizeRichTextHtml(
            '<table><thead><tr><th scope="col">k</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>',
        );
        expect(out).toContain('<table>');
        expect(out).toContain('<thead>');
        expect(out).toContain('<th scope="col">k</th>');
        expect(out).toContain('<td>v</td>');
    });

    it('keeps safe links and rewrites rel="noopener noreferrer"', () => {
        const out = sanitizeRichTextHtml(
            '<a href="https://example.com" target="_blank">x</a>',
        );
        expect(out).toContain('href="https://example.com"');
        expect(out).toContain('target="_blank"');
        expect(out).toContain('rel="noopener noreferrer"');
    });

    it('keeps mailto: and tel: links', () => {
        const out = sanitizeRichTextHtml(
            '<a href="mailto:a@b.com">m</a><a href="tel:+1234">t</a>',
        );
        expect(out).toContain('mailto:a@b.com');
        expect(out).toContain('tel:+1234');
    });

    it('drops a non-standard target value but keeps the link', () => {
        const out = sanitizeRichTextHtml(
            '<a href="https://example.com" target="_top">x</a>',
        );
        expect(out).toContain('href="https://example.com"');
        expect(out).not.toMatch(/target=/);
    });
});

// ─── Rich text — null / non-string handling ────────────────────────

describe('sanitizeRichTextHtml — defensive defaults', () => {
    it('returns empty string for null', () => {
        expect(sanitizeRichTextHtml(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
        expect(sanitizeRichTextHtml(undefined)).toBe('');
    });

    it('returns empty string for non-string input', () => {
        // Defensive — the type system says string; the runtime check
        // is so a future TS-loose call site can't bypass sanitisation.
        expect(sanitizeRichTextHtml(42 as unknown as string)).toBe('');
    });
});

// ─── Plain text profile ───────────────────────────────────────────

describe('sanitizePlainText — strips everything', () => {
    it('removes all tags but keeps the text', () => {
        const out = sanitizePlainText('<p>Hello <b>world</b></p>');
        expect(out).toBe('Hello world');
    });

    it('drops <script> body so the text never reaches the renderer', () => {
        const out = sanitizePlainText('safe<script>alert(1)</script>tail');
        expect(out).not.toMatch(/alert/);
        expect(out).toContain('safe');
        expect(out).toContain('tail');
    });

    it('does NOT reconstitute a <script> from an entity-encoded payload (double-unescape XSS)', () => {
        // Regression: the old "strip tags THEN decode" order let a
        // pre-encoded `&lt;script&gt;` survive the stripper and then decode
        // back into a live `<script>`. Encoded and raw payloads must be
        // treated identically — the script is removed, not re-emitted.
        const out = sanitizePlainText('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(out).not.toMatch(/<script/i);
        expect(out).not.toMatch(/alert/);
    });

    it('strips an entity-encoded event-handler tag (no live <img onerror>)', () => {
        const out = sanitizePlainText('&lt;img src=x onerror=alert(document.cookie)&gt;');
        expect(out).not.toMatch(/<img/i);
        expect(out).not.toMatch(/onerror/i);
    });

    it('resists MULTI-level entity encoding (&amp;lt;script&amp;gt;)', () => {
        const out = sanitizePlainText('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;');
        expect(out).not.toMatch(/<script/i);
        expect(out).not.toMatch(/alert/);
    });

    it('resists numeric-entity encoding (&#60;script&#62; / &#x3c;)', () => {
        expect(sanitizePlainText('&#60;script&#62;alert(1)&#60;/script&#62;')).not.toMatch(/<script/i);
        expect(sanitizePlainText('&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;')).not.toMatch(/<script/i);
    });

    it('decodes &amp; and &quot; and &#39;', () => {
        expect(sanitizePlainText('Tom &amp; Jerry')).toBe('Tom & Jerry');
        expect(sanitizePlainText('she said &quot;hi&quot;')).toBe('she said "hi"');
        expect(sanitizePlainText('don&#39;t')).toBe("don't");
    });

    it('returns empty string for null / undefined / non-string', () => {
        expect(sanitizePlainText(null)).toBe('');
        expect(sanitizePlainText(undefined)).toBe('');
        expect(sanitizePlainText(42 as unknown as string)).toBe('');
    });
});

// ─── URL profile ──────────────────────────────────────────────────
