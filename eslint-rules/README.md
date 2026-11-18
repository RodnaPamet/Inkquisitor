# `eslint-rules/` — Inkquisitor's own ESLint rules

Lifted from inflect-compliance's `eslint-rules/` (see `docs/carve-manifest.md`).

> If the rule is structural — a banned import, a required prop, a forbidden
> identifier — write an **ESLint rule** instead of a regex under
> `tests/guards/`. An AST rule survives reformatting and renaming; a regex over
> source text does not.

## Layout

```
eslint-rules/
  index.js                        the plugin, registered as `local` in eslint.config.mjs
  rules/<rule-name>.js            one rule per file
  __tests__/<rule-name>.test.ts   RuleTester, run by Jest's unit project
```

CommonJS `.js` on purpose: ESLint's ESM config imports it through Node's
CJS/ESM interop and Jest's CommonJS runtime requires it. `.mjs` is not
downlevelled by ts-jest (every rule test fails on `export`); `.cjs` is outside
the scope eslint-config-next registers its plugins for.

## Rules

| Rule | Scope (eslint.config.mjs) | Holds |
| --- | --- | --- |
| `anthropic-client-single-seam` | `src/**`, except `src/lib/ai/client.ts` | Roadmap rule 3: one file loads `@anthropic-ai/*`. `import type` is allowed. |
| `no-raw-prompt-logging` | server code under `src/` (not `src/components/`) | Roadmap rule 4: a log, error-report or audit call carries ids, digests and counts, never author text, a prompt or a completion. |
| `no-request-derived-public-url` | `src/app/api/**` | A URL handed outside the process comes from `publicBaseUrl()` (APP_URL), never `req.nextUrl.host`. |
| `no-brand-focus-indicator` | `src/components/**`, `packages/ui/**` | A focus ring reads the accent token, not a brand token. |
| `no-translucent-focus-indicator` | same | A focus ring is drawn solid, with no opacity modifier (WCAG 1.4.11). |

## Adding a rule

1. Write `rules/<name>.js` exporting an ESLint `RuleModule`.
2. Register it in `index.js`.
3. Add `__tests__/<name>.test.ts` with **both** `valid` and `invalid` cases.
   An invalid-only suite passes against a rule that flags everything. Call
   `ruleTester.run(...)` directly in the `describe` body, never inside `it`.
4. Turn it on in `eslint.config.mjs` and run `npm run lint` over the whole
   repo before choosing a severity.

Prefer a `no-restricted-syntax` selector in `eslint.config.mjs` when one
esquery selector says the whole thing.
