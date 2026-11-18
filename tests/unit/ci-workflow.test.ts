/**
 * The CI workflow keeps its shape: the required checks by exact name (Phase
 * 0.1's four plus Phase 0.4's Security, CodeQL and Docker), the triggers,
 * superseded-run cancellation, Node 24, the security gates at their
 * strictness, and no secret anywhere. A required check is matched by NAME in branch protection,
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

    it('has exactly the jobs Lint, Typecheck, Test, Build, Security, CodeQL and Docker', () => {
        const names = Object.values(all).map((b) => /^ {4}name: (.+)$/m.exec(b)?.[1]);
        expect(names).toEqual(['Lint', 'Typecheck', 'Test', 'Build', 'Security', 'CodeQL', 'Docker']);
    });

    it('is read-only by default; only CodeQL may write, and only security events', () => {
        expect(ci).toMatch(/^permissions:\n {2}contents: read\n/m);
        const writers = Object.entries(all).filter(([, b]) => /: write/.test(b)).map(([id]) => id);
        expect(writers).toEqual(['codeql']);
        expect(all.codeql).toMatch(/security-events: write/);
    });

    it('pins every third-party action to at least a major version', () => {
        const uses = [...ci.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
        expect(uses.length).toBeGreaterThan(0);
        for (const u of uses) expect([u, /@v\d+(\.\d+){0,2}$/.test(u)]).toEqual([u, true]);
    });

    it('Security gates npm audit at moderate on production deps and runs the secret scan', () => {
        expect(all.security).toMatch(/run: npm audit --omit=dev --audit-level=moderate$/m);
        expect(all.security).toMatch(/run: bash scripts\/detect-secrets\.sh --all$/m);
    });

    it('CodeQL analyses javascript-typescript with github/codeql-action', () => {
        expect(all.codeql).toMatch(/uses: github\/codeql-action\/init@v\d+/);
        expect(all.codeql).toMatch(/languages: javascript-typescript/);
        expect(all.codeql).toMatch(/uses: github\/codeql-action\/analyze@v\d+/);
    });

    it('CodeQL can fail on what it finds: the SARIF is written, kept, and gated', () => {
        expect(all.codeql).toMatch(/^ {10}output: codeql-results$/m);
        expect(all.codeql).toMatch(/uses: actions\/upload-artifact@v\d+\n {8}with:\n {10}name: codeql-sarif\n {10}path: codeql-results$/m);
        expect(all.codeql).toMatch(/^ {8}run: node scripts\/sarif-gate\.js codeql-results$/m);
        // The gate runs after the analysis that writes what it reads.
        expect(all.codeql.indexOf('sarif-gate.js')).toBeGreaterThan(all.codeql.indexOf('codeql-action/analyze'));
    });

    it('Docker builds the image and Trivy blocks on fixable CRITICAL and HIGH', () => {
        expect(all.docker).toMatch(/uses: docker\/build-push-action@v\d+/);
        expect(all.docker).toMatch(/uses: aquasecurity\/trivy-action@/);
        expect(all.docker).toMatch(/severity: CRITICAL,HIGH$/m);
        expect(all.docker).toMatch(/ignore-unfixed: true$/m);
        expect(all.docker).toMatch(/exit-code: '1'$/m);
        // Trivy's internal 5-minute deadline would otherwise fail the gate
        // with no CVE found.
        expect(all.docker).toMatch(/^ {10}timeout: '15m'$/m);
    });

    it('runs on pull requests and on pushes to main', () => {
        expect(ci).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n/m);
    });

    it('cancels a superseded pull-request run, and groups a push by commit so no main run is dropped', () => {
        expect(ci).toMatch(/^concurrency:\n {2}group: .+\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
        // Keyed by ref, every main commit would share one group, and GitHub
        // cancels a waiting run when another queues behind it.
        expect(ci).toMatch(/^ {2}group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}$/m);
    });

    it('installs with npm ci on Node 24, cached, in every Node job', () => {
        expect(ci).toMatch(/^ {2}NODE_VERSION: '24'$/m);
        const nodeJobs = Object.entries(all).filter(([id]) => !['codeql', 'docker'].includes(id));
        expect(nodeJobs.map(([id]) => id)).toEqual(['lint', 'typecheck', 'test', 'build', 'security']);
        for (const [id, block] of nodeJobs) {
            expect([id, /node-version: \$\{\{ env\.NODE_VERSION \}\}/.test(block)]).toEqual([id, true]);
            expect([id, /cache: npm/.test(block)]).toEqual([id, true]);
            expect([id, /- run: npm ci$/m.test(block)]).toEqual([id, true]);
        }
    });

    it('Test runs unit tests, applies migrations, then integration tests against postgres:16 and Redis', () => {
        const test = all.test;
        expect(test).toMatch(/services:\n {6}postgres:\n {8}image: postgres:16\n/);
        expect(test).toMatch(/\n {6}redis:\n {8}image: redis:7/);
        const order = ['run: npm test', 'run: npm run migrate:deploy', 'run: npm run test:integration'].map((s) => test.indexOf(s));
        expect(order.every((i) => i > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('Build succeeds without secrets', () => {
        expect(all.build).toMatch(/SKIP_ENV_VALIDATION: '1'/);
        expect(all.build).toMatch(/- run: npm run build$/m);
        expect(all.build).toMatch(/- run: npm run build:worker$/m);
        expect(ci).not.toMatch(/\$\{\{\s*secrets\./);
    });
});
