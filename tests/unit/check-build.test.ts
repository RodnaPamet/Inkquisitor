/**
 * scripts/check-build.js — the Build check's own rules (issue #8, brief item 3).
 *
 * The two warnings are the ones the Phase 0.3 build really printed; the
 * bundles are built in a temporary folder, so each rule is shown to refuse
 * what it is for and to pass a clean build.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const check = require('../../scripts/check-build.js') as {
    findWarnings(output: string): string[];
    findProxyNodeOnlyModules(bundle: string): string[];
    findServerEnvNames(chunk: string, keys: string[]): string[];
    serverEnvKeys(envSource: string): string[];
    checkBuild(output: string, nextDir: string): string[];
};

const PHASE_03_OUTPUT = [
    '▲ Next.js 16.4.6 (webpack)',
    '⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.',
    '<w> [webpack.cache.PackFileCacheStrategy] Serializing big strings (105kiB) impacts deserialization performance',
    '⚠ Compiled with warnings in 30.0s',
    './node_modules/@upstash/redis/nodejs.mjs',
    'A Node.js API is used (process.version at line: 270) which is not supported in the Edge Runtime.',
    '✓ Generating static pages using 3 workers (6/6) in 343ms',
].join('\n');

it('finds both warnings the Phase 0.3 build printed, and not webpack’s cache notices', () => {
    const found = check.findWarnings(PHASE_03_OUTPUT);
    expect(found).toHaveLength(3);
    expect(found.join('\n')).toContain('"middleware" file convention is deprecated');
    expect(found.join('\n')).toContain('not supported in the Edge Runtime');
    expect(check.findWarnings('▲ Next.js\n✓ Compiled successfully\n<w> cache notice')).toEqual([]);
    // Colour codes do not hide one.
    expect(check.findWarnings('\u001b[33m⚠\u001b[39m something')).toHaveLength(1);
});

it('names the Node-only modules a proxy bundle carries', () => {
    const upstashNode = fs.readFileSync(path.join(__dirname, '../../node_modules/@upstash/redis/nodejs.mjs'), 'utf8');
    const upstashFetch = fs.readFileSync(path.join(__dirname, '../../node_modules/@upstash/redis/cloudflare.mjs'), 'utf8');
    expect(check.findProxyNodeOnlyModules(upstashNode)).toEqual([expect.stringContaining('@upstash/redis')]);
    expect(check.findProxyNodeOnlyModules(upstashFetch)).toEqual([]);
    expect(check.findProxyNodeOnlyModules('require("ioredis")')).toEqual(['ioredis']);
});

it('reads the server env keys from src/env.ts and finds them in a chunk', () => {
    const keys = check.serverEnvKeys(fs.readFileSync(path.join(__dirname, '../../src/env.ts'), 'utf8'));
    expect(keys).toEqual(expect.arrayContaining(['DATA_ENCRYPTION_KEY', 'AUTH_SECRET', 'DATABASE_URL', 'TRUSTED_PROXY_HOPS']));
    expect(keys).not.toContain('NODE_ENV');
    expect(check.findServerEnvNames('{DATABASE_URL:a.string(),AUTH_SECRET:b}', keys)).toEqual(['DATABASE_URL', 'AUTH_SECRET']);
    expect(check.findServerEnvNames('i.env.NEXTAUTH_URL', keys)).toEqual([]);
    expect(check.findServerEnvNames('MY_DATABASE_URLS', keys)).toEqual([]);
});

describe('checkBuild over a build folder', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-build-'));
        fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'static', 'chunks'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'server', 'middleware.js'), 'module.exports = {}');
        fs.writeFileSync(path.join(dir, 'static', 'chunks', 'a.js'), 'console.log(1)');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('passes a clean build', () => {
        expect(check.checkBuild('✓ Compiled successfully', dir)).toEqual([]);
    });

    it('fails a warning, a Node-only proxy, a leaked schema and an empty build', () => {
        fs.writeFileSync(path.join(dir, 'server', 'middleware.js'), 'x="[Upstash Redis] Unable to get environment variables"');
        fs.writeFileSync(path.join(dir, 'static', 'chunks', 'b.js'), 'DATA_ENCRYPTION_KEY:z.string()');
        const problems = check.checkBuild(PHASE_03_OUTPUT, dir);
        expect(problems.filter((p) => p.startsWith('build warning'))).toHaveLength(3);
        expect(problems.some((p) => p.startsWith('proxy bundle carries @upstash/redis'))).toBe(true);
        expect(problems.some((p) => p.includes('names server env variables: DATA_ENCRYPTION_KEY'))).toBe(true);
        fs.rmSync(path.join(dir, 'static'), { recursive: true });
        fs.rmSync(path.join(dir, 'server', 'middleware.js'));
        expect(check.checkBuild('', dir)).toEqual([expect.stringContaining('no proxy bundle'), expect.stringContaining('no client chunks')]);
    });
});
