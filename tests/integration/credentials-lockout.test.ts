/**
 * The credentials chokepoint against a real database: progressive lockout,
 * timing equalisation, and the audit rows a failed sign-in leaves.
 *
 * bcrypt is the real module, wrapped so the suite can COUNT compares: the
 * timing property is "every failure costs one bcrypt compare", which a count
 * proves without a stopwatch. The delay is served by an injected recorder, so
 * the suite asserts the delay REQUESTED, not wall-clock time.
 */
jest.mock('bcrypt', () => {
    const actual = jest.requireActual('bcrypt');
    return { ...actual, compare: jest.fn((...args: unknown[]) => actual.compare(...args)) };
});

import bcrypt from 'bcrypt';
import { prisma } from '@/lib/db';
import { authenticateWithPassword, progressiveKeyFor } from '@/lib/auth/credentials';
import { hashPassword } from '@/lib/auth/passwords';
import { resetProgressiveFailures, LOGIN_PROGRESSIVE_POLICY } from '@/lib/security/rate-limit';
import { createAccount, uniqueEmail } from '../helpers/workspaces';

const compare = bcrypt.compare as unknown as jest.Mock;
const PASSWORD = ['plume', 'quill', 'inkwell', 'vellum'].join('-');

let account: Awaited<ReturnType<typeof createAccount>>;
let sleeps: number[];
const recorder = { sleepImpl: async (ms: number) => void sleeps.push(ms) };

beforeAll(async () => {
    account = await createAccount({ passwordHash: await hashPassword(PASSWORD) });
});
afterAll(() => prisma.$disconnect());

beforeEach(() => {
    process.env.RATE_LIMIT_ENABLED = '1';
    sleeps = [];
    resetProgressiveFailures(progressiveKeyFor(account.email));
    compare.mockClear();
});
afterEach(() => {
    delete process.env.RATE_LIMIT_ENABLED;
});

async function attempt(password: string, email = account.email) {
    return authenticateWithPassword({ email, password }, recorder);
}

it('the right password signs in, and resets the failure count', async () => {
    await attempt('wrong-one');
    await attempt('wrong-two');
    expect(await attempt(PASSWORD)).toMatchObject({ ok: true, userId: account.userId, email: account.email });
    // A third failure after the reset is the first again: no delay.
    await attempt('wrong-three');
    expect(sleeps).toEqual([]);
});

it('the email is case- and space-insensitive', async () => {
    expect((await attempt(PASSWORD, `  ${account.email.toUpperCase()}  `)).ok).toBe(true);
});

it('progresses: free attempts, then 5 s, then 30 s, then a 15-minute lockout', async () => {
    const results = [];
    for (let i = 1; i <= 10; i++) results.push(await attempt(`wrong-${i}`));
    expect(results.every((r) => !r.ok && r.reason === 'credentials_invalid')).toBe(true);
    // Attempts 1-3 run free (the delay applies once 3 failures are counted),
    // 4-5 wait 5 s, 6-10 wait 30 s.
    expect(sleeps).toEqual([5_000, 5_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
    expect(LOGIN_PROGRESSIVE_POLICY.lockoutAtFailures).toBe(10);

    // Locked: even the right password is refused, with a retry-after.
    const locked = await attempt(PASSWORD);
    expect(locked).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect((locked as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(14 * 60);
});

it('every failure costs exactly one bcrypt compare: unknown email, wrong password, lockout', async () => {
    await authenticateWithPassword({ email: uniqueEmail('nobody'), password: 'whatever-it-is' }, recorder);
    expect(compare).toHaveBeenCalledTimes(1);

    compare.mockClear();
    await attempt('wrong');
    expect(compare).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 10; i++) await attempt('wrong');
    compare.mockClear();
    const locked = await attempt(PASSWORD);
    expect(locked).toMatchObject({ reason: 'rate_limited' });
    expect(compare).toHaveBeenCalledTimes(1);
});

it('an unknown email and a wrong password give the same answer', async () => {
    const unknown = await authenticateWithPassword({ email: uniqueEmail('nobody'), password: 'x-x-x-x-x' }, recorder);
    const wrong = await attempt('x-x-x-x-x');
    expect(unknown).toEqual(wrong);
    expect(unknown).toEqual({ ok: false, reason: 'credentials_invalid' });
});

it('a failure is recorded on the account’s workspace trail, without the address or the password', async () => {
    await attempt('definitely-wrong');
    const rows = await prisma.auditLog.findMany({ where: { workspaceId: account.workspaceId, action: 'USER_SIGN_IN_FAILED' } });
    expect(rows.length).toBeGreaterThan(0);
    const last = rows[rows.length - 1];
    expect(last.actorUserId).toBe(account.userId);
    expect(last.detailsJson).toMatchObject({ method: 'credentials', reason: 'credentials_invalid' });
    expect(JSON.stringify(last.detailsJson)).not.toContain(account.email);
    expect(JSON.stringify(last.detailsJson)).not.toContain('definitely-wrong');
});

it('with the limiter off (RATE_LIMIT_ENABLED=0) there is no lockout', async () => {
    process.env.RATE_LIMIT_ENABLED = '0';
    for (let i = 0; i < 11; i++) await attempt('wrong');
    expect((await attempt(PASSWORD)).ok).toBe(true);
    expect(sleeps).toEqual([]);
});
