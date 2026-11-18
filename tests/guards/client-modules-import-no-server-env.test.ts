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

const USE_CLIENT_DIRECTIVE = /^(['"])use client\1/;

/**
 * True when the file's prologue opens with a `'use client'` directive, after
 * any whitespace, line comments and block comments. A forward scan: each
 * character is visited once, so no input can make it backtrack (a regex with
 * a repeated group of comment alternatives could, exponentially).
 */
function isClientModule(source: string): boolean {
    let i = 0;
    for (;;) {
        while (i < source.length && /\s/.test(source[i])) i += 1;
        if (source.startsWith('//', i)) {
            const end = source.indexOf('\n', i + 2);
            if (end === -1) return false;
            i = end + 1;
        } else if (source.startsWith('/*', i)) {
            const end = source.indexOf('*/', i + 2);
            if (end === -1) return false;
            i = end + 2;
        } else {
            break;
        }
    }
    return USE_CLIENT_DIRECTIVE.test(source.slice(i, i + 12));
}

// `from '…'`, a bare side-effect `import '…'`, `import('…')` and `require('…')`.
const SERVER_ENV_IMPORT = /(?:from\s+|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:@\/env|(?:\.\.?\/)+env)['"]/;

function importsServerEnv(source: string): boolean {
    return SERVER_ENV_IMPORT.test(source);
}

describe('client modules import no server env', () => {
    it('detects the shapes it is meant to refuse (and only those)', () => {
        expect(isClientModule("'use client';\nexport {}")).toBe(true);
        expect(isClientModule('// header\n"use client"\n')).toBe(true);
        expect(isClientModule("export const x = 'use client';")).toBe(false);
    });

    it('finds the directive only in the prologue, after any comments', () => {
        expect(isClientModule('/* licence\n * header */\n// note\n\n  "use client";')).toBe(true);
        expect(isClientModule('// a\n  // b\n/** c */ /* d */\n\'use client\'')).toBe(true);
        expect(isClientModule("import x from 'y';\n'use client';")).toBe(false);
        expect(isClientModule("/* unterminated 'use client'")).toBe(false);
        expect(isClientModule("// no newline 'use client'")).toBe(false);
        expect(isClientModule('')).toBe(false);
    });

    it('scans adversarial comment runs in linear time', () => {
        // Many adjacent closed comments: the old nested-repetition regex
        // backtracked exponentially here (about a second at 28 repeats).
        const closed = '/**/ '.repeat(30) + 'x';
        const unterminated = '/*'.repeat(100_000);
        const start = Date.now();
        expect(isClientModule(closed)).toBe(false);
        expect(isClientModule(unterminated)).toBe(false);
        expect(isClientModule('/**/ '.repeat(100_000) + "'use client'")).toBe(true);
        expect(Date.now() - start).toBeLessThan(1000);
    });

    it('detects server env imports (and only those)', () => {
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
