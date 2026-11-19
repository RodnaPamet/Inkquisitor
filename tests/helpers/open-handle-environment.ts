/**
 * The integration project's test environment: Node's, plus a check that a
 * test file leaves nothing holding the process open (Phase 0.H review).
 *
 * A file that forgets to close a Redis client, a Prisma pool, a server or a
 * timer used to cost nothing visible: in band, Jest just waited (or a later
 * file inherited the socket), and `--detectOpenHandles` only PRINTS. Here the
 * resources keeping the event loop alive (`process.getActiveResourcesInfo()`,
 * which leaves out anything `unref`'d) are counted per type when the file's
 * environment is set up and again after it is torn down — after every
 * `afterAll` the file registered. A type whose count grew is a leak, and the
 * environment's teardown throws, which fails THAT file ("Test suite failed to
 * run: …"), named.
 *
 * Closing is asynchronous (a socket is reported until its `close` callback
 * runs), so the check waits up to `SETTLE_MS` for the counts to come back
 * down before it decides.
 *
 * Not counted, because Jest and the stdio streams own them:
 *   PipeWrap, TTYWrap   the process's stdout / stderr
 *   FSReqCallback, FSReqPromise   Jest's own cache and reporter file I/O
 *   Immediate   a setImmediate is gone by the next turn; one left behind
 *               cannot hold the loop past it
 *
 * The check runs per FILE in the process that ran it, so it holds in band
 * (`npm run test:integration`) and in workers alike.
 */
import { TestEnvironment } from 'jest-environment-node';

const IGNORED: ReadonlySet<string> = new Set(['PipeWrap', 'TTYWrap', 'FSReqCallback', 'FSReqPromise', 'Immediate']);
const SETTLE_MS = 3_000;
const POLL_MS = 25;

/** Live resources by type, Jest's and stdio's left out. */
export function liveResourceCounts(info: readonly string[] = process.getActiveResourcesInfo()): Map<string, number> {
    const counts = new Map<string, number>();
    for (const type of info) if (!IGNORED.has(type)) counts.set(type, (counts.get(type) ?? 0) + 1);
    return counts;
}

/** The types whose count exceeds the baseline's, as `Type ×n`, or [] when nothing grew. */
export function leakedSince(baseline: ReadonlyMap<string, number>, now: ReadonlyMap<string, number>): string[] {
    const leaked: string[] = [];
    for (const [type, n] of now) {
        const extra = n - (baseline.get(type) ?? 0);
        if (extra > 0) leaked.push(`${type} ×${extra}`);
    }
    return leaked.sort();
}

export default class OpenHandleEnvironment extends TestEnvironment {
    private baseline: Map<string, number> = new Map();

    override async setup(): Promise<void> {
        this.baseline = liveResourceCounts();
        await super.setup();
    }

    override async teardown(): Promise<void> {
        await super.teardown();
        let leaked = leakedSince(this.baseline, liveResourceCounts());
        const deadline = Date.now() + SETTLE_MS;
        while (leaked.length > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            leaked = leakedSince(this.baseline, liveResourceCounts());
        }
        if (leaked.length > 0) {
            throw new Error(
                `This test file left resources holding the process open: ${leaked.join(', ')}. ` +
                    'Close every client, pool, server and timer it opened in an afterAll ' +
                    '(Redis: closeRedisClient; Prisma: $disconnect), or unref a timer that must outlive it.',
            );
        }
    }
}
