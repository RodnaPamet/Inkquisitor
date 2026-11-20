/**
 * scripts/check-build.js — the Build check's own rules (issue #8, brief item 3).
 *
 * The two warnings are the ones the Phase 0.3 build really printed; the
 * bundles are built in a temporary folder, so each rule is shown to refuse
 * what it is for and to pass a clean build.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const check = require('../../scripts/check-build.js') as {
    findWarnings(output: string): string[];
    findProxyNodeOnlyModules(bundle: string): string[];
    findServerEnvNames(chunk: string, keys: string[]): string[];
    serverEnvKeys(envSource: string): string[];
    checkBuild(output: string, nextDir: string, budget?: unknown): string[];
    findOnDemandInFirstLoad(nextDir: string): string[];
    firstLoadSizes(nextDir: string): Map<string, number>;
    budgetFor(sizes: Map<string, number>, headroom?: number): { headroom: number; routes: Record<string, { recorded: number; budget: number }> };
    findBudgetProblems(sizes: Map<string, number>, budget: unknown): string[];
    BUDGET_HEADROOM: number;
};

/** A page's client reference manifest, as `next build` writes it. */
function writeManifest(dir: string, route: string, chunks: string[], css: string[] = []): void {
    const file = path.join(dir, 'server', 'app', ...route.split('/').filter(Boolean), 'page_client-reference-manifest.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const manifest = { clientModules: { m1: { id: 1, name: '*', chunks, async: false } }, entryCSSFiles: { [route]: css.map((p) => ({ inlined: false, path: p })) } };
    fs.writeFileSync(file, `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST[${JSON.stringify(route + '/page')}]=${JSON.stringify(manifest)};`);
}

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
    // The cold-cache advice is the one exempt line; anything else with the prefix still counts.
    expect(check.findWarnings('⚠ No build cache found. Please configure build caching for faster rebuilds. Read more: https://nextjs.org/docs/messages/no-cache')).toEqual([]);
    expect(check.findWarnings('⚠ No build cache found. Please configure build caching for faster rebuilds.\n⚠ Something else')).toEqual(['⚠ Something else']);
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
        // tldraw, in a chunk of its own that no page loads up front (Phase 3.1).
        fs.writeFileSync(path.join(dir, 'static', 'chunks', '399.js'), 'x="TLDRAW_USER_DATA_v3"');
        // The layout worker, one self-contained chunk no page loads up front (Phase 3.H).
        fs.writeFileSync(path.join(dir, 'static', 'chunks', 'layout-worker.js'), 'postMessage({worker:"inkquisitor:story-map-layout-worker"})');
        writeManifest(dir, '/w/[slug]/books', ['static/chunks/a.js']);
    });
    /** The budget this folder's build records: what a clean build is held to. */
    const recorded = () => check.budgetFor(check.firstLoadSizes(dir));
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('passes a clean build', () => {
        expect(check.checkBuild('✓ Compiled successfully', dir, recorded())).toEqual([]);
    });

    it('fails a warning, a Node-only proxy, a leaked schema and an empty build', () => {
        fs.writeFileSync(path.join(dir, 'server', 'middleware.js'), 'x="[Upstash Redis] Unable to get environment variables"');
        fs.writeFileSync(path.join(dir, 'static', 'chunks', 'b.js'), 'DATA_ENCRYPTION_KEY:z.string()');
        const problems = check.checkBuild(PHASE_03_OUTPUT, dir, recorded());
        expect(problems.filter((p) => p.startsWith('build warning'))).toHaveLength(3);
        expect(problems.some((p) => p.startsWith('proxy bundle carries @upstash/redis'))).toBe(true);
        expect(problems.some((p) => p.includes('names server env variables: DATA_ENCRYPTION_KEY'))).toBe(true);
        fs.rmSync(path.join(dir, 'static'), { recursive: true });
        fs.rmSync(path.join(dir, 'server', 'middleware.js'));
        expect(check.checkBuild('', dir, recorded())).toEqual([
            expect.stringContaining('no proxy bundle'),
            expect.stringContaining('no client chunks'),
            expect.stringContaining('tldraw is in no client chunk'),
            expect.stringContaining('the story map layout worker is in no client chunk'),
        ]);
    });

    it('fails a page that loads tldraw up front, by script or by stylesheet (Phase 3.1)', () => {
        writeManifest(dir, '/w/[slug]/books/[bookId]/maps/[kind]', ['static/chunks/a.js', 'static/chunks/399.js']);
        fs.mkdirSync(path.join(dir, 'static', 'css'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'static', 'css', 'tl.css'), '.tl-container{}');
        writeManifest(dir, '/w/[slug]/settings', ['static/chunks/a.js'], ['static/css/tl.css']);
        expect(check.findOnDemandInFirstLoad(dir)).toEqual([
            expect.stringMatching(/maps\/\[kind\]\/page loads tldraw up front \(static\/chunks\/399\.js\)/),
            expect.stringMatching(/settings\/page loads tldraw up front \(static\/css\/tl\.css\)/),
        ]);
    });

    it('fails a build with no page manifests to read', () => {
        fs.rmSync(path.join(dir, 'server', 'app'), { recursive: true });
        expect(check.findOnDemandInFirstLoad(dir)).toEqual([expect.stringContaining('no client reference manifests')]);
    });
});

describe('the layout worker (Phase 3.H)', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-build-worker-'));
        fs.mkdirSync(path.join(dir, 'static', 'chunks'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'static', 'chunks', '399.js'), 'x="TLDRAW_USER_DATA_v3"');
        writeManifest(dir, '/w/[slug]/books', ['static/chunks/a.js']);
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('fails a page that loads it up front, and a worker that loads other scripts (its policy refuses them)', () => {
        fs.writeFileSync(path.join(dir, 'static', 'chunks', 'w.js'), 'importScripts("/_next/static/chunks/dagre.js");x="inkquisitor:story-map-layout-worker"');
        writeManifest(dir, '/w/[slug]/books/[bookId]/maps/[kind]', ['static/chunks/w.js']);
        expect(check.findOnDemandInFirstLoad(dir)).toEqual([
            expect.stringContaining('loads other scripts'),
            expect.stringMatching(/maps\/\[kind\]\/page loads the story map layout worker up front/),
        ]);
    });
});

describe('the bundle budget (Phase 3.H)', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-build-budget-'));
        fs.mkdirSync(path.join(dir, 'static', 'chunks'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'static', 'css'), { recursive: true });
        // Incompressible (hash output), and the same on every run, so a size is a size.
        const noise = (n: number, seed: number) => Buffer.concat(Array.from({ length: Math.ceil(n / 32) }, (_, k) => createHash('sha256').update(`${seed}:${k}`).digest())).subarray(0, n);
        fs.writeFileSync(path.join(dir, 'static', 'chunks', 'main.js'), noise(20_000, 1));
        fs.writeFileSync(path.join(dir, 'static', 'chunks', 'books.js'), noise(5_000, 2));
        fs.writeFileSync(path.join(dir, 'static', 'chunks', 'settings.js'), noise(1_000, 3));
        fs.writeFileSync(path.join(dir, 'static', 'css', 'app.css'), noise(3_000, 4));
        fs.writeFileSync(path.join(dir, 'build-manifest.json'), JSON.stringify({ rootMainFiles: ['static/chunks/main.js'], polyfillFiles: [] }));
        writeManifest(dir, '/w/[slug]/books', ['static/chunks/books.js'], ['static/css/app.css']);
        writeManifest(dir, '/w/[slug]/settings', ['static/chunks/settings.js', 'static/chunks/main.js']);
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('measures each route’s first load: the root chunks, its chunks and its stylesheets, each file once, gzipped', () => {
        const sizes = check.firstLoadSizes(dir);
        expect([...sizes.keys()].sort()).toEqual(['/w/[slug]/books/page', '/w/[slug]/settings/page']);
        // Incompressible: gzip adds a little; the shared root chunk counts once on the settings page.
        expect(sizes.get('/w/[slug]/books/page')).toBeGreaterThan(28_000);
        expect(sizes.get('/w/[slug]/settings/page')).toBeGreaterThan(21_000);
        expect(sizes.get('/w/[slug]/settings/page')).toBeLessThan(22_000);
    });

    it('records a budget with headroom, and holds a route to it', () => {
        const sizes = check.firstLoadSizes(dir);
        const budget = check.budgetFor(sizes);
        const books = budget.routes['/w/[slug]/books/page'];
        expect(books.recorded).toBe(sizes.get('/w/[slug]/books/page'));
        expect(books.budget).toBeGreaterThanOrEqual(books.recorded * (1 + check.BUDGET_HEADROOM));
        expect(books.budget % 1024).toBe(0);
        expect(check.findBudgetProblems(sizes, budget)).toEqual([]);
    });

    it('fails growth past the budget, a route with no budget, and a budget for a route that is gone', () => {
        const budget = check.budgetFor(check.firstLoadSizes(dir));
        // A new dependency in the books page's first load: 40 KB more.
        fs.writeFileSync(path.join(dir, 'static', 'chunks', 'books.js'), Buffer.concat(Array.from({ length: 1400 }, (_, k) => createHash('sha256').update(`grow:${k}`).digest())));
        writeManifest(dir, '/w/[slug]/search', ['static/chunks/settings.js']);
        const routes = { ...budget.routes, '/w/[slug]/gone/page': { recorded: 1, budget: 1024 } };
        const problems = check.findBudgetProblems(check.firstLoadSizes(dir), { ...budget, routes });
        expect(problems).toEqual([
            expect.stringMatching(/^\/w\/\[slug\]\/books\/page first load is \d+ bytes gzipped, over its budget of \d+/),
            expect.stringMatching(/^\/w\/\[slug\]\/search\/page has no bundle budget/),
            expect.stringContaining('names /w/[slug]/gone/page, which the build no longer has'),
        ]);
    });

    it('the committed budget names routes, and every budget is its recorded size plus the headroom', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const committed = require('../../scripts/bundle-budget.json') as { headroom: number; routes: Record<string, { recorded: number; budget: number }> };
        expect(committed.headroom).toBe(check.BUDGET_HEADROOM);
        const entries = Object.entries(committed.routes);
        expect(entries.length).toBeGreaterThan(10);
        for (const [route, { recorded, budget }] of entries) {
            expect([route, budget]).toEqual([route, Math.ceil((recorded * (1 + check.BUDGET_HEADROOM)) / 1024) * 1024]);
        }
        // The map page is budgeted like any other: tldraw is not in its first load.
        expect(committed.routes['/w/[workspaceSlug]/books/[bookId]/maps/[kind]/page']).toBeDefined();
    });
});
