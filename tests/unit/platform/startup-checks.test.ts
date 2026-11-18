/**
 * Production refuses to start while something it requires is missing; every
 * other environment starts on its defaults.
 */
import { enforceProductionConfig, productionConfigProblems } from '@/lib/startup-checks';
import { isNextProductionBuild } from '@/lib/build-phase';

const GOOD = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/ink',
    REDIS_URL: 'redis://:pw@redis:6379',
    CLAMAV_HOST: 'clamav:3310',
    FILE_STORAGE_ROOT: '/var/lib/inkquisitor/uploads',
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
])('refuses: %s', (_name, override, message) => {
    const problems = productionConfigProblems({ ...GOOD, ...override });
    expect(problems.join(' ')).toMatch(message);
});

it('S3 storage needs no FILE_STORAGE_ROOT', () => {
    expect(productionConfigProblems({ ...GOOD, FILE_STORAGE_ROOT: undefined, STORAGE_PROVIDER: 's3', S3_BUCKET: 'b' })).toEqual([]);
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
