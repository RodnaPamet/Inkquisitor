/**
 * Flat ESLint config (ESLint 9). Next 16's `eslint-config-next` ships flat
 * config only.
 *
 * Adapted from inflect-compliance's eslint.config.mjs: the Next presets, the
 * ignore list, `reportUnusedDisableDirectives: 'error'` and (Phase 0.2) its
 * React-Compiler hook rules at `warn`, scoped here to the lifted UI code. Its local rule
 * plugin (`eslint-rules/`) arrives in Phase 0.4, starting with
 * `anthropic-client-single-seam` (roadmap rule 3).
 */
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

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
        ],
    },
    {
        rules: {
            // `any` is an error from day one — there is no debt to ratchet.
            '@typescript-eslint/no-explicit-any': 'error',
        },
    },
    {
        // Server and shared code logs through the structured logger that
        // Phase 0.4 lifts, never the console (author text must never reach a
        // log line by accident — roadmap rule 4).
        files: ['src/**/*.{ts,tsx}'],
        rules: {
            'no-console': 'error',
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
