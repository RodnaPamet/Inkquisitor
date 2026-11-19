/**
 * `logEvent(ctx, …)` — the one way application code writes to the audit
 * trail. It routes through `appendAuditEntry` (`src/lib/audit/audit-writer.ts`),
 * which hash-chains the row onto the workspace's trail under row-level
 * security.
 *
 * `details` carries ids, counts and codes only — never author text, an email
 * address, a password or a token (roadmap rule 4). The trail is read by the
 * workspace's OWNER and is immutable: what goes in cannot be taken out.
 *
 * Pass `{ db }` to append inside a transaction the caller holds (under the
 * workspace's RLS), so the row commits or rolls back with the change it
 * records. Without it the append is a transaction of its own.
 *
 * Adapted from inflect-compliance's `src/app-layer/events/audit.ts` (see
 * docs/carve-manifest.md): no legacy free-text `details`, no metadata blob,
 * and a closed set of action names.
 */
import type { RequestContext } from '@/app-layer/types';
import { appendAuditEntry, appendAuditEntryWithin, type AuditActorType } from '@/lib/audit/audit-writer';
import type { PrismaTx } from '@/lib/db/rls-middleware';

/** Every action the trail records. Add one here, with its emitter. */
export type AuditAction =
    | 'USER_SIGNED_UP'
    | 'WORKSPACE_CREATED'
    | 'MEMBERSHIP_CREATED'
    | 'MEMBERSHIP_ROLE_CHANGED'
    | 'MEMBERSHIP_REMOVED'
    | 'USER_SIGNED_IN'
    | 'USER_SIGN_IN_FAILED'
    | 'USER_SIGNED_OUT'
    | 'ACCOUNT_LINKED'
    | 'ACCOUNT_CLAIMED'
    | 'SESSION_REVOKED'
    | 'AUTHZ_DENIED'
    | 'BOOK_CREATED'
    | 'BOOK_UPDATED'
    | 'BOOK_DELETED'
    | 'BIBLE_ELEMENT_CREATED'
    | 'BIBLE_ELEMENT_UPDATED'
    | 'BIBLE_ELEMENT_DELETED'
    | 'BIBLE_FIELDS_UPDATED'
    | 'BIBLE_RELATION_CREATED'
    | 'BIBLE_RELATION_DELETED'
    | 'BIBLE_VERSION_RESTORED'
    | 'BIBLE_EXPORTED'
    | 'BIBLE_BUNDLE_IMPORTED'
    | 'BIBLE_CONCEPT_NOTE_IMPORTED';

export interface AuditEventPayload {
    action: AuditAction;
    entityType: string;
    entityId: string | null;
    /** Ids, counts, codes. Never author text or a credential. */
    details?: Record<string, unknown>;
}

/** The context an event needs: a workspace to chain into, and whoever acted (if anyone). */
export type AuditContext = Pick<RequestContext, 'requestId' | 'userId'> & { workspaceId: string };

export async function logEvent(
    ctx: AuditContext,
    payload: AuditEventPayload,
    options: { db?: PrismaTx; actorType?: AuditActorType } = {},
): Promise<void> {
    const input = {
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.userId ?? null,
        actorType: options.actorType ?? (ctx.userId ? 'USER' : 'SYSTEM'),
        action: payload.action,
        entityType: payload.entityType,
        entityId: payload.entityId,
        detailsJson: payload.details ?? {},
        requestId: ctx.requestId,
    } as const;
    if (options.db) {
        await appendAuditEntryWithin(options.db, input);
    } else {
        await appendAuditEntry(input);
    }
}
