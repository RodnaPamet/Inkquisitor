/**
 * Flat ESLint config (ESLint 9). Next 16's `eslint-config-next` ships flat
 * config only.
 *
 * Adapted from inflect-compliance's eslint.config.mjs: the Next presets, the
 * ignore list, `reportUnusedDisableDirectives: 'error'` and, since Phase 0.4,
 * the local rule plugin (`eslint-rules/`, registered as `local`).
 */
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import localRules from './eslint-rules/index.js';

const config = [
    ...nextCoreWebVitals,
    ...nextTypescript,
    {
        // A suppression comment that suppresses nothing is an error: it is a
        // standing licence for whatever lands on that line next.
        linterOptions: { reportUnusedDisableDirectives: 'error' },
    },
    {
        ignores: [
            '.next/**',
            // The worker bundles scripts/build-worker.mjs writes: esbuild
            // inlines src/ into them, so linting them reports src's own rules
            // against a copy of src.
            'dist/**',
            'node_modules/**',
            // Claude Code runtime state: `.claude/worktrees/<id>/` holds full
            // checkouts of the repo, which would be linted twice.
            '.claude/**',
            'coverage/**',
            'playwright-report/**',
            'test-results/**',
            'public/**',
            'next-env.d.ts',
            // The docs site's build output and staged content (generated).
            'site/dist/**',
            'site/.astro/**',
            'site/node_modules/**',
            'site/src/content/docs/**',
            // The release tooling's install (.github/workflows/release.yml).
            'release/node_modules/**',
        ],
    },
    {
        plugins: { local: localRules },
        rules: {
            // `any` is an error from day one — there is no debt to ratchet.
            '@typescript-eslint/no-explicit-any': 'error',
        },
    },
    {
        // Server and shared code logs through the structured logger, never the
        // console (author text must never reach a log line by accident —
        // roadmap rule 4).
        files: ['src/**/*.{ts,tsx}'],
        rules: {
            'no-console': 'error',
            // Roadmap rule 3: one file loads the model SDK.
            'local/anthropic-client-single-seam': 'error',
        },
    },
    {
        // The rule plugin, the docs stager and the CodeQL gate are CommonJS
        // (see eslint-rules/README.md), and their tests require them the
        // same way.
        files: ['eslint-rules/**/*.{js,ts}', 'site/scripts/**/*.js', 'scripts/**/*.js', 'tests/unit/sarif-gate.test.ts'],
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
    {
        // The seam itself (Phase 2.1).
        files: ['src/lib/ai/client.ts'],
        rules: { 'local/anthropic-client-single-seam': 'off' },
    },
    {
        // The edge logger is the console's one legitimate caller: pino does not
        // run in the edge runtime, and it redacts before it writes.
        files: ['src/lib/observability/edge-logger.ts'],
        rules: { 'no-console': 'off' },
    },
    {
        // Roadmap rule 4 at the sink: a log, error-report or audit call carries
        // ids, digests and counts, never author text. Server code only — a
        // component renders the author's text to the author, which is the
        // product working.
        files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
        ignores: ['src/components/**'],
        rules: { 'local/no-raw-prompt-logging': 'error' },
    },
    {
        files: ['src/app/api/**/*.{ts,tsx}'],
        rules: { 'local/no-request-derived-public-url': 'error' },
    },
    {
        // Focus indicators in the shared UI: drawn from the accent token, solid.
        files: ['src/components/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}', 'src/app/**/*.tsx'],
        rules: {
            'local/no-brand-focus-indicator': 'error',
            'local/no-translucent-focus-indicator': 'error',
        },
    },
];

export default config;
