/**
 * docs/carve-manifest.md stays true of the tree (roadmap rule 7): every file
 * it lists as copied or adapted exists, and every row names its source path
 * and a full source commit. A file deleted or renamed without its row being
 * updated fails here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const manifest = fs.readFileSync(path.join(ROOT, 'docs/carve-manifest.md'), 'utf8');

/** Rows of the table under the given `## ` heading, as cell arrays. */
function tableUnder(heading: string): string[][] {
    const start = manifest.indexOf(`## ${heading}\n`);
    if (start < 0) throw new Error(`carve-manifest: no "## ${heading}" section`);
    const rest = manifest.slice(start + heading.length + 4);
    const end = rest.search(/^## /m);
    const section = end < 0 ? rest : rest.slice(0, end);
    return section
        .split('\n')
        .filter((l) => l.startsWith('|'))
        .slice(2) // header + separator
        .map((l) => l.slice(1, -1).split(' | ').map((c) => c.trim()));
}

const code = (cell: string) => /^`([^`]+)`$/.exec(cell)?.[1];

describe('docs/carve-manifest.md', () => {
    const copied = tableUnder('Copied or adapted files');

    it('lists the files copied in Phase 0.1', () => {
        const paths = copied.map((r) => code(r[0]));
        expect(paths).toEqual(
            expect.arrayContaining(['LICENSE', 'docker-compose.yml', 'Dockerfile', 'src/env.ts', 'src/env-client.ts']),
        );
    });

    it('every copied file exists in Inkquisitor', () => {
        const missing = copied.map((r) => code(r[0]) ?? r[0]).filter((p) => !fs.existsSync(path.join(ROOT, p)));
        expect(missing).toEqual([]);
    });

    it('every row names a source path, a full source commit and its edits', () => {
        const bad = copied.filter(
            (r) => r.length !== 4 || !code(r[1]) || !/^`[0-9a-f]{40}`$/.test(r[2]) || r[3].length === 0,
        );
        expect(bad).toEqual([]);
    });

    it('lists each Inkquisitor path once', () => {
        const paths = copied.map((r) => r[0]);
        expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual([]);
    });

    it('every file whose lineage is recorded as "rule followed" exists', () => {
        const missing = tableUnder('Rules followed, code new')
            .map((r) => code(r[0]) ?? r[0])
            .filter((p) => !fs.existsSync(path.join(ROOT, p)));
        expect(missing).toEqual([]);
    });
});
