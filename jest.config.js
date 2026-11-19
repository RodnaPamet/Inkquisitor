/**
 * Jest configuration — three projects.
 *
 *   `unit`        tests/unit, tests/guards and eslint-rules/__tests__. Node
 *                 environment, no database, no network.
 *   `rendered`    tests/rendered and co-located `__tests__` under
 *                 packages/ui/src. jsdom: real React renders of the UI
 *                 platform with Testing Library, jest-dom and jest-axe.
 *   `integration` tests/integration. Node environment against a real
 *                 PostgreSQL named by DATABASE_URL, run in band.
 *
 * `npm test` runs `unit` and `rendered`; `npm run test:integration` runs
 * `integration`.
 *
 * `@/env` and `@/env-client` map to tests/mocks/env.ts in every project:
 * `@t3-oss/env-nextjs` ships ESM only, so a suite reaching either real module
 * would fail to load under Jest's CommonJS runtime (the same mapping
 * inflect-compliance uses). The mock answers from process.env.
 *
 * `@inkquisitor/ui/*` maps straight to packages/ui/src: jest-resolve does not
 * honour the package's `exports` ARRAY fallback, so `.tsx` subpaths would not
 * resolve through the workspace symlink (measured in inflect-compliance at
 * #3046 step 2b). The `rendered` project is adapted from inflect's `jsdom`
 * project (see docs/carve-manifest.md).
 */
/**
 * ESM-only packages the unit and integration projects load, transformed for
 * Jest's CommonJS runtime. The `sanitize-html` cluster (Phase 1.1, the
 * write-path sanitiser `src/lib/security/sanitize.ts`): htmlparser2 12,
 * domhandler, domutils, dom-serializer, domelementtype and entities are
 * `"type": "module"` with import-first entries. `sanitize-html` itself is
 * CommonJS and listed only so a copy nested under it is not ignored by the
 * outer path segment matching (`transformIgnorePatterns` is an unanchored
 * regex; inflect-compliance's jest.config.js tells the story).
 */
const NODE_ESM_ALLOW_LIST = ['sanitize-html', 'htmlparser2', 'domhandler', 'domutils', 'dom-serializer', 'domelementtype', 'entities'].join('|');

const shared = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/jest.setup.js'],
    moduleNameMapper: {
        '\\.css$': '<rootDir>/tests/mocks/style.ts',
        '^@/env$': '<rootDir>/tests/mocks/env.ts',
        '^@/env-client$': '<rootDir>/tests/mocks/env.ts',
        '^@inkquisitor/ui/(.*)$': '<rootDir>/packages/ui/src/$1',
        '^@/(.*)$': '<rootDir>/src/$1',
    },
    transform: {
        '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }],
        // The ESM-only packages below, transpiled to CommonJS for Jest's runtime.
        '^.+\\.m?js$': ['ts-jest', { tsconfig: { allowJs: true } }],
    },
    transformIgnorePatterns: [`node_modules/(?!(${NODE_ESM_ALLOW_LIST})/)`],
    testPathIgnorePatterns: ['/node_modules/', '/.next/', '/.claude/'],
    // `.claude/worktrees/<id>/` holds full checkouts; without this the haste
    // map finds a second copy of every manual mock.
    modulePathIgnorePatterns: ['<rootDir>/.claude/'],
};

/**
 * ESM-only packages in the UI platform's graph, transformed for the jsdom
 * project's CommonJS runtime. TanStack Table v9 is ESM-only (no `require`
 * condition); the TipTap / ProseMirror cluster ships ESM entries; the chart
 * platform's visx packages re-export d3 modules that ship as ESM.
 */
const RENDERED_ESM_ALLOW_LIST = [
    '@tanstack/(?:react-table|table-core)',
    '@visx/[^/]+',
    'd3-[^/]+',
    'internmap',
    '@tiptap/[^/]+',
    'prosemirror-[^/]+',
    'linkify-it',
    'linkifyjs',
    'markdown-it',
    'orderedmap',
    'rope-sequence',
    'w3c-keyname',
].join('|');

/** @type {import('jest').Config} */
module.exports = {
    projects: [
        {
            ...shared,
            displayName: 'unit',
            testMatch: [
                '<rootDir>/tests/unit/**/*.test.ts?(x)',
                '<rootDir>/tests/guards/**/*.test.ts?(x)',
                // RuleTester suites for the local ESLint plugin (Phase 0.4).
                '<rootDir>/eslint-rules/__tests__/**/*.test.ts',
            ],
        },
        {
            ...shared,
            displayName: 'rendered',
            testEnvironment: 'jsdom',
            setupFilesAfterEnv: ['<rootDir>/tests/rendered/setup.ts'],
            moduleNameMapper: {
                // Vaul's drawer crashes under React 19 in jsdom (pointer
                // math on an undefined transform). The stub renders its
                // slots through Radix Dialog so Modal's drawer branch mounts.
                '^vaul$': '<rootDir>/tests/rendered/vaul-mock.tsx',
                '\\.(css|less|scss|sass)$': '<rootDir>/tests/rendered/style-mock.ts',
                ...shared.moduleNameMapper,
            },
            testMatch: [
                '<rootDir>/tests/rendered/**/*.test.ts?(x)',
                // Co-located package tests (e.g. packages/ui hooks). Anchored
                // here explicitly: inflect found such a test matched by NO
                // project once it moved into the package, and silently
                // stopped running.
                '<rootDir>/packages/*/src/**/__tests__/**/*.test.ts?(x)',
                // …and next to the app's own primitives (src/components/ui/hooks).
                '<rootDir>/src/**/__tests__/**/*.test.ts?(x)',
            ],
            transform: {
                '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: '<rootDir>/tests/rendered/tsconfig.json' }],
                '^.+\\.m?js$': ['ts-jest', { tsconfig: '<rootDir>/tests/rendered/tsconfig.json' }],
            },
            transformIgnorePatterns: [`node_modules/(?!(${RENDERED_ESM_ALLOW_LIST})/)`],
        },
        {
            ...shared,
            displayName: 'integration',
            testMatch: ['<rootDir>/tests/integration/**/*.test.ts?(x)'],
        },
    ],
};
