/**
 * The release workflow runs on GITHUB_TOKEN alone: no stored secret, no
 * commit back to main (which a protected main refuses from that token), and
 * a token that can write contents and nothing else.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
const rc = JSON.parse(fs.readFileSync(path.join(ROOT, '.releaserc.json'), 'utf8'));

it('runs semantic-release on pushes to main', () => {
    expect(wf).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]/m);
    expect(wf).toMatch(/run: \.\/release\/node_modules\/\.bin\/semantic-release$/m);
    expect(rc.branches).toEqual(['main']);
});

it('installs the release tooling from a committed lockfile, never through npx ranges', () => {
    const runs = [...wf.matchAll(/^\s+run: (.*)$/gm)].map((m) => m[1]);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.filter((r) => /\bnpx\b/.test(r))).toEqual([]);
    expect(wf).toMatch(/run: npm ci --prefix release --ignore-scripts\b/);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'release/package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'release/package-lock.json'), 'utf8'));
    // An exact pin in package.json, and the lockfile resolves that version.
    expect(pkg.dependencies['semantic-release']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages['node_modules/semantic-release'].version).toBe(pkg.dependencies['semantic-release']);
    // Every plugin .releaserc.json names is in the locked tree.
    for (const p of rc.plugins) {
        const name = Array.isArray(p) ? p[0] : p;
        expect(lock.packages[`node_modules/${name}`]).toBeDefined();
    }
});

it('does not persist the token in the checkout', () => {
    expect(wf).toMatch(/uses: actions\/checkout@v\d+\n\s+with:\n(?:\s+#.*\n|\s+[a-z-]+: .*\n)*?\s+persist-credentials: false/);
});

it('uses the job token and no stored secret', () => {
    expect(wf).toMatch(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    expect(wf).not.toMatch(/\$\{\{\s*secrets\./);
});

it('writes contents only', () => {
    const writes = [...wf.matchAll(/^\s+([a-z-]+): write$/gm)].map((m) => m[1]);
    expect(writes).toEqual(['contents']);
});

it('pushes no commit back: no git or changelog plugin, no comments', () => {
    const names = rc.plugins.map((p: string | [string, unknown]) => (Array.isArray(p) ? p[0] : p));
    expect(names).toEqual([
        '@semantic-release/commit-analyzer',
        '@semantic-release/release-notes-generator',
        '@semantic-release/github',
    ]);
    const github = rc.plugins.find((p: unknown) => Array.isArray(p) && p[0] === '@semantic-release/github')[1];
    expect(github).toMatchObject({ successComment: false, failComment: false });
});
