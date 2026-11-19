/**
 * No test file reaches the Docker build context. `next build` inside the image
 * type-checks every file tsconfig.json includes, and test files import
 * tests/helpers, which .dockerignore leaves out: one co-located test in the
 * context fails the image build (0.H, eslint-rules/__tests__). The population
 * is git's.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';

/** The directory patterns .dockerignore excludes (lines ending in `/`). */
function excludedDirs(): { anywhere: boolean; dir: string }[] {
    return fs
        .readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('!') && l.endsWith('/'))
        .map((l) => (l.startsWith('**/') ? { anywhere: true, dir: l.slice(3, -1) } : { anywhere: false, dir: l.replace(/^\//, '').slice(0, -1) }));
}

function excluded(file: string, dirs: ReturnType<typeof excludedDirs>): boolean {
    const parts = file.split('/');
    return dirs.some(({ anywhere, dir }) =>
        anywhere ? parts.slice(0, -1).includes(dir) : file === dir || file.startsWith(`${dir}/`),
    );
}

it('every test file is outside the Docker build context', () => {
    const dirs = excludedDirs();
    const tests = repoRelativeFiles().filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
    expect(tests.length).toBeGreaterThan(50);
    expect(tests.filter((f) => !excluded(f, dirs))).toEqual([]);
});

it('the matcher reads both pattern kinds', () => {
    const dirs = [{ anywhere: false, dir: 'tests' }, { anywhere: true, dir: '__tests__' }];
    expect(excluded('tests/unit/x.test.ts', dirs)).toBe(true);
    expect(excluded('eslint-rules/__tests__/x.test.ts', dirs)).toBe(true);
    expect(excluded('src/lib/x.test.ts', dirs)).toBe(false);
});
