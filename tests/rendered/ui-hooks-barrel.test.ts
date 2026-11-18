/**
 * The hooks barrel (`@/components/ui/hooks`) exports every shared hook.
 *
 * Rule followed from inflect-compliance's `ui-hooks-barrel` guard (see
 * docs/carve-manifest.md), checked by identity instead of by regex: every
 * `use-*.ts(x)` module in the two hook directories is imported, and each
 * `use…` function it exports must be the SAME function object the barrel
 * exports under that name. A hook added without a barrel line fails here,
 * and so does a barrel line pointing at a stale copy.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as barrel from '@/components/ui/hooks';

const ROOT = path.resolve(__dirname, '../..');
const DIRS = [
    { dir: 'src/components/ui/hooks', spec: (stem: string) => `@/components/ui/hooks/${stem}` },
    { dir: 'packages/ui/src/components/ui/hooks', spec: (stem: string) => `@inkquisitor/ui/components/ui/hooks/${stem}` },
];

const MODULES = DIRS.flatMap(({ dir, spec }) =>
    fs
        .readdirSync(path.join(ROOT, dir))
        .filter((f) => /^use-.+\.tsx?$/.test(f))
        .map((f) => ({ file: `${dir}/${f}`, spec: spec(f.replace(/\.tsx?$/, '')) })),
);

describe('ui hooks barrel', () => {
    it('finds the hook modules in both directories', () => {
        expect(MODULES.filter((m) => m.file.startsWith('src/')).length).toBeGreaterThanOrEqual(3);
        expect(MODULES.filter((m) => m.file.startsWith('packages/')).length).toBeGreaterThanOrEqual(10);
    });

    it.each(MODULES.map((m) => [m.file, m.spec]))('%s: every exported hook is re-exported by the barrel', (_file, spec) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(spec) as Record<string, unknown>;
        const hooks = Object.entries(mod).filter(([name, value]) => /^use[A-Z]/.test(name) && typeof value === 'function');
        expect(hooks.length).toBeGreaterThan(0);
        const missing = hooks
            .filter(([name, value]) => (barrel as Record<string, unknown>)[name] !== value)
            .map(([name]) => name);
        expect(missing).toEqual([]);
    });
});
