/**
 * Jest configuration — two projects.
 *
 *   `unit`        tests/unit, tests/guards and eslint-rules/__tests__. Node
 *                 environment, no database,
 *                 no network. `npm test` runs this project.
 *   `integration` tests/integration. Node environment against a real
 *                 PostgreSQL named by DATABASE_URL. `npm run test:integration`
 *                 runs it, in band.
 *
 * `@/env` and `@/env-client` map to tests/mocks/env.ts in both projects:
 * `@t3-oss/env-nextjs` ships ESM only, so a suite reaching either real module
 * would fail to load under Jest's CommonJS runtime (the same mapping
 * inflect-compliance uses). The mock answers from process.env.
 */
const shared = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/jest.setup.js'],
    moduleNameMapper: {
        '\\.css$': '<rootDir>/tests/mocks/style.ts',
        '^@/env$': '<rootDir>/tests/mocks/env.ts',
        '^@/env-client$': '<rootDir>/tests/mocks/env.ts',
        '^@/(.*)$': '<rootDir>/src/$1',
    },
    transform: {
        '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }],
    },
    testPathIgnorePatterns: ['/node_modules/', '/.next/', '/.claude/'],
};

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
            displayName: 'integration',
            testMatch: ['<rootDir>/tests/integration/**/*.test.ts?(x)'],
        },
    ],
};
