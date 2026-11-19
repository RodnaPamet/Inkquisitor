/**
 * Flat ESLint config (ESLint 9). Next 16's `eslint-config-next` ships flat
 * config only.
 *
 * Adapted from inflect-compliance's eslint.config.mjs: the Next presets, the
 * ignore list, `reportUnusedDisableDirectives: 'error'`, (Phase 0.2) its
 * React-Compiler hook rules at `warn`, scoped here to the lifted UI code, and
 * (Phase 0.4) the local rule plugin (`eslint-rules/`, registered as `local`).
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
        // roadmap rule 4). The worker and its health check are server code
        // too (Phase 0.H): they log through the process logger.
        files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
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
        // ── One way into the vector store (subphase 2.0, D8) ──
        //
        // `src/app-layer/repositories/vector.repository.ts` refuses any record
        // carrying more than a key, a book scope, a content hash and a vector
        // (vectors only), refuses a transaction not bound to the workspace a
        // call names, and bounds every read. So no other file under `src/` may
        // load a backend under `repositories/vector/`, name the store's table
        // in a literal, or reach its Prisma delegate.
        // See eslint-rules/rules/vector-store-single-seam.js.
        files: ['src/**/*.ts', 'src/**/*.tsx'],
        rules: { 'local/vector-store-single-seam': 'error' },
    },
    {
        // The seam and its backends.
        files: ['src/app-layer/repositories/vector.repository.ts', 'src/app-layer/repositories/vector/**/*.ts'],
        rules: { 'local/vector-store-single-seam': 'off' },
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
    {
        // Jest manual mocks are CommonJS (Jest loads them with require).
        files: ['__mocks__/**/*.js'],
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
    {
        // The UI platform lifted from inflect-compliance in Phase 0.2.
        // React 19's compiler-aware hook rules flag real but non-breaking
        // patterns across this code; inflect runs them at `warn` for the same
        // reason, and migrating each call site is its own piece of work. The
        // downgrade is scoped to the lifted directories: code written for
        // Inkquisitor outside them keeps the rules at `error`.
        files: [
            'packages/ui/src/**/*.{ts,tsx}',
            'src/components/ui/**/*.{ts,tsx}',
            'src/components/layout/**/*.{ts,tsx}',
            'src/components/command-palette/**/*.{ts,tsx}',
            'src/components/filters/**/*.{ts,tsx}',
            'src/components/app-shell/**/*.{ts,tsx}',
            'src/lib/hooks/**/*.{ts,tsx}',
            'tests/rendered/**/*.{ts,tsx}',
        ],
        rules: {
            'react-hooks/set-state-in-effect': 'warn',
            'react-hooks/refs': 'warn',
            'react-hooks/immutability': 'warn',
            'react-hooks/rules-of-hooks': 'warn',
            'react-hooks/error-boundaries': 'warn',
            'react-hooks/purity': 'warn',
            'react-hooks/static-components': 'warn',
            'react-hooks/use-memo': 'warn',
            'react-hooks/set-state-in-render': 'warn',
        },
    },
];

export default config;
