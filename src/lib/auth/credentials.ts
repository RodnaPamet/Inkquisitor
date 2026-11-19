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
 *     └─ audit                        (USER_SIGN_IN_FAILED, NOT awaited, at most one
 *                                      per user per lockout window, none for a
 *                                      lockout refusal; success is recorded by
 *                                      the jwt callback with the session id)
 *
 * ACCOUNT-ENUMERATION SAFE. Unknown email, a Google-only account (no
 * password) and a wrong password all return `credentials_invalid`, and every
 * one of them costs exactly one bcrypt compare (`dummyVerify` where there is
 * no real hash), so neither the answer nor its timing says which. A locked
 * out identifier answers `rate_limited` — but only after the same compare,
 * and the lockout is reached by failing, so it tells an attacker nothing an
 * attacker did not cause. The failure's audit row is NOT awaited: appending it
 * fans out to every workspace the user belongs to, and an unknown email has
 * none, so awaiting it made the known-email answer measurably slower. Both
 * paths await the same work: one lookup, one bcrypt compare.
 *
 * BOUNDED AUDIT VOLUME. Anyone can fail a sign-in for anyone's address, and
 * the trail is append-only, so a failure writes at most ONE row per user per
 * lockout window (`LOGIN_PROGRESSIVE_POLICY.lockoutMs`), with the limiter on
 * or off, and an attempt refused DURING a lockout writes none (it is the
 * lockout's own consequence, already evidenced by the row that preceded it).
 * The window is per process, like the lockout store.
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
            // No audit row: a refusal during a lockout is the lockout's own
            // consequence, and unauthenticated callers must not be able to
            // grow a victim's append-only trail with it.
            logger.warn('auth.sign_in_refused_locked', { component: 'auth', ...(user ? { userId: user.id } : {}) });
            return { ok: false, reason: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
        }
        if (decision.delayMs > 0) await sleepImpl(decision.delayMs);
    }

    if (!user || !user.passwordHash) {
        await dummyVerify(password);
        const after = lockoutOn ? recordProgressiveFailure(key, LOGIN_PROGRESSIVE_POLICY) : null;
        recordFailure(user?.id ?? null, user ? 'no_password' : 'unknown_email', after?.failureCount, input.requestId);
        return { ok: false, reason: 'credentials_invalid' };
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
        const after = lockoutOn ? recordProgressiveFailure(key, LOGIN_PROGRESSIVE_POLICY) : null;
        recordFailure(user.id, 'credentials_invalid', after?.failureCount, input.requestId);
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

// ─── The failure trail: fire and forget, bounded per user ───────────

/** userId → when its current audit window opened. Insertion-ordered (oldest first). */
const failureWindowOpenedAt = new Map<string, number>();
const MAX_TRACKED_USERS = 10_000;
/** In-flight appends, so a test (or a graceful shutdown) can wait for them. */
const pendingAudits = new Set<Promise<void>>();

/** True when this failure may write a row: the first for `userId` in the current lockout window. */
function claimFailureWindow(userId: string, now: number): boolean {
    const windowMs = LOGIN_PROGRESSIVE_POLICY.lockoutMs;
    const opened = failureWindowOpenedAt.get(userId);
    if (opened !== undefined && now - opened < windowMs) return false;
    failureWindowOpenedAt.delete(userId);
    // Swept on a caller's turn, never on a timer.
    if (failureWindowOpenedAt.size >= MAX_TRACKED_USERS) {
        for (const [id, at] of failureWindowOpenedAt) {
            if (now - at >= windowMs) failureWindowOpenedAt.delete(id);
        }
        while (failureWindowOpenedAt.size >= MAX_TRACKED_USERS) {
            const oldest = failureWindowOpenedAt.keys().next().value;
            if (oldest === undefined) break;
            failureWindowOpenedAt.delete(oldest);
        }
    }
    failureWindowOpenedAt.set(userId, now);
    return true;
}

/**
 * Record a failed sign-in WITHOUT making the caller wait for it. An unknown
 * email has no workspace trail and is only logged (without the address); a
 * known one writes at most one row per lockout window. Errors are logged by
 * user id, never the email.
 */
function recordFailure(
    userId: string | null,
    reason: 'credentials_invalid' | 'no_password' | 'unknown_email',
    failureCount: number | undefined,
    requestId: string | undefined,
): void {
    if (!userId) {
        logger.warn('auth.sign_in_failed', { component: 'auth', reason });
        return;
    }
    if (!claimFailureWindow(userId, Date.now())) {
        logger.warn('auth.sign_in_failed', { component: 'auth', reason, userId, audited: false });
        return;
    }
    const append = recordUserAuthEvent({
        userId,
        action: 'USER_SIGN_IN_FAILED',
        details: { method: 'credentials', reason, ...(failureCount !== undefined ? { failureCount } : {}) },
        requestId,
    })
        .catch((err: unknown) => {
            logger.error('auth.sign_in_failure_audit_failed', {
                component: 'auth',
                userId,
                errorName: err instanceof Error ? err.name : 'unknown',
            });
        })
        .finally(() => {
            pendingAudits.delete(append);
        });
    pendingAudits.add(append);
}

/** Resolves once every failure audit started so far has settled (tests; graceful shutdown). */
export async function settleSignInFailureAudits(): Promise<void> {
    await Promise.all([...pendingAudits]);
}

/** @internal Forget every per-user audit window and stop tracking in-flight appends (tests). */
export function _resetSignInFailureAuditWindow(): void {
    failureWindowOpenedAt.clear();
    pendingAudits.clear();
}
