/**
 * A module a client component can reach does not import `src/env.ts`
 * (Phase 0.H, brief item 3; it replaces the one-hop
 * `client-modules-import-no-server-env` guard of Phase 0.1).
 *
 * `src/env.ts` is server-only. A server variable's VALUE never reaches a
 * browser — t3-env throws on a server key read from the client — but its
 * SCHEMA is ordinary module code: the key names, the `z.string()…` calls and
 * the whole `runtimeEnv` mapping. `next build` bundles everything a
 * `'use client'` file statically reaches, so ONE import edge, however many
 * modules away, puts all of it into a route's First Load JS. The one-hop
 * guard saw only a `'use client'` file importing `@/env` itself; a client
 * file importing a helper that imports `@/env` passed it.
 *
 * NO ALLOWLIST. A client-reachable module that needs a variable declares a
 * `NEXT_PUBLIC_` one in `src/env-client.ts` (the only kind a browser can
 * read), or the module is not really client-side and moves behind a server
 * module.
 *
 * The built bundle is checked too: `scripts/check-build.mjs` fails when a
 * server variable's name appears in any client chunk.
 *
 * Adapted from inflect-compliance's
 * `tests/guards/client-reachable-modules-import-no-server-env.test.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bundledSpecifiers, clientRoots, isClientModule, reachFrom } from '../helpers/client-import-graph';
import { REPO_ROOT, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const SERVER_ENV = path.join(REPO_ROOT, 'src/env.ts');
const CLIENT_ENV = path.join(REPO_ROOT, 'src/env-client.ts');

describe('a module a client component can reach imports no server env', () => {
    const clientFiles = clientRoots();
    const { reached, via } = reachFrom(clientFiles);

    it('src/env.ts is not reachable from any `use client` file', () => {
        const reachable = reached.has(SERVER_ENV);
        expect({ reachable, path: reachable ? via(SERVER_ENV) : 'none' }).toEqual({ reachable: false, path: 'none' });
    });

    /*
        THE POSITIVE COMPANION. "src/env.ts was not reached" is satisfied just
        as well by a walk that reached nothing — a renamed helper, a
        `clientRoots()` that silently returns [] — so the walk is shown to work:
        it finds the client roots, follows them past the roots themselves, and
        crosses into the UI package through its alias.
    */
    it('actually walked a client graph, through the package alias', () => {
        expect(clientFiles.length).toBeGreaterThan(50);
        expect(reached.size).toBeGreaterThan(clientFiles.length);
        const cn = path.join(REPO_ROOT, 'packages/ui/src/lib/cn.ts');
        expect(reached.has(cn)).toBe(true);
        expect(via(cn)).toContain('packages/ui/src/lib/cn.ts');
    });

    it('would report a server env import two modules away (an in-memory proof)', () => {
        // The edges the walker reads, on sources that never touch the disk.
        expect(bundledSpecifiers("import { helper } from '@/lib/helper';", 'a.tsx')).toEqual(['@/lib/helper']);
        expect(bundledSpecifiers("import { env } from '@/env';\nexport const x = env.X;")).toEqual(['@/env']);
        expect(bundledSpecifiers("import type { Env } from '@/env';")).toEqual([]);
        expect(bundledSpecifiers("export { env } from '@/env';")).toEqual(['@/env']);
        expect(bundledSpecifiers("const m = await import('@/env');")).toEqual(['@/env']);
    });

    it('finds the directive only in the prologue, after any comments', () => {
        expect(isClientModule("'use client';\nexport {}")).toBe(true);
        expect(isClientModule('/* licence */\n// note\n"use client";')).toBe(true);
        expect(isClientModule("export const x = 'use client';")).toBe(false);
        expect(isClientModule("import x from 'y';\n'use client';")).toBe(false);
    });

    it('the client env module declares only NEXT_PUBLIC_ variables', () => {
        const src = codeOf(fs.readFileSync(CLIENT_ENV, 'utf8'));
        const block = src.slice(src.indexOf('client: {'), src.indexOf('runtimeEnv'));
        const keys = [...block.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
        expect(keys.filter((k) => !k.startsWith('NEXT_PUBLIC_'))).toEqual([]);
    });

    it('the server env module declares no client variable (an empty `client: {}` only) and no NEXT_PUBLIC_ one', () => {
        const src = codeOf(fs.readFileSync(SERVER_ENV, 'utf8'));
        expect({
            nonEmptyClientBlocks: [...src.matchAll(/^\s*client:\s*\{(?!\s*\})/gm)].length,
            nextPublic: [...new Set([...src.matchAll(/NEXT_PUBLIC_[A-Z0-9_]*/g)].map((m) => m[0]))],
        }).toEqual({ nonEmptyClientBlocks: 0, nextPublic: [] });
    });

    it('names the files it is about, so a rename cannot make it vacuous', () => {
        expect(repoRelative(SERVER_ENV)).toBe('src/env.ts');
        expect(fs.existsSync(SERVER_ENV)).toBe(true);
        expect(fs.existsSync(CLIENT_ENV)).toBe(true);
    });
});
