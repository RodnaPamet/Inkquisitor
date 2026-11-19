/**
 * The integration project's open-handle check FAILS a file that leaves
 * something holding the process open, and passes one that cleans up (Phase
 * 0.H review). Driven for real: Jest is run as a child process over two
 * throwaway test files, with the integration project's environment
 * (tests/helpers/open-handle-environment.ts), and its exit code and report are
 * read. The counting itself is unit-tested beside it.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { leakedSince, liveResourceCounts } from '../helpers/open-handle-environment';
import { REPO_ROOT } from '../helpers/repo-files';

describe('the count', () => {
    it('leaves out the resources Jest and stdio own, and reports only growth', () => {
        const baseline = liveResourceCounts(['PipeWrap', 'TTYWrap', 'FSReqCallback', 'Immediate', 'Timeout']);
        expect([...baseline]).toEqual([['Timeout', 1]]);
        const now = liveResourceCounts(['Timeout', 'Timeout', 'TCPSocketWrap', 'PipeWrap', 'PipeWrap']);
        expect(leakedSince(baseline, now)).toEqual(['TCPSocketWrap ×1', 'Timeout ×1']);
        expect(leakedSince(now, baseline)).toEqual([]);
    });
});

describe('the environment, run by Jest', () => {
    let dir: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-handles-'));
        fs.writeFileSync(
            path.join(dir, 'leaks.test.js'),
            `const net = require('node:net');
             it('opens a server and never closes it', async () => {
                 const server = net.createServer();
                 await new Promise((r) => server.listen(0, '127.0.0.1', r));
             });
             it('starts a timer and never clears it', () => { setInterval(() => undefined, 60_000); });`,
        );
        fs.writeFileSync(
            path.join(dir, 'clean.test.js'),
            `const net = require('node:net');
             it('opens a server and closes it, and unrefs a timer it keeps', async () => {
                 const server = net.createServer();
                 await new Promise((r) => server.listen(0, '127.0.0.1', r));
                 await new Promise((r) => server.close(r));
                 setInterval(() => undefined, 60_000).unref();
             });`,
        );
        fs.writeFileSync(
            path.join(dir, 'jest.config.js'),
            `module.exports = ${JSON.stringify({
                rootDir: dir,
                testEnvironment: path.join(REPO_ROOT, 'tests/helpers/open-handle-environment.ts'),
                transform: { '^.+\\.ts$': [require.resolve('ts-jest'), { isolatedModules: true }] },
                cacheDirectory: path.join(dir, '.cache'),
            })};`,
        );
    });

    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    function runJest(file: string) {
        return spawnSync(
            process.execPath,
            [require.resolve('jest/bin/jest'), '--config', path.join(dir, 'jest.config.js'), '--runInBand', '--forceExit', file],
            { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, CI: '1' } },
        );
    }

    it('fails a file that leaves a server and a timer running, naming what it left', () => {
        const run = runJest('leaks.test.js');
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('left resources holding the process open');
        expect(run.stderr).toMatch(/TCPServerWrap ×1/);
        expect(run.stderr).toMatch(/Timeout ×1/);
    }, 90_000);

    it('passes a file that closes what it opened', () => {
        const run = runJest('clean.test.js');
        expect([run.status, run.stderr]).toEqual([0, expect.stringContaining('1 passed')]);
    }, 90_000);
});
