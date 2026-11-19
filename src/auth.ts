/**
 * NextAuth v4 configuration (Phase 0.3): Credentials and, when configured,
 * Google. JWT sessions, each backed by a `UserSession` row.
 *
 *   providers   Credentials → `authenticateWithPassword` (src/lib/auth/credentials.ts:
 *               bcrypt, progressive lockout, timing equalisation). Google only when
 *               GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set.
 *   signIn      Google → `resolveGoogleSignIn` (src/app-layer/usecases/sign-up.ts):
 *               refuses an address Google did not verify, links or claims an
 *               existing account, or provisions a new one with its workspace.
 *   jwt         At sign-in: resolve the database user, read the membership claims,
 *               record a `UserSession` (throws if it cannot: an unrevocable session
 *               is not handed out), audit USER_SIGNED_IN. On every later pass:
 *               `verifySession` — a revoked, expired or missing row, or a bumped
 *               `sessionVersion`, THROWS `SessionRevokedError`, so
 *               `getServerSession` returns null. Never a flag.
 *   session     Exposes id, email, name and image. Nothing else.
 *   signOut     Revokes the session's row and audits USER_SIGNED_OUT.
 *
 * Adapted from inflect-compliance's `src/auth.ts` (see docs/carve-manifest.md).
 * Dropped, as the 0.3 brief says: Microsoft Entra, SAML and OIDC SSO, SCIM, the
 * MFA policy, API keys, invites, and the Prisma adapter (accounts are created by
 * the sign-up usecase, so the adapter would be a second writer).
 */
import { getServerSession, type NextAuthOptions, type Session } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import { env } from '@/env';
import { authSecret } from '@/lib/auth/auth-secret';
import { authenticateWithPassword } from '@/lib/auth/credentials';
import { applyMembershipClaims } from '@/lib/auth/membership-claims';
import { SessionRevokedError } from '@/lib/auth/session-revoked';
import { recordUserAuthEvent } from '@/lib/audit/user-auth-events';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';
import {
    SESSION_MAX_AGE_SECONDS,
    recordNewSession,
    revokeSessionBySessionId,
    verifySession,
} from '@/lib/security/session-tracker';
import { resolveGoogleSignIn } from '@/app-layer/usecases/sign-up';
import { ForbiddenError } from '@/lib/errors/types';

/** True when the Google provider (and its button) is configured. */
export function googleSignInEnabled(): boolean {
    return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** The error the Credentials provider reports for a locked-out identifier. */
export const RATE_LIMITED_SIGN_IN_ERROR = 'RateLimited';
/** The error a Google sign-in reports when Google did not verify the address. */
export const GOOGLE_UNVERIFIED_SIGN_IN_ERROR = 'GoogleEmailUnverified';

function headerValue(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : undefined;
}

function buildProviders(): NextAuthOptions['providers'] {
    const providers: NextAuthOptions['providers'] = [
        CredentialsProvider({
            id: 'credentials',
            name: 'Email and password',
            credentials: {
                email: { label: 'Email', type: 'email' },
                password: { label: 'Password', type: 'password' },
            },
            async authorize(credentials, req) {
                const result = await authenticateWithPassword({
                    email: credentials?.email ?? '',
                    password: credentials?.password ?? '',
                    requestId: headerValue(req?.headers, 'x-request-id'),
                });
                if (result.ok) return { id: result.userId, email: result.email, name: result.name };
                // A fixed code, never the reason: every other failure is the
                // generic CredentialsSignin, so the answer does not enumerate.
                if (result.reason === 'rate_limited') throw new Error(RATE_LIMITED_SIGN_IN_ERROR);
                return null;
            },
        }),
    ];
    if (googleSignInEnabled()) {
        providers.push(
            GoogleProvider({
                clientId: env.GOOGLE_CLIENT_ID as string,
                clientSecret: env.GOOGLE_CLIENT_SECRET as string,
                authorization: { params: { scope: 'openid email profile' } },
            }),
        );
    }
    return providers;
}

/** The database user a sign-in resolves to. */
async function resolveSignInUserId(user: { id?: string | null }, provider: string, providerAccountId: string): Promise<string | null> {
    if (provider === 'credentials') return user.id ?? null;
    const link = await runWithoutRls({ reason: 'auth-identity' }, (db) =>
        db.account.findUnique({
            where: { provider_providerAccountId: { provider, providerAccountId } },
            select: { userId: true },
        }),
    );
    return link?.userId ?? null;
}

export const authOptions: NextAuthOptions = {
    providers: buildProviders(),
    pages: { signIn: '/login', error: '/login' },
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },
    secret: authSecret(),
    logger: {
        error(code, metadata) {
            if (metadata instanceof SessionRevokedError) {
                logger.info('auth.session_refused', { component: 'auth', reason: metadata.reason });
                return;
            }
            logger.error('auth.nextauth_error', {
                component: 'auth',
                code: String(code),
                errorName: metadata instanceof Error ? metadata.name : undefined,
            });
        },
        warn(code) {
            logger.warn('auth.nextauth_warning', { component: 'auth', code: String(code) });
        },
        debug() {
            // next-auth's debug output carries tokens and profiles; never forwarded.
        },
    },
    callbacks: {
        async signIn({ account, profile }) {
            if (!account || account.provider === 'credentials') return true;
            if (account.provider !== 'google') return false;
            const google = (profile ?? {}) as { email?: string | null; email_verified?: unknown; name?: string | null; picture?: string | null };
            try {
                await resolveGoogleSignIn({
                    providerAccountId: account.providerAccountId,
                    email: google.email,
                    emailVerified: google.email_verified,
                    name: google.name,
                    image: google.picture,
                });
                return true;
            } catch (err) {
                if (err instanceof ForbiddenError) return `/login?error=${GOOGLE_UNVERIFIED_SIGN_IN_ERROR}`;
                throw err;
            }
        },

        async jwt({ token, user, account, trigger }) {
            if (account && user) {
                const userId = await resolveSignInUserId(user, account.provider, account.providerAccountId);
                if (!userId) throw new Error('The sign-in resolved to no account');
                await applyMembershipClaims(token, userId);
                token.provider = account.provider;
                const recorded = await recordNewSession({ userId });
                token.userSessionId = recorded.sessionId;
                await recordUserAuthEvent({
                    userId,
                    action: 'USER_SIGNED_IN',
                    details: { method: account.provider, sessionRowId: recorded.rowId },
                });
                return token;
            }

            if (!token.userId || !token.userSessionId) throw new SessionRevokedError('session_missing');
            const verdict = await verifySession(token.userSessionId);
            switch (verdict.status) {
                case 'revoked':
                case 'expired':
                    throw new SessionRevokedError('session_revoked');
                case 'missing':
                    throw new SessionRevokedError('session_missing');
                case 'active':
                    if (verdict.userId !== token.userId) throw new SessionRevokedError('session_missing');
                    if (verdict.sessionVersion > (token.sessionVersion ?? 0)) {
                        throw new SessionRevokedError('session_version_bumped');
                    }
                    break;
                case 'unavailable':
                    // A database blip lets the request through; the next pass checks again.
                    break;
            }

            if (trigger === 'update') await applyMembershipClaims(token, token.userId);
            return token;
        },

        async session({ session, token }) {
            session.user = {
                id: token.userId ?? '',
                email: token.email ?? '',
                name: token.name ?? null,
                image: token.picture ?? null,
            };
            return session;
        },
    },
    events: {
        async signOut({ token }) {
            const sessionId = token?.userSessionId;
            const userId = token?.userId;
            if (!sessionId || !userId) return;
            const revoked = await revokeSessionBySessionId(sessionId, 'signout').catch(() => false);
            if (revoked) await recordUserAuthEvent({ userId, action: 'USER_SIGNED_OUT', details: { method: token.provider ?? null } });
        },
    },
};

/** The current session in a server component or route handler, or null. */
export async function auth(): Promise<Session | null> {
    return getServerSession(authOptions);
}
