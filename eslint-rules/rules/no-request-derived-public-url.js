'use strict';

/**
 * Externally-published URLs must come from `publicBaseUrl`, not the request.
 *
 * THE BUG THIS PREVENTS (found in inflect-compliance). Route handlers built
 * base URLs like:
 *
 *     const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
 *
 * Behind a reverse proxy that is the app's own bind address: the page
 * rendered `https://0.0.0.0:3000/…` while `APP_URL` was set correctly. In
 * Inkquisitor the same mistake would put a dead host into a share link or a
 * password-reset email.
 *
 * WHY AN ESLINT RULE. A regex for this template literal is defeated by
 * splitting the expression across two lines, or by `const { host } =
 * req.nextUrl`. This matches the member access itself.
 *
 * SCOPE. Only `src/app/api/**` — route handlers are where these strings are
 * built and handed out. `proxy.ts` may inspect the host for routing
 * decisions that never leave the process, and the helper itself must read
 * `nextUrl.origin` to implement the fallback.
 *
 * Lifted from inflect-compliance's `eslint-rules/rules/no-request-derived-public-url.js`.
 */

/** Reading these off a request yields the proxy-facing value, not the public one. */
const REQUEST_ORIGIN_PROPS = new Set(['host', 'origin', 'hostname']);

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Build externally-published URLs from publicBaseUrl(), not from the request',
        },
        schema: [],
        messages: {
            requestDerived:
                'Do not derive a public URL from `nextUrl.{{prop}}` — behind a proxy this is the ' +
                "app's internal bind address (0.0.0.0:3000). " +
                'Use `publicBaseUrl(req)` from `@/lib/http/public-base-url`, which prefers APP_URL.',
        },
    },

    create(context) {
        const filename = context.filename ?? context.getFilename();
        const normalized = filename.split('\\').join('/');

        // Only route handlers. See SCOPE above.
        if (!normalized.includes('/src/app/api/')) return {};
        // The helper implements the fallback, so it must read the request.
        if (normalized.endsWith('/lib/http/public-base-url.ts')) return {};

        /** `req.nextUrl` — the object these props are read off. */
        const isNextUrl = (n) =>
            n &&
            n.type === 'MemberExpression' &&
            !n.computed &&
            n.property.type === 'Identifier' &&
            n.property.name === 'nextUrl';

        return {
            // `const { host } = req.nextUrl` — the form a regex over source text
            // misses entirely, and which the first version of this rule missed
            // too: it only walked MemberExpressions, and a destructuring pattern
            // is not one. Caught by mutation-testing the rule against exactly the
            // shape its own docblock claimed to cover.
            VariableDeclarator(node) {
                if (!node.init || !isNextUrl(node.init)) return;
                if (!node.id || node.id.type !== 'ObjectPattern') return;
                for (const prop of node.id.properties) {
                    if (prop.type !== 'Property' || prop.computed) continue;
                    if (prop.key.type !== 'Identifier') continue;
                    if (!REQUEST_ORIGIN_PROPS.has(prop.key.name)) continue;
                    context.report({
                        node: prop,
                        messageId: 'requestDerived',
                        data: { prop: prop.key.name },
                    });
                }
            },

            MemberExpression(node) {
                if (node.computed || node.property.type !== 'Identifier') return;
                if (!REQUEST_ORIGIN_PROPS.has(node.property.name)) return;

                // `<anything>.nextUrl.<host|origin|hostname>`
                if (!isNextUrl(node.object)) return;

                context.report({
                    node,
                    messageId: 'requestDerived',
                    data: { prop: node.property.name },
                });
            },
        };
    },
};
