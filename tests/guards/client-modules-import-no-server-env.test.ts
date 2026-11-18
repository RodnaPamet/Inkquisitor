/**
 * A `'use client'` module never imports the server env module.
 *
 * `src/env.ts` is server-only. Its values never reach a browser, but its
 * schema would be bundled into every route whose client graph reaches it.
 * Client code reads `@/env-client`. This guard scans every `'use client'`
 * file git knows about; it has no allowlist.
 *
 * Phase 0.H widens it to the transitive import graph (as inflect-compliance's
 * client-reachable-modules guard does) once there are client modules that
 * import one another.
 */
import * as fs from 'node:fs';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const USE_CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*['"]use client['"]/;
// `from '…'`, a bare side-effect `import '…'`, `import('…')` and `require('…')`.
const SERVER_ENV_IMPORT = /(?:from\s+|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:@\/env|(?:\.\.?\/)+env)['"]/;

function importsServerEnv(source: string): boolean {
    return SERVER_ENV_IMPORT.test(source);
}

function isClientModule(source: string): boolean {
    return USE_CLIENT.test(source);
}

describe('client modules import no server env', () => {
    it('detects the shapes it is meant to refuse (and only those)', () => {
        expect(isClientModule("'use client';\nexport {}")).toBe(true);
        expect(isClientModule('// header\n"use client"\n')).toBe(true);
        expect(isClientModule("export const x = 'use client';")).toBe(false);
        expect(importsServerEnv("import { env } from '@/env';")).toBe(true);
        expect(importsServerEnv("const { env } = await import('@/env');")).toBe(true);
        expect(importsServerEnv("import { env } from '../env';")).toBe(true);
        expect(importsServerEnv("import '@/env';")).toBe(true);
        expect(importsServerEnv('import "../env";')).toBe(true);
        expect(importsServerEnv("const e = require('@/env');")).toBe(true);
        expect(importsServerEnv("import { env } from '@/env-client';")).toBe(false);
        expect(importsServerEnv("import '@/env-client';")).toBe(false);
        expect(importsServerEnv("import '@/environment';")).toBe(false);
    });

    it('no "use client" file under src imports @/env', () => {
        const offenders = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })
            .filter((file) => {
                const src = fs.readFileSync(file, 'utf8');
                return isClientModule(src) && importsServerEnv(src);
            })
            .map(repoRelative);
        expect(offenders).toEqual([]);
    });
});
