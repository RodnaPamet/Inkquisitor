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

const ROOT = path.resolve(__dirname, '..');

/** The lines of build output that are warnings. */
function findWarnings(output) {
    return output
        .split(/\r?\n/)
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
        .filter((l) => /^\s*⚠/.test(l) || /not supported in the Edge Runtime/.test(l));
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
    process.stdout.write('\ncheck-build: no warnings, a clean proxy bundle, no server env in client chunks\n');
}

if (require.main === module) {
    main().catch((err) => {
        process.stderr.write(`check-build: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    });
}

module.exports = { LIBRARY_CLIENT_READS, findWarnings, findProxyNodeOnlyModules, findServerEnvNames, serverEnvKeys, checkBuild, PROXY_FORBIDDEN };
