/**
 * No `console.*` in server code (Phase 0.H, brief item 4), held twice:
 *
 *   1. the REPO's ESLint config turns `no-console` on for every server path —
 *      route handlers, usecases, the proxy, the auth configuration, the
 *      worker — and off only for the edge logger, which redacts before it
 *      writes (linted with the real config, at paths planted in memory);
 *   2. no file git lists under `src/` or `scripts/` calls the console in
 *      code, which also catches a call hidden behind an `eslint-disable`
 *      comment (comments are blanked before matching).
 *
 * `scripts/*.js|mjs` are build tools (the docs stager, the SARIF gate, the
 * build checker): their console is a terminal, not a log stream.
 */
import * as fs from 'node:fs';
import { lintWithRepoConfig } from './helpers/lint-with-repo-config';
import * as path from 'node:path';
import { REPO_ROOT, repoFiles, repoRelative } from '../../tests/helpers/repo-files';
import { codeOf } from '../../tests/helpers/source-blocks';

const SERVER_PATHS = [
    'src/app/api/w/[workspaceSlug]/members/route.ts',
    'src/app-layer/usecases/members.ts',
    'src/lib/auth/credentials.ts',
    'src/proxy.ts',
    'src/auth.ts',
    'src/instrumentation-node.ts',
    'scripts/worker.ts',
    'scripts/worker-healthcheck.ts',
];

const EDGE_LOGGER = 'src/lib/observability/edge-logger.ts';

describe('the ESLint config', () => {
    it('refuses console.* on every server path', () => {
        const results = lintWithRepoConfig('no-console', 'export function f(x: string) { console.log(x); console.error(x); }\n', SERVER_PATHS);
        expect(results.map((r) => [r.filePath, r.fatal, r.ruleIds])).toEqual(
            SERVER_PATHS.map((p) => [p, [], ['no-console', 'no-console']]),
        );
    }, 60_000);

    it('allows it in the edge logger only', () => {
        const [r] = lintWithRepoConfig('no-console', 'export function f(x: string) { console.log(x); }\n', [EDGE_LOGGER]);
        expect([r.fatal, r.ruleIds]).toEqual([[], []]);
    }, 60_000);
});

const CONSOLE_CALL = /\bconsole\s*(?:\.\s*[A-Za-z_$]+|\[)/;

describe('the source', () => {
    it('no server file calls the console, outside the edge logger', () => {
        const files = [
            ...repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }),
            ...repoFiles({ under: 'scripts', extensions: ['.ts'] }),
        ].filter((f) => repoRelative(f) !== EDGE_LOGGER);
        expect(files.length).toBeGreaterThan(100);
        const offenders = files.filter((f) => CONSOLE_CALL.test(codeOf(fs.readFileSync(f, 'utf8')))).map(repoRelative);
        expect(offenders).toEqual([]);
    });

    it('the scan sees through a disable comment, and not into a comment', () => {
        expect(CONSOLE_CALL.test(codeOf('// eslint-disable-next-line no-console\nconsole.log(secret);'))).toBe(true);
        expect(CONSOLE_CALL.test(codeOf('console["log"](x)'))).toBe(true);
        expect(CONSOLE_CALL.test(codeOf('// inflect logged it with console.error'))).toBe(false);
        expect(CONSOLE_CALL.test(codeOf(fs.readFileSync(path.join(REPO_ROOT, EDGE_LOGGER), 'utf8')))).toBe(true);
    });
});
