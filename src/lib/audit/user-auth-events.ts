/**
 * Authentication events on the audit trail: sign-in success and failure,
 * sign-out, session revocation, a Google identity linked to or claiming an
 * account.
 *
 * The trail is per workspace (src/lib/audit/audit-writer.ts), and a person
 * exists across workspaces, so a user-level event is appended to EVERY
 * workspace the user is a member of (oldest first, at most
 * `MAX_JWT_MEMBERSHIPS`): each workspace's owner sees who signed in to reach
 * it. A failure for an email that names no account has no workspace to go to
 * and is logged only — without the address.
 *
 * Never throws. A sign-in must not fail because the trail could not be
 * written; the failure is logged instead. (Authorization denials are the
 * opposite — `requirePermission` lets a failed write fail the request.)
 */
import { randomUUID } from 'node:crypto';
import type { AuditAction } from '@/app-layer/events/audit';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { MAX_JWT_MEMBERSHIPS } from '@/lib/auth/workspace-gate';
import { logger } from '@/lib/observability/logger';

export type UserAuthAction = Extract<
    AuditAction,
    'USER_SIGNED_IN' | 'USER_SIGN_IN_FAILED' | 'USER_SIGNED_OUT' | 'SESSION_REVOKED' | 'ACCOUNT_LINKED' | 'ACCOUNT_CLAIMED'
>;

export async function recordUserAuthEvent(input: {
    userId: string;
    action: UserAuthAction;
    /** Ids, counts, codes. Never an email, a password or a token. */
    details?: Record<string, unknown>;
    requestId?: string;
}): Promise<void> {
    try {
        const memberships = await runWithoutRls({ reason: 'workspace-discovery' }, (db) =>
            db.workspaceMembership.findMany({
                where: { userId: input.userId },
                orderBy: { createdAt: 'asc' },
                take: MAX_JWT_MEMBERSHIPS,
                select: { workspaceId: true },
            }),
        );
        const requestId = input.requestId ?? randomUUID();
        for (const { workspaceId } of memberships) {
            await appendAuditEntry({
                workspaceId,
                actorUserId: input.userId,
                actorType: 'USER',
                action: input.action,
                entityType: 'User',
                entityId: input.userId,
                detailsJson: input.details ?? {},
                requestId,
            });
        }
    } catch (err) {
        logger.error('audit.user_auth_event_failed', {
            component: 'audit',
            action: input.action,
            errorName: err instanceof Error ? err.name : 'unknown',
        });
    }
}
