/**
 * The membership claims the JWT carries, read from the database.
 *
 * The proxy (`src/proxy.ts`) authorizes `/w/<slug>/…` from these claims with no
 * database hit (`./workspace-gate.ts`), so they are the fast path, not the
 * source of truth: every workspace route re-checks the membership in the
 * database (`getWorkspaceCtx`). Capped at `MAX_JWT_MEMBERSHIPS` so the cookie
 * stays bounded; over the cap `membershipsTruncated` makes the edge defer a
 * slug miss to that server check.
 *
 * Read at sign-in and on an explicit session update. Lifted from
 * inflect-compliance's `applyMembershipClaims` in `src/auth.ts` (see
 * docs/carve-manifest.md), cut to workspaces.
 */
import type { JWT } from 'next-auth/jwt';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { MAX_JWT_MEMBERSHIPS, type MembershipClaim } from './workspace-gate';

export interface MembershipClaims {
    memberships: MembershipClaim[];
    membershipsTruncated: boolean;
    sessionVersion: number;
}

export async function readMembershipClaims(userId: string): Promise<MembershipClaims | null> {
    return runWithoutRls({ reason: 'auth-identity' }, async (db) => {
        const user = await db.user.findUnique({
            where: { id: userId },
            select: {
                sessionVersion: true,
                memberships: {
                    // A deleted workspace (5.H-a) is no membership to claim.
                    where: { workspace: { deletedAt: null } },
                    orderBy: { createdAt: 'asc' },
                    // One past the cap, so a capped list is a fact, not a guess.
                    take: MAX_JWT_MEMBERSHIPS + 1,
                    select: { role: true, workspace: { select: { id: true, slug: true } } },
                },
            },
        });
        if (!user) return null;
        return {
            memberships: user.memberships
                .slice(0, MAX_JWT_MEMBERSHIPS)
                .map((m) => ({ slug: m.workspace.slug, workspaceId: m.workspace.id, role: m.role })),
            membershipsTruncated: user.memberships.length > MAX_JWT_MEMBERSHIPS,
            sessionVersion: user.sessionVersion,
        };
    });
}

/** Write the claims onto `token`. A user that no longer exists gets none. */
export async function applyMembershipClaims(token: JWT, userId: string): Promise<void> {
    const claims = await readMembershipClaims(userId);
    token.userId = userId;
    token.memberships = claims?.memberships ?? [];
    token.membershipsTruncated = claims?.membershipsTruncated ?? false;
    token.sessionVersion = claims?.sessionVersion ?? 0;
}
