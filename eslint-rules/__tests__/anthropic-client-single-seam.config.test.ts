/**
 * The repo's ESLint configuration refuses a second Anthropic client
 * construction site (roadmap rule 3: one file loads the model SDK).
 *
 * `anthropic-client-single-seam.test.ts` proves the RULE catches every way of
 * loading the SDK. This proves the CONFIG applies it: a planted
 * `new Anthropic(...)` is linted with `eslint.config.mjs` at ordinary paths
 * under `src/` (it must be refused) and at the seam, `src/lib/ai/client.ts`
 * (the one exemption, where it must not be). The planted text is linted AS
 * the seam's path, so the verdict does not depend on what the real seam file
 * (Phase 2.1) holds; the real tree is linted by `npm run lint`.
 *
 * Adapted from inflect-compliance's
 * `eslint-rules/__tests__/anthropic-client-single-seam.config.test.ts`.
 */
import { lintWithRepoConfig, type LintResult } from './helpers/lint-with-repo-config';

const RULE_ID = 'local/anthropic-client-single-seam';
const SEAM = 'src/lib/ai/client.ts';

const PLANTED = [
    `import Anthropic from '@anthropic-ai/sdk';`,
    `export const direct = () => new Anthropic({ maxRetries: 0 });`,
    '',
].join('\n');

const PLANT_SITES = [
    'src/lib/ai/planted-second-client.ts',
    // The structured-call engine sits beside the seam and must still get its
    // client from clientForRun.
    'src/lib/ai/call-structured.ts',
    'src/app-layer/usecases/planted-anthropic-client.ts',
    'src/app/api/planted/route.ts',
    'src/components/PlantedClient.tsx',
    // `allowJs`: a JavaScript module under src/ is bundled like any other.
    'src/lib/ai/planted-second-client.js',
    'src/lib/ai/planted-second-client.mjs',
    'scripts/planted-anthropic-client.mjs',
];

describe('the ESLint config allows one Anthropic construction site', () => {
    let results: LintResult[];
    const at = (filePath: string) => results.find((r) => r.filePath === filePath)!;

    beforeAll(() => {
        results = lintWithRepoConfig(RULE_ID, PLANTED, [...PLANT_SITES, SEAM]);
    }, 120_000);

    it('every file parsed, so no verdict below is vacuous', () => {
        expect(results).toHaveLength(PLANT_SITES.length + 1);
        expect(results.filter((r) => r.fatal.length > 0)).toEqual([]);
    });

    it.each(PLANT_SITES)('refuses the planted construction at %s', (site) => {
        expect(at(site).ruleIds).toContain(RULE_ID);
    });

    it('allows the same text in the seam itself (the one exemption)', () => {
        expect(at(SEAM).ruleIds).not.toContain(RULE_ID);
    });
});
