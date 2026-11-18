/**
 * The CI workflow keeps the shape Phase 0.1 set: the four required checks by
 * exact name, the triggers, superseded-run cancellation, Node 24, and no
 * secret anywhere. A required check is matched by NAME in branch protection,
 * so a renamed job silently stops being required — this test is where that
 * rename fails instead.
 *
 * Read as text: the file is small and fixed in shape, and a YAML dependency
 * for one test is not worth carrying.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ci = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');

/** Top-level job blocks: `  <id>:` at two spaces under `jobs:`. */
function jobs(): Record<string, string> {
    const body = ci.slice(ci.indexOf('\njobs:\n') + '\njobs:\n'.length);
    const out: Record<string, string> = {};
    const parts = body.split(/^ {2}(?=[a-z][\w-]*:\s*$)/m).filter((p) => p.trim());
    for (const part of parts) {
        const id = /^([a-z][\w-]*):/.exec(part)?.[1];
        if (id) out[id] = part;
    }
    return out;
}

describe('.github/workflows/ci.yml', () => {
    const all = jobs();

    it('has exactly the jobs Lint, Typecheck, Test and Build', () => {
        const names = Object.values(all).map((b) => /^ {4}name: (.+)$/m.exec(b)?.[1]);
        expect(names).toEqual(['Lint', 'Typecheck', 'Test', 'Build']);
    });

    it('runs on pull requests and on pushes to main', () => {
        expect(ci).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n/m);
    });

    it('cancels a superseded pull-request run', () => {
        expect(ci).toMatch(/^ {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
    });

    it('gives every push its own per-commit group, so no queued main run is evicted', () => {
        const group = /^concurrency:\n {2}group: (.+)$/m.exec(ci)?.[1];
        // The push arm must come first and key on the commit; a per-ref group
        // for pushes holds one pending run and evicts the one in the middle.
        expect(group).toBe(
            "ci-${{ github.workflow }}-${{ github.event_name == 'push' && github.sha || github.event.pull_request.number || github.ref }}",
        );
    });

    it('installs with npm ci on Node 24, cached, in every job', () => {
        expect(ci).toMatch(/^ {2}NODE_VERSION: '24'$/m);
        for (const [id, block] of Object.entries(all)) {
            expect([id, /node-version: \$\{\{ env\.NODE_VERSION \}\}/.test(block)]).toEqual([id, true]);
            expect([id, /cache: npm/.test(block)]).toEqual([id, true]);
            expect([id, /- run: npm ci$/m.test(block)]).toEqual([id, true]);
        }
    });

    it('Test runs unit and integration tests against a postgres:16 service', () => {
        const test = all.test;
        expect(test).toMatch(/services:\n {6}postgres:\n {8}image: postgres:16\n/);
        expect(test).toMatch(/run: npm test\b/);
        expect(test).toMatch(/run: npm run test:integration\b/);
    });

    it('Build succeeds without secrets', () => {
        expect(all.build).toMatch(/SKIP_ENV_VALIDATION: '1'/);
        expect(all.build).toMatch(/- run: npm run build$/m);
        expect(ci).not.toMatch(/secrets\./);
    });
});
