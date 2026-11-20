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
 *      `*_client-reference-manifest.js`), and must be in some chunk.
 *
 *   node scripts/check-build.js            build, then check
 *   node scripts/check-build.js --no-build check the existing .next only
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
const ON_DEMAND_ONLY = [{ module: 'tldraw', jsNeedle: 'TLDRAW_USER_DATA_v3', cssNeedle: '.tl-container' }];

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
            .filter((f) => fs.readFileSync(f, 'utf8').includes(f.endsWith('.css') ? lib.cssNeedle : lib.jsNeedle))
            .map((f) => path.relative(nextDir, f).split(path.sep).join('/'));
        if (!carriers.some((c) => c.endsWith('.js'))) problems.push(`${lib.module} is in no client chunk (did the canvas stop being built?)`);
        for (const [route, files] of routes) {
            const found = carriers.filter((c) => files.has(c));
            if (found.length > 0) problems.push(`${route} loads ${lib.module} up front (${found.join(', ')}); load it with next/dynamic`);
        }
    }
    return problems;
}

/** Every problem with the build in `nextDir`, given its printed output. */
function checkBuild(output, nextDir = path.join(ROOT, '.next')) {
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
    process.stdout.write('\ncheck-build: no warnings, a clean proxy bundle, no server env in client chunks, tldraw in no first load\n');
}

if (require.main === module) {
    main().catch((err) => {
        process.stderr.write(`check-build: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    });
}

module.exports = { ON_DEMAND_ONLY, findOnDemandInFirstLoad, firstLoadFilesByRoute, LIBRARY_CLIENT_READS, findWarnings, findProxyNodeOnlyModules, findServerEnvNames, serverEnvKeys, checkBuild, PROXY_FORBIDDEN };
