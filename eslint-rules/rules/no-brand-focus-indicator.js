'use strict';

/**
 * A focus indicator in the shared UI reads the ACCENT, never a brand token.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * The accent tokens (`--accent-default`, `--accent-emphasis`) are the colours
 * a SOLID focus indicator is drawn in. Where a theme aliases the accent to the
 * brand, a class naming either renders identically, so a brand-coloured focus
 * ring looks right — until a theme focuses in one colour and fills with
 * another, and that one control's ring is the wrong colour. Nothing visible
 * would show it while the two values match, which is why this is a lint rule.
 *
 * Lifted from inflect-compliance's `eslint-rules/rules/no-brand-focus-indicator.js`.
 *
 * ── WHAT IT SEES ─────────────────────────────────────────────────────────
 *
 * Every string a class can live in: a string `Literal` (a JSX attribute, a
 * `cn()` / `cva()` argument, an object value) and each quasi of a template
 * literal. Each whitespace-separated token is a candidate class. A token is
 * flagged when BOTH hold:
 *
 *   - its variant chain contains a focus state: `focus:`, `focus-visible:`,
 *     `focus-within:`, also as `group-…` / `peer-…` and stacked with other
 *     variants (`md:focus-visible:`);
 *   - its utility paints a ring, shadow, outline or border, and the value is a
 *     brand token: the named palette (`ring-brand-emphasis`, `border-brand-500`)
 *     or an arbitrary value that reads `--brand-*`
 *     (`ring-[var(--brand-default)]/40`, `shadow-[0_0_0_4px_var(--brand-default)]`).
 *
 * NOT flagged, on purpose:
 *
 *   - the same utilities with no focus variant. A selected card's brand ring or
 *     a KPI glow is brand DECORATION, which a host recolours with its brand —
 *     that is the brand doing its job, not a pointer;
 *   - focus utilities that read the accent, `--ring` / `ring-ring`,
 *     `--focus-ring` or `--ctrl-edge-focus`: those are already their own
 *     tokens, overridable without touching the fill.
 *
 * Comments are never visited, so a doc block quoting a banned class is fine.
 *
 * ── WHAT IT CANNOT SEE ───────────────────────────────────────────────────
 *
 * A class assembled from fragments at run time (`'focus-visible:ring-' + tone`)
 * and CSS outside JS and TS (`globals.css`). The shared UI has neither today.
 * A green run proves the visible shape is absent, not that every focus ring in
 * the tree is accent-coloured.
 */

/** A variant (one `x:` link of the chain) that means "this element is focused". */
const FOCUS_VARIANT = /^(?:group-|peer-)?focus(?:-visible|-within)?(?:\/[\w-]+)?$/;

/** The utilities that draw a focus indicator. */
const INDICATOR_UTILITY = /^-?(?:ring(?:-offset)?|shadow|outline|border(?:-[a-z]{1,2})?)-(.+)$/;

/** A brand-token value: the named palette, or an arbitrary value reading `--brand-*`. */
const BRAND_VALUE = /^(?:brand-[\w-]+|\[[^\]]*--brand-[^\]]*\])(?:\/[\w.[\]-]+)?$/;

/**
 * Split one class token into its variant chain and its utility, on the `:`
 * separators that sit OUTSIDE square brackets — `[&:hover]:ring-…` and
 * `shadow-[0_0_0_2px_var(--x)]` both contain characters that a naive split
 * would cut in the wrong place.
 */
function splitClass(token) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < token.length; i++) {
        const ch = token[i];
        if (ch === '[') depth++;
        else if (ch === ']') depth = Math.max(0, depth - 1);
        else if (ch === ':' && depth === 0) {
            parts.push(token.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(token.slice(start));
    return { variants: parts.slice(0, -1), utility: parts[parts.length - 1] };
}

/** The offending class, or null. */
function brandFocusClass(token) {
    const { variants, utility } = splitClass(token);
    if (!variants.some((v) => FOCUS_VARIANT.test(v))) return null;
    // `!` important may lead (Tailwind 3) or trail (Tailwind 4).
    const bare = utility.replace(/^!/, '').replace(/!$/, '');
    const m = INDICATOR_UTILITY.exec(bare);
    if (!m) return null;
    return BRAND_VALUE.test(m[1]) ? token : null;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'A focus indicator reads --accent-default / --accent-emphasis (or the ring tokens), never a --brand-* token',
        },
        schema: [],
        messages: {
            brandFocus:
                '"{{cls}}" draws a focus indicator from a brand token. Read the accent instead: ' +
                'ring-[var(--accent-default)], shadow-[…var(--accent-default)] or --accent-emphasis. ' +
                'The accent is its own token so the focus colour can differ from the fill colour ' +
                'without recolouring every brand surface. See src/styles/tokens.css.',
        },
    },

    create(context) {
        function check(node, text) {
            if (typeof text !== 'string' || !text.includes('focus')) return;
            for (const token of text.split(/\s+/)) {
                if (!token) continue;
                const cls = brandFocusClass(token);
                if (cls) context.report({ node, messageId: 'brandFocus', data: { cls } });
            }
        }

        return {
            Literal(node) {
                check(node, node.value);
            },
            TemplateElement(node) {
                check(node, node.value.cooked);
            },
        };
    },
};
