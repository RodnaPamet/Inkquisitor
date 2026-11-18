'use strict';

/**
 * `eslint-plugin-local` — this repository's own ESLint rules, registered as
 * `local` in `eslint.config.mjs`.
 *
 * A structural rule (a banned import, a forbidden identifier, a shape of
 * expression) is an ESLint rule rather than a regex under `tests/guards/`:
 * an AST rule survives reformatting and renaming, a regex over source text
 * does not. See ./README.md for when a rule belongs here and how to add one.
 *
 * CommonJS `.js`, as in inflect-compliance (whose `eslint-rules/index.js` this
 * is adapted from): `package.json` declares no `"type"`, so ESLint's ESM
 * config can import it and Jest's CommonJS runtime can require it for
 * RuleTester. A `.mjs` file is not downlevelled by ts-jest; a `.cjs` file is
 * outside the scope eslint-config-next registers its plugins for.
 */

module.exports = {
    meta: {
        name: 'eslint-plugin-local',
        version: '1.0.0',
    },
    rules: {
        'anthropic-client-single-seam': require('./rules/anthropic-client-single-seam'),
        'no-raw-prompt-logging': require('./rules/no-raw-prompt-logging'),
        'no-request-derived-public-url': require('./rules/no-request-derived-public-url'),
        'no-brand-focus-indicator': require('./rules/no-brand-focus-indicator'),
        'no-translucent-focus-indicator': require('./rules/no-translucent-focus-indicator'),
    },
};
