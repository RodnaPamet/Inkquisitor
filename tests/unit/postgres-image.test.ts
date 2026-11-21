/**
 * inkquisitor-postgres's image is the official postgres:16-alpine plus
 * pgvector at a pinned tag and commit, built and scanned before it is
 * published, on a weekly and upstream-digest cadence (owner decision D7,
 * 2026-11-19); and every Postgres the repository runs is that image, built
 * from the Dockerfile in CI rather than pulled.
 *
 * Each assertion is one an easy edit would undo with nothing failing at build:
 * a base moved to Debian (which changes the collation under a data volume), a
 * base pinned by digest (which freezes the patches the tag delivers), pgvector
 * built for the runner's CPU, a toolchain left in the image, a publish that
 * stops gating, a schedule that stops rebuilding, or a CI job that goes back
 * to a Postgres without the extension the migrations create. Parsed (YAML,
 * Dockerfile instructions), so each is on a value rather than a needle in a
 * file.
 *
 * Adapted from inflect-compliance's `tests/guards/postgres-pgvector-image.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import { repoRelativeFiles } from '../helpers/repo-files';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

const DOCKERFILE = 'deploy/postgres/Dockerfile';
const SMOKE = 'deploy/postgres/smoke.sh';
const PUBLISH = '.github/workflows/postgres-image.yml';
const START = 'deploy/postgres/start.sh';
const OURS = 'ghcr.io/rodnapamet/inkquisitor-postgres';
/** pgvector v0.8.7, released 2026-10-01: the tag and the commit it names. */
const PGVECTOR_VERSION = 'v0.8.7';
const PGVECTOR_COMMIT = 'f37c13f68b57d2c3472b2214fbcff699d6d34876';
/** The Go that rebuilds gosu, by tag and digest (2026-11-15). */
const GO_BUILDER = 'golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf';
/** gosu 1.19, the release upstream ships: the tag and the commit it names. */
const GOSU_VERSION = '1.19';
const GOSU_COMMIT = '6456aaa0f3c854d199d0f037f068eb97515b7513';

/** Dockerfile instructions: comments dropped, continuations joined. */
function instructions(src: string): { op: string; args: string }[] {
    const joined = src
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n')
        .replace(/\\\n/g, ' ');
    return joined
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => {
            const m = /^(\S+)\s+(.*)$/.exec(l);
            return { op: (m?.[1] ?? l).toUpperCase(), args: m?.[2] ?? '' };
        });
}

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
    name?: string;
    if?: string;
    steps: Step[];
    needs?: unknown;
    outputs?: Record<string, string>;
    services?: Record<string, { image?: unknown }>;
    container?: unknown;
    permissions?: Record<string, string>;
};
type Workflow = {
    on?: unknown;
    true?: unknown;
    permissions?: Record<string, string>;
    env?: Record<string, string>;
    jobs: Record<string, Job>;
};

const loadWorkflow = (rel: string): Workflow => yaml.load(read(rel)) as Workflow;
/** js-yaml reads a bare `on:` key as the boolean `true`. */
const triggersOf = (wf: Workflow): Record<string, unknown> =>
    (wf.on ?? wf.true ?? {}) as Record<string, unknown>;
const gateOf = (job: Job): Step | undefined =>
    job.steps.find((s) => (s.name ?? '').startsWith('Gate: Trivy') && (s.name ?? '').includes('inkquisitor-postgres image'));

describe('deploy/postgres/Dockerfile — postgres:16-alpine plus pinned pgvector, and nothing else', () => {
    const ops = instructions(read(DOCKERFILE));

    it('is a gosu build stage, then FROM, COPY, two ARGs, the pgvector RUN and the base-package RUN (the scan is not vacuous)', () => {
        expect(ops.map((o) => o.op)).toEqual(['FROM', 'ARG', 'ARG', 'RUN', 'FROM', 'COPY', 'ARG', 'ARG', 'RUN', 'RUN']);
    });

    it('builds the final stage FROM the official 16-alpine TAG: same musl, no digest', () => {
        expect(ops[4].args).toBe('postgres:16-alpine');
    });

    it('rebuilds gosu with a pinned Go, at the release upstream ships, verified by commit, without cgo', () => {
        expect(ops[0].args).toBe(`${GO_BUILDER} AS gosu-build`);
        expect(ops[1].args).toBe(`GOSU_VERSION=${GOSU_VERSION}`);
        expect(ops[2].args).toBe(`GOSU_COMMIT=${GOSU_COMMIT}`);
        const commands = ops[3].args.split('&&').map((c) => c.trim().replace(/\s+/g, ' '));
        expect(commands).toEqual([
            'set -eux',
            'apk add --no-cache git',
            'git clone --quiet --depth 1 --branch "${GOSU_VERSION}" https://github.com/tianon/gosu.git /src/gosu',
            'test "$(git -C /src/gosu rev-parse HEAD)" = "${GOSU_COMMIT}"',
            'cd /src/gosu',
            'CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "-d -w" -o /out/gosu .',
            '/out/gosu --version',
            '/out/gosu nobody true',
        ]);
        // Over the upstream binary, so the entrypoint's `gosu` and the su-exec symlink both resolve to it.
        expect(ops[5].args).toBe('--from=gosu-build /out/gosu /usr/local/bin/gosu');
    });

    it('pins pgvector by tag and by the commit that tag names', () => {
        expect(ops[6].args).toBe(`PGVECTOR_VERSION=${PGVECTOR_VERSION}`);
        expect(ops[7].args).toBe(`PGVECTOR_COMMIT=${PGVECTOR_COMMIT}`);
    });

    it('fetches, verifies, builds portably, installs and removes the toolchain in one layer', () => {
        const commands = ops[8].args.split('&&').map((c) => c.trim().replace(/\s+/g, ' '));
        expect(commands).toEqual([
            'set -eux',
            'apk add --no-cache --virtual .pgvector-build build-base git',
            'git clone --quiet --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git /tmp/pgvector',
            'test "$(git -C /tmp/pgvector rev-parse HEAD)" = "${PGVECTOR_COMMIT}"',
            'make -C /tmp/pgvector OPTFLAGS="" with_llvm=no',
            'make -C /tmp/pgvector OPTFLAGS="" with_llvm=no install',
            'rm -rf /tmp/pgvector',
            'apk del --no-network .pgvector-build',
        ]);
    });

    it('raises base-image packages with a fixed HIGH advisory to the fixed version, with a floor', () => {
        // Trivy (CRITICAL,HIGH, ignore-unfixed) fails the Docker check on a
        // base package with a fix; the floor keeps a cached layer honest.
        expect(ops[9].op).toBe('RUN');
        expect(ops[9].args.trim()).toBe('apk add --no-cache --upgrade "libxml2>=2.13.9-r3"');
    });
});

describe('deploy/postgres/smoke.sh — the extension loads and a cosine query answers', () => {
    const src = read(SMOKE);

    it('expects the version the Dockerfile pins', () => {
        expect(/^PGVECTOR_VERSION="([^"]*)"$/m.exec(src)?.[1]).toBe(PGVECTOR_VERSION.slice(1));
    });

    it('creates the extension, queries by cosine distance, through HNSW with iterative scans', () => {
        for (const needle of [
            'CREATE EXTENSION vector;',
            'USING hnsw (embedding vector_cosine_ops)',
            'SET hnsw.iterative_scan = strict_order;',
        ]) {
            expect(src.split('\n').filter((l) => l.includes(needle))).toHaveLength(1);
        }
    });

    it('requires the rebuilt gosu: the builder\'s Go, read from the Dockerfile, and a working switch to postgres', () => {
        const goLine = src.split('\n').filter((l) => l.startsWith('GO_VERSION=$(sed'));
        expect(goLine).toHaveLength(1);
        expect(src.split('\n').filter((l) => l.includes('*"($GO_VERSION on "*) ;;'))).toHaveLength(1);
        expect(src.split('\n').filter((l) => l.includes('gosu postgres id -un'))).toHaveLength(1);
        expect(src.split('\n').filter((l) => l.includes('readlink /usr/local/bin/su-exec'))).toHaveLength(1);
    });

    it('refuses an image that is not musl or still carries the toolchain', () => {
        expect(src.split('\n').filter((l) => l.includes("ls /lib/ld-musl-*.so.1"))).toHaveLength(1);
        expect(/^for tool in (.*); do$/m.exec(src)?.[1].split(' ')).toEqual(['gcc', 'cc', 'make', 'git']);
    });

    it('is executable, as both workflows invoke it directly (and so is the CI start script)', () => {
        expect(fs.statSync(path.join(REPO_ROOT, SMOKE)).mode & 0o111).not.toBe(0);
        expect(fs.statSync(path.join(REPO_ROOT, START)).mode & 0o111).not.toBe(0);
    });
});

describe('the publish workflow — weekly, on an upstream digest move and on dispatch, gated before it pushes', () => {
    const wf = loadWorkflow(PUBLISH);
    const decide = wf.jobs.decide;
    const job = wf.jobs['build-scan-push'];

    it('is triggered by a person or the schedule, never by a push or a pull request', () => {
        expect(Object.keys(triggersOf(wf)).sort()).toEqual(['schedule', 'workflow_dispatch']);
    });

    it('runs a weekly rebuild and a daily digest check, and the weekly cron is the one decide names', () => {
        const crons = (triggersOf(wf).schedule as { cron: string }[]).map((c) => c.cron);
        expect(crons).toHaveLength(2);
        const weekly = crons.find((c) => /^\d+ \d+ \* \* \d$/.test(c));
        const daily = crons.find((c) => /^\d+ \d+ \* \* \*$/.test(c));
        expect(weekly).toBeDefined();
        expect(daily).toBeDefined();
        const run = decide.steps.find((s) => s.name === 'Read the upstream and published base digests')?.run ?? '';
        expect(run.includes(`[ "\${SCHEDULE}" = "${weekly}" ]`)).toBe(true);
        // A moved upstream digest rebuilds; an unreadable one fails rather than skipping.
        expect(run.includes('[ "${PUBLISHED}" != "${UPSTREAM_DIGEST}" ]')).toBe(true);
        expect(run.includes('could not read the upstream')).toBe(true);
    });

    it('holds read access to the code, and package write in the pushing job alone', () => {
        // A job without its own block inherits the workflow's: decide reads
        // registry metadata anonymously and must never hold package write.
        expect(wf.permissions).toEqual({ contents: 'read' });
        expect(decide.permissions).toBeUndefined();
        expect(job.permissions).toEqual({ contents: 'read', packages: 'write' });
        for (const [name, j] of Object.entries(wf.jobs)) {
            if (name !== 'build-scan-push') expect([name, j.permissions?.packages]).toEqual([name, undefined]);
        }
    });

    it('publishes from main only, and only when decide says so', () => {
        expect(decide.if).toBe("github.ref == 'refs/heads/main'");
        expect(job.needs).toEqual(['decide']);
        expect(job.if).toBe("github.ref == 'refs/heads/main' && needs.decide.outputs.build == 'true'");
    });

    it('builds without pushing, smoke-tests, gates, and only then pushes', () => {
        const names = job.steps.map((s) => s.name ?? s.uses ?? '');
        const at = (prefix: string) => names.findIndex((n) => n.startsWith(prefix));
        expect(at('Build the inkquisitor-postgres image')).toBeGreaterThan(-1);
        expect(job.steps[at('Build the inkquisitor-postgres image')].with?.push).toBe(false);
        expect(at('Smoke-test the inkquisitor-postgres image')).toBeGreaterThan(at('Build the inkquisitor-postgres image'));
        expect(at('Gate: Trivy scan')).toBeGreaterThan(at('Smoke-test the inkquisitor-postgres image'));
        expect(at('Push the scanned image')).toBeGreaterThan(at('Gate: Trivy scan'));
    });

    it('builds from deploy/postgres/ on exactly the upstream digest decide read, and labels it', () => {
        const build = job.steps.find((s) => (s.name ?? '').startsWith('Build the inkquisitor-postgres image'));
        expect(build?.with?.context).toBe('deploy/postgres');
        expect(build?.with?.file).toBe(DOCKERFILE);
        expect(String(build?.with?.['build-contexts']).trim()).toBe(
            'postgres:16-alpine=docker-image://${{ env.UPSTREAM }}@${{ needs.decide.outputs.upstream_digest }}',
        );
        expect(String(build?.with?.labels)).toContain(
            'org.opencontainers.image.base.digest=${{ needs.decide.outputs.upstream_digest }}',
        );
        expect(wf.env?.UPSTREAM).toBe('docker.io/library/postgres:16-alpine');
    });

    it('pushes the moving line tag and an immutable per-build tag to our package', () => {
        expect(`ghcr.io/${wf.env?.IMAGE_NAME}`).toBe(OURS);
        expect(wf.env?.LINE_TAG).toBe('16-alpine');
        const push = job.steps.find((s) => s.name === 'Push the scanned image')?.run ?? '';
        const pushes = push.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('docker push'));
        // The immutable tag first: a failure between the two leaves the line where it was.
        expect(pushes).toEqual(['docker push "${BUILD_TAG}"', 'docker push "${LINE}"']);
        expect(push.includes('BUILD_TAG="${REGISTRY}/${IMAGE_NAME}:${LINE_TAG}-pgvector${PGVECTOR}-$(date -u +%Y%m%d)-${GITHUB_SHA::9}"')).toBe(true);
        expect(push.includes(':latest')).toBe(false);
    });
});

describe('the gate is the same in CI and in the publish', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml');
    const docker = ci.jobs.docker;
    const publishJob = loadWorkflow(PUBLISH).jobs['build-scan-push'];

    it("CI's Docker job builds the same Dockerfile uncached on a fresh base, and runs the same smoke test", () => {
        const build = docker.steps.find((s) => s.name === 'Build the inkquisitor-postgres image (no push)');
        expect(build?.with).toMatchObject({ context: 'deploy/postgres', file: DOCKERFILE, push: false, load: true, pull: true, 'no-cache': true });
        const smoke = docker.steps.findIndex((s) => (s.run ?? '').startsWith(`${SMOKE} `));
        const gate = docker.steps.findIndex((s) => s === gateOf(docker));
        expect(smoke).toBeGreaterThan(docker.steps.indexOf(build!));
        expect(gate).toBeGreaterThan(smoke);
    });

    it.each([
        ['ci.yml (Docker)', () => gateOf(docker)],
        ['postgres-image.yml', () => gateOf(publishJob)],
    ])('%s blocks on CRITICAL,HIGH with fixes, with a deadline that is not read as a finding', (_, gate) => {
        const w = gate()?.with ?? {};
        expect(String(w['exit-code'])).toBe('1');
        expect(w.severity).toBe('CRITICAL,HIGH');
        expect(w['ignore-unfixed']).toBe(true);
        expect(w['vuln-type']).toBe('os,library');
        expect(w.timeout).toBe('15m');
    });
});

/**
 * Every Postgres moves together. The 2.0 migration runs `CREATE EXTENSION
 * vector` in `prisma migrate deploy`, so a single Postgres left on an image
 * without it — a CI job's service container, the Compose file — fails that
 * migration. CI does not pull the image either: the package does not exist
 * until the publish workflow first runs on main, and a pull request must test
 * the Dockerfile it carries.
 */
describe('every Postgres the repository runs is deploy/postgres/Dockerfile', () => {
    const LINE = `${OURS}:16-alpine`;
    const files = repoRelativeFiles();
    /** A Postgres image, however it is spelled: the official one, ours, the Debian pgvector, Bitnami. */
    const isPostgresImage = (image: string): boolean => {
        const repository = image.split('@')[0].replace(/:[^/:]*$/, '');
        const last = repository.split('/').pop() ?? '';
        return /postgres|pgvector/.test(last);
    };

    type Svc = { image?: unknown; build?: unknown };
    const compose = files
        .filter((f) => /(^|\/)docker-compose[^/]*\.ya?ml$/.test(f))
        .flatMap((rel) =>
            Object.entries((yaml.load(read(rel)) as { services?: Record<string, Svc> }).services ?? {}).map(([name, svc]) => ({
                where: `${rel}: ${name}`,
                image: String(svc.image ?? ''),
                build: svc.build,
            })),
        )
        .filter((r) => isPostgresImage(r.image));
    const workflowServices = files
        .filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
        .flatMap((rel) =>
            Object.entries(loadWorkflow(rel).jobs ?? {}).flatMap(([jobId, job]) => [
                ...Object.entries(job.services ?? {}).map(([name, svc]) => ({ where: `${rel}: ${jobId}.services.${name}`, image: String(svc.image ?? '') })),
                ...(job.container === undefined
                    ? []
                    : [{ where: `${rel}: ${jobId}.container`, image: String(typeof job.container === 'string' ? job.container : ((job.container as Svc).image ?? '')) }]),
            ]),
        )
        .filter((r) => isPostgresImage(r.image));

    it('the Compose Postgres is our line tag, built from deploy/postgres when absent', () => {
        expect(compose.map((r) => r.where)).toEqual(['docker-compose.yml: postgres']);
        expect(compose[0].image).toBe(LINE);
        expect(compose[0].build).toEqual({ context: 'deploy/postgres' });
    });

    it('no workflow job runs a Postgres service or container image (none could carry the Dockerfile under test)', () => {
        expect(workflowServices.map((r) => `${r.where}: ${r.image}`)).toEqual([]);
    });

    it.each(['test', 'e2e'])('ci.yml %s builds the image from the Dockerfile, starts it, and only then migrates', (jobId) => {
        const job = loadWorkflow('.github/workflows/ci.yml').jobs[jobId];
        const at = (pred: (s: Step) => boolean) => job.steps.findIndex(pred);
        const build = at((s) => s.name === 'Build the inkquisitor-postgres image (no push)');
        const start = at((s) => (s.run ?? '').startsWith(`${START} `));
        const migrate = at((s) => s.run === 'npm run migrate:deploy');
        expect(job.steps[build]?.with).toMatchObject({ context: 'deploy/postgres', file: DOCKERFILE, push: false, load: true });
        expect(String(job.steps[build]?.with?.['cache-from'])).toBe('type=gha,scope=inkquisitor-postgres');
        // The tag the build loads is the tag the start script runs.
        expect(job.steps[start].run).toBe(`${START} "${job.steps[build]?.with?.tags}" inkquisitor_test`);
        expect(build).toBeGreaterThan(-1);
        expect(start).toBeGreaterThan(build);
        expect(migrate).toBeGreaterThan(start);
    });

    it("the official image is only ever the Dockerfile's base", () => {
        const froms = files
            .filter((f) => /(^|\/)Dockerfile($|\.)/.test(f))
            .flatMap((rel) =>
                instructions(read(rel))
                    .filter((o) => o.op === 'FROM' && isPostgresImage(o.args.split(/\s+/)[0]))
                    .map((o) => `${rel}: ${o.args}`),
            );
        expect(froms).toEqual([`${DOCKERFILE}: postgres:16-alpine`]);
    });

    it('detector proof: the classifier sees every spelling of a Postgres image and nothing else', () => {
        for (const image of [
            'postgres:16',
            'postgres:16-alpine',
            'docker.io/library/postgres:17',
            LINE,
            `${OURS}@sha256:${'a'.repeat(64)}`,
            'ghcr.io/rodnapamet/postgres-pgvector:16-alpine',
            'pgvector/pgvector:0.8.7-pg16-bookworm',
            'bitnami/postgresql:16',
        ]) {
            expect(isPostgresImage(image)).toBe(true);
        }
        for (const image of ['redis:7-alpine', 'edoburu/pgbouncer:latest', 'node:24-alpine']) {
            expect(isPostgresImage(image)).toBe(false);
        }
    });
});

describe("start.sh and smoke.sh wait for the REAL server, not the entrypoint's initdb server", () => {
    /*
     * The upstream entrypoint does initdb's work on a temporary server that
     * listens on the Unix socket only (`listen_addresses=''`), stops it, and
     * starts the real one. A fake `docker` plays that sequence: while the
     * temporary server runs, `pg_isready` over the socket answers ready and
     * over TCP (`-h`) does not; once the real server is up, both answer. The
     * scripts must do their first real work (start.sh's extension query,
     * smoke.sh's first check) only against the real server.
     */
    const TEMP_PROBES = 3;
    const FAKE_DOCKER = `#!/usr/bin/env bash
state="$FAKE_STATE"
n=$(cat "$state/probes" 2>/dev/null || echo 0)
phase=temp; [ "$n" -ge ${TEMP_PROBES} ] && phase=real
case "$1" in
  run) echo fake-container-id ;;
  inspect) echo true ;;
  logs) ;;
  exec)
    shift 2
    if [ "$1" = pg_isready ]; then
      echo $((n + 1)) > "$state/probes"
      case " $* " in
        *" -h "*) [ "$phase" = real ] ;;
        *) true ;;
      esac
      exit $?
    fi
    [ -f "$state/first-work" ] || echo "$phase" > "$state/first-work"
    if [ "$1" = psql ]; then echo 1; exit 0; fi
    exit 1 ;;
esac
`;

    function runWithFakeDocker(script: string, args: string[]): { status: number | null; firstWork: string } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-start-'));
        try {
            const bin = path.join(dir, 'bin');
            fs.mkdirSync(bin);
            fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
            fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
            const result = spawnSync('bash', [path.join(REPO_ROOT, script), ...args], {
                env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_STATE: dir },
                encoding: 'utf-8',
                timeout: 20_000,
            });
            const marker = path.join(dir, 'first-work');
            return { status: result.status, firstWork: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf-8').trim() : 'none' };
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    it('start.sh queries the extension only once the real server answers, and succeeds', () => {
        expect(runWithFakeDocker(START, ['img', 'inkquisitor_test'])).toEqual({ status: 0, firstWork: 'real' });
    });

    it("smoke.sh's first check meets the real server", () => {
        // The fake answers every check after readiness with a failure, so the
        // script stops at its first one; what matters is which server it met.
        expect(runWithFakeDocker(SMOKE, ['img']).firstWork).toBe('real');
    });
});
