/**
 * `local/vector-store-single-seam` — RuleTester, plus the repo config's wiring.
 *
 * The valid cases are the load-bearing half: the repository's own path, a
 * directory that merely shares the prefix (`vectors/`, `vector-search-params`),
 * a relative import that does NOT resolve into the backends, and a comment
 * naming the table. An invalid-only suite would pass against a rule that
 * flags every import.
 *
 * The last block lints planted files with `eslint.config.mjs` itself, in a
 * child process (Jest cannot load the ESM config), so a config edit that
 * drops the rule or widens the exemption fails here, not only the rule.
 *
 * Adapted from inflect-compliance's
 * `eslint-rules/__tests__/vector-store-single-seam.test.ts`.
 */
import * as path from 'node:path';
import { RuleTester } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import { lintWithRepoConfig, REPO_ROOT, type LintResult } from './helpers/lint-with-repo-config';

// CommonJS on purpose — see eslint-rules/index.js.
const rule = require('../rules/vector-store-single-seam');

const RULE_ID = 'local/vector-store-single-seam';
const USECASE = path.join(REPO_ROOT, 'src/app-layer/usecases/question-dedupe.ts');
const REPO_DIR_FILE = path.join(REPO_ROOT, 'src/app-layer/repositories/something.repository.ts');

const ruleTester = new RuleTester({
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
});

describe('local/vector-store-single-seam', () => {
    ruleTester.run('vector-store-single-seam', rule, {
        valid: [
            {
                name: 'the repository seam itself, by alias',
                filename: USECASE,
                code: `import { getVectorRepository } from '@/app-layer/repositories/vector.repository';`,
            },
            {
                name: 'a directory or module that only shares the prefix',
                filename: USECASE,
                code: `import { x } from '@/app-layer/repositories/vectors/thing';\nimport { MAX_SEARCH_K } from '@/app-layer/repositories/vector-search-params';`,
            },
            {
                name: 'a relative import that resolves outside the backends',
                filename: REPO_DIR_FILE,
                code: `import { getVectorRepository } from './vector.repository';`,
            },
            {
                name: 'a comment naming the table is prose, not a query',
                filename: USECASE,
                code: `// VectorEmbedding rows are reached through the repository.\nexport const a = 1;`,
            },
            {
                name: 'an ordinary table and delegate',
                filename: USECASE,
                code: `prisma.bibleElement.findMany({ take: 1 });\nconst q = 'SELECT 1 FROM "BibleElement"';`,
            },
        ],
        invalid: [
            {
                name: 'a backend by alias',
                filename: USECASE,
                code: `import { createPgvectorStore } from '@/app-layer/repositories/vector/pgvector-store';`,
                errors: [{ messageId: 'backendLoad' }],
            },
            {
                name: 'a type-only import of the backend contract',
                filename: USECASE,
                code: `import type { VectorStoreBackend } from '@/app-layer/repositories/vector/types';`,
                errors: [{ messageId: 'backendLoad' }],
            },
            {
                name: 'a backend by a relative path from the repositories directory',
                filename: REPO_DIR_FILE,
                code: `import { createInProcessVectorStore } from './vector/in-process-store';`,
                errors: [{ messageId: 'backendLoad' }],
            },
            {
                name: 'a re-export of a backend',
                filename: USECASE,
                code: `export * from '@/app-layer/repositories/vector/pgvector-store';`,
                errors: [{ messageId: 'backendLoad' }],
            },
            {
                name: 'a dynamic import and a require',
                filename: USECASE,
                code: `const a = import('@/app-layer/repositories/vector/pgvector-store');\nconst b = require('@/app-layer/repositories/vector');`,
                errors: [{ messageId: 'backendLoad' }, { messageId: 'backendLoad' }],
            },
            {
                name: 'a raw query naming the table, in a string and in a template',
                filename: USECASE,
                code: `const q = 'SELECT 1 FROM "VectorEmbedding"';\nconst r = \`DELETE FROM "VectorEmbedding" WHERE x = \${1}\`;`,
                errors: [{ messageId: 'tableName' }, { messageId: 'tableName' }],
            },
            {
                name: 'the Prisma delegate, by name and by computed literal',
                filename: USECASE,
                code: `prisma.vectorEmbedding.deleteMany({});\ntx['vectorEmbedding'].count();`,
                errors: [{ messageId: 'delegate' }, { messageId: 'delegate' }],
            },
        ],
    });
});

describe('the ESLint config applies it everywhere under src/ except the seam and its backends', () => {
    const PLANTED = `import { createPgvectorStore } from '@/app-layer/repositories/vector/pgvector-store';\nexport const s = createPgvectorStore;\n`;
    const SITES = [
        'src/app-layer/usecases/planted-vector-backdoor.ts',
        'src/lib/ai/planted-vector-backdoor.ts',
        'src/app-layer/jobs/planted-vector-backdoor.ts',
    ];
    const EXEMPT = ['src/app-layer/repositories/vector.repository.ts', 'src/app-layer/repositories/vector/other-backend.ts'];
    let results: LintResult[];
    const flagged = (p: string) => results.find((r) => r.filePath === p)!.ruleIds.includes(RULE_ID);

    beforeAll(() => {
        results = lintWithRepoConfig(RULE_ID, PLANTED, [...SITES, ...EXEMPT]);
    }, 120_000);

    it('every file parsed, so no verdict below is vacuous', () => {
        expect(results).toHaveLength(SITES.length + EXEMPT.length);
        expect(results.filter((r) => r.fatal.length > 0)).toEqual([]);
    });

    it.each(SITES)('refuses the planted backend import at %s', (site) => {
        expect(flagged(site)).toBe(true);
    });

    it.each(EXEMPT)('allows it in %s', (site) => {
        expect(flagged(site)).toBe(false);
    });
});
