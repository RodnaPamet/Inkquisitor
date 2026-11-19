/**
 * The session and JWT shapes Inkquisitor stores (Phase 0.3). A declaration
 * file rather than an augmentation inside `src/auth.ts` so the edge
 * middleware reads typed claims without importing the auth configuration,
 * which reaches Prisma and cannot run on the edge.
 *
 * Adapted from inflect-compliance's augmentations in `src/auth.ts` (see
 * docs/carve-manifest.md), cut to what this product stores.
 */
import 'next-auth';
import 'next-auth/jwt';
import type { MembershipClaim } from '@/lib/auth/workspace-gate';

declare module 'next-auth' {
    interface Session {
        user: {
            id: string;
            email: string;
            name?: string | null;
            image?: string | null;
        };
    }
}

declare module 'next-auth/jwt' {
    interface JWT {
        /** The database user id. */
        userId?: string;
        /** `User.sessionVersion` when this token was minted; a higher stored value refuses it. */
        sessionVersion?: number;
        /** The `UserSession.sessionId` this token belongs to; verified on every JWT pass. */
        userSessionId?: string;
        /** The user's workspaces, oldest first, capped at MAX_JWT_MEMBERSHIPS. */
        memberships?: MembershipClaim[];
        /** True when `memberships` is a capped subset: the edge then defers a slug miss to the server gate. */
        membershipsTruncated?: boolean;
        /** `credentials` or `google`. */
        provider?: string;
    }
}
