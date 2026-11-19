/**
 * Production refuses to start while something it requires is missing; every
 * other environment starts on its defaults.
 */
import { enforceProductionConfig, productionConfigProblems } from '@/lib/startup-checks';
import { isNextProductionBuild } from '@/lib/build-phase';
import { DEV_FALLBACK_AUTH_SECRET } from '@/lib/auth/auth-constants';
import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from '@/lib/security/encryption-constants';

// Assembled at run time: a secret-shaped literal in the tree trips the scanners.
const longValue = (seed: string) => `${seed}-`.repeat(8);

const GOOD = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/ink',
    REDIS_URL: 'redis://:pw@redis:6379',
    CLAMAV_HOST: 'clamav:3310',
    FILE_STORAGE_ROOT: '/var/lib/inkquisitor/uploads',
    AUTH_SECRET: longValue('auth'),
    NEXTAUTH_URL: 'https://app.example',
    DATA_ENCRYPTION_KEY: longValue('kek'),
};

it('development and test need nothing beyond their defaults', () => {
    expect(productionConfigProblems({ NODE_ENV: 'development' })).toEqual([]);
    expect(productionConfigProblems({ NODE_ENV: 'test' })).toEqual([]);
});

it('a complete production configuration passes', () => {
    expect(productionConfigProblems(GOOD)).toEqual([]);
});

it.each([
    ['REDIS_URL missing', { REDIS_URL: undefined }, /REDIS_URL is required/],
    ['REDIS_URL unauthenticated', { REDIS_URL: 'redis://redis:6379' }, /password/],
    ['DATABASE_URL missing', { DATABASE_URL: '' }, /DATABASE_URL/],
    ['s3 without a bucket', { STORAGE_PROVIDER: 's3' }, /S3_BUCKET/],
    ['local storage on the temp-directory default', { FILE_STORAGE_ROOT: undefined }, /FILE_STORAGE_ROOT/],
    ['explicitly local storage with no root', { STORAGE_PROVIDER: 'local', FILE_STORAGE_ROOT: ' ' }, /FILE_STORAGE_ROOT/],
    ['no virus scanner', { CLAMAV_HOST: undefined }, /CLAMAV_HOST/],
    ['half an Upstash configuration', { UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' }, /UPSTASH/],
    ['AUTH_SECRET missing', { AUTH_SECRET: undefined }, /AUTH_SECRET is required/],
    ['AUTH_SECRET too short', { AUTH_SECRET: 'short' }, /AUTH_SECRET is required/],
    ['AUTH_SECRET is the development fallback', { AUTH_SECRET: DEV_FALLBACK_AUTH_SECRET }, /AUTH_SECRET is the documented development fallback/],
    ['NEXTAUTH_URL missing', { NEXTAUTH_URL: undefined }, /NEXTAUTH_URL/],
    ['DATA_ENCRYPTION_KEY missing', { DATA_ENCRYPTION_KEY: undefined }, /DATA_ENCRYPTION_KEY is required/],
    ['DATA_ENCRYPTION_KEY too short', { DATA_ENCRYPTION_KEY: 'x'.repeat(31) }, /DATA_ENCRYPTION_KEY is required/],
    ['DATA_ENCRYPTION_KEY is the development fallback', { DATA_ENCRYPTION_KEY: DEV_FALLBACK_DATA_ENCRYPTION_KEY }, /development fallback/],
    ['half a Google configuration', { GOOGLE_CLIENT_ID: 'id.apps.example' }, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/],
    ['the embedding stub', { EMBEDDING_PROVIDER: 'stub' }, /EMBEDDING_PROVIDER=stub is for development and test/],
    ['TEI with no URL', { EMBEDDING_PROVIDER: 'tei', EMBEDDING_TEI_MODEL: 'm', EMBEDDING_TEI_DIMENSIONS: '384' }, /EMBEDDING_TEI_BASE_URL is required/],
    [
        'TEI outside the deployment',
        { EMBEDDING_PROVIDER: 'tei', EMBEDDING_TEI_BASE_URL: 'https://93.184.216.34', EMBEDDING_TEI_MODEL: 'm', EMBEDDING_TEI_DIMENSIONS: '384' },
        /EMBEDDING_TEI_BASE_URL must name a service inside the deployment/,
    ],
    ['a model key without the zero-retention statement (D5)', { ANTHROPIC_API_KEY: longValue('key') }, /ANTHROPIC_ZDR_CONFIRMED=1/],
    ['a model key with ZDR stated as 0', { ANTHROPIC_API_KEY: longValue('key'), ANTHROPIC_ZDR_CONFIRMED: '0' }, /ANTHROPIC_ZDR_CONFIRMED=1/],
    ['ambient SDK headers', { ANTHROPIC_CUSTOM_HEADERS: 'anthropic-beta: x' }, /ANTHROPIC_CUSTOM_HEADERS must be unset/],
    ['a malformed AI ceiling', { AI_MONTHLY_CEILING_USD_DEFAULT: '25 dollars' }, /AI_MONTHLY_CEILING_USD_DEFAULT/],
    ['a ceiling past the bound', { AI_MONTHLY_CEILING_USD_DEFAULT: '1000000' }, /AI_MONTHLY_CEILING_USD_DEFAULT/],
    ['a malformed kill switch', { AI_DISABLED: 'yes' }, /AI_DISABLED must be 0 or 1/],
])('refuses: %s', (_name, override, message) => {
    const problems = productionConfigProblems({ ...GOOD, ...override });
    expect(problems.join(' ')).toMatch(message);
});

it('S3 storage needs no FILE_STORAGE_ROOT', () => {
    expect(productionConfigProblems({ ...GOOD, FILE_STORAGE_ROOT: undefined, STORAGE_PROVIDER: 's3', S3_BUCKET: 'b' })).toEqual([]);
});

it('embeddings: unset is no problem yet (nothing embeds before 2.1), and a whole TEI route inside the deployment passes', () => {
    expect(productionConfigProblems(GOOD)).toEqual([]);
    expect(
        productionConfigProblems({
            ...GOOD,
            EMBEDDING_PROVIDER: 'tei',
            EMBEDDING_TEI_BASE_URL: 'http://tei:80',
            EMBEDDING_TEI_MODEL: 'BAAI/bge-small-en-v1.5',
            EMBEDDING_TEI_DIMENSIONS: '384',
        }),
    ).toEqual([]);
});

it('the model layer: no key is no problem in 2.1 (nothing calls a model in production before 2.2); a key with ZDR stated passes', () => {
    expect(productionConfigProblems(GOOD)).toEqual([]);
    expect(productionConfigProblems({ ...GOOD, ANTHROPIC_API_KEY: longValue('key'), ANTHROPIC_ZDR_CONFIRMED: '1' })).toEqual([]);
    expect(productionConfigProblems({ ...GOOD, AI_DISABLED: '1', AI_MONTHLY_CEILING_USD_DEFAULT: '12.50' })).toEqual([]);
});

it('scanning disabled needs no scanner', () => {
    expect(productionConfigProblems({ ...GOOD, CLAMAV_HOST: undefined, AV_SCAN_MODE: 'disabled' })).toEqual([]);
});

it('enforce reports each problem and exits 1; a good config does neither', () => {
    const lines: string[] = [];
    const exit = jest.fn();
    enforceProductionConfig({ NODE_ENV: 'production' }, (l) => lines.push(l), exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.every((l) => l.startsWith('[startup] FATAL: '))).toBe(true);

    const exit2 = jest.fn();
    enforceProductionConfig(GOOD, () => undefined, exit2);
    expect(exit2).not.toHaveBeenCalled();
});

describe('next build', () => {
    // `next build` runs as NODE_ENV=production and imports every route module,
    // with no runtime secret present. It must not be refused; the server it
    // builds is checked when it starts.
    const BUILD = { NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' };

    it('the build phase is the value Next itself sets', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { PHASE_PRODUCTION_BUILD } = require('next/constants') as { PHASE_PRODUCTION_BUILD: string };
        expect(isNextProductionBuild({ NEXT_PHASE: PHASE_PRODUCTION_BUILD })).toBe(true);
    });

    it('a build with no runtime configuration is not refused', () => {
        expect(productionConfigProblems(BUILD)).toEqual([]);
        expect(productionConfigProblems({ ...BUILD, REDIS_URL: 'redis://localhost:6379' })).toEqual([]);
    });

    it('only the build phase is exempt: the running server is still refused', () => {
        for (const phase of [undefined, '', 'phase-production-server', 'phase-development-server', 'phase-export']) {
            expect(isNextProductionBuild({ NEXT_PHASE: phase })).toBe(false);
            expect(productionConfigProblems({ NODE_ENV: 'production', NEXT_PHASE: phase }).join(' ')).toMatch(
                /REDIS_URL is required/,
            );
        }
    });
});
