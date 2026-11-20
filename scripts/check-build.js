'use strict';
/**
 * The Build check: run `next build --webpack` and fail on what a green build
 * would otherwise carry silently (Phase 0.H, issues #8 and brief item 3).
 *
 *   1. ANY WARNING the build prints (`⚠` lines, Next's warning prefix). The two
 *      that shipped in Phase 0.4 and 0.3 were "the middleware file convention
 *      is deprecated" and "A Node.js API is used (process.version) which is not
 *      supported in the Edge Runtime" (@upstash/redis's Node entry in the
 *      proxy's graph). A build that warns is a build nobody reads: the next
 *      warning would hide behind the first two. (webpack's own `<w>` cache
 *      notices are not build warnings and are not counted.)
 *   2. THE PROXY BUNDLE carrying a Node-only module the proxy must not load:
 *      the Upstash Node entry, ioredis, Prisma, pino. The bundle is Next's
 *      (`.next/server/middleware.js`, the name it keeps for the proxy), which
 *      also contains Next's own Node adapter, so the check names modules, not
 *      Node built-ins (tests/guards/proxy-imports-no-node-only-module.test.ts
 *      holds the source graph to that).
 *   3. A CLIENT CHUNK naming a server environment variable (every key of
 *      `src/env.ts`'s `runtimeEnv` but NODE_ENV): the schema of `src/env.ts`
 *      reached the browser bundle. The source-graph guard is
 *      tests/guards/client-reachable-modules-import-no-server-env.test.ts; this
 *      reads what was actually shipped.
 *   4. AN ON-DEMAND LIBRARY in a route's first load (Phase 3.1): tldraw, which
 *      the story canvas loads with `next/dynamic` and `ssr: false`, must sit
 *      in no page's client chunks or entry stylesheets (each page's
 *      `*_client-reference-manifest.js`), and must be in some chunk. So must
 *      the story map's layout worker (Phase 3.H), which must also load no
 *      other script: its response carries the static assets' `default-src
 *      'none'`, so a worker that `importScripts` a split chunk would fail.
 *   5. THE BUNDLE BUDGET (Phase 3.H): each route's first-load JavaScript and
 *      CSS (the shared root chunks plus the route's own client chunks and
 *      entry stylesheets), gzipped, against its budget in
 *      `scripts/bundle-budget.json`. A route past its budget fails; so does a
 *      route with no budget (a new page is measured and recorded on purpose)
 *      and a budget for a route that no longer exists. See "Raising a budget"
 *      below.
 *
 *   node scripts/check-build.js                  build, then check
 *   node scripts/check-build.js --no-build       check the existing .next only
 *   node scripts/check-build.js --no-build --record-budget
 *                                                measure the existing .next and
 *                                                rewrite the budget file
 *
 * RAISING A BUDGET. A budget is the route's recorded size plus
 * `BUDGET_HEADROOM`, rounded up to a KiB, so ordinary churn passes and a new
 * dependency in a first load does not. When growth is deliberate: build, run
 * `node scripts/check-build.js --no-build --record-budget`, and commit the
 * rewritten `scripts/bundle-budget.json` in the same pull request with a line
 * in its description saying what grew and why (the diff shows the bytes). Never
 * raise the headroom to get a change through, and never record a budget from
 * a build of other code: the file is the measured truth of this tree.
 *
 * CommonJS with no dependencies, so the Jest suite can require its checks
 * (tests/unit/check-build.test.ts) and CI runs it with bare node.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * Lines Next prints with its warning prefix that are not warnings about the
 * build. Each entry is one exact message, with the reason it is not a defect;
 * nothing else is ever exempt.
 */
const NOT_BUILD_WARNINGS = [
    // Advice to persist .next/cache between CI runs. CI does cache it (ci.yml),
    // but a cold cache (first run of a key, eviction) still prints this, and
    // nothing about the build output depends on it.
    /^\s*⚠ No build cache found\. Please configure build caching for faster rebuilds\./,
];

/** The lines of build output that are warnings. */
function findWarnings(output) {
    return output
        .split(/\r?\n/)
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
        .filter((l) => /^\s*⚠/.test(l) || /not supported in the Edge Runtime/.test(l))
        .filter((l) => !NOT_BUILD_WARNINGS.some((re) => re.test(l)));
}

/** Node-only modules the proxy bundle must not carry, each by a string only it contains. */
const PROXY_FORBIDDEN = [
    { module: '@upstash/redis (Node entry; import @upstash/redis/cloudflare)', needle: '[Upstash Redis] Unable to get environment variables' },
    { module: 'ioredis', needle: 'ioredis' },
    { module: '@prisma/client', needle: '@prisma/client' },
    { module: 'pino', needle: 'pino-std-serializers' },
    { module: 'bcrypt', needle: 'bcrypt_lib' },
];

function findProxyNodeOnlyModules(bundle) {
    return PROXY_FORBIDDEN.filter((f) => bundle.includes(f.needle)).map((f) => f.module);
}

/** The server variables `src/env.ts` declares, read from its `runtimeEnv` block. */
function serverEnvKeys(envSource) {
    const block = /runtimeEnv:\s*\{([^}]*)\}/.exec(envSource);
    if (!block) throw new Error('src/env.ts: no runtimeEnv block found');
    return [...block[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1]).filter((k) => k !== 'NODE_ENV');
}

/**
 * Server variable names a LIBRARY's client code reads by itself, never through
 * `src/env.ts` (each is `undefined` in a browser). Closed, each with its reader.
 */
const LIBRARY_CLIENT_READS = {
    NEXTAUTH_URL: 'next-auth/react resolves its base URL from process.env.NEXTAUTH_URL.',
};

function findServerEnvNames(chunk, keys) {
    return keys.filter((k) => !(k in LIBRARY_CLIENT_READS) && new RegExp(`\\b${k}\\b`).test(chunk));
}

function filesUnder(dir, ext) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...filesUnder(p, ext));
        else if (p.endsWith(ext)) out.push(p);
    }
    return out;
}

/**
 * Libraries that may load only ON DEMAND, never in a route's first load
 * (Phase 3.1): tldraw is loaded with `next/dynamic` and `ssr: false` by the
 * story canvas, so no page — not even the map page — carries it up front.
 * Each is found by a string only its code (or stylesheet) contains; a build
 * where it is in no chunk at all is a problem too (a check over nothing).
 */
const ON_DEMAND_ONLY = [
    { module: 'tldraw', jsNeedle: 'TLDRAW_USER_DATA_v3', cssNeedle: '.tl-container' },
    // The story map's layout worker (Phase 3.H): its script's marker
    // (`LAYOUT_WORKER_MARKER`, src/lib/canvas/auto-layout-worker.ts).
    { module: 'the story map layout worker', jsNeedle: 'inkquisitor:story-map-layout-worker', selfContained: true },
];

/** Every page's first-load files: the chunks of its client modules and its entry stylesheets. */
function firstLoadFilesByRoute(nextDir) {
    const out = new Map();
    for (const file of filesUnder(path.join(nextDir, 'server', 'app'), '_client-reference-manifest.js')) {
        const sandbox = {};
        sandbox.globalThis = sandbox;
        vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
        for (const [route, manifest] of Object.entries(sandbox.__RSC_MANIFEST ?? {})) {
            const files = new Set();
            for (const mod of Object.values(manifest.clientModules ?? {})) for (const c of mod.chunks ?? []) files.add(decodeURIComponent(c));
            for (const sheets of Object.values(manifest.entryCSSFiles ?? {})) for (const sheet of sheets) files.add(typeof sheet === 'string' ? sheet : sheet.path);
            out.set(route, files);
        }
    }
    return out;
}

/** Problems with on-demand libraries: present in some route's first load, or built nowhere. */
function findOnDemandInFirstLoad(nextDir) {
    const problems = [];
    const staticFiles = [...filesUnder(path.join(nextDir, 'static'), '.js'), ...filesUnder(path.join(nextDir, 'static'), '.css')];
    const routes = firstLoadFilesByRoute(nextDir);
    if (routes.size === 0) problems.push('no client reference manifests under .next/server/app (the first-load check would read nothing)');
    for (const lib of ON_DEMAND_ONLY) {
        const carriers = staticFiles
            .filter((f) => {
                const needle = f.endsWith('.css') ? lib.cssNeedle : lib.jsNeedle;
                return needle !== undefined && fs.readFileSync(f, 'utf8').includes(needle);
            })
            .map((f) => path.relative(nextDir, f).split(path.sep).join('/'));
        if (!carriers.some((c) => c.endsWith('.js'))) problems.push(`${lib.module} is in no client chunk (did the canvas stop being built?)`);
        if (lib.selfContained) {
            for (const c of carriers.filter((f) => f.endsWith('.js'))) {
                if (fs.readFileSync(path.join(nextDir, c), 'utf8').includes('importScripts')) {
                    problems.push(`${lib.module} (${c}) loads other scripts; its policy (default-src 'none') refuses them, so it must be one chunk`);
                }
            }
        }
        for (const [route, files] of routes) {
            const found = carriers.filter((c) => files.has(c));
            if (found.length > 0) problems.push(`${route} loads ${lib.module} up front (${found.join(', ')}); load it with next/dynamic`);
        }
    }
    return problems;
}

// ─── The bundle budget (Phase 3.H) ─────────────────────────────────

const BUDGET_FILE = path.join(ROOT, 'scripts', 'bundle-budget.json');
/** What a budget allows above the recorded size: ordinary churn, not a new dependency. */
const BUDGET_HEADROOM = 0.1;

/** The chunks every page loads first (the webpack runtime, React, Next's client), from the build manifest. */
function rootMainFiles(nextDir) {
    const file = path.join(nextDir, 'build-manifest.json');
    if (!fs.existsSync(file)) return [];
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return [...(manifest.rootMainFiles ?? []), ...(manifest.polyfillFiles ?? [])];
}

/**
 * Each page's first load, gzipped (level 9, so the number is the file's and
 * not the machine's): the root chunks plus the page's client chunks and
 * entry stylesheets, each file counted once. Route handlers are not pages.
 */
function firstLoadSizes(nextDir) {
    const zlib = require('node:zlib');
    const sizeOf = new Map();
    const gz = (rel) => {
        if (!sizeOf.has(rel)) {
            const file = path.join(nextDir, rel);
            sizeOf.set(rel, fs.existsSync(file) ? zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length : 0);
        }
        return sizeOf.get(rel);
    };
    const shared = rootMainFiles(nextDir);
    const out = new Map();
    for (const [route, files] of firstLoadFilesByRoute(nextDir)) {
        // A page's first load; a route handler (`…/route`) sends no page.
        if (!route.endsWith('/page')) continue;
        const all = new Set([...shared, ...files]);
        let bytes = 0;
        for (const rel of all) bytes += gz(rel);
        out.set(route, bytes);
    }
    return out;
}

/** A budget file's contents for these measured sizes. */
function budgetFor(sizes, headroom = BUDGET_HEADROOM) {
    const routes = {};
    for (const route of [...sizes.keys()].sort()) {
        const recorded = sizes.get(route);
        routes[route] = { recorded, budget: Math.ceil((recorded * (1 + headroom)) / 1024) * 1024 };
    }
    return {
        note: 'Per-route first-load JS + CSS, gzipped (scripts/check-build.js, rule 5). Rewritten only by `node scripts/check-build.js --no-build --record-budget`; see "Raising a budget" there.',
        headroom: headroom,
        routes,
    };
}

/** Problems with the measured sizes against `budget` (the file's contents). */
function findBudgetProblems(sizes, budget) {
    const problems = [];
    if (sizes.size === 0) return problems;
    const routes = (budget && budget.routes) || {};
    for (const [route, bytes] of sizes) {
        const entry = routes[route];
        if (!entry) {
            problems.push(`${route} has no bundle budget (first load ${bytes} bytes gzipped); record one: node scripts/check-build.js --no-build --record-budget`);
        } else if (bytes > entry.budget) {
            problems.push(`${route} first load is ${bytes} bytes gzipped, over its budget of ${entry.budget} (recorded ${entry.recorded}); shrink it, or raise the budget deliberately (scripts/check-build.js, "Raising a budget")`);
        }
    }
    for (const route of Object.keys(routes)) {
        if (!sizes.has(route)) problems.push(`the bundle budget names ${route}, which the build no longer has; remove it (--record-budget)`);
    }
    return problems;
}

function readBudget() {
    return fs.existsSync(BUDGET_FILE) ? JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) : null;
}

/** Every problem with the build in `nextDir`, given its printed output. */
function checkBuild(output, nextDir = path.join(ROOT, '.next'), budget) {
    const problems = [];
    for (const w of findWarnings(output)) problems.push(`build warning: ${w.trim()}`);

    const proxyBundle = path.join(nextDir, 'server', 'middleware.js');
    if (!fs.existsSync(proxyBundle)) {
        problems.push('no proxy bundle at .next/server/middleware.js (did src/proxy.ts stop being built?)');
    } else {
        for (const m of findProxyNodeOnlyModules(fs.readFileSync(proxyBundle, 'utf8'))) problems.push(`proxy bundle carries ${m}`);
    }

    const keys = serverEnvKeys(fs.readFileSync(path.join(ROOT, 'src', 'env.ts'), 'utf8'));
    const chunks = filesUnder(path.join(nextDir, 'static'), '.js');
    if (chunks.length === 0) problems.push('no client chunks under .next/static (an empty build checks nothing)');
    for (const chunk of chunks) {
        const names = findServerEnvNames(fs.readFileSync(chunk, 'utf8'), keys);
        if (names.length > 0) problems.push(`${path.relative(ROOT, chunk)} names server env variables: ${names.join(', ')}`);
    }
    problems.push(...findOnDemandInFirstLoad(nextDir));
    problems.push(...findBudgetProblems(firstLoadSizes(nextDir), budget === undefined ? readBudget() : budget));
    return problems;
}

function runBuild() {
    return new Promise((resolve) => {
        const child = spawn('npx', ['next', 'build', '--webpack'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        let output = '';
        const take = (stream, sink) =>
            stream.on('data', (d) => {
                output += d.toString();
                sink.write(d);
            });
        take(child.stdout, process.stdout);
        take(child.stderr, process.stderr);
        child.on('exit', (code) => resolve({ code: code ?? 1, output }));
    });
}

async function main() {
    let output = '';
    if (process.argv.includes('--record-budget')) {
        if (!process.argv.includes('--no-build')) throw new Error('--record-budget measures an existing build: pass --no-build too');
        const budget = budgetFor(firstLoadSizes(path.join(ROOT, '.next')));
        fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`);
        process.stdout.write(`check-build: recorded the bundle budget of ${Object.keys(budget.routes).length} routes in scripts/bundle-budget.json\n`);
        return;
    }
    if (!process.argv.includes('--no-build')) {
        const built = await runBuild();
        if (built.code !== 0) process.exit(built.code);
        output = built.output;
    }
    const problems = checkBuild(output);
    if (problems.length > 0) {
        process.stderr.write(`\ncheck-build: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
        process.exit(1);
    }
    process.stdout.write('\ncheck-build: no warnings, a clean proxy bundle, no server env in client chunks, tldraw and the layout worker in no first load, every route within its bundle budget\n');
}

if (require.main === module) {
    main().catch((err) => {
        process.stderr.write(`check-build: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    });
}

module.exports = { BUDGET_HEADROOM, budgetFor, findBudgetProblems, firstLoadSizes, rootMainFiles, ON_DEMAND_ONLY, findOnDemandInFirstLoad, firstLoadFilesByRoute, LIBRARY_CLIENT_READS, findWarnings, findProxyNodeOnlyModules, findServerEnvNames, serverEnvKeys, checkBuild, PROXY_FORBIDDEN };
