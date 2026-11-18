/**
 * The repo's ESLint configuration refuses author text at a log or error-report
 * call in server code (roadmap rule 4), and only there.
 *
 * `no-raw-prompt-logging.test.ts` proves the rule's logic. This proves the
 * config wires it: a planted `logger.info(…, { answer })` is linted with
 * `eslint.config.mjs` under `src/` and `scripts/` (refused) and under
 * `src/components/` (allowed: a component renders the author's text to the
 * author, which is the product working).
 */
import { lintWithRepoConfig, type LintResult } from './helpers/lint-with-repo-config';

const RULE_ID = 'local/no-raw-prompt-logging';

const PLANTED = [
    `import { logger } from '@/lib/observability/logger';`,
    `export function saved(questionId: string, answer: string): void {`,
    `    logger.info('answer saved', { questionId, answer });`,
    `}`,
    '',
].join('\n');

const REFUSED_AT = [
    'src/lib/planted-logging.ts',
    'src/app-layer/usecases/planted-logging.ts',
    'src/app/api/planted/route.ts',
    'scripts/planted-logging.ts',
];
const ALLOWED_AT = ['src/components/PlantedLogging.tsx'];

describe('the ESLint config applies no-raw-prompt-logging to server code', () => {
    let results: LintResult[];
    const at = (filePath: string) => results.find((r) => r.filePath === filePath)!;

    beforeAll(() => {
        results = lintWithRepoConfig(RULE_ID, PLANTED, [...REFUSED_AT, ...ALLOWED_AT]);
    }, 120_000);

    it('every file parsed, so no verdict below is vacuous', () => {
        expect(results).toHaveLength(REFUSED_AT.length + ALLOWED_AT.length);
        expect(results.filter((r) => r.fatal.length > 0)).toEqual([]);
    });

    it.each(REFUSED_AT)('refuses author text at a log call in %s', (site) => {
        expect(at(site).ruleIds).toContain(RULE_ID);
    });

    it.each(ALLOWED_AT)('leaves %s alone', (site) => {
        expect(at(site).ruleIds).not.toContain(RULE_ID);
    });
});
