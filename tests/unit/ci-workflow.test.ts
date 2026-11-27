/**
 * The CI workflow keeps its shape: the required checks by exact name (Phase
 * 0.1's four, Phase 0.4's Security, CodeQL and Docker, and E2E), the triggers,
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

    it('has exactly the jobs Lint, Typecheck, Test, Build, Security, CodeQL, Docker and E2E', () => {
        const names = Object.values(all).map((b) => /^ {4}name: (.+)$/m.exec(b)?.[1]);
        expect(names).toEqual(['Lint', 'Typecheck', 'Test', 'Build', 'Security', 'CodeQL', 'Docker', 'E2E']);
    });

    it('runs the backup and restore drill’s tools inside the Postgres container the Test job starts (Phase 5.H-a)', () => {
        const name = /^NAME="([^"]+)"$/m.exec(fs.readFileSync(path.resolve(__dirname, '../../deploy/postgres/start.sh'), 'utf8'))?.[1];
        expect(name).toBeTruthy();
        expect(all.test).toMatch(new RegExp(`^ {6}PG_TOOLS_CONTAINER: ${name}$`, 'm'));
        expect(all.test).toMatch(/deploy\/postgres\/start\.sh/);
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

    it('reads Docker Hub through a mirror: every buildx builder and every Redis (issue #23, item 4)', () => {
        const builders = [...ci.matchAll(/- uses: docker\/setup-buildx-action@v\d+\n((?: {8}.*\n)*)/g)];
        expect(builders.length).toBe(3);
        for (const b of builders) {
            expect(b[1]).toContain('buildkitd-config-inline: |');
            expect(b[1]).toContain('[registry."docker.io"]');
            expect(b[1]).toContain('mirrors = ["mirror.gcr.io"]');
        }
        // No image is run from Docker Hub by its bare name.
        const images = [...ci.matchAll(/image: (\S+)/g)].map((m) => m[1]);
        const redis = [...ci.matchAll(/(\S*)redis:7-alpine/g)].map((m) => m[1]);
        expect(redis.length).toBe(2);
        for (const r of [...images, ...redis.map((prefix) => `${prefix}redis`)]) expect([r, r.startsWith('mirror.gcr.io/')]).toEqual([r, true]);
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

    it('E2E installs only the Playwright headless shell, never apt packages', () => {
        // --with-deps apt-installs fonts from Ubuntu's mirrors; their
        // timeouts failed the job before any spec ran.
        expect(all.e2e).toMatch(/- run: npx playwright install --only-shell chromium$/m);
        const commands = all.e2e.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
        expect(commands).not.toMatch(/--with-deps|apt-get/);
    });

    it('E2E gives the production build a Redis that requires a password', () => {
        // The start-up check refuses a passwordless REDIS_URL in production;
        // a job-level REDIS_URL would override playwright.config.ts's one.
        expect(all.e2e).not.toMatch(/^\s+REDIS_URL:/m);
        expect(all.e2e).toMatch(/redis-server --requirepass e2e/);
    });

    it('installs with npm ci on Node 24, cached, in every Node job', () => {
        expect(ci).toMatch(/^ {2}NODE_VERSION: '24'$/m);
        const nodeJobs = Object.entries(all).filter(([id]) => !['codeql', 'docker'].includes(id));
        expect(nodeJobs.map(([id]) => id)).toEqual(['lint', 'typecheck', 'test', 'build', 'security', 'e2e']);
        for (const [id, block] of nodeJobs) {
            expect([id, /node-version: \$\{\{ env\.NODE_VERSION \}\}/.test(block)]).toEqual([id, true]);
            expect([id, /cache: npm/.test(block)]).toEqual([id, true]);
            expect([id, /- run: npm ci$/m.test(block)]).toEqual([id, true]);
        }
    });

    it('Test runs unit tests, applies migrations, then integration tests against Postgres with pgvector and Redis', () => {
        const test = all.test;
        // Postgres is built from deploy/postgres/Dockerfile in the job and
        // started before anything touches it (subphase 2.0, D7): the
        // migrations create the vector extension, which postgres:16 lacks.
        expect(test).not.toMatch(/image: postgres/);
        expect(test).toMatch(/\n {6}redis:\n {8}image: mirror\.gcr\.io\/library\/redis:7/);
        const order = [
            'name: Build the inkquisitor-postgres image (no push)',
            'run: deploy/postgres/start.sh',
            'run: npm test',
            'run: npm run migrate:deploy',
            'run: npm run test:integration',
        ].map((s) => test.indexOf(s));
        expect(order.every((i) => i > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('E2E drives the build against the same Postgres with pgvector, started before the migrations', () => {
        const e2e = all.e2e;
        expect(e2e).not.toMatch(/image: postgres/);
        const order = ['name: Build the inkquisitor-postgres image (no push)', 'run: deploy/postgres/start.sh', 'run: npm run migrate:deploy', 'run: npm run test:e2e'].map(
            (s) => e2e.indexOf(s),
        );
        expect(order.every((i) => i > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('Docker also builds, smoke-tests and gates the Postgres image (never pushed from CI)', () => {
        const docker = all.docker;
        expect(docker).toMatch(/run: deploy\/postgres\/smoke\.sh "inkquisitor-postgres:ci-\$\{\{ github\.sha \}\}"$/m);
        expect(docker).toMatch(/image-ref: inkquisitor-postgres:ci-\$\{\{ github\.sha \}\}$/m);
        // Both Trivy gates block on fixable CRITICAL and HIGH with the long deadline.
        expect(docker.match(/uses: aquasecurity\/trivy-action@/g)).toHaveLength(2);
        expect(docker.match(/^ {10}severity: CRITICAL,HIGH$/gm)).toHaveLength(2);
        expect(docker.match(/^ {10}exit-code: '1'$/gm)).toHaveLength(2);
        expect(docker.match(/^ {10}ignore-unfixed: true$/gm)).toHaveLength(2);
        expect(docker.match(/^ {10}timeout: '15m'$/gm)).toHaveLength(2);
        expect(ci).not.toMatch(/push: true/);
    });

    it('Build succeeds without secrets', () => {
        expect(all.build).toMatch(/SKIP_ENV_VALIDATION: '1'/);
        // The build runs through its checker, which fails on a warning (Phase 0.H).
        expect(all.build).toMatch(/- run: npm run build:check$/m);
        expect(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).scripts['build:check']).toBe('node scripts/check-build.js');
        expect(all.build).toMatch(/- run: npm run build:worker$/m);
        expect(ci).not.toMatch(/\$\{\{\s*secrets\./);
    });
});
