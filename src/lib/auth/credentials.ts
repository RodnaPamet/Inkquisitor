/**
 * The credentials sign-in chokepoint: ONE function owns the whole
 * email + password decision. NextAuth's Credentials provider (src/auth.ts)
 * delegates here and nothing else verifies a password.
 *
 *   authenticateWithPassword
 *     ├─ progressive lockout gate     (LOGIN_PROGRESSIVE_POLICY, per email)
 *     ├─ user lookup                  (plain client: User is not workspace-scoped)
 *     ├─ password verify              (./passwords)
 *     ├─ silent rehash on verify      (when BCRYPT_COST moved)
 *     └─ audit                        (USER_SIGN_IN_FAILED; success is recorded
 *                                      by the jwt callback with the session id)
 *
 * ACCOUNT-ENUMERATION SAFE. Unknown email, a Google-only account (no
 * password) and a wrong password all return `credentials_invalid`, and every
 * one of them costs exactly one bcrypt compare (`dummyVerify` where there is
 * no real hash), so neither the answer nor its timing says which. A locked
 * out identifier answers `rate_limited` — but only after the same compare,
 * and the lockout is reached by failing, so it tells an attacker nothing an
 * attacker did not cause.
 *
 * PROGRESSIVE LOCKOUT (`LOGIN_PROGRESSIVE_POLICY`, src/lib/security/rate-limit.ts):
 * 3 failures → 5 s delay before the next verify, 5 → 30 s, 10 → 15 minutes
 * locked, keyed on sha256(email) so the in-memory store holds no address.
 * Off when the rate limiter is (`RATE_LIMIT_ENABLED=0`, and under Jest unless
 * a suite sets it to 1). The store is per process: the edge auth tier and the
 * route's LOGIN_LIMIT bound the rest.
 *
 * Lifted from inflect-compliance's `src/lib/auth/credentials.ts` (see
 * docs/carve-manifest.md). Not carried: the Upstash per-email sliding window,
 * the email-verification gate (no verification flow yet) and the email-hash
 * lookup column (Inkquisitor stores the email itself, lower-cased).
 */
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { recordUserAuthEvent } from '@/lib/audit/user-auth-events';
import { isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';
import {
    LOGIN_PROGRESSIVE_POLICY,
    evaluateProgressiveRateLimit,
    recordProgressiveFailure,
    resetProgressiveFailures,
} from '@/lib/security/rate-limit';
import { logger } from '@/lib/observability/logger';
import { dummyVerify, hashPassword, needsRehash, verifyPassword } from './passwords';

export type AuthFailureReason = 'credentials_invalid' | 'rate_limited';

export type AuthResult =
    | { ok: true; userId: string; email: string; name: string | null }
    | { ok: false; reason: AuthFailureReason; retryAfterSeconds?: number };

export interface AuthenticateInput {
    email: string;
    password: string;
    requestId?: string;
}

export interface AuthenticateOptions {
    /**
     * Serves the progressive delay. Called once per attempt, only when the
     * delay is above zero, with that exact number. A test passes a recorder so
     * it asserts the delay REQUESTED rather than the time elapsed. It never
     * touches `dummyVerify`, so it cannot open a timing oracle.
     */
    sleepImpl?: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The canonical form of an email: trimmed and lower-cased (`User.email` is stored this way). */
export function normaliseEmail(email: string): string {
    return (email ?? '').trim().toLowerCase();
}

/** The lockout key: a digest, so the store holds no address. */
export function progressiveKeyFor(email: string): string {
    return `login-progressive:${createHash('sha256').update(normaliseEmail(email), 'utf8').digest('hex')}`;
}

export async function authenticateWithPassword(input: AuthenticateInput, options: AuthenticateOptions = {}): Promise<AuthResult> {
    const email = normaliseEmail(input.email);
    const password = input.password ?? '';
    const sleepImpl = options.sleepImpl ?? sleep;

    if (!email || !password) {
        await dummyVerify(password);
        return { ok: false, reason: 'credentials_invalid' };
    }

    const key = progressiveKeyFor(email);
    const lockoutOn = !isRateLimitBypassed();

    let user: { id: string; email: string; name: string | null; passwordHash: string | null } | null = null;
    try {
        user = await prisma.user.findUnique({
            where: { email },
            select: { id: true, email: true, name: true, passwordHash: true },
        });
    } catch (err) {
        logger.warn('auth.credentials_lookup_failed', {
            component: 'auth',
            errorName: err instanceof Error ? err.name : 'unknown',
        });
        await dummyVerify(password);
        return { ok: false, reason: 'credentials_invalid' };
    }

    if (lockoutOn) {
        const decision = evaluateProgressiveRateLimit(key, LOGIN_PROGRESSIVE_POLICY);
        if (!decision.allowed) {
            // The same compare a real verify costs, so a locked-out answer is not faster.
            await dummyVerify(password);
            await recordFailure(user?.id ?? null, 'rate_limited', decision.failureCount, input.requestId);
            return { ok: false, reason: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
        }
        if (decision.delayMs > 0) await sleepImpl(decision.delayMs);
    }

    if (!user || !user.passwordHash) {
        await dummyVerify(password);
        const after = lockoutOn ? recordProgressiveFailure(key, LOGIN_PROGRESSIVE_POLICY) : null;
        await recordFailure(user?.id ?? null, user ? 'no_password' : 'unknown_email', after?.failureCount, input.requestId);
        return { ok: false, reason: 'credentials_invalid' };
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
        const after = lockoutOn ? recordProgressiveFailure(key, LOGIN_PROGRESSIVE_POLICY) : null;
        await recordFailure(user.id, 'credentials_invalid', after?.failureCount, input.requestId);
        return { ok: false, reason: 'credentials_invalid' };
    }

    if (needsRehash(user.passwordHash)) {
        // Best-effort: the person has proved the password already.
        try {
            await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
        } catch {
            // housekeeping, not a gate
        }
    }

    resetProgressiveFailures(key);
    return { ok: true, userId: user.id, email: user.email, name: user.name };
}

async function recordFailure(
    userId: string | null,
    reason: 'credentials_invalid' | 'no_password' | 'unknown_email' | 'rate_limited',
    failureCount: number | undefined,
    requestId: string | undefined,
): Promise<void> {
    if (!userId) {
        // No account, so no workspace trail to write to. The address is not logged.
        logger.warn('auth.sign_in_failed', { component: 'auth', reason });
        return;
    }
    await recordUserAuthEvent({
        userId,
        action: 'USER_SIGN_IN_FAILED',
        details: { method: 'credentials', reason, ...(failureCount !== undefined ? { failureCount } : {}) },
        requestId,
    });
}
