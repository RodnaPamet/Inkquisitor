/**
 * The proxy's import graph reaches no Node-only module (Phase 0.H, issue #8).
 *
 * Next 16 runs `src/proxy.ts` on the Node runtime, so a Node-only import would
 * not fail the build. It is refused anyway: the proxy runs on EVERY request,
 * before any route, and its graph has been kept runtime-neutral (Web Crypto,
 * `fetch`, a console logger) since it was edge middleware. Two things went
 * wrong when it was not: `@upstash/redis`'s package root is its Node entry,
 * which read `process.version` and put an Edge Runtime warning in every build;
 * and a database client, an ioredis connection or pino in this graph would be
 * loaded on the path of every request, including the probes.
 *
 * The walk is tests/helpers/client-import-graph.ts. The PACKAGES the graph
 * may reach are a closed list: a new one is a reviewed entry here. Node
 * built-ins (`node:*` and the bare names) are refused outright, wherever in
 * the graph they appear. `scripts/check-build.mjs` checks the bundle the
 * build actually produces for the same thing.
 */
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { reachFrom } from '../helpers/client-import-graph';
import { REPO_ROOT, repoRelative } from '../helpers/repo-files';

const PROXY = path.join(REPO_ROOT, 'src/proxy.ts');

/** The packages the proxy's graph may import, each with why it is runtime-neutral. */
const ALLOWED_PACKAGES: Readonly<Record<string, string>> = {
    'next/server': 'NextRequest / NextResponse: the proxy contract itself.',
    'next-auth/jwt': '`getToken` decodes the session cookie with Web Crypto (jose).',
    '@t3-oss/env-nextjs': 'The env schema (src/env.ts): pure validation.',
    zod: 'Pure validation.',
    '@upstash/ratelimit': 'The edge tiers’ limiter: REST over fetch.',
    '@upstash/redis/cloudflare': 'The fetch-only Upstash entry. NOT the package root, which is the Node entry.',
};

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

describe('the proxy imports no Node-only module', () => {
    const { reached, unresolved, via } = reachFrom([PROXY]);

    it('walked the proxy (a walk that reached nothing would pass)', () => {
        expect(reached.has(path.join(REPO_ROOT, 'src/lib/rate-limit/edge-tier.ts'))).toBe(true);
        expect(reached.has(path.join(REPO_ROOT, 'src/lib/security/csp.ts'))).toBe(true);
        expect(unresolved.length).toBeGreaterThan(0);
    });

    it('reaches no Node built-in', () => {
        const builtins = unresolved.filter((u) => NODE_BUILTINS.has(u.spec)).map((u) => `${via(u.module)} → ${u.spec}`);
        expect(builtins).toEqual([]);
    });

    it('reaches only the packages listed, by the entry listed', () => {
        const unlisted = unresolved
            .filter((u) => !NODE_BUILTINS.has(u.spec) && !(u.spec in ALLOWED_PACKAGES))
            .map((u) => `${via(u.module)} → ${u.spec}`);
        expect(unlisted).toEqual([]);
    });

    it('never reaches the database client, Redis, pino or the Node logger', () => {
        const forbidden = ['src/lib/db.ts', 'src/lib/redis.ts', 'src/lib/observability/logger.ts', 'src/auth.ts'];
        expect(forbidden.filter((f) => reached.has(path.join(REPO_ROOT, f)))).toEqual([]);
    });

    it('the list is not stale: every allowed package is still imported', () => {
        const used = new Set(unresolved.map((u) => u.spec));
        expect(Object.keys(ALLOWED_PACKAGES).filter((p) => !used.has(p))).toEqual([]);
        expect(repoRelative(PROXY)).toBe('src/proxy.ts');
    });
});
