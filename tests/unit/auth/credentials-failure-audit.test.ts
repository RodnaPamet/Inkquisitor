/**
 * The audit side of a failed password sign-in, with the database and the
 * trail stubbed (the integration twin is tests/integration/credentials-lockout.test.ts).
 *
 *   - TIMING: a failure for a KNOWN email does not wait for its audit row.
 *     The append fans out to every one of the user's workspaces; an unknown
 *     email has none, so awaiting it made "this account exists" measurable.
 *   - VOLUME: an unauthenticated caller cannot grow a victim's append-only
 *     trail without bound — no row for an attempt refused during lockout, and
 *     at most one failure row per user per lockout window.
 */
const findUnique = jest.fn();
jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: (...args: unknown[]) => findUnique(...args), update: jest.fn() } } }));

const recordUserAuthEvent = jest.fn();
jest.mock('@/lib/audit/user-auth-events', () => ({ recordUserAuthEvent: (...args: unknown[]) => recordUserAuthEvent(...args) }));

const verifyPassword = jest.fn(async () => false);
const dummyVerify = jest.fn(async () => undefined);
jest.mock('@/lib/auth/passwords', () => ({
    verifyPassword: (...args: unknown[]) => verifyPassword(...(args as [])),
    dummyVerify: (...args: unknown[]) => dummyVerify(...(args as [])),
    needsRehash: () => false,
    hashPassword: async () => 'unused',
}));

import {
    _resetSignInFailureAuditWindow,
    authenticateWithPassword,
    progressiveKeyFor,
    settleSignInFailureAudits,
} from '@/lib/auth/credentials';
import { LOGIN_PROGRESSIVE_POLICY } from '@/lib/security/rate-limit';
import { lockoutFor } from '@/lib/security/progressive-lockout';

const EMAIL = 'victim@example.test';
const USER = { id: 'user-victim', email: EMAIL, name: null, passwordHash: 'stored-hash' };
const noSleep = { sleepImpl: async () => undefined };

let now: number;
beforeEach(async () => {
    now = Date.UTC(2026, 10, 19, 12, 0, 0);
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    findUnique.mockReset().mockResolvedValue(USER);
    recordUserAuthEvent.mockReset().mockResolvedValue(undefined);
    verifyPassword.mockClear();
    dummyVerify.mockClear();
    await lockoutFor(LOGIN_PROGRESSIVE_POLICY).reset(progressiveKeyFor(EMAIL));
    _resetSignInFailureAuditWindow();
    delete process.env.RATE_LIMIT_ENABLED;
});
afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.RATE_LIMIT_ENABLED;
});

const attempt = (password = 'wrong') => authenticateWithPassword({ email: EMAIL, password }, noSleep);

describe('timing: the failure path does not wait for the audit write', () => {
    it('a known email with a wrong password answers while its audit append is still pending', async () => {
        recordUserAuthEvent.mockImplementation(() => new Promise(() => undefined)); // never settles
        // The timer is cleared: one left running outlives the file in its Jest
        // worker, which is then force-exited at the end of the run.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const blocked = new Promise((r) => (timer = setTimeout(() => r('BLOCKED'), 1_000)));
        const answer = await Promise.race([attempt(), blocked]).finally(() => clearTimeout(timer));
        expect(answer).toEqual({ ok: false, reason: 'credentials_invalid' });
        expect(recordUserAuthEvent).toHaveBeenCalledTimes(1);
    });

    it('a failing audit append does not fail the sign-in answer, and is not awaited by it', async () => {
        recordUserAuthEvent.mockRejectedValue(new Error('trail down'));
        await expect(attempt()).resolves.toEqual({ ok: false, reason: 'credentials_invalid' });
        await expect(settleSignInFailureAudits()).resolves.toBeUndefined();
    });

    it('known and unknown emails do the same awaited work: one lookup, one compare', async () => {
        await attempt();
        findUnique.mockResolvedValue(null);
        await attempt();
        expect(verifyPassword.mock.calls.length + dummyVerify.mock.calls.length).toBe(2);
        expect(findUnique).toHaveBeenCalledTimes(2);
    });
});

describe('volume: the trail is bounded per user', () => {
    it('ten failures in one window write ONE row; attempts refused during the lockout write none', async () => {
        process.env.RATE_LIMIT_ENABLED = '1';
        for (let i = 0; i < LOGIN_PROGRESSIVE_POLICY.lockoutAtFailures; i++) {
            expect(await attempt(`wrong-${i}`)).toMatchObject({ ok: false, reason: 'credentials_invalid' });
            now += 1_000;
        }
        expect(recordUserAuthEvent).toHaveBeenCalledTimes(1);
        expect(recordUserAuthEvent.mock.calls[0][0]).toMatchObject({ userId: USER.id, action: 'USER_SIGN_IN_FAILED' });

        for (let i = 0; i < 5; i++) {
            expect(await attempt()).toMatchObject({ ok: false, reason: 'rate_limited' });
            now += 1_000;
        }
        expect(recordUserAuthEvent).toHaveBeenCalledTimes(1);
    });

    it('a lockout refusal writes no row even when it is the first event of a window', async () => {
        process.env.RATE_LIMIT_ENABLED = '1';
        for (let i = 0; i < LOGIN_PROGRESSIVE_POLICY.lockoutAtFailures; i++) await attempt();
        _resetSignInFailureAuditWindow();
        recordUserAuthEvent.mockClear();
        expect(await attempt()).toMatchObject({ reason: 'rate_limited' });
        expect(recordUserAuthEvent).not.toHaveBeenCalled();
    });

    it('a new window allows one more row', async () => {
        process.env.RATE_LIMIT_ENABLED = '0';
        await attempt();
        await attempt();
        expect(recordUserAuthEvent).toHaveBeenCalledTimes(1);
        now += LOGIN_PROGRESSIVE_POLICY.lockoutMs + 1;
        await attempt();
        await attempt();
        expect(recordUserAuthEvent).toHaveBeenCalledTimes(2);
    });

    it('the bound holds with the limiter off, and is per user', async () => {
        process.env.RATE_LIMIT_ENABLED = '0';
        for (let i = 0; i < 50; i++) await attempt();
        expect(recordUserAuthEvent).toHaveBeenCalledTimes(1);
        findUnique.mockResolvedValue({ ...USER, id: 'user-other' });
        await attempt();
        expect(recordUserAuthEvent).toHaveBeenCalledTimes(2);
        expect(recordUserAuthEvent.mock.calls[1][0]).toMatchObject({ userId: 'user-other' });
    });
});

describe('concurrency: the lockout gates the verify, not a read taken before it', () => {
    // The pre-review flow read the count, verified, then recorded the failure:
    // twenty guesses sent together at nine failures all read nine and all
    // verified. The attempt is now counted atomically BEFORE the verify.
    it('twenty concurrent wrong passwords at nine failures: one verify, nineteen refusals, one compare each', async () => {
        process.env.RATE_LIMIT_ENABLED = '1';
        for (let i = 0; i < LOGIN_PROGRESSIVE_POLICY.lockoutAtFailures - 1; i++) await attempt(`wrong-${i}`);
        verifyPassword.mockClear();
        dummyVerify.mockClear();
        // A verify that takes real time, so every attempt is in flight at once.
        verifyPassword.mockImplementation(() => new Promise((r) => setImmediate(() => r(false))));

        const results = await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(`guess-${i}`)));

        expect(verifyPassword).toHaveBeenCalledTimes(1);
        expect(results.filter((r) => !r.ok && r.reason === 'rate_limited')).toHaveLength(19);
        // Timing: every refusal still paid one compare.
        expect(verifyPassword.mock.calls.length + dummyVerify.mock.calls.length).toBe(20);
        verifyPassword.mockImplementation(async () => false);
    });

    it('from zero, forty concurrent guesses verify at most the lockout count', async () => {
        process.env.RATE_LIMIT_ENABLED = '1';
        verifyPassword.mockImplementation(() => new Promise((r) => setImmediate(() => r(false))));
        await Promise.all(Array.from({ length: 40 }, (_, i) => attempt(`guess-${i}`)));
        expect(verifyPassword).toHaveBeenCalledTimes(LOGIN_PROGRESSIVE_POLICY.lockoutAtFailures);
        verifyPassword.mockImplementation(async () => false);
    });
});
